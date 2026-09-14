/**
 * The remediation plan: cached scan results turned into a backlog.
 *
 * Every finding that names components becomes one story with a stable key, a
 * priority, an effort estimate and the playbook's steps; everything OrgTriage
 * could *not* evaluate is listed separately, so a plan never implies that an
 * unchecked area is healthy. Pure functions over the shared types — the report
 * page renders this, and the exporters serialise it, without either touching
 * the worker.
 */

import type { AnalyzerId, FindingItem, ScanResult, Severity } from './types';
import { KIND_LABEL, KIND_SLUG, PLAYBOOK, type Playbook, type StoryKind, type StoryRole } from './playbook';

/* -------------------------------------------------------------------------- */
/* Model                                                                      */
/* -------------------------------------------------------------------------- */

export type Priority = 'P1' | 'P2' | 'P3';
export type EffortSize = 'XS' | 'S' | 'M' | 'L' | 'XL';

/**
 * The canonical order areas appear in, everywhere.
 *
 * Derived from AREA_LABEL rather than written out a second time: the hand-kept
 * copy of this list silently dropped `access` when that analyzer was added,
 * which sorted it to the front (indexOf returned -1) and left it out of the
 * "not scanned" list entirely.
 */
export const AREA_ORDER: AnalyzerId[] = [
  'apex',
  'flows',
  'reports',
  'layouts',
  'ops',
  'access',
  'limits',
  'security',
  'fields',
  'apexlint',
];

export const AREA_LABEL: Record<AnalyzerId, string> = {
  apex: 'Apex',
  flows: 'Flows',
  reports: 'Reports & dashboards',
  layouts: 'Layouts & SLDS',
  ops: 'Operations',
  access: 'Access & permissions',
  limits: 'Limits & storage',
  security: 'Security settings',
  fields: 'Field usage',
  apexlint: 'Apex code quality',
};

/**
 * The workstream each area's stories belong to.
 *
 * Named for the work rather than the analyzer, because these become Jira epics
 * and an epic called "Apex" tells a delivery team nothing. Each name is unique
 * across the plan, which the Jira importer requires: it resolves `Epic Link` by
 * matching `Epic Name`, and two epics sharing a name make that ambiguous.
 */
export const EPIC_NAME: Record<AnalyzerId, string> = {
  apex: 'Apex Governance',
  flows: 'Flow Reliability',
  reports: 'Reporting Performance',
  layouts: 'Layout & SLDS Cleanliness',
  ops: 'Operations & Job Health',
  access: 'Security & Access',
  limits: 'Limits & Storage',
  security: 'Security Baseline',
  fields: 'Schema Cleanup',
  apexlint: 'Apex Code Quality',
};

export interface Epic {
  /** `OT-E1`-style key, referenced by each story's `epicKey`. */
  key: string;
  analyzer: AnalyzerId;
  /** Jira's `Epic Name` — unique within the plan. */
  name: string;
  summary: string;
  storyKeys: string[];
  points: number;
  hours: number;
}

/** What the report needs to know about the org — display facts only. */
export interface PlanOrg {
  orgId: string;
  orgName: string;
  organizationType: string;
  isSandbox: boolean;
  instanceName: string;
  apiVersion: string;
  lightningHost: string;
  /** Who ran the scans, for the cover page. */
  userName: string;
}

export interface Story {
  /** `OT-001`-style key, stable for the ordering of one plan. */
  key: string;
  ruleId: string;
  analyzer: AnalyzerId;
  area: string;
  title: string;
  severity: Severity;
  priority: Priority;
  kind: StoryKind;
  kindLabel: string;
  role: StoryRole;
  rationale: string;
  remediation: string;
  steps: string[];
  acceptance: string[];
  docUrl?: string;
  items: FindingItem[];
  /** Planning hours, and the bucket they fall in. */
  effortHours: number;
  effortSize: EffortSize;
  /** Fibonacci story points, derived from the hours — see {@link storyPoints}. */
  points: number;
  /** The epic this story rolls up to, keyed into {@link Plan.epics}. */
  epicKey: string;
  /** True when no playbook entry exists for the rule; steps fall back to the remediation sentence. */
  unscripted: boolean;
}

