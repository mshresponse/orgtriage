/**
 * Shared domain types.
 *
 * Nothing in this file may describe a credential. Session ids, cookies, and
 * access tokens exist only inside the service worker's `auth` module and are
 * never modelled in a type that crosses a message boundary — if a token can't
 * be named in a transferable shape, it can't be accidentally transferred.
 */

/* -------------------------------------------------------------------------- */
/* Org identity                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The connection facts the panel is allowed to know. Deliberately free of any
 * credential material: the panel can render who it's connected to, but cannot
 * itself call Salesforce.
 */
export interface OrgContext {
  /** 18-character org id. */
  orgId: string;
  /** e.g. `acme.my.salesforce.com` — the API host, not the Lightning host. */
  apiHost: string;
  /** e.g. `acme.lightning.force.com` — where Setup links are built from. */
  lightningHost: string;
  /** Org display name from the Organization sObject. */
  orgName: string;
  /** `Production`, `Developer Edition`, `Sandbox`, … */
  instanceName: string;
  organizationType: string;
  isSandbox: boolean;
  /** The API version this session negotiated, e.g. `"64.0"`. */
  apiVersion: string;
  /** Current user's display name and id — for "who am I acting as". */
  userId: string;
  userName: string;
  /** True when the user lacks a permission the analyzers need. */
  limitedAccess: boolean;
  /**
   * `Organization.NamespacePrefix` — null for almost every org, set in a
   * packaging org or one using namespaced 2GP. Components carrying it are the
   * org's own work, not an installed package's; without it those orgs examine
   * zero components. See `isManaged` in the analyzer framework.
   */
  orgNamespace: string | null;
}

/* -------------------------------------------------------------------------- */
/* Findings                                                                   */
/* -------------------------------------------------------------------------- */

export type Severity = 'critical' | 'warning' | 'info' | 'success';

export type AnalyzerId =
  | 'apex'
  | 'reports'
  | 'flows'
  | 'layouts'
  | 'ops'
  | 'access'
  | 'limits'
  | 'security'
  | 'fields'
  | 'apexlint';

/**
 * One diagnosed problem class (e.g. "triggers with no test coverage"), with the
 * concrete components that exhibit it.
 */
export interface Finding {
  /** Stable rule id, e.g. `apex.no-coverage`. Used for muting and scoring. */
  id: string;
  analyzer: AnalyzerId;
  severity: Severity;
  /** One-line statement of the problem, already counting the instances. */
  title: string;
  /** Why this matters — the admin-facing rationale. */
  rationale: string;
  /** What to do about it. */
  remediation: string;
  /** Documentation backing the rule, if any: Salesforce's, or the linter catalogue the rule came from. */
  docUrl?: string;
  /** Weight this rule contributes to the domain score when it fires. */
  weight: number;
  items: FindingItem[];
  /** Set when the rule could not be evaluated (missing permission, API error). */
  inconclusive?: { reason: string };
}

export interface FindingItem {
  /** Salesforce component id when there is one. */
  id?: string;
  /** API name / DeveloperName. */
  name: string;
  /** Human label where it differs from the API name. */
  label?: string;
  /** Deep link into Setup for this component. */
  setupUrl?: string;
  /** Rule-specific evidence rendered as table columns. Missing values render
   *  as an em dash rather than being dropped, so a blank cell reads as "not
   *  known" rather than "not applicable". */
  evidence?: Record<string, string | number | boolean | null | undefined>;
}

/* -------------------------------------------------------------------------- */
/* Scan results                                                               */
/* -------------------------------------------------------------------------- */

export interface DomainScore {
  analyzer: AnalyzerId;
  /**
   * 0–100, or **null** when the area could not be graded at all — nothing was
   * examined, or no rule could be evaluated.
   *
   * A high score means "the checks that ran found little", not "this area is
   * healthy": read it together with {@link ruleCoverage}, which says how much
   * of the area was actually checked. The two used to be conflated, so an org
   * where every describe failed scored 100.
   */
  score: number | null;
  grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  counts: Record<Severity, number>;
  /** Total components examined — the denominator behind the score. */
  examined: number;
  /** Fraction of this area's rule weight that reached a verdict, 0–1. */
  ruleCoverage?: number;
  /** Why the grade is absent or held back, in one sentence. */
  ungradedReason?: string;
}

