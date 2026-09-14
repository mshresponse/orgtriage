/**
 * Panel state.
 *
 * A deliberately small observable store rather than a framework: the panel has
 * one org, five tabs, and four scan slots. Lit components subscribe in
 * `connectedCallback` and request an update on change.
 */

import { send, sendOrThrow, SCAN_PORT, type ErrorPayload, type PortBind, type ScanEvent } from '@/shared/messages';
import { whenBoundTabSettled, boundTab } from './tab';
import type { AreaDiff } from '@/shared/diff';
import type { Priority } from '@/shared/plan';
import {
  DEFAULT_PANEL_PREFS,
  type AnalyzerId,
  type ApiBudget,
  type CacheEntryMeta,
  type OrgContext,
  type PanelPrefs,
  type ScanProgress,
  type ScanResult,
  type StalenessVerdict,
} from '@/shared/types';

/**
 * The panel's three top-level views.
 *
 * It used to be one tab per area. That worked at five and broke at ten: the
 * narrowest dock is 25% of a laptop viewport, around 360px, and ten tabs there
 * are unreadable however they wrap. More to the point, a tab per analyzer asks
 * the reader to know which analyzer owns their problem before they can look at
 * it — which is backwards. `work` answers "what should I do", `areas` answers
 * "what was checked", and an area's findings are a drill-down inside `areas`
 * rather than a destination of their own.
 */
export type TabId = 'overview' | 'work' | 'areas';

/**
 * `typicalCalls` is what one scan of the area costs in API calls, with the
 * default detail budget of 300 components.
 *
 * The numbers are derived, not guessed. Each analyzer runs a fixed handful of
 * SOQL queries, then a detail phase that fetches metadata one component at a
 * time — flow metadata, FlexiPage metadata, report and layout describes. That
 * phase goes through `/composite` at 25 subrequests per API call, so a full
 * 300-component detail budget is twelve calls however large the org is. The
 * ranges below are (small org … detail budget saturated).
 *
 * They exist so the cost of a scan is visible before it is spent, rather than
 * only reported afterwards. For context: a Developer Edition org gets 15,000
 * API calls a day and most production orgs 100,000 or more, so scanning
 * everything is well under one percent of a day's allowance. The per-area
 * opt-out exists anyway, because it is the admin's allowance to spend.
 */
export const ANALYZERS: {
  id: AnalyzerId;
  label: string;
  blurb: string;
  typicalCalls: [number, number];
  /** What makes this area cost what it does, in one clause. */
  costNote: string;
}[] = [
  {
    id: 'apex',
    label: 'Apex',
    blurb: 'Classes and triggers: coverage, API currency, and trigger topology.',
    typicalCalls: [8, 25],
    costNote: 'inventories and coverage, plus symbol tables batched 25 to a call',
  },
  {
    id: 'flows',
    label: 'Flows',
    blurb: 'Flows, Process Builder and workflow rules: bulkification, fault paths, and version debt.',
    typicalCalls: [7, 60],
    costNote: 'inventories, plus flow and workflow-rule metadata 8 to a call up to the detail budgets — 300 flows is about 38 calls',
  },
  {
    id: 'reports',
    label: 'Reports',
    blurb: 'Reports and dashboards: abandonment, unfiltered scans, and broken sources.',
    typicalCalls: [10, 330],
    costNote: 'one describe per report up to the detail budget (300), one per dashboard, plus one field catalogue per object filtered on — the most expensive area',
  },
  {
    id: 'layouts',
    label: 'Layouts',
    blurb: 'Page layouts, Lightning pages, and SLDS conformance.',
    typicalCalls: [12, 60],
    costNote: 'layout describes 10 objects to a call, Lightning page metadata 10 pages to a call, up to the detail budget, plus stylesheet reads',
  },
  {
    id: 'ops',
    label: 'Ops',
    blurb: 'Failed and scheduled jobs, flow interviews, stuck approvals, release updates due, and buttons that will break.',
    typicalCalls: [9, 17],
    costNote: 'a fixed set of queries plus user lookups 200 to a call; no per-component fetches',
  },
  {
    id: 'access',
    label: 'Access',
    blurb: 'Who holds Modify All Data and the other permissions that ignore the sharing model.',
    typicalCalls: [8, 18],
    costNote: 'permission sets, groups, assignments, users, profile flags and licence counts, paged at 2,000 rows — cost scales with users and assignments',
  },
  {
    id: 'limits',
    label: 'Limits',
    blurb:
      'Storage and debug-log headroom, the governor limits nearest their ceiling, and where the storage went.',
    typicalCalls: [5, 6],
    costNote: 'five aggregate reads, whatever the size of the org — the cheapest area here',
  },
  {
    id: 'security',
    label: 'Security',
    blurb: 'Salesforce’s own Health Check risks: settings that differ from its published baseline.',
    typicalCalls: [3, 3],
    costNote: 'the Health Check API answers in three reads',
  },
  {
    id: 'fields',
    label: 'Fields',
    blurb: 'Custom fields nothing in the org’s metadata references, and fields with no description.',
    typicalCalls: [15, 130],
    costNote: 'one query per object (up to 40), Apex bodies, then flow and validation-rule metadata 8 to a call, each capped at 400 bodies',
  },
  {
    id: 'apexlint',
    label: 'Code quality',
    blurb: 'Source-level checks over the deployed Apex: queries in loops, sharing, swallowed errors.',
    typicalCalls: [4, 12],
    costNote: 'class and trigger bodies, paged at 2,000 rows',
  },
];