export interface AreaSummary {
  analyzer: AnalyzerId;
  area: string;
  score: number | null;
  grade: string | null;
  counts: Record<Severity, number>;
  examined: number;
  ruleCoverage: number;
  completedAt: number;
  apiCalls: number;
  stories: number;
  hours: number;
  points: number;
}

/** Something the plan could not judge — listed so nobody reads silence as health. */
export interface ReviewItem {
  analyzer: AnalyzerId;
  area: string;
  title: string;
  detail: string;
  /** `inconclusive` = a rule could not run; `manual` = a rule that only lists work for a person; `warning` = analyzer note; `partial` = truncated scan. */
  kind: 'inconclusive' | 'manual' | 'warning' | 'partial';
  items: FindingItem[];
}

export interface Plan {
  org: PlanOrg;
  generatedAt: number;
  areas: AreaSummary[];
  epics: Epic[];
  /** Areas with no snapshot, so the cover can say what was not scanned. */
  unscanned: AnalyzerId[];
  stories: Story[];
  review: ReviewItem[];
  totals: {
    stories: number;
    components: number;
    hours: number;
    /** Hours converted at {@link HOURS_PER_PERSON_DAY}. */
    personDays: number;
    /** Person-days converted at {@link DAYS_PER_SPRINT}, for one person. */
    sprints: number;
    points: number;
    byPriority: Record<Priority, number>;
    byKind: Record<StoryKind, number>;
    critical: number;
    warning: number;
    info: number;
  };
}

/* -------------------------------------------------------------------------- */
/* Building                                                                   */
/* -------------------------------------------------------------------------- */

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2, success: 3 };

export const PRIORITY_FOR: Record<Severity, Priority> = {
  critical: 'P1',
  warning: 'P2',
  info: 'P3',
  success: 'P3',
};

/** What a priority is called wherever a person reads it. The `P1` keys stay internal. */
/**
 * What to call the link behind a rule. Most rules cite Salesforce; the rules
 * that came from a linter cite the linter, and the label must say so — a
 * reader who clicks "Salesforce documentation" and lands on a community
 * project has been misled.
 */
