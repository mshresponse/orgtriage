/**
 * Service worker — message router and the only place that talks to Salesforce.
 *
 * Trust model: the panel and the content script are both untrusted callers.
 * Neither may name the org it wants; the worker derives that from the sending
 * tab's own URL, so a compromised panel cannot point a query at a different org
 * the user happens to be logged into. Requests carry no credentials in either
 * direction — see `auth.ts`, which owns the session end to end.
 */

import {
  AuthError,
  resolveOrgHost,
  clearAllSessions,
  isAllowedApiHost,
  type OrgHost,
} from './auth';
import { SalesforceClient, SalesforceError } from './sfClient';
import * as cache from './cache';
import { comparable, diffAgainst, digestOf, type AreaDiff } from '@/shared/diff';

import { ANALYZERS, advanceScan, cancelScan, commitScan, probeWatermark } from './scanRunner';
import type { ErrorPayload, Request, Response, ResponseData } from '@/shared/messages';
import { SCAN_PORT, type PortBind } from '@/shared/messages';
import {
  DEFAULT_PANEL_PREFS,
  type AnalyzerId,
  type OrgContext,
  type PanelPrefs,
  type ScanResult,
  type OrgWatermark,
  type StalenessVerdict,
} from '@/shared/types';

const PREFS_KEY = 'panelPrefs';
const SETTINGS_KEY = 'settings';

interface Settings {
  /** Include managed-package components in every scan. */
  includeManaged: boolean;
  /** Cap on components fetched one at a time (flow/page metadata, describes). */
  detailBudget: number;
  /** Empty means "negotiate with the org". */
  apiVersionOverride: string;
}

const DEFAULT_SETTINGS: Settings = {
  includeManaged: false,
  detailBudget: 300,
  apiVersionOverride: '',
};

/* -------------------------------------------------------------------------- */
/* Per-tab org resolution                                                     */
/* -------------------------------------------------------------------------- */

interface OrgSession {
  host: OrgHost;
  client: SalesforceClient;
  context: OrgContext;
}

const orgSessions = new Map<string, OrgSession>();

/**
 * The org context — name, ids, user, whether Limits is readable — costs four
 * API calls to build, and the service worker that holds it is discarded after
 * about thirty seconds of quiet. Every Salesforce tab that opens after that
 * (an "Open" link from the report, for instance) used to rebuild it. It holds
 * no credential, so it is kept in `storage.session`, which lasts for the
 * browser session and is cleared when the sid cookie goes away.
 */
const CONTEXT_TTL_MS = 30 * 60 * 1000;
const CONTEXT_PREFIX = 'orgContext::';

/**
 * "OrgTriage used N today": the count of calls this extension has made to
 * the org since midnight UTC, across worker restarts. Kept in storage.local
 * under the org and the day, so yesterday's key simply goes unread.
 */
function usageKey(orgId15: string): string {
  return `apiUsed::${orgId15}::${new Date().toISOString().slice(0, 10)}`;
}

/**
 * The org's last-reported allowance, remembered per org in `storage.session`.
 * The figure comes from the `Sforce-Limit-Info` header of whatever call was
 * made last, and a service worker Chrome has stopped for idleness forgets it;
 * the panel then read "API unknown" after a few minutes away, although the
 * cache reads it had just made cost nothing and the last reading was minutes
 * old at most. Remembering it keeps the footer honest without spending a call
 * to refresh a number that a scan will refresh anyway.
 */
const BUDGET_PREFIX = 'budget::';
type StoredBudget = { max: number; remaining: number; observedAt: number };

async function attachUsageCounter(client: SalesforceClient, orgId15: string): Promise<void> {
  const key = usageKey(orgId15);
  try {
    const stored = (await chrome.storage.local.get(key))[key];
    client.apiCallsBefore = typeof stored === 'number' ? stored : 0;
  } catch {
    client.apiCallsBefore = 0;
  }
  client.onCall = (total) => {
    void chrome.storage.local.set({ [key]: total }).catch(() => {
      /* the in-memory count still shows */
    });
  };
  const budgetKey = BUDGET_PREFIX + orgId15;
  let remembered: StoredBudget | undefined;
  try {
    remembered = (await chrome.storage.session.get(budgetKey))[budgetKey] as StoredBudget | undefined;
  } catch {
    /* nothing remembered */
  }
  client.budget = {
    max: remembered?.max ?? null,
    remaining: remembered?.remaining ?? null,
    usedByOrgTriage: client.apiCallsBefore,
    observedAt: remembered?.observedAt ?? null,
  };
  client.onBudget = (budget) => {
    if (budget.max === null || budget.remaining === null || budget.observedAt === null) return;
    const entry: StoredBudget = { max: budget.max, remaining: budget.remaining, observedAt: budget.observedAt };
    void chrome.storage.session.set({ [budgetKey]: entry }).catch(() => {
      /* memory alone is fine */
    });
  };
}