export interface AnalyzerSlot {
  result: ScanResult | null;
  /** What changed since the snapshot this one replaced, when there was one. */
  diff: AreaDiff | null;
  staleness: StalenessVerdict;
  loading: boolean;
  /** A cached snapshot is being read; distinct from a scan so a Run click is not swallowed. */
  reading: boolean;
  progress: ScanProgress | null;
  error: ErrorPayload | null;
}

function emptySlot(): AnalyzerSlot {
  return { result: null, diff: null, staleness: { state: 'absent' }, loading: false, reading: false, progress: null, error: null };
}

export interface PanelState {
  /** Null until the worker resolves the org; `error` explains why if it stays null. */
  org: OrgContext | null;
  orgError: ErrorPayload | null;
  connecting: boolean;
  prefs: PanelPrefs;
  tab: TabId;
  /** The area open inside the Areas tab, or null for the grid. */
  focusArea: AnalyzerId | null;
  /** Filters on the Work list. Not persisted — a filter is a moment, not a setting. */
  workFilter: { priority: Priority | null; area: AnalyzerId | null; role: string | null };
  slots: Record<AnalyzerId, AnalyzerSlot>;
  budget: ApiBudget | null;
  cacheEntries: CacheEntryMeta[];
  /** False until the first cache status arrives; the footer says "Reading…" rather than "No local snapshot" meanwhile. */
  cacheKnown: boolean;
  cacheBytes: number;
  /** Result of the last connection self-test, shown when connecting fails. */
  diagnostics: { name: string; ok: boolean; detail: string }[] | null;
  diagnosing: boolean;
  /** The page refused to narrow, so the panel is overlaying despite the pref. */
  /**
   * Build string reported by the service worker, or null before it answers.
   * Compared with this bundle's own so a stale worker is named rather than
   * showing up as an inexplicable error from a feature the panel can see.
   */
  workerBuild: string | null;
  /** Which findings the user has expanded, per analyzer. Survives a page reload. */
  openFindings: Record<string, string[]>;
  /** A finding to scroll into view once its area has rendered; set by a deep link. */
  pendingScroll: string | null;
  /**
   * A cache clear is in flight.
   *
   * Worth a flag of its own: every message goes through the worker's
   * `sessionFor`, which on a cold service worker re-resolves the org first —
   * several API round trips — so a clear can take ten seconds or more with no
   * visible sign that the click registered.
   */
  clearing: boolean;
}

