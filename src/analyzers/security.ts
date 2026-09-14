/**
 * Security settings — read from Salesforce's own Health Check rather than
 * reimplemented.
 *
 * Setup > Security > Health Check compares an org's security settings against a
 * Salesforce-published baseline and scores the result. That baseline is the
 * product of Salesforce's own security team, it moves with each release, and
 * reproducing it here would mean maintaining a copy that silently drifts out of
 * date. The Health Check API exposes the whole thing as two read-only Tooling
 * objects, so this analyzer reads the verdict instead of forming its own.
 *
 *   SecurityHealthCheck       the org's score and the baseline it was measured
 *                             against.
 *   SecurityHealthCheckRisks  one row per setting that differs from the
 *                             baseline, with the org's value, the baseline
 *                             value, and how serious the difference is.
 *
 * Both need View Setup and Configuration and nothing more.
 * https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_securityhealthcheckrisks.htm
 *
 * What this analyzer adds over the Setup page: the risks reach the remediation
 * plan as stories with owners and estimates, they are compared against the
 * previous scan so progress is visible, and they sit beside everything else
 * wrong with the org rather than on a page somebody has to remember to open.
 */

import type { FindingItem, Severity } from '@/shared/types';
import {
  capped,
  checkCancelled,
  finding,
  inconclusive,
  isFinding,
  summarise,
  setupUrl,
  tryQuery,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzerOutput,
  type Phase,
  type RuleOutcome,
  type RuleSpec,
} from './framework';

const MAX_ITEMS = 120;

interface HealthCheckRow {
  Score?: number | null;
  DurableId?: string | null;
  CustomBaselineId?: string | null;
}

interface RiskRow {
  Setting: string | null;
  SettingGroup: string | null;
  OrgValue: string | null;
  StandardValue: string | null;
  RiskType: string | null;
  SettingRiskCategory?: string | null;
}

/**
 * `RiskType` values, worst first.
 *
 * Salesforce groups risks into these bands on the Health Check page. Anything
 * unrecognised is treated as a medium risk rather than dropped — a new band in
 * a future release should surface as a finding, not vanish.
 */
const RISK_ORDER = ['HIGH_RISK', 'MEDIUM_RISK', 'LOW_RISK', 'INFORMATIONAL'] as const;

/** `RiskType` for a setting whose org value already matches the baseline. */
const MEETS_STANDARD = 'MEETS_STANDARD';

/** True when Health Check says this setting is on the baseline: not a finding. */
export function meetsStandard(riskType: string | null | undefined): boolean {
  return (riskType ?? '').toUpperCase() === MEETS_STANDARD;
}

/**
 * Health Check occasionally returns its own missing-label marker instead of a
 * value (`__MISSING LABEL__ PropertyFile - val SessionSettings.lockSessionsToIpDisabled …`).
 * The trailing token usually still says Enabled or Disabled; show that and say
 * the label is Salesforce's gap, not the org's.
 */
export function cleanHealthCheckValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!value.startsWith('__MISSING LABEL__')) return value;
  const state = /(Enabled|Disabled)\b/.exec(value)?.[1];
  return state ? `${state} (label missing in Salesforce)` : 'value unlabelled by Salesforce';
}

export function riskRank(riskType: string | null | undefined): number {
  const index = RISK_ORDER.indexOf((riskType ?? '').toUpperCase() as (typeof RISK_ORDER)[number]);
  return index === -1 ? 1 : index;
}

