/**
 * Analyzer framework.
 *
 * Analyzers are async generators, not plain async functions, because an MV3
 * service worker gets at most five minutes per event and thirty seconds of idle
 * before it is terminated. Yielding between phases lets the runner return to the
 * event loop, report progress, and start a fresh event budget for the next
 * phase — so a scan of a large org survives instead of being killed halfway
 * through with nothing to show for the API calls it already spent.
 *
 * Each analyzer yields a phase description and finally returns its findings.
 */

import type {
  AnalyzerId,
  DomainScore,
  Finding,
  ScanMetrics,
  ScanResult,
  Severity,
} from '@/shared/types';
import type { SalesforceClient } from '@/background/sfClient';
import { SalesforceError } from '@/background/sfClient';

export interface AnalyzerContext {
  client: SalesforceClient;
  orgId: string;
  lightningHost: string;
  /** When false, managed-package components are excluded from every rule. */
  includeManaged: boolean;
  /**
   * `Organization.NamespacePrefix`, or null for the overwhelmingly common
   * org that has none. Components carrying *this* namespace are the org's own
   * work, not someone else's package — see {@link isManaged}.
   */
  orgNamespace: string | null;
  /** Upper bound on components fetched one-at-a-time (flow/page metadata). */
  detailBudget: number;
  signal: AbortSignal;
}

export interface Phase {
  phase: string;
  /** 0–1 through the analyzer's own work, or null when the total is unknown. */
  fraction: number | null;
}

export interface AnalyzerOutput {
  metrics: ScanMetrics;
  findings: Finding[];
  warnings: string[];
  examined: number;
  truncated?: { reason: string; examined: number; total: number | null };
  /** How much of the analyzer's rule weight actually reached a verdict. */
  coverage?: RuleCoverage;
}

/**
 * Every rule an analyzer owns, so the score can say how much of the domain was
 * actually checked. Without this, "no rule fired" and "no rule ran" produce the
 * same 100 — and an org where every describe 403'd presents as an A.
 */
export interface RuleCoverage {
  /** Total weight of every rule the analyzer could have evaluated. */
  totalWeight: number;
  /** Weight of the rules that actually reached a verdict. */
  evaluatedWeight: number;
}

export interface Analyzer {
  id: AnalyzerId;
  label: string;
  run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void>;
}

/* -------------------------------------------------------------------------- */
/* Finding construction                                                       */
/* -------------------------------------------------------------------------- */

export interface RuleSpec {
  id: string;
  severity: Severity;
  /** Receives the item count so the title can state the actual number. */
  title: (count: number) => string;
  rationale: string;
  remediation: string;
  docUrl?: string;
  weight: number;
}

/**
 * A rule that ran and found nothing.
 *
 * Deliberately not `null`. "Checked and clean" and "never checked" are
 * different facts about an org, and collapsing both to `null` is what let a
 * domain where no rule could run present as a perfect score. Carrying the id
 * lets {@link summarise} tell them apart at the end without every call site
 * having to remember to say so.
 */
export interface CleanRule {
  readonly cleanRuleId: string;
}

export type RuleOutcome = Finding | CleanRule | null;

export function isFinding(outcome: RuleOutcome): outcome is Finding {
  return outcome !== null && !('cleanRuleId' in outcome);
}

/**
 * Build a finding, or record that the rule ran clean. Keeping this in one place
 * means every analyzer reports in the same shape and no rule can accidentally
 * emit an empty finding that reads as a problem.
 */
export function finding(
  analyzer: AnalyzerId,
  spec: RuleSpec,
  items: Finding['items'],
): RuleOutcome {
  if (items.length === 0) return { cleanRuleId: spec.id };
  return {
    id: spec.id,
    analyzer,
    severity: spec.severity,
    title: spec.title(items.length),
    rationale: spec.rationale,
    remediation: spec.remediation,
    docUrl: spec.docUrl,
    weight: spec.weight,
    items,
  };
}

/**
 * A rule that could not be evaluated. Recorded explicitly rather than dropped:
 * "we could not check this" and "this is fine" must never look the same in an
 * org health report.
 */
export function inconclusive(
  analyzer: AnalyzerId,
  spec: RuleSpec,
  reason: string,
): Finding {
  return {
    id: spec.id,
    analyzer,
    severity: 'info',
    title: `${spec.title(0)} — not evaluated`,
    rationale: spec.rationale,
    remediation: spec.remediation,
    docUrl: spec.docUrl,
    weight: 0,
    items: [],
    inconclusive: { reason },
  };
}

/* -------------------------------------------------------------------------- */
/* Scoring                                                                    */
/* -------------------------------------------------------------------------- */