/**
 * The tab and the expanded findings, persisted.
 *
 * Clicking a component navigates the Salesforce tab, and when Lightning takes
 * that as a full page load the panel iframe is destroyed and rebuilt. Without
 * this the user came back to the Overview tab with everything collapsed —
 * having just clicked something *in* a finding they were reading.
 */
const VIEW_KEY = 'panelView';

interface StoredView {
  tab: TabId;
  focusArea: AnalyzerId | null;
  openFindings: Record<string, string[]>;
}

type Listener = () => void;

class Store {
  state: PanelState = {
    org: null,
    orgError: null,
    connecting: true,
    prefs: { ...DEFAULT_PANEL_PREFS },
    tab: 'overview',
    focusArea: null,
    workFilter: { priority: null, area: null, role: null },
    slots: {
      apex: emptySlot(),
      flows: emptySlot(),
      reports: emptySlot(),
      layouts: emptySlot(),
      ops: emptySlot(),
      access: emptySlot(),
      limits: emptySlot(),
      security: emptySlot(),
      fields: emptySlot(),
      apexlint: emptySlot(),
    },
    budget: null,
    cacheEntries: [],
    cacheKnown: false,
    cacheBytes: 0,
    diagnostics: null,
    diagnosing: false,
    workerBuild: null,
    openFindings: {},
    pendingScroll: null,
    clearing: false,
  };

  private listeners = new Set<Listener>();
  private port: chrome.runtime.Port | null = null;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  patch(partial: Partial<PanelState>): void {
    this.state = { ...this.state, ...partial };
    this.emit();
  }

  patchSlot(analyzer: AnalyzerId, partial: Partial<AnalyzerSlot>): void {
    this.state = {
      ...this.state,
      slots: {
        ...this.state.slots,
        [analyzer]: { ...this.state.slots[analyzer], ...partial },
      },
    };
    this.emit();
  }

  /* -------------------------------------------------------------------- */

  /** First contact. Shows the connecting state, because there is nothing else
   *  to show. */
  async connect(): Promise<void> {
    this.patch({ connecting: true, orgError: null });
    await this.resolveOrg();
  }

  /**
   * Re-resolve the org after the tab moved to a different Salesforce origin.
   *
   * Unlike {@link connect} this never sets `connecting`, because doing so
   * unmounts the analyzer view — losing the filter, the scroll position and
   * every expanded finding. It also skips the cache re-read when the org id
   * comes back unchanged, which is the common case (Lightning and Setup are
   * different origins for the same org), so switching between them costs
   * nothing beyond the one `org.context` call.
   */
  async reconnect(): Promise<void> {
    const previous = this.state.org?.orgId ?? null;
    await this.resolveOrg({ keepCacheIfSameOrg: previous });
  }

  private async resolveOrg(opts: { keepCacheIfSameOrg?: string | null } = {}): Promise<void> {
    await whenBoundTabSettled();
    const res = await send({ type: 'org.context' });
    if (!res.ok) {
      this.patch({ org: null, orgError: res.error, connecting: false });
      return;
    }
    const sameOrg =
      opts.keepCacheIfSameOrg != null && opts.keepCacheIfSameOrg === res.data.orgId;
    this.patch({ org: res.data, orgError: null, connecting: false });
    if (sameOrg) {
      await this.takeFocus();
      return;
    }
    await Promise.all([this.loadCachedAll(), this.refreshCacheStatus()]);
    // After the cache reads, not alongside them: the budget comes from the
    // headers of authenticated calls, and with the org context cached the
    // staleness probes are the first such calls this worker makes.
    await this.refreshBudget();
    await this.takeFocus();
  }

  /**
   * A tab opened from the report's "Open" link carries a finding to land on.
   * The worker hands it over once, for this org only; anything else leaves the
   * restored view alone.
   */
  async takeFocus(): Promise<void> {
    if (!this.state.org) return;
    const res = await send({ type: 'focus.take' });
    if (!res.ok || !res.data) return;
    this.focusFinding(res.data.analyzer, res.data.findingId);
  }