/**
 * The staleness watermark (latest Setup Audit Trail entry) is one row per
 * org, not per area. Reading it once per area made every panel open cost ten
 * API calls; it is now read once and kept for a few minutes, in memory and in
 * storage.session so a restarted worker does not pay again. A scan still
 * probes fresh (scan.run), because that is the moment the answer must be
 * exact.
 */
const WATERMARK_TTL_MS = 5 * 60 * 1000;
/**
 * A scan records the watermark the snapshot was taken against. "Scan all"
 * finishes ten areas within a couple of minutes, and a watermark up to a
 * minute old is conservative — a Setup change inside that minute makes the
 * snapshot read as stale, never as fresh — so the ten completions share one
 * probe instead of paying ten.
 */
const SCAN_WATERMARK_MAX_AGE_MS = 60 * 1000;
const WATERMARK_PREFIX = 'watermark::';
const watermarks = new Map<string, { value: OrgWatermark | null; at: number }>();
/**
 * One probe in flight per org. The panel reads all ten areas at once, so
 * without this every read that arrives before the first probe answers would
 * miss the cache and probe again — ten calls where one was owed. Measured
 * 2026-09-10: "used today" rose by exactly ten, seven minutes after a scan.
 */
const pendingWatermarks = new Map<string, Promise<OrgWatermark | null>>();

/**
 * The org's staleness watermark, no older than `maxAgeMs`. Reports whether
 * this call actually spent an API request, so a scan can count it.
 */
async function freshWatermark(
  session: OrgSession,
  maxAgeMs: number,
): Promise<{ value: OrgWatermark | null; probed: boolean }> {
  const key = session.context.orgId;
  const now = Date.now();
  const inMemory = watermarks.get(key);
  if (inMemory && now - inMemory.at < maxAgeMs) return { value: inMemory.value, probed: false };
  try {
    const stored = (await chrome.storage.session.get(WATERMARK_PREFIX + key))[WATERMARK_PREFIX + key] as
      | { value: OrgWatermark | null; at: number }
      | undefined;
    if (stored && now - stored.at < maxAgeMs) {
      watermarks.set(key, stored);
      return { value: stored.value, probed: false };
    }
  } catch {
    /* no session storage: probe */
  }
  const pending = pendingWatermarks.get(key);
  if (pending) return { value: await pending, probed: false };
  const probe = (async () => {
    const value = await probeWatermark(session.client);
    const entry = { value, at: Date.now() };
    watermarks.set(key, entry);
    try {
      await chrome.storage.session.set({ [WATERMARK_PREFIX + key]: entry });
    } catch {
      /* memory alone is fine */
    }
    return value;
  })();
  pendingWatermarks.set(key, probe);
  try {
    return { value: await probe, probed: true };
  } finally {
    pendingWatermarks.delete(key);
  }
}

async function cachedWatermark(session: OrgSession): Promise<OrgWatermark | null> {
  return (await freshWatermark(session, WATERMARK_TTL_MS)).value;
}

/** The finding a newly opened Salesforce tab's sidebar should land on; set by the report page. */
const FOCUS_KEY = 'pendingFocus';
const FOCUS_TTL_MS = 5 * 60 * 1000;

async function loadCachedContext(key: string, apiHost: string): Promise<OrgContext | null> {
  try {
    const storageKey = CONTEXT_PREFIX + key;
    const stored = await chrome.storage.session.get(storageKey);
    const entry = stored[storageKey] as { context: OrgContext; savedAt: number } | undefined;
    if (!entry || Date.now() - entry.savedAt > CONTEXT_TTL_MS) return null;
    if (entry.context.apiHost !== apiHost) return null;
    return entry.context;
  } catch {
    return null;
  }
}