const SEVERITY_MULTIPLIER: Record<Severity, number> = {
  critical: 1,
  warning: 0.45,
  info: 0.12,
  success: 0,
};

/**
 * How much of a rule's weight applies simply because it fired at all, as
 * opposed to scaling with how widespread the problem is.
 *
 * This split matters. A purely proportional score is badly wrong for large
 * orgs: three dashboard components pointing at deleted reports is a real,
 * user-visible breakage, but as a proportion of 1,900 reports it rounds to
 * nothing, and the org scores an A while its executive dashboard shows errors.
 * A purely fixed score is wrong in the other direction — it cannot distinguish
 * two uncovered classes from two hundred.
 */
const RULE_FIRED_SHARE = 0.45;

/**
 * Below this share of evaluated rule weight an area is reported ungraded.
 * Half is a judgement, not a measurement: with less than half the checks run,
 * the grade would say more about the user's permissions than about the org.
 */
export const MIN_GRADED_COVERAGE = 0.5;

/**
 * Score a domain 0–100.
 *
 * Each fired rule deducts `weight × severity × scale`, where `scale` is
 * {@link RULE_FIRED_SHARE} for existing at all plus the remainder scaled by the
 * square root of the affected proportion. The square root is so the first few
 * instances cost meaningfully more than the hundredth: one uncovered trigger
 * matters, the difference between 90 and 95 uncovered classes does not.
 */
export function scoreDomain(
  analyzer: AnalyzerId,
  findings: Finding[],
  examined: number,
  coverage?: RuleCoverage,
): DomainScore {
  const counts: Record<Severity, number> = { critical: 0, warning: 0, info: 0, success: 0 };
  let deduction = 0;

  for (const item of findings) {
    if (item.inconclusive || item.items.length === 0) continue;
    counts[item.severity] += 1;

    const proportion =
      examined > 0 ? Math.min(1, item.items.length / examined) : 1;
    const scale = RULE_FIRED_SHARE + (1 - RULE_FIRED_SHARE) * Math.sqrt(proportion);
    deduction += item.weight * SEVERITY_MULTIPLIER[item.severity] * scale;
  }

  const ruleCoverage =
    coverage && coverage.totalWeight > 0
      ? Math.min(1, coverage.evaluatedWeight / coverage.totalWeight)
      : 1;

  // Nothing was looked at. There is no evidence for *any* grade, and the honest
  // answer is to say so rather than to award the top one by default.
  //
  // The same applies below MIN_GRADED_COVERAGE. The cap further down pulls a
  // score toward 50 in proportion to what was not checked, which is right when
  // most of the area ran — but at 10% coverage a clean org came out at 55, an
  // F, and an F reads as a verdict on the org rather than on the evidence. Too
  // little evidence is "not graded", not "failing".
  if (examined === 0 || ruleCoverage < MIN_GRADED_COVERAGE) {
    return {
      analyzer,
      score: null,
      grade: null,
      counts,
      examined,
      ruleCoverage,
      // Order matters: when every rule was inconclusive, "nothing examined" is
      // true but misleading — the org may well have components; the reads
      // failed. Only when the rules ran and found nothing is the org empty.
      ungradedReason:
        ruleCoverage === 0
          ? 'No rule in this area could be evaluated.'
          : examined === 0
            // Not "this org has none": scope filtering (managed packages) can
            // empty the set in an org that is full of them. What is certainly
            // true is that nothing was in scope; the area's warnings say why.
            ? 'Nothing was in scope for this area, so there is nothing to grade.'
            : `Only ${Math.round(ruleCoverage * 100)}% of this area's checks could be evaluated — too little evidence for a grade.`,
    };
  }

  const score = Math.max(0, Math.min(100, Math.round(100 - deduction)));

  // A domain where half the rules could not run must not present as an A. The
  // cap is the best grade the evidence can support: with 60% of rule weight
  // evaluated, the most that can honestly be claimed is 60 + (clean) — so the
  // score is pulled toward the middle in proportion to what was NOT checked.
  const capped = Math.round(score * ruleCoverage + 50 * (1 - ruleCoverage));
  const effective = Math.min(score, capped);

  return {
    analyzer,
    score: effective,
    grade: gradeFor(effective),
    counts,
    examined,
    ruleCoverage,
    ungradedReason:
      ruleCoverage < 0.999
        ? `Only ${Math.round(ruleCoverage * 100)}% of this area's checks could be evaluated; the score is held back accordingly.`
        : undefined,
  };
}