  /** Open one area on one finding, with its steps expanded, and scroll to it. */
  focusFinding(analyzer: AnalyzerId, findingId: string): void {
    const current = new Set(this.state.openFindings[analyzer] ?? []);
    current.add(findingId);
    current.add(`${findingId}#steps`);
    this.patch({
      tab: 'areas',
      focusArea: analyzer,
      openFindings: { ...this.state.openFindings, [analyzer]: [...current] },
      pendingScroll: findingId,
    });
    void this.saveView();
  }

  /** Step-by-step connection diagnosis. Safe to run when nothing else works. */
  async runDiagnostics(): Promise<void> {
    this.patch({ diagnosing: true });
    const res = await send({ type: 'diag.selfTest' });
    this.patch({
      diagnosing: false,
      diagnostics: res.ok
        ? res.data.checks
        : [{ name: 'Diagnostics', ok: false, detail: res.error.message }],
    });
  }

  async prefsLoad(): Promise<void> {
    const res = await send({ type: 'prefs.get' });
    if (res.ok) this.patch({ prefs: res.data });
  }

  async prefsSet(patch: Partial<PanelPrefs>): Promise<void> {
    const res = await send({ type: 'prefs.set', patch });
    if (res.ok) this.patch({ prefs: res.data });
  }

  setTab(tab: TabId): void {
    this.patch({ tab });
    void this.saveView();
  }

  /**
   * Open one area's findings.
   *
   * Switching to the Areas tab as well as setting the focus, so that a link
   * from the Overview's work queue lands on the findings rather than on the
   * grid with an invisible selection.
   */
  setWorkFilter(patch: Partial<PanelState['workFilter']>): void {
    this.patch({ workFilter: { ...this.state.workFilter, ...patch } });
  }

  openArea(analyzer: AnalyzerId | null): void {
    this.patch({ tab: 'areas', focusArea: analyzer });
    void this.saveView();
  }

  /** Expand or collapse one finding, remembering it across a page reload. */
  setFindingOpen(analyzer: AnalyzerId, findingId: string, open: boolean): void {
    const current = new Set(this.state.openFindings[analyzer] ?? []);
    if (open) current.add(findingId);
    else current.delete(findingId);
    this.patch({ openFindings: { ...this.state.openFindings, [analyzer]: [...current] } });
    void this.saveView();
  }

  isFindingOpen(analyzer: AnalyzerId, findingId: string): boolean {
    return (this.state.openFindings[analyzer] ?? []).includes(findingId);
  }

  async viewLoad(): Promise<void> {
    try {
      const stored = await chrome.storage.local.get(VIEW_KEY);
      const view = stored[VIEW_KEY] as Partial<StoredView> | undefined;
      if (!view) return;
      this.patch({
        tab: view.tab ?? this.state.tab,
        focusArea: view.focusArea ?? this.state.focusArea,
        openFindings: view.openFindings ?? {},
      });
    } catch {
      /* the view is a convenience; a failure here must not stop the panel */
    }
  }

  private async saveView(): Promise<void> {
    try {
      await chrome.storage.local.set({
        [VIEW_KEY]: {
          tab: this.state.tab,
          focusArea: this.state.focusArea,
          openFindings: this.state.openFindings,
        } satisfies StoredView,
      });
    } catch {
      /* as above */
    }
  }

  /**
   * Ask the worker which build it is running. Chrome can keep an old service
   * worker across an extension reload, and the symptom is a feature the panel
   * knows about failing in the worker for no visible reason.
   */
  async checkBuild(): Promise<void> {
    const res = await send({ type: 'meta.build' });
    this.patch({ workerBuild: res.ok ? res.data.build : null });
  }