async function saveCachedContext(key: string, context: OrgContext): Promise<void> {
  try {
    await chrome.storage.session.set({ [CONTEXT_PREFIX + key]: { context, savedAt: Date.now() } });
  } catch {
    /* a cache miss next time is the whole cost */
  }
}

async function clearCachedContexts(): Promise<void> {
  try {
    const all = await chrome.storage.session.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith(CONTEXT_PREFIX));
    if (keys.length > 0) await chrome.storage.session.remove(keys);
  } catch {
    /* nothing cached, or no session storage in this browser */
  }
}

/**
 * Resolve the org for a sender, using only browser-supplied facts.
 *
 * `sender.tab.url` is populated because the extension holds host permissions
 * for Salesforce hosts; it is not taken from the message body precisely so that
 * the caller cannot choose which org is queried.
 */
/**
 * The Salesforce tab a request is about.
 *
 * A message from a page inside a tab carries `sender.tab`. The side panel is
 * not inside a tab, so it names one by id instead; the id is accepted only
 * from the extension's own pages, and the tab's URL is then read from the
 * browser — the panel can point at any of the user's open tabs, and at
 * nothing else.
 */
async function tabFor(sender: chrome.runtime.MessageSender, tabId?: number): Promise<chrome.tabs.Tab | null> {
  if (sender.tab?.url) return sender.tab;
  if (typeof tabId !== 'number') return null;
  if (!sender.url?.startsWith(chrome.runtime.getURL(''))) return null;
  try {
    return await chrome.tabs.get(tabId);
  } catch {
    return null;
  }
}

async function sessionFor(sender: chrome.runtime.MessageSender, tabId?: number): Promise<OrgSession> {
  const tab = await tabFor(sender, tabId);
  // While a freshly opened tab is still navigating, only `pendingUrl` is set.
  const tabUrl = tab?.url || tab?.pendingUrl;
  if (!tabUrl) {
    throw new AuthError(
      'NO_TAB',
      'OrgTriage could not identify the Salesforce tab it is beside.',
      'Open a Salesforce tab, then open the panel again.',
    );
  }

  // `cookieStoreId` is a Firefox extension to the Tab type: Firefox has no
  // incognito split mode, so the store must be named explicitly. In Chrome it
  // is undefined and `"incognito": "split"` selects the right store instead.
  const cookieStoreId = (tab as { cookieStoreId?: string } | undefined)?.cookieStoreId;
  const host = await resolveOrgHost(tabUrl, cookieStoreId);
  const key = `${host.cookieStoreId ?? 'default'}::${host.apiHost}`;

  const existing = orgSessions.get(key);
  if (existing) return existing;

  const settings = await loadSettings();
  const client = new SalesforceClient(host);
  await attachUsageCounter(client, host.orgId15);
  // Always probe: this is what settles which candidate host actually answers,
  // and it costs no API call. The version override only overrides the version.
  await client.resolveHost();
  if (settings.apiVersionOverride) client.setApiVersion(settings.apiVersionOverride);

  // `resolveHost` has settled `host.apiHost`; a cached context is only reused
  // for that same host. The API version and Lightning host are taken from this
  // tab rather than from the cache, since neither costs a call.
  const cached = await loadCachedContext(key, host.apiHost);
  const context = cached
    ? { ...cached, apiVersion: client.apiVersion, lightningHost: deriveLightningHost(tabUrl, host.apiHost) }
    : await buildOrgContext(client, host, tabUrl);
  if (!cached) await saveCachedContext(key, context);
  const session: OrgSession = { host, client, context };
  orgSessions.set(key, session);
  return session;
}