export function gradeFor(score: number): DomainScore['grade'] {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

/**
 * @param apiCallsAtStart The client's counter when this job began. The client
 *   is shared across every analyzer and every rescan of an org, so its counter
 *   is a session total; a snapshot that stored it verbatim reported the second
 *   area's cost as "everything so far". The result carries only this job's own
 *   spend.
 */
export function toScanResult(
  analyzer: AnalyzerId,
  ctx: AnalyzerContext,
  output: AnalyzerOutput,
  startedAt: number,
  apiCallsAtStart = 0,
): ScanResult {
  return {
    analyzer,
    orgId: ctx.orgId,
    completedAt: Date.now(),
    durationMs: Date.now() - startedAt,
    apiCalls: Math.max(0, ctx.client.apiCalls - apiCallsAtStart),
    apiVersion: ctx.client.apiVersion,
    build: typeof __ORGTRIAGE_BUILD__ === 'string' ? __ORGTRIAGE_BUILD__ : undefined,
    // Everything that changes what a scan looks at, so two snapshots are only
    // compared when they examined the same population: a smaller detail budget
    // leaves components undescribed, and a finding that vanishes because it
    // was never re-examined is not a fix.
    // The API version too: an override or a release bump moves floors such as
    // the old-API-version rule's, so a component can "resolve" untouched.
    scope: `${ctx.includeManaged ? 'with-managed' : 'unmanaged'}:detail-${ctx.detailBudget}:api-${ctx.client.apiVersion}`,
    score: scoreDomain(analyzer, output.findings, output.examined, output.coverage),
    metrics: output.metrics,
    findings: output.findings,
    warnings: output.warnings,
    truncated: output.truncated,
  };
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Run a query that may fail for permission reasons, returning `null` instead of
 * throwing. Permission-degraded users are a first-class state: a user without
 * "View Setup and Configuration" should be told which check was skipped and
 * why, not shown a zero.
 */
export async function tryQuery<T>(
  fn: () => Promise<T>,
  onSkip: (reason: string) => void,
  label: string,
): Promise<T | null> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof SalesforceError) {
      if (err.code === 'BUDGET_EXHAUSTED' || err.code === 'THROTTLED') throw err;
      onSkip(`${label} was skipped: ${err.message}`);
      return null;
    }
    onSkip(`${label} was skipped: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Stop the analyzer if the scan was cancelled.
 *
 * Called at every phase boundary. Cancellation used to stop only the *next*
 * slice from being requested, so the phase in flight ran to completion and
 * spent its API calls anyway — the button said "cancelled" while the org was
 * still being queried.
 */
/**
 * Tracks which of an analyzer's rules actually reached a verdict.
 *
 * The failure this exists to prevent: a rule that cannot run emits nothing, and
 * "nothing" is indistinguishable from "clean". An org where every describe
 * returned 403 and every permission was missing scored 100/A, and the type
 * comment described that as a property rather than the bug it was.
 *
 * Usage: declare every rule the analyzer owns up front, then call `evaluated()`
 * for each one that reached a verdict — including the ones that found nothing,
 * because "checked and clean" is a verdict. Whatever is left over is reported
 * as unevaluated and holds the grade back.
 */
export class CoverageLedger {
  private readonly weights = new Map<string, number>();
  private readonly done = new Set<string>();

  constructor(rules: Record<string, RuleSpec>) {
    for (const rule of Object.values(rules)) {
      // Zero-weight rules are informational and cannot move a score, so
      // counting them would dilute the measure of what was checked.
      if (rule.weight > 0) this.weights.set(rule.id, rule.weight);
    }
  }

  /** Mark one or more rules as having reached a verdict. */
  evaluated(...specs: RuleSpec[]): void {
    for (const spec of specs) this.done.add(spec.id);
  }

  /** The rule ids that never reached a verdict, for the warnings list. */
  get unevaluated(): string[] {
    return [...this.weights.keys()].filter((id) => !this.done.has(id));
  }

  get coverage(): RuleCoverage {
    let totalWeight = 0;
    let evaluatedWeight = 0;
    for (const [id, weight] of this.weights) {
      totalWeight += weight;
      if (this.done.has(id)) evaluatedWeight += weight;
    }
    return { totalWeight, evaluatedWeight };
  }
}

/**
 * Turn an analyzer's accumulated rule outcomes into the findings it reports and
 * the coverage figure the score needs.
 *
 * A rule counts as evaluated when it produced a finding or ran clean. An
 * explicit `inconclusive()` does *not* count — that is the whole point of
 * emitting one — and a rule that was never reached at all is listed in the
 * warnings so the user can see what was not checked, rather than inferring
 * health from silence.
 */
export function summarise(
  rules: Record<string, RuleSpec>,
  outcomes: RuleOutcome[],
): { findings: Finding[]; coverage: RuleCoverage; unevaluated: string[] } {
  const ledger = new CoverageLedger(rules);
  const byId = new Map(Object.values(rules).map((r) => [r.id, r]));
  const findings: Finding[] = [];

  // A rule that could not be evaluated wins over any earlier verdict on the
  // same rule. Analyzers build their outcomes in passes, and a later pass can
  // discover that an earlier clean result rested on nothing — the flows
  // analyzer emitted "no stale versions" and then "no version rows could be
  // read" for the same rule, and the first one counted. One outcome per rule,
  // and "not evaluated" is the one that survives.
  const unevaluable = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome !== null && isFinding(outcome) && outcome.inconclusive) unevaluable.add(outcome.id);
  }

  const seenInconclusive = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome === null) continue;
    if (!isFinding(outcome)) {
      if (unevaluable.has(outcome.cleanRuleId)) continue;
      const spec = byId.get(outcome.cleanRuleId);
      if (spec) ledger.evaluated(spec);
      continue;
    }
    if (unevaluable.has(outcome.id)) {
      if (!outcome.inconclusive || seenInconclusive.has(outcome.id)) continue;
      seenInconclusive.add(outcome.id);
      findings.push(outcome);
      continue;
    }
    findings.push(outcome);
    const spec = byId.get(outcome.id);
    if (spec) ledger.evaluated(spec);
  }

  return { findings, coverage: ledger.coverage, unevaluated: ledger.unevaluated };
}

export function checkCancelled(ctx: AnalyzerContext): void {
  if (ctx.signal.aborted) {
    throw new DOMException('Scan cancelled', 'AbortError');
  }
}

/** Setup deep link for a component, built against the org's Lightning host. */
export function setupUrl(lightningHost: string, path: string): string {
  return `https://${lightningHost}/lightning/setup/${path}`;
}

/** `.../lightning/r/<id>/view`-style object link. */
export function recordUrl(lightningHost: string, id: string): string {
  return `https://${lightningHost}/lightning/r/${id}/view`;
}

export function percent(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : Math.round((numerator / denominator) * 100);
}

/** Age in whole days, or null when the date is missing/unparseable. */
export function daysSince(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const time = Date.parse(value);
  if (Number.isNaN(time)) return null;
  return Math.floor((now - time) / 86_400_000);
}

/**
 * Is this component someone else's — i.e. shipped by an installed package and
 * therefore not something the admin can fix?
 *
 * `ManageableState` is the authority and `NamespacePrefix` is not. Verified
 * against a live org: every installed component reports
 * `ManageableState: 'installed'` alongside its namespace, while the org's own
 * code reports `'unmanaged'`. Treating any `NamespacePrefix` as managed breaks
 * exactly the orgs that have their own namespace — ISV packaging orgs, and any
 * customer using namespaced 2GP — where *every* locally authored class and flow
 * carries one. Those orgs used to examine zero components and score A.
 *
 * `orgNamespace` is still honoured so that a packaging org's own namespace is
 * never counted as foreign even if a state value we have not seen shows up.
 *
 * States other than `unmanaged` — `installed`, `released`, `beta`,
 * `deprecated`, `deprecatedEditable` — all describe packaged components. Only
 * `released`/`beta` in the *packaging* org are locally editable, which is what
 * the `orgNamespace` check covers.
 */
export function isManaged(
  record: { NamespacePrefix?: unknown; ManageableState?: unknown },
  orgNamespace: string | null = null,
): boolean {
  const ns = typeof record.NamespacePrefix === 'string' ? record.NamespacePrefix : '';
  if (ns.length > 0 && orgNamespace !== null && ns === orgNamespace) return false;

  const state = record.ManageableState;
  if (typeof state === 'string') return state !== 'unmanaged';

  // No `ManageableState` selected: fall back to the namespace, which is the
  // only signal left. Analyzers should select the field.
  return ns.length > 0;
}

/** Group into a Map keyed by the selector, preserving insertion order. */
export function groupBy<T, K>(items: T[], key: (item: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket) bucket.push(item);
    else map.set(k, [item]);
  }
  return map;
}

/**
 * Cap a list and report the fact. Silent truncation in an org-health report is
 * the worst failure mode available: it reads as "nothing more to see".
 */
export function capped<T>(
  items: T[],
  limit: number,
  onCap: (dropped: number) => void,
): T[] {
  if (items.length <= limit) return items;
  onCap(items.length - limit);
  return items.slice(0, limit);
}