  /** Read every analyzer's cached snapshot. Never triggers a scan. */
  async loadCachedAll(): Promise<void> {
    const failed = (await Promise.all(ANALYZERS.map((a) => this.loadCached(a.id)))).filter(
      (ok): ok is false => ok === false,
    );
    // The cards are painted from local cache by now; the one org-wide probe
    // refines their staleness a moment later rather than holding them back.
    void this.refreshStaleness();
    // A cache read that fails right after a page load is usually a race with
    // the tab still settling (a Setup-domain redirect, a session cookie being
    // written); one retry a moment later covers that, and a failure that
    // survives it is shown on the area rather than passed off as "no snapshot".
    if (failed.length > 0) {
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await Promise.all(ANALYZERS.filter((a) => !this.state.slots[a.id].result).map((a) => this.loadCached(a.id)));
    }
  }

  /** One probe for the org, then every cached area's verdict updated in place. */
  async refreshStaleness(): Promise<void> {
    const res = await send({ type: 'scan.staleness' });
    if (!res.ok) return;
    for (const [analyzer, staleness] of Object.entries(res.data) as [AnalyzerId, StalenessVerdict][]) {
      if (this.state.slots[analyzer]?.result) this.patchSlot(analyzer, { staleness });
    }
  }

  /** Read one area's snapshot; returns false when the worker refused so the caller can retry. */
  async loadCached(analyzer: AnalyzerId): Promise<boolean> {
    // A local IndexedDB read, no API call. Marked as reading so the area
    // shows a skeleton rather than "no snapshot yet" for the instant it takes.
    this.patchSlot(analyzer, { reading: true });
    const res = await send({ type: 'scan.cached', analyzer });
    if (res.ok) {
      this.patchSlot(analyzer, {
        result: res.data.result,
        diff: res.data.diff ?? null,
        staleness: res.data.staleness,
        error: null,
        reading: false,
      });
      return true;
    }
    this.patchSlot(analyzer, { reading: false, ...(this.state.slots[analyzer].result ? {} : { error: res.error }) });
    return false;
  }

  /**
   * Run a scan to completion.
   *
   * The worker advances the scan one time-boxed slice per message so it never
   * exceeds the service worker's five-minute-per-event ceiling, which means the
   * panel drives the loop. `force` is always true: there is no implicit refresh
   * path anywhere in this app — a scan happens because someone asked for one.
   */
  /** Areas whose running scan the user asked to stop; cleared when the loop exits. */
  private readonly cancelRequested = new Set<AnalyzerId>();
  private cancelAllRequested = false;

  /**
   * Stop a running scan. The worker aborts the job and the loop below stops
   * asking for slices; the area keeps the snapshot it had before. Nothing is
   * refunded: calls already made were made.
   */
  async cancelScan(analyzer: AnalyzerId): Promise<void> {
    if (!this.state.slots[analyzer].loading) return;
    this.cancelRequested.add(analyzer);
    await send({ type: 'scan.cancel', analyzer });
  }

  /** Stop "Scan all": the area in progress is cancelled and no further area starts. */
  async cancelScanAll(): Promise<void> {
    this.cancelAllRequested = true;
    const running = ANALYZERS.find((a) => this.state.slots[a.id].loading);
    if (running) await this.cancelScan(running.id);
  }

  async scan(analyzer: AnalyzerId): Promise<void> {
    if (this.state.slots[analyzer].loading) return;
    this.patchSlot(analyzer, { loading: true, error: null, progress: null });
    this.cancelRequested.delete(analyzer);
    this.ensurePort();

    const stopped = () => {
      // Keep the previous result and its staleness; only the in-flight state
      // clears. The worker refuses to write a cancelled scan's snapshot, so
      // the cache holds the previous one; re-read it rather than trust what
      // this slot had, in case the cancel arrived after the write completed.
      this.patchSlot(analyzer, { loading: false, progress: null, error: null });
      this.cancelRequested.delete(analyzer);
      void this.loadCached(analyzer);
    };

    let force = true;
    // Bounded so a worker bug cannot spin forever. At 45s per slice this allows
    // roughly an hour of scanning, far beyond any real org.
    for (let slice = 0; slice < 80; slice++) {
      // A cancel that landed between slices: the worker has already dropped
      // the job, and asking for another slice would start a fresh scan.
      if (this.cancelRequested.has(analyzer)) return stopped();
      const res = await send({ type: 'scan.run', analyzer, force });
      force = false;

      // A cancel that landed mid-slice surfaces as the worker's abort error;
      // that is the stop the user asked for, not a failure to report.
      if (this.cancelRequested.has(analyzer)) return stopped();
      if (!res.ok) {
        this.patchSlot(analyzer, { loading: false, progress: null, error: res.error });
        return;
      }
      if (res.data.status === 'done') {
        this.patchSlot(analyzer, {
          result: res.data.result,
          diff: res.data.diff ?? null,
          staleness: { state: 'fresh', cachedAt: res.data.result.completedAt },
          loading: false,
          progress: null,
        });
        await Promise.all([this.refreshBudget(), this.refreshCacheStatus()]);
        return;
      }
      this.patchSlot(analyzer, { progress: res.data.progress });
    }

    this.patchSlot(analyzer, {
      loading: false,
      progress: null,
      error: {
        code: 'SCAN_TOO_LONG',
        message: 'The scan did not finish in a reasonable time and was stopped.',
        hint: 'Lower the detail budget in options, or scan one area at a time.',
      },
    });
  }