async function buildOrgContext(
  client: SalesforceClient,
  host: OrgHost,
  tabUrl: string,
): Promise<OrgContext> {
  // Sandbox and instance come from the Organization record rather than from the
  // hostname: `--` appears in Visualforce package hosts and Developer Edition
  // names end in `-dev-ed`, so hostname heuristics get this wrong.
  const org = await client.queryOne<{
    Id: string;
    Name: string;
    IsSandbox: boolean;
    InstanceName: string;
    OrganizationType: string;
    NamespacePrefix: string | null;
  }>(
    'SELECT Id, Name, IsSandbox, InstanceName, OrganizationType, NamespacePrefix FROM Organization',
  );

  // Who the extension is acting as. The versioned REST root advertises an
  // `identity` URL whose last path segment is the running user's id; that is
  // the cheapest way to learn it without an Apex call. Purely informational —
  // failure here must not stop the panel from opening.
  let userId = '';
  let userName = '';
  try {
    const root = await client.get<{ identity?: string }>('/');
    const match = /\/id\/[^/]+\/([A-Za-z0-9]{15,18})/.exec(root.identity ?? '');
    if (match?.[1]) {
      userId = match[1];
      const user = await client.queryOne<{ Id: string; Name: string }>(
        `SELECT Id, Name FROM User WHERE Id = '${userId.replace(/[^A-Za-z0-9]/g, '')}'`,
      );
      userName = user?.Name ?? '';
    }
  } catch {
    /* identity is a nicety, not a requirement */
  }

  // A cheap probe for the permission most checks depend on.
  let limitedAccess = false;

  try {
    await client.getLimits();
  } catch {
    limitedAccess = true;
  }

  const lightningHost = deriveLightningHost(tabUrl, host.apiHost);

  return {
    orgId: org?.Id ?? host.orgId15,
    apiHost: host.apiHost,
    lightningHost,
    orgName: org?.Name ?? 'Unknown org',
    instanceName: org?.InstanceName ?? '',
    organizationType: org?.OrganizationType ?? '',
    isSandbox: org?.IsSandbox ?? false,
    apiVersion: client.apiVersion,
    userId,
    userName,
    limitedAccess,
    orgNamespace: org?.NamespacePrefix ?? null,
  };
}

/** Prefer the tab's own Lightning host; fall back to deriving it from the API host. */
function deriveLightningHost(tabUrl: string, apiHost: string): string {
  try {
    const host = new URL(tabUrl).hostname;
    if (host.includes('.lightning.force.com')) return host;
  } catch {
    /* fall through */
  }
  const derived = apiHost
    .replace(/\.my\.salesforce\.com$/, '.lightning.force.com')
    .replace(/\.my\.([^.]+)\.salesforce\.com$/, '.lightning.$1.force.com');
  return isAllowedApiHost(derived) ? derived : apiHost;
}

/* -------------------------------------------------------------------------- */
/* Settings and prefs                                                         */
/* -------------------------------------------------------------------------- */

async function loadSettings(): Promise<Settings> {
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  return { ...DEFAULT_SETTINGS, ...(stored[SETTINGS_KEY] as Partial<Settings> | undefined) };
}

async function loadPrefs(): Promise<PanelPrefs> {
  const stored = await chrome.storage.local.get(PREFS_KEY);
  return { ...DEFAULT_PANEL_PREFS, ...(stored[PREFS_KEY] as Partial<PanelPrefs> | undefined) };
}

async function savePrefs(patch: Partial<PanelPrefs>): Promise<PanelPrefs> {
  const next = { ...(await loadPrefs()), ...patch };
  await chrome.storage.local.set({ [PREFS_KEY]: next });
  return next;
}

/* -------------------------------------------------------------------------- */
/* Progress ports                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Progress ports, each bound to the org of the tab that opened it.
 *
 * The binding is derived the same way every request's org is — from the
 * port's own sender, never from anything the panel says — and a port whose
 * org cannot be resolved is bound to nothing and receives nothing. Before
 * this, one global set received every message, so a panel open on org A was
 * handed org B's completed scan result in full.
 */
const progressPorts = new Map<chrome.runtime.Port, string | null>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== SCAN_PORT) return;
  progressPorts.set(port, null);
  port.onDisconnect.addListener(() => progressPorts.delete(port));
  const sender = port.sender;
  if (!sender) return;
  // The panel's first message names its tab; a port that never binds stays
  // unbound and receives nothing.
  port.onMessage.addListener((message: PortBind) => {
    if (message?.type !== 'bind') return;
    sessionFor(sender, message.tabId)
      .then((session) => {
        if (progressPorts.has(port)) progressPorts.set(port, session.context.orgId);
      })
      .catch(() => {
        /* unresolvable tab: the port stays unbound */
      });
  });
});