export function docLabel(url: string): string {
  if (/^https:\/\/flow-scanner\.github\.io\//.test(url)) return 'Lightning Flow Scanner documentation';
  if (/^https:\/\/docs\.pmd-code\.org\//.test(url)) return 'PMD documentation';
  if (/^https:\/\/[^/]*(salesforce\.com|lightningdesignsystem\.com)\//.test(url)) return 'Salesforce documentation';
  return 'Documentation';
}

export const PRIORITY_NAME: Record<Priority, string> = {
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

export const PRIORITY_LABEL: Record<Priority, string> = {
  P1: 'High · Fix now',
  P2: 'Medium · Next sprint',
  P3: 'Low · Backlog',
};

/** Jira's default priority names, which its CSV importer maps without configuration. */
/**
 * Jira's default scheme is Highest, High, Medium, Low, Lowest. The three
 * middle values are the ones teams actually triage with, and they are the same
 * words the report shows, so a story called High here arrives in Jira as High.
 * Highest stays free for the team's own outages.
 */
export const JIRA_PRIORITY: Record<Priority, string> = {
  P1: 'High',
  P2: 'Medium',
  P3: 'Low',
};

/**
 * Bucket planning hours the way most teams size stories. The boundaries are
 * a working day and a working week, so a size reads as a calendar promise
 * rather than a number nobody remembers.
 */
export function effortSize(hours: number): EffortSize {
  if (hours <= 2) return 'XS';
  if (hours <= 8) return 'S';
  if (hours <= 24) return 'M';
  if (hours <= 80) return 'L';
  return 'XL';
}

export const EFFORT_LABEL: Record<EffortSize, string> = {
  XS: 'XS · under 2h',
  S: 'S · up to a day',
  M: 'M · up to 3 days',
  L: 'L · up to 2 weeks',
  XL: 'XL · over 2 weeks',
};

/**
 * Planning hours for a story. Per-item cost tapers after the first fifty
 * components: once a fix is routine it goes faster, and a list of four hundred
 * abandoned reports is a morning with a spreadsheet, not four hundred separate
 * jobs.
 */
export function estimateHours(playbook: Playbook | undefined, itemCount: number): number {
  if (!playbook) return Math.max(1, roundQuarter(0.5 * itemCount + 1));
  const { fixed, perItem } = playbook.effort;
  const routine = Math.min(itemCount, 50);
  const bulk = Math.max(0, itemCount - 50);
  return roundQuarter(fixed + perItem * routine + perItem * 0.4 * bulk);
}

function roundQuarter(hours: number): number {
  return Math.round(hours * 4) / 4;
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 8) return `${trim(hours)} h`;
  if (hours < 80) return `${trim(hours / 8)} d`;
  return `${trim(hours / 40)} wk`;
}

function trim(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

/**
 * Gross hours in one person-day, and person-days in one sprint.
 *
 * Both are stated on the report rather than hidden here, because they are the
 * assumptions a client will argue with. Eight hours is a *gross* day — the
 * estimates already include the reading and checking, so deflating it again for
 * "productive time" would double-count. Ten days is one person through a
 * two-week sprint; a team of three clears three times as much.
 */
export const HOURS_PER_PERSON_DAY = 8;
export const DAYS_PER_SPRINT = 10;

/**
 * Fibonacci story points from planning hours.
 *
 * Points are not another estimate — they are the same estimate in the unit a
 * sprint board wants, so the two can never disagree. Teams whose velocity is
 * calibrated differently should re-point on import; the hours are the figure to
 * trust, and the report says so.
 */
export function storyPoints(hours: number): number {
  if (hours <= 2) return 1;
  if (hours <= 4) return 2;
  if (hours <= 8) return 3;
  if (hours <= 16) return 5;
  if (hours <= 32) return 8;
  if (hours <= 64) return 13;
  return 21;
}

export function formatDays(hours: number): string {
  return trim(Math.round((hours / HOURS_PER_PERSON_DAY) * 10) / 10);
}

export function buildPlan(org: PlanOrg, results: ScanResult[], now = Date.now()): Plan {
  const stories: Story[] = [];
  const review: ReviewItem[] = [];
  const areas: AreaSummary[] = [];
  const scanned = new Set<AnalyzerId>();

  for (const result of results) {
    const area = AREA_LABEL[result.analyzer];
    scanned.add(result.analyzer);
    let areaHours = 0;
    let areaPoints = 0;
    let areaStories = 0;

    for (const finding of result.findings) {
      if (finding.inconclusive) {
        review.push({
          analyzer: result.analyzer,
          area,
          title: finding.title.replace(/ — not evaluated$/, ''),
          detail: finding.inconclusive.reason,
          kind: 'inconclusive',
          items: [],
        });
        continue;
      }
      if (finding.items.length === 0) continue;

      // Zero-weight rules cannot move a score because they describe work a
      // person has to do by hand — joined reports to open, package flows that
      // cannot be read. They are review items, not stories.
      if (finding.weight === 0) {
        review.push({
          analyzer: result.analyzer,
          area,
          title: finding.title,
          detail: finding.remediation,
          kind: 'manual',
          items: finding.items,
        });
        continue;
      }

      const playbook = PLAYBOOK[finding.id];
      const hours = estimateHours(playbook, finding.items.length);
      const points = storyPoints(hours);
      areaHours += hours;
      areaPoints += points;
      areaStories += 1;

      stories.push({
        key: '',
        points,
        epicKey: '',
        ruleId: finding.id,
        analyzer: result.analyzer,
        area,
        title: finding.title,
        severity: finding.severity,
        priority: PRIORITY_FOR[finding.severity],
        kind: playbook?.kind ?? 'debt',
        kindLabel: KIND_LABEL[playbook?.kind ?? 'debt'],
        role: playbook?.role ?? 'admin or developer',
        rationale: finding.rationale,
        remediation: finding.remediation,
        steps: playbook?.steps ?? [finding.remediation],
        acceptance: [
          ...(playbook ? [playbook.acceptance] : []),
          `Re-run the OrgTriage ${area} scan: the check "${finding.id}" reports none of the ${
            finding.items.length === 1 ? 'component' : `${finding.items.length} components`
          } listed below.`,
        ],
        docUrl: finding.docUrl,
        items: finding.items,
        effortHours: hours,
        effortSize: effortSize(hours),
        unscripted: !playbook,
      });
    }

    for (const warning of result.warnings) {
      review.push({ analyzer: result.analyzer, area, title: 'Analyzer note', detail: warning, kind: 'warning', items: [] });
    }
    if (result.truncated) {
      review.push({
        analyzer: result.analyzer,
        area,
        title: 'Partial scan',
        detail: `${result.truncated.reason} Examined ${result.truncated.examined.toLocaleString()} of ${
          result.truncated.total === null ? 'an unknown number of' : result.truncated.total.toLocaleString()
        } components.`,
        kind: 'partial',
        items: [],
      });
    }

    areas.push({
      analyzer: result.analyzer,
      area,
      score: result.score.score,
      grade: result.score.grade,
      counts: result.score.counts,
      examined: result.score.examined,
      ruleCoverage: result.score.ruleCoverage ?? 1,
      completedAt: result.completedAt,
      apiCalls: result.apiCalls,
      stories: areaStories,
      hours: areaHours,
      points: areaPoints,
    });
  }

  // Priority first, then the rule's own weight (how much the analyzer thinks
  // it matters), then breadth. The key is assigned after sorting so OT-001 is
  // the first thing to do.
  stories.sort(
    (a, b) =>
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      weightOf(results, b) - weightOf(results, a) ||
      b.items.length - a.items.length ||
      a.title.localeCompare(b.title),
  );
  stories.forEach((story, i) => {
    story.key = `OT-${String(i + 1).padStart(3, '0')}`;
  });

  /* One epic per area that actually has stories. Built after the sort so the
     epics come out in the order their first story does — the most urgent
     workstream first, which is also the order a Jira import needs them in. */
  const epics: Epic[] = [];
  const epicByArea = new Map<AnalyzerId, Epic>();
  for (const story of stories) {
    let epic = epicByArea.get(story.analyzer);
    if (!epic) {
      epic = {
        key: `OT-E${epics.length + 1}`,
        analyzer: story.analyzer,
        name: EPIC_NAME[story.analyzer],
        summary: `${EPIC_NAME[story.analyzer]} — ${AREA_LABEL[story.analyzer]} remediation for ${org.orgName}`,
        storyKeys: [],
        points: 0,
        hours: 0,
      };
      epics.push(epic);
      epicByArea.set(story.analyzer, epic);
    }
    story.epicKey = epic.key;
    epic.storyKeys.push(story.key);
    epic.points += story.points;
    epic.hours = roundQuarter(epic.hours + story.effortHours);
  }

  const totalHours = roundQuarter(stories.reduce((n, s) => n + s.effortHours, 0));
  const totals: Plan['totals'] = {
    stories: stories.length,
    components: stories.reduce((n, s) => n + s.items.length, 0),
    hours: totalHours,
    personDays: Math.round((totalHours / HOURS_PER_PERSON_DAY) * 10) / 10,
    sprints: Math.round((totalHours / HOURS_PER_PERSON_DAY / DAYS_PER_SPRINT) * 10) / 10,
    points: stories.reduce((n, s) => n + s.points, 0),
    byPriority: { P1: 0, P2: 0, P3: 0 },
    byKind: { bug: 0, debt: 0, hygiene: 0 },
    critical: 0,
    warning: 0,
    info: 0,
  };
  for (const story of stories) {
    totals.byPriority[story.priority] += 1;
    totals.byKind[story.kind] += 1;
    if (story.severity === 'critical') totals.critical += 1;
    else if (story.severity === 'warning') totals.warning += 1;
    else totals.info += 1;
  }

  const order = AREA_ORDER;
  areas.sort((a, b) => order.indexOf(a.analyzer) - order.indexOf(b.analyzer));

  return {
    org,
    generatedAt: now,
    areas,
    epics,
    unscanned: order.filter((id) => !scanned.has(id)),
    stories,
    review,
    totals,
  };
}

function weightOf(results: ScanResult[], story: Story): number {
  for (const result of results) {
    if (result.analyzer !== story.analyzer) continue;
    const finding = result.findings.find((f) => f.id === story.ruleId);
    if (finding) return finding.weight;
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Exporters                                                                  */
/* -------------------------------------------------------------------------- */

/** How many component names an export carries per story before it points at the report instead. */
const EXPORT_ITEM_LIMIT = 50;

function csvCell(value: string | number): string {
  const text = String(value);
  // Leading = + - @ would be interpreted as a formula by spreadsheet tools.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

function itemLine(item: FindingItem): string {
  const evidence = Object.entries(item.evidence ?? {})
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(', ');
  const label = item.label && item.label !== item.name ? ` (${item.label})` : '';
  return `${item.name}${label}${evidence ? ` — ${evidence}` : ''}`;
}

function itemBlock(story: Story, bullet: string): string[] {
  const lines = story.items.slice(0, EXPORT_ITEM_LIMIT).map((i) => `${bullet} ${itemLine(i)}`);
  if (story.items.length > EXPORT_ITEM_LIMIT) {
    lines.push(`${bullet} … and ${story.items.length - EXPORT_ITEM_LIMIT} more; see the OrgTriage remediation plan for the full list.`);
  }
  return lines;
}

/** Plain-text story body, shared by the CSV description and the Markdown export. */
export function storyDescription(story: Story, plan: Plan): string {
  const lines: string[] = [];
  lines.push(`Why it matters`, story.rationale, '');
  lines.push(`Steps`);
  story.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  lines.push('', `Acceptance criteria`);
  for (const a of story.acceptance) lines.push(`- ${a}`);
  lines.push('', `Affected components (${story.items.length})`, ...itemBlock(story, '-'));
  if (story.docUrl) lines.push('', `Reference: ${story.docUrl}`);
  lines.push(
    '',
    `Source: OrgTriage scan of ${plan.org.orgName} (${plan.org.orgId}) on ${new Date(plan.generatedAt).toISOString().slice(0, 10)} · rule ${story.ruleId} · estimate ${formatHours(story.effortHours)} (${story.effortSize}) · ${story.role}`,
  );
  return lines.join('\n');
}

/**
 * CSV in the shape Jira's importer maps by default (Summary, Issue Type,
 * Priority, Description, Labels), with the OrgTriage columns after. Azure
 * DevOps and most trackers accept the same file with a column mapping step.
 */
/**
 * CSV for Jira's own importer, epics included.
 *
 * Two things about Jira's CSV import shape this file, and both come from
 * Atlassian's documentation rather than from taste:
 *
 *  1. **Epics must precede their children.** The importer creates rows in file
 *     order and resolves `Epic Link` against epics that already exist, so an
 *     epic listed after its stories silently imports them unparented.
 *  2. **There are two hierarchy mechanisms** and which one a site accepts
 *     depends on its project type. Company-managed projects match `Epic Link`
 *     against `Epic Name`; the newer mechanism is `Parent` referencing an
 *     `Issue ID` within the same file. Both are emitted, because a column the
 *     importer does not recognise is simply left unmapped, whereas a missing
 *     one costs the user a second import.
 *
 * `Project key` is emitted empty. The wizard asks for the project, and a key
 * guessed here would be wrong in every org but the one it was guessed for —
 * fill it in only for a multi-project import.
 *
 * Known limitation, stated on the report as well: team-managed projects cannot
 * always expose `Parent`, so hierarchy may not survive the import there. The
 * stories still import; they arrive unparented.
 */
export function planToJiraCsv(plan: Plan): string {
  const header = [
    'Issue ID',
    'Parent',
    'Project key',
    'Summary',
    'Issue Type',
    'Epic Name',
    'Epic Link',
    'Priority',
    'Description',
    'Labels',
    'Story Points',
    'Original Estimate (hours)',
    'OrgTriage Key',
    'Area',
    'Severity',
    'Rule',
    'Components',
    'Effort Size',
    'Role',
  ];

  const rows: (string | number)[][] = [];

  for (const epic of plan.epics) {
    rows.push([
      epic.key,
      '',
      '',
      epic.summary,
      'Epic',
      epic.name,
      '',
      '',
      `${AREA_LABEL[epic.analyzer]} remediation from an OrgTriage scan of ${plan.org.orgName} (${plan.org.orgId}) on ${isoDay(plan.generatedAt)}. ${epic.storyKeys.length} stories, ${epic.points} points, ${formatHours(epic.hours)}.`,
      ['orgtriage', epic.analyzer].join(' '),
      epic.points,
      epic.hours,
      epic.key,
      AREA_LABEL[epic.analyzer],
      '',
      '',
      '',
      '',
      '',
    ]);

    for (const story of plan.stories.filter((st) => st.epicKey === epic.key)) {
      rows.push([
        story.key,
        epic.key,
        '',
        `${story.key} ${story.title}`,
        story.kind === 'bug' ? 'Bug' : 'Task',
        '',
        epic.name,
        JIRA_PRIORITY[story.priority],
        storyDescription(story, plan),
        ['orgtriage', story.analyzer, KIND_SLUG[story.kind]].join(' '),
        story.points,
        story.effortHours,
        story.key,
        story.area,
        story.severity,
        story.ruleId,
        story.items.length,
        story.effortSize,
        story.role,
      ]);
    }
  }

  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/** Retained name for the Jira export, which is what `planToCsv` always was. */
export const planToCsv = planToJiraCsv;

/**
 * A flat CSV with plain column names, for every tracker that is not Jira.
 *
 * No hierarchy columns and no tool-specific vocabulary: one row per story,
 * named so a human mapping them into Azure DevOps, Linear, Asana or a
 * spreadsheet can tell what each one is without a legend. The epic is carried
 * as an ordinary column rather than a link, because each tool spells that
 * relationship differently and a wrong guess imports badly.
 */
export function planToGenericCsv(plan: Plan): string {
  const header = [
    'Key',
    'Title',
    'Workstream',
    'Area',
    'Type',
    'Priority',
    'Severity',
    'Points',
    'Estimate (hours)',
    'Estimate (days)',
    'Effort Size',
    'Role',
    'Rule',
    'Components',
    'Component names',
    'Why it matters',
    'Steps',
    'Acceptance criteria',
    'Reference',
  ];
  const rows = plan.stories.map((story) => [
    story.key,
    story.title,
    EPIC_NAME[story.analyzer],
    story.area,
    story.kindLabel,
    PRIORITY_LABEL[story.priority],
    story.severity,
    story.points,
    story.effortHours,
    formatDays(story.effortHours),
    story.effortSize,
    story.role,
    story.ruleId,
    story.items.length,
    story.items.slice(0, EXPORT_ITEM_LIMIT).map((i) => i.name).join('; '),
    story.rationale,
    story.steps.map((step, i) => `${i + 1}. ${step}`).join('\n'),
    story.acceptance.join('\n'),
    story.docUrl ?? '',
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

/**
 * The whole plan as JSON, for anyone driving a tracker's API rather than its
 * importer.
 *
 * Deliberately the plan model itself rather than a bespoke shape: the fields
 * are the ones documented in this file, and a consumer that wants something
 * else can map it. `schema` is a version marker so a script can fail loudly
 * against a future change instead of quietly reading a field that moved.
 */
export function planToJson(plan: Plan): string {
  return JSON.stringify(
    {
      schema: 'orgtriage.plan/1',
      generatedAt: new Date(plan.generatedAt).toISOString(),
      org: plan.org,
      assumptions: {
        hoursPerPersonDay: HOURS_PER_PERSON_DAY,
        daysPerSprint: DAYS_PER_SPRINT,
        note: 'Estimates are planning figures for an experienced Salesforce admin or developer, with per-component cost tapering after fifty components. Points are derived from the hours, not estimated separately.',
        disclaimer:
          'OrgTriage is a diagnostic tool, not an adviser. Every item below is a recommendation: have an experienced Salesforce administrator or developer verify it, test the change outside production, and deploy it through your normal release process. Provided as is, without warranty.',
      },
      totals: plan.totals,
      areas: plan.areas,
      epics: plan.epics,
      stories: plan.stories,
      review: plan.review,
    },
    null,
    2,
  );
}

function isoDay(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

export function planToMarkdown(plan: Plan): string {
  const date = new Date(plan.generatedAt);
  const lines: string[] = [];
  lines.push(`# Remediation plan — ${plan.org.orgName}`, '');
  lines.push(
    `${plan.org.organizationType}${plan.org.isSandbox ? ' (sandbox)' : ''} · ${plan.org.instanceName} · API v${plan.org.apiVersion} · generated ${date.toISOString().slice(0, 10)} by OrgTriage${plan.org.userName ? ` for ${plan.org.userName}` : ''}`,
    '',
  );
  lines.push(`> OrgTriage is a diagnostic tool, not an adviser. Every item below is a recommendation: have an experienced Salesforce administrator or developer verify it, test the change outside production, and deploy it through your normal release process. Provided as is, without warranty.`, '');
  lines.push('## Summary', '');
  lines.push('| Area | Score | High | Medium | Low | Examined | Checks evaluated | Items | Estimate |');
  lines.push('|---|---|---|---|---|---|---|---|---|');
  for (const a of plan.areas) {
    lines.push(
      `| ${a.area} | ${a.score === null ? 'not graded' : `${a.score} (${a.grade})`} | ${a.counts.critical} | ${a.counts.warning} | ${a.counts.info} | ${a.examined} | ${Math.round(a.ruleCoverage * 100)}% | ${a.stories} | ${formatHours(a.hours)} |`,
    );
  }
  for (const id of plan.unscanned) lines.push(`| ${AREA_LABEL[id]} | not scanned | | | | | | | |`);
  lines.push(
    '',
    `**${plan.totals.stories} backlog items** covering ${plan.totals.components} components · ${plan.totals.byPriority.P1} high, ${plan.totals.byPriority.P2} medium, ${plan.totals.byPriority.P3} low priority · ${plan.totals.byKind.bug} bug, ${plan.totals.byKind.debt} tech debt, ${plan.totals.byKind.hygiene} maintenance · planning estimate ${formatHours(plan.totals.hours)}`,
    '',
  );

  lines.push('## Backlog', '');
  lines.push('| Key | Item | Area | Priority | Type | Components | Size | Estimate |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const s of plan.stories) {
    lines.push(`| ${s.key} | ${s.title} | ${s.area} | ${PRIORITY_NAME[s.priority]} | ${s.kindLabel} | ${s.items.length} | ${s.effortSize} | ${formatHours(s.effortHours)} |`);
  }
  lines.push('');

  lines.push('## Backlog items', '');
  for (const s of plan.stories) {
    lines.push(`### ${s.key} — ${s.title}`, '');
    lines.push(`*${s.area} · ${PRIORITY_LABEL[s.priority]} · ${s.kindLabel} · ${s.role} · ${EFFORT_LABEL[s.effortSize]} (${formatHours(s.effortHours)})*`, '');
    lines.push('**Why it matters.** ' + s.rationale, '');
    lines.push('**Steps**', '');
    s.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push('', '**Acceptance criteria**', '');
    for (const a of s.acceptance) lines.push(`- ${a}`);
    lines.push('', `**Affected components (${s.items.length})**`, '', ...itemBlock(s, '-'));
    if (s.docUrl) lines.push('', `Reference: ${s.docUrl}`);
    lines.push('');
  }

  if (plan.review.length > 0) {
    lines.push('## Not evaluated or needs a person', '');
    lines.push('These items could not be judged from the API and are not counted in the backlog items above.', '');
    for (const r of plan.review) {
      lines.push(`- **${r.area} · ${r.title}** — ${r.detail}`);
      for (const item of r.items.slice(0, EXPORT_ITEM_LIMIT)) lines.push(`  - ${itemLine(item)}`);
      if (r.items.length > EXPORT_ITEM_LIMIT) lines.push(`  - … and ${r.items.length - EXPORT_ITEM_LIMIT} more`);
    }
    lines.push('');
  }

  lines.push('---', '', 'Estimates are planning figures for an experienced admin or developer working in a sandbox with a normal release process. Generated by OrgTriage from metadata; no business records were read, and the people-related fields it does read are listed in its privacy policy.');
  return lines.join('\n') + '\n';
}