  async scanAll(): Promise<void> {
    // Sequential on purpose: four concurrent metadata sweeps is exactly the
    // pattern that trips an org's concurrent-request ceiling.
    const skip = new Set(this.state.prefs.skipInScanAll ?? []);
    this.cancelAllRequested = false;
    for (const analyzer of ANALYZERS) {
      if (this.cancelAllRequested) break;
      if (skip.has(analyzer.id)) continue;
      await this.scan(analyzer.id);
    }
    this.cancelAllRequested = false;
  }

  /** Include or exclude one area from "Scan all areas", and remember it. */
  async setScanAllIncludes(analyzer: AnalyzerId, included: boolean): Promise<void> {
    const current = new Set(this.state.prefs.skipInScanAll ?? []);
    if (included) current.delete(analyzer);
    else current.add(analyzer);
    await this.prefsSet({ skipInScanAll: [...current] });
  }

  async clearCache(analyzer?: AnalyzerId): Promise<void> {
    if (this.state.clearing) return;
    this.patch({ clearing: true });
    try {
      await send(analyzer ? { type: 'cache.clear', analyzer } : { type: 'cache.clear' });
    } finally {
      this.patch({ clearing: false });
    }
    if (analyzer) {
      this.patchSlot(analyzer, { result: null, staleness: { state: 'absent' } });
    } else {
      for (const a of ANALYZERS) {
        this.patchSlot(a.id, { result: null, staleness: { state: 'absent' } });
      }
    }
    await this.refreshCacheStatus();
  }

  async refreshBudget(): Promise<void> {
    const res = await send({ type: 'budget.get' });
    if (res.ok) this.patch({ budget: res.data });
  }

  async refreshCacheStatus(): Promise<void> {
    const res = await send({ type: 'cache.status' });
    if (res.ok) this.patch({ cacheEntries: res.data.entries, cacheBytes: res.data.totalBytes, cacheKnown: true });
  }

  /** Long-lived port so scan progress can stream while a scan runs. */
  private ensurePort(): void {
    if (this.port) return;
    try {
      this.port = chrome.runtime.connect({ name: SCAN_PORT });
      // The port has no tab either; say which tab's org it should follow.
      const tabId = boundTab();
      if (tabId !== null) this.port.postMessage({ type: 'bind', tabId } satisfies PortBind);
      this.port.onMessage.addListener((message: ScanEvent) => {
        if (message.type === 'progress') {
          this.patchSlot(message.progress.analyzer, { progress: message.progress });
        } else if (message.type === 'error') {
          this.patchSlot(message.analyzer, { error: message.error, loading: false });
        }
      });
      this.port.onDisconnect.addListener(() => {
        this.port = null;
      });
    } catch {
      // Progress streaming is a nicety; scans still complete without it.
      this.port = null;
    }
  }
}

export const store = new Store();

/** Convenience for views that need the worker directly. */
export { send, sendOrThrow };
