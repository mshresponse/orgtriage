/**
 * Snapshot diffing — what changed in an area since the last scan.
 *
 * A single scan says what is wrong today. The question a consultant is actually
 * asked at the next meeting is different: *is it getting better?* Without a
 * before, "23 warnings" is a number nobody can act on; with one, "six of the
 * eleven uncovered classes now have tests, and two new ones appeared" is a
 * status report.
 *
 * What is stored, and why it is not the whole previous snapshot: keeping two
 * full `ScanResult`s per area would roughly double the cache for a comparison
 * that needs only identity and counts. Instead each entry carries a compact
 * digest of the snapshot it replaced — per rule, the severity, the title, the
 * item count, and the item names up to {@link MAX_DIGEST_ITEMS}. Above that cap
 * the diff still reports the count change but stops naming individual
 * components, and says so, rather than inventing a list.
 *
 * Pure: no client, no storage, no clock beyond the timestamps it is handed.
 */

import type { AnalyzerId, ScanResult, Severity } from './types';

/** Item names kept per rule. Above this the diff is counts only. */
export const MAX_DIGEST_ITEMS = 250;

export interface RuleDigest {
  severity: Severity;
  title: string;
  count: number;
  /** Item names, or null when the rule had more than the cap. */
  items: string[] | null;
}

export interface SnapshotDigest {
  analyzer: AnalyzerId;
  completedAt: number;
  score: number | null;
  grade: string | null;
  examined: number;
  counts: Record<Severity, number>;
  rules: Record<string, RuleDigest>;
  /**
   * Rules that could not be evaluated in this snapshot. Kept separately from
   * `rules` so a later diff can refuse to compare them: a rule that fired last
   * week and could not be checked this week has not been resolved, and saying
   * so is the one mistake a progress report must never make.
   */
  inconclusive: string[];
  /** Extension version that produced the snapshot; see {@link comparable}. */
  build?: string;
  /** What the scan was allowed to look at; see {@link comparable}. */
  scope?: string;
  /** API version the scan ran against; see {@link AreaDiff.platformMoved}. */
  apiVersion?: string;
}

/**
 * Whether two snapshots may be compared at all. Only when the same extension
 * version produced both: a rule that was corrected in between makes every
 * item it stopped reporting look "fixed", and a person who has only updated
 * the extension would be told their org improved. Snapshots from before the
 * version was recorded are never compared.
 */
export function comparable(
  previous: { build?: string; scope?: string },
  current: { build?: string; scope?: string },
): boolean {
  // Scope as well as build: turning on "include managed packages" changes what
  // a scan looks at, and the next scan then reports every packaged component
  // as newly appeared. Measured against a production org, where flipping the
  // setting produced "96 new" in an org nothing had happened to.
  return (
    typeof previous.build === 'string' &&
    previous.build === current.build &&
    previous.scope === current.scope
  );
}

export interface RuleChange {
  ruleId: string;
  title: string;
  severity: Severity;
  /** Positive means the rule affects more components than it did. */
  delta: number;
  count: number;
  /** Component names that were not there before, capped for display. */
  appeared: string[];
  /** Component names that are no longer flagged, capped for display. */
  cleared: string[];
  /** True when either side exceeded the digest cap, so names are incomplete. */
  namesIncomplete: boolean;
}

export interface AreaDiff {
  analyzer: AnalyzerId;
  /** When the snapshot being compared against was taken. */
  since: number;
  scoreDelta: number | null;
  countDelta: Record<Severity, number>;
  /** Rules that fired now and did not before. */
  appeared: RuleChange[];
  /** Rules that fired before and are clean now. */
  resolved: RuleChange[];
  /** Rules that fired in both, with a different number of components. */
  changed: RuleChange[];
  /** True when nothing at all moved. */
  unchanged: boolean;
  /**
   * Set when the org's API version differs between the two snapshots. That is
   * a real change — flows and classes on the old version genuinely are one
   * release further behind — but it is Salesforce's doing, not the admin's,
   * and a diff that grows overnight for that reason should say so.
   */
  platformMoved?: { from: string; to: string };
}

const ZERO_COUNTS: Record<Severity, number> = { critical: 0, warning: 0, info: 0, success: 0 };

/** Reduce a finished scan to the facts a later diff needs. */
export function digestOf(result: ScanResult): SnapshotDigest {
  const rules: Record<string, RuleDigest> = {};
  const unevaluated: string[] = [];
  for (const finding of result.findings) {
    // An inconclusive rule is not a verdict, and treating one as "clean now"
    // would announce a fix that never happened.
    if (finding.inconclusive) {
      unevaluated.push(finding.id);
      continue;
    }
    rules[finding.id] = {
      severity: finding.severity,
      title: finding.title,
      count: finding.items.length,
      items:
        finding.items.length > MAX_DIGEST_ITEMS
          ? null
          : finding.items.map((item) => item.name),
    };
  }
  return {
    analyzer: result.analyzer,
    completedAt: result.completedAt,
    build: result.build,
    scope: result.scope,
    apiVersion: result.apiVersion,
    score: result.score.score,
    grade: result.score.grade,
    examined: result.score.examined,
    counts: { ...ZERO_COUNTS, ...result.score.counts },
    rules,
    inconclusive: unevaluated,
  };
}

