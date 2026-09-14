/**
 * Message contracts.
 *
 * Two channels, deliberately separate:
 *
 *  - `chrome.runtime` messages between the panel/content script and the service
 *    worker. Only the service worker holds credentials; these messages carry
 *    *results*, never tokens, and never a caller-supplied org host (the worker
 *    derives the org from the sender tab so a compromised panel cannot redirect
 *    queries at another org).
 *
 *  - `window.postMessage` between the content script and the panel iframe, for
 *    frame geometry only. Both ends verify `event.origin`.
 */

import type { AreaDiff } from './diff';
import type {
  AnalyzerId,
  ApiBudget,
  CacheEntryMeta,
  OrgContext,
  PanelPrefs,
  ScanProgress,
  ScanResult,
  StalenessVerdict,
} from './types';

/* -------------------------------------------------------------------------- */
/* chrome.runtime — request/response                                          */
/* -------------------------------------------------------------------------- */

export type Request = TabScoped &
  (
  | { type: 'org.context' }
  | { type: 'org.limits' }
  | { type: 'scan.run'; analyzer: AnalyzerId; force: boolean }
  | { type: 'scan.cached'; analyzer: AnalyzerId }
  /**
   * Staleness verdicts for every cached area of the tab's org, after the one
   * org-wide probe. `scan.cached` judges by snapshot age alone so the panel can
   * paint at once; this refines those verdicts a moment later.
   */
  | { type: 'scan.staleness' }
  | { type: 'scan.cancel'; analyzer: AnalyzerId }
  | { type: 'cache.status' }
  | { type: 'cache.clear'; analyzer?: AnalyzerId }
  | { type: 'budget.get' }
  | { type: 'prefs.get' }
  | { type: 'prefs.set'; patch: Partial<PanelPrefs> }
  | { type: 'diag.selfTest' }
  /**
   * The build string compiled into the service worker.
   *
   * Chrome can keep an old service worker alive across an extension reload, so
   * the panel and the worker are not always the same build — the symptom is a
   * feature the panel knows about failing in the worker with a puzzling error
   * ("Unknown analyzer: ops"). The panel compares this with its own compiled
   * constant and says plainly what happened.
   */
  | { type: 'meta.build' }
  /**
   * Every cached snapshot for one org, for the remediation report page. The
   * report opens in its own tab at the extension origin, so there is no
   * Salesforce tab to derive the org from; the caller names it instead. That
   * is acceptable here and nowhere else: the cache holds rule verdicts and
   * component names, never credentials, and the worker makes no API call to
   * serve it.
   */
  | { type: 'report.data'; orgId: string }
  /**
   * Set by the report page just before it opens a Salesforce tab from an
   * "Open" link: the finding that tab's sidebar should land on. Report page
   * only, like `report.data`, and the worker makes no API call to serve it.
   */
  | { type: 'focus.set'; orgId: string; analyzer: AnalyzerId; findingId: string }
  /** Taken once by a panel as it connects; answered only for the sender's own org. */
  | { type: 'focus.take' }
  /** Report page → every panel: a focus was stored, take it if it is yours. */
  | { type: 'focus.nudge' }
  );

/** Attached by the panel to every request; see {@link setDefaultTabId}. */
export interface TabScoped {
  tabId?: number;
}

/**
 * A scan advances one slice per message. The service worker is killed after
 * five minutes on a single event, so the caller keeps sending `scan.run` until
 * it receives `status: 'done'`.
 */
export type ScanStep =
  | { status: 'running'; progress: ScanProgress }
  /**
   * `diff` is attached by the worker after the result is cached, not by the
   * analyzer: the comparison is against the snapshot this scan replaced, which
   * only the cache knows about. Absent on the first scan of an area.
   */
  | { status: 'done'; result: ScanResult; diff?: AreaDiff };

export type ResponseData = {
  'org.context': OrgContext;
  'org.limits': Record<string, { Max: number; Remaining: number }>;
  'scan.run': ScanStep;
  'scan.cached': { result: ScanResult | null; staleness: StalenessVerdict; diff?: AreaDiff };
  'scan.staleness': Partial<Record<AnalyzerId, StalenessVerdict>>;
  'scan.cancel': { cancelled: boolean };
  'cache.status': { entries: CacheEntryMeta[]; totalBytes: number; quotaBytes: number | null };
  'cache.clear': { cleared: number };
  'budget.get': ApiBudget;
  'prefs.get': PanelPrefs;
  'prefs.set': PanelPrefs;
  'diag.selfTest': SelfTestReport;
  'meta.build': { build: string; analyzers: string[] };
  'report.data': { results: ScanResult[]; entries: CacheEntryMeta[]; diffs: AreaDiff[] };
  'focus.set': { stored: boolean };
  'focus.take': { analyzer: AnalyzerId; findingId: string } | null;
  'focus.nudge': { noted: true };
};

export type Response<K extends Request['type'] = Request['type']> =
  | { ok: true; data: ResponseData[K] }
  | { ok: false; error: ErrorPayload };

export interface ErrorPayload {
  /** Stable machine code, e.g. `NO_SESSION`, `INSUFFICIENT_ACCESS`, `THROTTLED`. */
  code: string;
  /** Message safe to show a user. Never contains request headers or tokens. */
  message: string;
  /** What the user can do about it. */
  hint?: string;
  /** HTTP status when the failure came from Salesforce. */
  status?: number;
}

/** Fired by the worker during a scan; the panel subscribes via a long-lived port. */
export type ScanEvent =
  | { type: 'progress'; progress: ScanProgress }
  | { type: 'done'; result: ScanResult }
  | { type: 'error'; analyzer: AnalyzerId; error: ErrorPayload };

export const SCAN_PORT = 'orgtriage.scan';

export interface SelfTestReport {
  checks: { name: string; ok: boolean; detail: string }[];
}

/** Typed `chrome.runtime.sendMessage` wrapper used by both the panel and content. */
export async function send<R extends Request>(
  request: R,
): Promise<Response<R['type']>> {
  try {
    const scoped = request.tabId === undefined && defaultTabId !== null ? { ...request, tabId: defaultTabId } : request;
    return (await chrome.runtime.sendMessage(scoped)) as Response<R['type']>;
  } catch (err) {
    // The worker was replaced mid-flight (extension reload/update) or the
    // context is gone. Surface it as a normal error rather than throwing.
    return {
      ok: false,
      error: {
        code: 'DISCONNECTED',
        message: 'Lost the connection to the OrgTriage background service.',
        hint: 'Reload the Salesforce tab.',
        detail: String(err),
      } as ErrorPayload & { detail: string },
    };
  }
}

/** Unwraps a response or throws a typed error — for call sites that prefer try/catch. */
export async function sendOrThrow<R extends Request>(
  request: R,
): Promise<ResponseData[R['type']]> {
  const res = await send(request);
  if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
  return res.data as ResponseData[R['type']];
}

/* -------------------------------------------------------------------------- */
/* Tab binding                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The side panel is not a tab, so a message from it carries no `sender.tab`.
 * The panel names the Salesforce tab it is showing beside, and the worker
 * reads that tab's URL from the browser (`chrome.tabs.get`), never from the
 * message — the panel can only point at a tab the user actually has open.
 */
let defaultTabId: number | null = null;

export function setDefaultTabId(tabId: number | null): void {
  defaultTabId = tabId;
}

/** First message on the scan port: which tab's org the port belongs to. */
export interface PortBind {
  type: 'bind';
  tabId: number;
}