/** Turn `HIGH_RISK` into `High risk`, and an unknown band into itself. */
export function riskLabel(riskType: string | null | undefined): string {
  if (!riskType) return 'Unclassified';
  const words = riskType.replace(/_/g, ' ').toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `SessionSettings` → `Session settings`. Salesforce returns these camel-cased.
 *
 * The tail is lowercased rather than left title-cased: these read as sentences
 * in a finding ("Session timeout is a high risk"), and Title Case mid-sentence
 * reads as a proper noun.
 */
export function humanSetting(name: string | null | undefined): string {
  if (!name) return 'Setting';
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const RULES = {
  highRisk: {
    id: 'security.health-check-high',
    severity: 'critical',
    title: (n) => `${n} security ${n === 1 ? 'setting is' : 'settings are'} a high risk against the Health Check baseline`,
    rationale:
      'These are the settings Health Check classifies as high risk. Each one is a documented weakening of ' +
      'the org against the configured baseline (Salesforce\u2019s standard unless the org set a custom one; ' +
      'the area says which), and each has a recommended value that is one field on a Setup page.',
    remediation:
      'Open Setup > Security > Health Check and work down the high-risk group. Each row names the setting, ' +
      'the org’s value and the recommended one; most are a single change with no dependency on anything else.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=sf.security_health_check.htm&type=5',
    weight: 26,
  },
  mediumRisk: {
    id: 'security.health-check-medium',
    severity: 'warning',
    title: (n) => `${n} security ${n === 1 ? 'setting is' : 'settings are'} a medium risk against the Health Check baseline`,
    rationale:
      'Medium-risk settings rarely cause an incident on their own; they lower the cost of one that starts ' +
      'somewhere else. They are also the cheapest security work available, because the recommended value is ' +
      'published and the change is a Setup field.',
    remediation:
      'Work these after the high-risk group. Where a setting is deliberately relaxed — a session timeout a ' +
      'business process depends on, say — record why, so the next reviewer does not undo the decision.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=sf.security_health_check.htm&type=5',
    weight: 12,
  },
  lowRisk: {
    id: 'security.health-check-low',
    severity: 'info',
    title: (n) => `${n} security ${n === 1 ? 'setting differs' : 'settings differ'} from the baseline at low risk`,
    rationale:
      'Listed for completeness, and because a long tail of low-risk differences is usually a sign that the ' +
      'org’s security settings have never been reviewed as a whole rather than that each was a decision. ' +
      'Health Check shows these as two groups, Low-Risk and Informational; both are counted here, and each ' +
      'row below names its group.',
    remediation: 'Review in one sitting; accept or correct each, and note the ones deliberately left alone.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=xcloud.security_health_check_score.htm&type=5',
    weight: 3,
  },
} satisfies Record<string, RuleSpec>;

export const SECURITY_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

/** Which rule a risk band belongs to. */
function ruleFor(riskType: string | null): RuleSpec {
  const rank = riskRank(riskType);
  if (rank === 0) return RULES.highRisk;
  if (rank === 1) return RULES.mediumRisk;
  return RULES.lowRisk;
}

export const securityAnalyzer: Analyzer = {
  id: 'security',
  label: 'Security',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const outcomes: RuleOutcome[] = [];
    const skip = (reason: string) => warnings.push(reason);

    checkCancelled(ctx);
    yield { phase: 'Reading Health Check risks', fraction: 0.4 };

    const risks = await tryQuery(
      () =>
        ctx.client.query<RiskRow>(
          'SELECT Setting, SettingGroup, OrgValue, StandardValue, RiskType, SettingRiskCategory FROM SecurityHealthCheckRisks',
          { tooling: true },
        ),
      skip,
      'Health Check risks',
    );

    if (!risks) {
      for (const rule of Object.values(RULES)) {
        outcomes.push(
          inconclusive(
            'security',
            rule,
            'SecurityHealthCheckRisks could not be queried. The Health Check API needs the View Setup and Configuration permission, and is available from Tooling API v37.0.',
          ),
        );
      }
      const summary = summarise(RULES, outcomes);
      return {
        metrics: { 'Health Check score': { value: '—' }, Risks: { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }

    /* The score is a separate object, and the documentation disagrees with
       itself about whether it is exposed to the API. Describing first turns
       that into a fact for this org instead of an assumption. */
    checkCancelled(ctx);
    yield { phase: 'Reading the Health Check score', fraction: 0.8 };
    const scoreDescribe = await tryQuery(
      () =>
        ctx.client.get<{ fields?: { name?: string }[] }>('/sobjects/SecurityHealthCheck/describe', {
          tooling: true,
        }),
      skip,
      'Health Check score describe',
    );
    const hasScore = (scoreDescribe?.fields ?? []).some((f) => f.name === 'Score');
    const health = hasScore
      ? await tryQuery(
          () => ctx.client.query<HealthCheckRow>('SELECT Score, CustomBaselineId FROM SecurityHealthCheck', { tooling: true }),
          skip,
          'Health Check score',
        )
      : null;
    const score = health?.records[0]?.Score ?? null;
    // Health Check can compare against a custom baseline instead of
    // Salesforce's; the rows then carry the custom values as StandardValue.
    // Salesforce returns 0 (not null) when the standard baseline is in use;
    // measured 2026-09-11 on an org whose Health Check page said
    // "Salesforce Baseline Standard".
    const rawBaseline = health?.records[0]?.CustomBaselineId;
    const customBaseline =
      rawBaseline === null || rawBaseline === undefined || String(rawBaseline).trim() === '' || String(rawBaseline) === '0'
        ? null
        : String(rawBaseline);
    if (customBaseline) {
      warnings.push(
        `Health Check in this org is configured with a custom baseline (${customBaseline}), so the baseline values below are your organisation's, not Salesforce's standard.`,
      );
    }
    if (!hasScore && scoreDescribe) {
      warnings.push(
        'This org’s SecurityHealthCheck object does not expose a Score field, so only the individual risks are reported. The score is on Setup > Security > Health Check.',
      );
    }

    const item = (row: RiskRow): FindingItem => ({
      name: humanSetting(row.Setting),
      label: row.SettingGroup ?? undefined,
      setupUrl: setupUrl(ctx.lightningHost, 'HealthCheck/home'),
      evidence: {
        Group: row.SettingGroup,
        'Your value': cleanHealthCheckValue(row.OrgValue),
        'Baseline value': cleanHealthCheckValue(row.StandardValue),
        'Risk band': riskLabel(row.SettingRiskCategory ?? row.RiskType),
        'Off baseline': riskLabel(row.RiskType),
      },
    });

    // Rows are bucketed by the setting's own band. `RiskType` says how far the
    // org's value is from the baseline; MEETS_STANDARD rows are compliant and
    // are counted, not listed — an earlier version treated that band as
    // unknown, defaulted it to "medium", and reported 27 compliant settings
    // as medium-risk findings.
    let compliant = 0;
    const byRule = new Map<string, RiskRow[]>();
    for (const row of risks.records) {
      if (meetsStandard(row.RiskType)) {
        compliant += 1;
        continue;
      }
      const rule = ruleFor(row.SettingRiskCategory ?? row.RiskType);
      const bucket = byRule.get(rule.id);
      if (bucket) bucket.push(row);
      else byRule.set(rule.id, [row]);
    }

    for (const rule of Object.values(RULES)) {
      const rows = byRule.get(rule.id) ?? [];
      outcomes.push(
        finding(
          'security',
          rule,
          capped(
            rows
              .sort((a, b) => (a.SettingGroup ?? '').localeCompare(b.SettingGroup ?? '') || (a.Setting ?? '').localeCompare(b.Setting ?? ''))
              .map(item),
            MAX_ITEMS,
            (dropped) => warnings.push(`${dropped} further ${riskLabel(rows[0]?.SettingRiskCategory ?? rows[0]?.RiskType).toLowerCase()} settings are not listed.`),
          ),
        ),
      );
    }

    const summary = summarise(RULES, outcomes);
    if (summary.unevaluated.length > 0) {
      warnings.push(
        `${summary.unevaluated.length} check(s) in this area could not be evaluated and are not reflected in the findings: ${summary.unevaluated.join(', ')}. The score is held back accordingly.`,
      );
    }

    const count = (id: string) => summary.findings.find((f) => f.id === id)?.items.length ?? 0;
    const metrics: AnalyzerOutput['metrics'] = {
      'Health Check score': score === null
        ? { value: '—', sub: 'not exposed to the API' }
        : { value: `${Math.round(score)}%`, sub: 'Salesforce’s own score', meter: score / 100 },
      'High risk': { value: count(RULES.highRisk.id) },
      'Medium risk': { value: count(RULES.mediumRisk.id) },
      // Health Check shows four bands; the fourth, Informational, is folded in
      // here so the tile can be reconciled against the page: Low + Informational.
      'Low risk': { value: count(RULES.lowRisk.id), sub: 'incl. informational' },
      'Meets standard': { value: compliant },
      'Settings compared': { value: risks.records.length },
    };

    return {
      metrics,
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      examined: Math.max(1, risks.records.length),
    };
  },
};

/** Severity a risk band maps to, exported so the tests can pin the mapping. */
export function severityForRisk(riskType: string | null): Severity {
  return ruleFor(riskType).severity;
}

/** True when the outcome fired, for the tests. */
export const outcomeFired = isFinding;