/** Names in `a` that are absent from `b`, capped for display. */
function missing(a: string[] | null, b: string[] | null, limit = 20): string[] {
  if (a === null || b === null) return [];
  const seen = new Set(b);
  return a.filter((name) => !seen.has(name)).slice(0, limit);
}

function change(
  ruleId: string,
  before: RuleDigest | undefined,
  after: RuleDigest | undefined,
): RuleChange {
  const beforeItems = before?.items ?? null;
  const afterItems = after?.items ?? null;
  return {
    ruleId,
    title: after?.title ?? before?.title ?? ruleId,
    severity: after?.severity ?? before?.severity ?? 'info',
    delta: (after?.count ?? 0) - (before?.count ?? 0),
    count: after?.count ?? 0,
    appeared: missing(afterItems, beforeItems ?? []),
    cleared: missing(beforeItems, afterItems ?? []),
    namesIncomplete:
      (before !== undefined && before.items === null) || (after !== undefined && after.items === null),
  };
}

/**
 * Compare a finished scan against the digest of the snapshot it replaced.
 *
 * Rules present in only one side are reported as appeared or resolved. A rule
 * that fired in both with the same count is not reported at all: "unchanged" is
 * the common case and listing it would bury the two lines that matter.
 */
export function diffAgainst(previous: SnapshotDigest, current: ScanResult): AreaDiff {
  const now = digestOf(current);
  // A rule that could not be evaluated on either side is not comparable. Older
  // entries were written before `inconclusive` existed, hence the `?? []`.
  const skip = new Set([...(previous.inconclusive ?? []), ...now.inconclusive]);
  const ids = new Set(
    [...Object.keys(previous.rules), ...Object.keys(now.rules)].filter((id) => !skip.has(id)),
  );

  const appeared: RuleChange[] = [];
  const resolved: RuleChange[] = [];
  const changed: RuleChange[] = [];

  for (const id of ids) {
    const before = previous.rules[id];
    const after = now.rules[id];
    const firedBefore = (before?.count ?? 0) > 0;
    const firesNow = (after?.count ?? 0) > 0;
    if (!firedBefore && !firesNow) continue;
    const record = change(id, before, after);
    if (!firedBefore) appeared.push(record);
    else if (!firesNow) resolved.push(record);
    else if (record.delta !== 0 || record.appeared.length > 0 || record.cleared.length > 0) {
      changed.push(record);
    }
  }

  const bySeverityThenSize = (a: RuleChange, b: RuleChange) =>
    severityRank(a.severity) - severityRank(b.severity) || Math.abs(b.delta) - Math.abs(a.delta);
  appeared.sort(bySeverityThenSize);
  resolved.sort(bySeverityThenSize);
  changed.sort(bySeverityThenSize);

  const countDelta = { ...ZERO_COUNTS };
  for (const severity of Object.keys(countDelta) as Severity[]) {
    countDelta[severity] = (now.counts[severity] ?? 0) - (previous.counts[severity] ?? 0);
  }

  return {
    analyzer: current.analyzer,
    since: previous.completedAt,
    scoreDelta:
      now.score !== null && previous.score !== null ? now.score - previous.score : null,
    countDelta,
    appeared,
    resolved,
    changed,
    unchanged:
      appeared.length === 0 &&
      resolved.length === 0 &&
      changed.length === 0 &&
      (now.score ?? null) === (previous.score ?? null),
    platformMoved:
      previous.apiVersion && previous.apiVersion !== current.apiVersion
        ? { from: previous.apiVersion, to: current.apiVersion }
        : undefined,
  };
}

function severityRank(severity: Severity): number {
  return { critical: 0, warning: 1, info: 2, success: 3 }[severity];
}

/** One-line summary for a card or a header, e.g. "+4 −11 since 6 Sep". */
export function summariseDiff(diff: AreaDiff): string {
  if (diff.unchanged) return 'No change since the previous scan';
  const gained = diff.appeared.reduce((n, r) => n + r.count, 0) + diff.changed.filter((r) => r.delta > 0).reduce((n, r) => n + r.delta, 0);
  const lost =
    diff.resolved.reduce((n, r) => n + Math.abs(r.delta), 0) +
    diff.changed.filter((r) => r.delta < 0).reduce((n, r) => n + Math.abs(r.delta), 0);
  const parts: string[] = [];
  if (lost > 0) parts.push(`${lost} fixed`);
  if (gained > 0) parts.push(`${gained} new`);
  if (parts.length === 0) parts.push('components changed');
  return parts.join(', ');
}