function broadcastProgress(orgId: string, message: unknown): void {
  for (const [port, boundOrgId] of progressPorts) {
    if (boundOrgId !== orgId) continue;
    try {
      port.postMessage(message);
    } catch {
      progressPorts.delete(port);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Request handling                                                           */
/* -------------------------------------------------------------------------- */

async function handle(
  request: Request,
  sender: chrome.runtime.MessageSender,
): Promise<ResponseData[Request['type']]> {
  switch (request.type) {
    case 'prefs.get':
      return loadPrefs();

    case 'prefs.set':
      return savePrefs(request.patch);

    case 'org.context': {
      const session = await sessionFor(sender, request.tabId);
      return session.context;
    }

    case 'org.limits': {
      const session = await sessionFor(sender, request.tabId);
      return session.client.getLimits();
    }

    case 'budget.get': {
      const session = await sessionFor(sender, request.tabId);
      return session.client.budget;
    }

    case 'scan.run': {
      const session = await sessionFor(sender, request.tabId);
      const settings = await loadSettings();
      const outcome = await advanceScan(
        request.analyzer,
        {
          client: session.client,
          orgId: session.context.orgId,
          lightningHost: session.context.lightningHost,
          includeManaged: settings.includeManaged,
          orgNamespace: session.context.orgNamespace,
          detailBudget: settings.detailBudget,
          // Placeholder: `ScanJob` replaces this with its own controller's
          // signal, which is what `scan.cancel` aborts.
          signal: new AbortController().signal,
        },
        // `force` only restarts a job on the first slice; later slices must
        // continue the job they started, not begin a new one each message.
        request.force && !isMidScan(session.context.orgId, request.analyzer),
      );

      if (outcome.status === 'running') {
        broadcastProgress(session.context.orgId, { type: 'progress', progress: outcome.progress });
        markMidScan(session.context.orgId, request.analyzer, true);
        return outcome;
      }

      markMidScan(session.context.orgId, request.analyzer, false);
      const { value: watermark, probed } = await freshWatermark(session, SCAN_WATERMARK_MAX_AGE_MS);
      // The probe is spent on this org's allowance like any analyzer call, so
      // it is booked against the area that paid it: the "API calls spent"
      // tile and the "used today" counter then agree.
      if (probed) outcome.result.apiCalls += 1;
      // Read the snapshot being replaced *before* the write, so the diff can be
      // handed back with the result and the panel does not have to pay a second
      // watermark probe to fetch it.
      const superseded = await cache.get(session.context.orgId, request.analyzer);
      // Last check before the write: a cancel that arrived during the awaits
      // above must still leave the previous snapshot in place.
      if (!commitScan(session.context.orgId, request.analyzer)) {
        throw new DOMException('Scan cancelled', 'AbortError');
      }
      await cache.put(outcome.result, watermark ?? undefined);
      const diff =
        superseded && comparable(superseded.result, outcome.result)
          ? diffAgainst(digestOf(superseded.result), outcome.result)
          : undefined;
      broadcastProgress(session.context.orgId, { type: 'done', result: outcome.result });
      return { ...outcome, diff };
    }

    case 'scan.cached': {
      const session = await sessionFor(sender, request.tabId);
      const entry = await cache.get(session.context.orgId, request.analyzer);
      if (!entry) return { result: null, staleness: { state: 'absent' } };
      // Judged by age alone, with no probe, so a reopened panel paints from
      // the local cache at once. The org-wide staleness probe follows in one
      // `scan.staleness` call for all areas; ten reads used to wait on it,
      // and on a slow org the whole panel sat blank until it answered.
      return {
        result: entry.result,
        staleness: cache.judge(entry.meta, null, Date.now()),
        diff: entry.previous && comparable(entry.previous, entry.result) ? diffAgainst(entry.previous, entry.result) : undefined,
      };
    }

    case 'scan.staleness': {
      const session = await sessionFor(sender, request.tabId);
      const entries = await cache.listMeta(session.context.orgId);
      if (entries.length === 0) return {};
      // One probe for the org (cached for a few minutes, deduplicated in
      // flight), then every cached area judged against it.
      const watermark = await cachedWatermark(session);
      const now = Date.now();
      const verdicts: Partial<Record<AnalyzerId, StalenessVerdict>> = {};
      for (const meta of entries) verdicts[meta.analyzer] = cache.judge(meta, watermark, now);
      return verdicts;
    }

    case 'scan.cancel': {
      const session = await sessionFor(sender, request.tabId);
      markMidScan(session.context.orgId, request.analyzer, false);
      return { cancelled: cancelScan(session.context.orgId, request.analyzer) };
    }

    case 'cache.status': {
      const session = await sessionFor(sender, request.tabId);
      const entries = await cache.listMeta(session.context.orgId);
      const usage = await cache.estimateUsage();
      return {
        entries,
        totalBytes: entries.reduce((sum, e) => sum + e.bytes, 0),
        quotaBytes: usage.quota,
      };
    }

    case 'cache.clear': {
      const session = await sessionFor(sender, request.tabId);
      return { cleared: await cache.clear(session.context.orgId, request.analyzer) };
    }

    case 'meta.build':
      // No org, no session: this must answer even when nothing else can.
      return { build: __ORGTRIAGE_BUILD__, analyzers: Object.keys(ANALYZERS) };

    case 'diag.selfTest':
      return runSelfTest(sender, request.tabId);

    case 'focus.set': {
      // Report page only, like `report.data`: the report is the one extension
      // page that opens Salesforce tabs on the user's behalf.
      if (!sender.url?.startsWith(chrome.runtime.getURL('report.html'))) {
        throw new AuthError('FORBIDDEN', 'Only the report page can set the sidebar focus.', 'Open the report from the sidebar.');
      }
      const analyzer = String(request.analyzer);
      const findingId = String(request.findingId);
      if (!(analyzer in ANALYZERS) || !/^[a-z0-9.#-]{1,80}$/i.test(findingId)) return { stored: false };
      try {
        await chrome.storage.session.set({
          [FOCUS_KEY]: {
            orgId: request.orgId.replace(/[^A-Za-z0-9]/g, ''),
            analyzer,
            findingId,
            setAt: Date.now(),
          },
        });
        return { stored: true };
      } catch {
        return { stored: false };
      }
    }

    case 'focus.nudge':
      // Addressed to the panels, which listen on the same channel; the worker
      // only has to not reject it.
      return { noted: true };

    case 'focus.take': {
      const session = await sessionFor(sender, request.tabId);
      try {
        const stored = (await chrome.storage.session.get(FOCUS_KEY))[FOCUS_KEY] as
          | { orgId: string; analyzer: string; findingId: string; setAt: number }
          | undefined;
        if (!stored) return null;
        if (Date.now() - stored.setAt > FOCUS_TTL_MS) {
          await chrome.storage.session.remove(FOCUS_KEY);
          return null;
        }
        // Another org's panel asking is not the consumer: leave the handoff
        // for the panel it was meant for.
        if (stored.orgId !== session.context.orgId) return null;
        await chrome.storage.session.remove(FOCUS_KEY);
        return { analyzer: stored.analyzer as AnalyzerId, findingId: stored.findingId };
      } catch {
        return null;
      }
    }

    case 'report.data': {
      // Cache only — no session, no API call. The org id is caller-supplied
      // because the report tab is not a Salesforce tab; see messages.ts. That
      // exception is for the report document alone: any other sender is a
      // Salesforce tab and goes through `sessionFor` like everything else.
      if (!sender.url?.startsWith(chrome.runtime.getURL('report.html'))) {
        throw new AuthError(
          'FORBIDDEN',
          'Cached results by org id can only be read by the report page.',
          'Open the report from the sidebar.',
        );
      }
      const orgId = request.orgId.replace(/[^A-Za-z0-9]/g, '');
      const entries = await cache.listMeta(orgId);
      const results: ScanResult[] = [];
      const diffs: AreaDiff[] = [];
      for (const entry of entries) {
        const hit = await cache.get(orgId, entry.analyzer);
        if (!hit) continue;
        results.push(hit.result);
        if (hit.previous && comparable(hit.previous, hit.result)) diffs.push(diffAgainst(hit.previous, hit.result));
      }
      return { results, entries, diffs };
    }


    default: {
      const exhaustive: never = request;
      throw new Error(`Unhandled request: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/** Tracks which analyzers have a slice in flight, so `force` restarts once only. */
const midScan = new Set<string>();
function isMidScan(orgId: string, analyzer: AnalyzerId): boolean {
  return midScan.has(`${orgId}:${analyzer}`);
}
function markMidScan(orgId: string, analyzer: AnalyzerId, active: boolean): void {
  const key = `${orgId}:${analyzer}`;
  if (active) midScan.add(key);
  else midScan.delete(key);
}

/**
 * Step-by-step connection diagnosis.
 *
 * Deliberately does *not* go through `sessionFor`, because the case worth
 * diagnosing is the one where `sessionFor` throws. Each step runs independently
 * and reports what it found, so a failure names the stage that broke rather
 * than collapsing into one opaque message.
 */
async function runSelfTest(
  sender: chrome.runtime.MessageSender,
  tabId?: number,
): Promise<ResponseData['diag.selfTest']> {
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  const record = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  // The panel is not inside a tab, so like every other request it names the
  // tab it sits beside; reading `sender.tab` alone failed this step for
  // every panel-run diagnosis.
  const tab = await tabFor(sender, tabId);
  const tabUrl = tab?.url;
  if (!tabUrl) {
    record('Salesforce tab', false, 'OrgTriage could not identify the Salesforce tab it is beside.');
    return { checks };
  }
  record('Salesforce tab', true, new URL(tabUrl).hostname);

  const cookieStoreId = (tab as { cookieStoreId?: string } | undefined)?.cookieStoreId;

  let host;
  try {
    host = await resolveOrgHost(tabUrl, cookieStoreId);
    record('Session cookie', true, `Org ${host.orgId15}`);
    record('Candidate API hosts', true, host.candidates.join(', '));
  } catch (err) {
    record('Session cookie', false, toErrorPayload(err).message);
    return { checks };
  }

  const client = new SalesforceClient(host);
  try {
    await client.resolveHost();
    record('Reachable API host', true, `${client.host.apiHost} · newest API v${client.apiVersion}`);
  } catch (err) {
    record('Reachable API host', false, toErrorPayload(err).message);
    return { checks };
  }

  const probe = async (name: string, fn: () => Promise<string>) => {
    try {
      record(name, true, await fn());
    } catch (err) {
      record(name, false, toErrorPayload(err).message);
    }
  };

  await probe('Authenticated query (Organization)', async () => {
    const org = await client.queryOne<{ Name: string; IsSandbox: boolean }>(
      'SELECT Name, IsSandbox FROM Organization',
    );
    return org ? `${org.Name}${org.IsSandbox ? ' (sandbox)' : ''}` : 'no row returned';
  });
  await probe('Tooling API', async () => {
    const { totalSize } = await client.query('SELECT Id FROM ApexClass', {
      tooling: true,
      maxRecords: 1,
    });
    return `${totalSize.toLocaleString()} Apex classes visible`;
  });
  await probe('Org limits (needs View Setup and Configuration)', async () => {
    const limits = await client.getLimits();
    const daily = limits.DailyApiRequests;
    return daily
      ? `${daily.Remaining.toLocaleString()} of ${daily.Max.toLocaleString()} API requests left in the rolling 24-hour window`
      : 'readable';
  });
  await probe('Analytics API', async () => {
    const { totalSize } = await client.query('SELECT Id FROM Report', { maxRecords: 1 });
    return `${totalSize.toLocaleString()} reports visible`;
  });
  await probe('Flow inventory (FlowDefinitionView, Flows analyzer)', async () => {
    // The Flows analyzer starts here and reports every rule as unchecked when
    // this object cannot be read. One row, same field list as the fallback.
    const { totalSize } = await client.query(
      'SELECT DurableId, ApiName, Label, ProcessType, IsActive, ActiveVersionId, LatestVersionId, NamespacePrefix FROM FlowDefinitionView',
      { maxRecords: 1 },
    );
    return `${totalSize.toLocaleString()} flow definitions visible`;
  });
  await probe('Setup Audit Trail (cache staleness probe)', async () => {
    const watermark = await probeWatermark(client);
    return watermark?.lastSetupChangeAt ?? 'not readable — staleness will use snapshot age only';
  });

  /* The Access analyzer's inputs, probed one row at a time.
     These are here rather than left to a scan because each is a *permission*
     question with a different answer per org, and finding out by running the
     whole analyzer costs a scan to learn something a single row can tell you.
     Every probe below is one API call and reads at most one record. */
  await probe('Permission sets (Access analyzer)', async () => {
    const { totalSize } = await client.query(
      'SELECT Id FROM PermissionSet',
      { maxRecords: 1 },
    );
    return `${totalSize.toLocaleString()} permission sets visible (includes one per profile)`;
  });
  await probe('Permission set groups (Access analyzer)', async () => {
    const { totalSize } = await client.query(
      'SELECT Id FROM PermissionSetGroupComponent',
      { maxRecords: 1 },
    );
    return totalSize === 0
      ? 'queryable; this org uses no permission set groups'
      : `${totalSize.toLocaleString()} group memberships, which will be expanded into member sets`;
  });
  await probe('Permission set assignments (Access analyzer)', async () => {
    const { totalSize } = await client.query(
      'SELECT Id FROM PermissionSetAssignment',
      { maxRecords: 1 },
    );
    // 2,000 rows per page: this is the one number that decides what an Access
    // scan costs, so it is worth knowing before running one.
    return `${totalSize.toLocaleString()} assignments — about ${Math.max(1, Math.ceil(totalSize / 2000))} API call(s) to read`;
  });

  return { checks };
}

function toErrorPayload(err: unknown): ErrorPayload {
  if (err instanceof SalesforceError) {
    return { code: err.code, message: err.message, hint: err.hint, status: err.status };
  }
  if (err instanceof AuthError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  const message = err instanceof Error ? err.message : String(err);
  return { code: 'UNEXPECTED', message };
}

chrome.runtime.onMessage.addListener(
  (request: Request, sender, sendResponse: (response: Response) => void) => {
    handle(request, sender)
      .then((data) => sendResponse({ ok: true, data } as Response))
      .catch((err) => sendResponse({ ok: false, error: toErrorPayload(err) }));
    // Literal true, not a truthy value: Chrome only keeps the channel open for
    // an async sendResponse when the listener returns exactly `true`.
    return true;
  },
);

/* -------------------------------------------------------------------------- */
/* Side panel                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The toolbar icon opens the side panel; Chrome closes it. The panel belongs
 * to the window and follows the active tab (see panel/tab.ts), and it is
 * switched off on tabs that are not Salesforce so it does not sit beside a
 * page it has nothing to say about.
 */
void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
  /* older Chrome without the behaviour API: the action still opens nothing, which the command covers */
});

// No window-wide panel. The panel exists per Salesforce tab and nowhere else:
// a window-wide one, once open, stayed on screen beside the remediation plan
// and every other tab even after that tab had been told "not here". With the
// default off, a tab gets a panel only from setPanelForTab below, and Chrome
// shows it only while that tab is in front.
void chrome.sidePanel.setOptions({ enabled: false }).catch(() => {
  /* no side panel API */
});

function isSalesforceTabUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && isAllowedApiHost(parsed.hostname);
  } catch {
    return false;
  }
}

/**
 * Whether the panel is switched on per tab, as last told to Chrome. Setting
 * the options again with the same values is not free: Chrome reloads the
 * panel document, which showed up as the panel restarting on every click of
 * a component link. So the call is made only when the answer changes.
 */
const panelEnabled = new Map<number, boolean>();

function setPanelForTab(tabId: number, url: string | undefined): void {
  const enabled = isSalesforceTabUrl(url);
  if (panelEnabled.get(tabId) === enabled) return;
  panelEnabled.set(tabId, enabled);
  void chrome.sidePanel.setOptions({ tabId, path: 'panel.html', enabled }).catch(() => {
    panelEnabled.delete(tabId);
  });
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url === undefined && info.status !== 'loading') return;
  setPanelForTab(tabId, tab.url ?? info.url);
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id !== undefined) setPanelForTab(tab.id, tab.url ?? tab.pendingUrl);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  panelEnabled.delete(tabId);
});

void chrome.tabs.query({}).then((tabs) => {
  for (const tab of tabs) if (tab.id !== undefined) setPanelForTab(tab.id, tab.url);
});

chrome.commands.onCommand.addListener((command) => {
  if (command !== 'toggle-panel') return;
  void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
    if (tab?.id === undefined) return;
    return chrome.sidePanel.open({ tabId: tab.id });
  });
});

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

// Signing out of Salesforce clears the sid cookie; drop cached sessions so the
// next request fails cleanly instead of retrying a dead token.
chrome.cookies.onChanged.addListener((change) => {
  if (change.cookie.name !== 'sid') return;
  if (change.removed) {
    clearAllSessions();
    orgSessions.clear();
    void clearCachedContexts();
  }
});

chrome.runtime.onInstalled.addListener(() => {
  clearAllSessions();
});