export interface ScanMetrics {
  /** Headline numbers the domain wants on its dashboard tiles. */
  [label: string]: { value: number | string; sub?: string; meter?: number };
}

export interface ScanResult {
  analyzer: AnalyzerId;
  orgId: string;
  /** Epoch ms when this scan completed. Drives the cache-age display. */
  completedAt: number;
  /** Wall-clock duration of the scan. */
  durationMs: number;
  /** API calls this scan consumed — shown so the budget cost is never hidden. */
  apiCalls: number;
  apiVersion: string;
  /**
   * Extension version that produced this snapshot. Two snapshots are only
   * compared when this matches: a rule corrected between versions must not
   * read as "67 fixed" to someone who merely updated the extension.
   */
  build?: string;
  /**
   * What this scan was allowed to look at — currently whether managed-package
   * components were included. Snapshots taken under different scope are not
   * comparable: the setting changing is not the org changing.
   */
  scope?: string;
  score: DomainScore;
  metrics: ScanMetrics;
  findings: Finding[];
  /** Non-fatal problems: skipped rules, partial data, permission gaps. */
  warnings: string[];
  /** Set when the scan stopped early; results are partial. */
  truncated?: { reason: string; examined: number; total: number | null };
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                      */
/* -------------------------------------------------------------------------- */

export type CacheState = 'fresh' | 'stale' | 'absent' | 'refreshing';

export interface CacheEntryMeta {
  analyzer: AnalyzerId;
  orgId: string;
  completedAt: number;
  apiVersion: string;
  /** Bytes the serialized entry occupies, for the storage readout. */
  bytes: number;
  /**
   * Result of the staleness probe at the time it last ran — an org-side
   * watermark (latest metadata change) captured when the scan completed. The
   * cache is *hybrid*: it never silently re-fetches, but it can tell the user
   * their snapshot has been overtaken by org changes.
   */
  watermark?: OrgWatermark;
}

export interface OrgWatermark {
  /** Most recent SetupAuditTrail entry seen, if readable. */
  lastSetupChangeAt?: string;
  /** Max LastModifiedDate observed across the analyzer's own metadata. */
  lastMetadataChangeAt?: string;
  /** Count of components at scan time — a cheap change signal. */
  componentCount?: number;
}

export interface StalenessVerdict {
  state: CacheState;
  /** Epoch ms of the cached scan, when present. */
  cachedAt?: number;
  /** Human-readable reason the entry is considered stale. */
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/* Scan progress                                                              */
/* -------------------------------------------------------------------------- */

export interface ScanProgress {
  analyzer: AnalyzerId;
  phase: string;
  /** 0–1, or null when the total isn't known yet. */
  fraction: number | null;
  apiCalls: number;
}

/* -------------------------------------------------------------------------- */
/* API budget                                                                 */
/* -------------------------------------------------------------------------- */

export interface ApiBudget {
  /** Daily API request allowance reported by the org. */
  max: number | null;
  remaining: number | null;
  /** Requests this extension has made in the current session. */
  usedByOrgTriage: number;
  /** Last time the org-reported figures were refreshed. */
  observedAt: number | null;
}

/* -------------------------------------------------------------------------- */
/* Panel preferences                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The panel is Chrome's side panel since 0.8.18: the browser places it beside
 * the page, sizes it by the user's drag, and keeps it across navigations. The
 * width modes, dock side and page-narrowing switch of the injected sidebar it
 * replaced are gone with it; stored preferences still carrying those keys are
 * ignored.
 */
export interface PanelPrefs {
  theme: 'dark' | 'light' | 'system';
  density: 'compact' | 'cozy';
  /**
   * Areas that "Scan all areas" leaves alone.
   *
   * Every scan spends the org's daily API allowance, and the areas differ by
   * roughly an order of magnitude in what they cost — a handful of queries for
   * Ops, versus a describe per report for Reports & Dashboards. An admin who
   * wants the expensive sweeps run deliberately, on their own schedule, marks
   * them here; their own Scan button on the area card still works.
   *
   * Empty by default: excluding an area by default would quietly produce a
   * partial picture that reads as a complete one.
   */
  skipInScanAll: AnalyzerId[];
}

export const DEFAULT_PANEL_PREFS: PanelPrefs = {
  theme: 'system',
  density: 'compact',
  skipInScanAll: [],
};
