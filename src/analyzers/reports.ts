/**
 * Reports and dashboards analyzer.
 *
 * Deliberate constraint: **this analyzer never runs a report.** The org's
 * synchronous report-run allowance is 500/hour and dashboard refreshes are
 * 200/hour, both shared with the customer's real integrations and schedules.
 * An audit that measured row counts by executing reports could break the
 * business it was auditing. Everything here is inferred from inventory SOQL and
 * the `describe` metadata, neither of which executes anything.
 *
 * Three facts about the Report object drive the rules and the wording:
 *  - `LastRunDate` is the only *org-wide* staleness signal. `LastViewedDate` and
 *    `LastReferencedDate` are per-current-user, so "nobody has opened this"
 *    cannot be answered from them and the UI says so rather than implying it.
 *  - `Report.OwnerId` is the containing **folder** id, not a user. `00D` means
 *    Unfiled Public Reports; `005` means someone's private folder.
 *  - Dashboard's display field is `Title`; Report's is `Name`.
 *
 * Docs:
 *   https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_report.htm
 *   https://developer.salesforce.com/docs/analytics/salesforce-analytics-rest-api/guide/sforce-analytics-rest-api-getbasic-reportmetadata.html
 */

import type { Finding, FindingItem } from '@/shared/types';
import { SalesforceError } from '@/background/sfClient';
import {
  capped,
  checkCancelled,
  summarise,
  type RuleOutcome,
  daysSince,
  finding,
  groupBy,
  inconclusive,
  recordUrl,
  setupUrl,
  tryQuery,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzerOutput,
  type Phase,
  type RuleSpec,
} from './framework';

/** OrgTriage recommendation: days without a run before a report reads abandoned. */
const ABANDONED_DAYS = 365;

/** Days without a dashboard refresh before it is treated as stale. */
const STALE_DASHBOARD_DAYS = 90;

interface ReportRow {
  Id: string;
  Name: string;
  DeveloperName: string;
  FolderName: string | null;
  Format: string;
  LastRunDate: string | null;
  LastViewedDate: string | null;
  Description: string | null;
  OwnerId: string;
}

interface DashboardRow {
  Id: string;
  Title: string;
  DeveloperName: string;
  FolderId: string;
  FolderName: string | null;
  RunningUserId: string;
  Type: string;
  Description: string | null;
  DashboardResultRefreshedDate: string | null;
}

interface DashboardComponentRow {
  Id: string;
  Name: string | null;
  DashboardId: string;
  CustomReportId: string | null;
}

/** One entry of `reportMetadata.reportFilters`. Verified shape from a live org. */
interface ReportFilter {
  column?: string;
  operator?: string;
  value?: string;
  filterType?: string;
}

/** One entry of `reportMetadata.crossFilters` (Analytics REST API reference). */
interface CrossFilter {
  /** `true` = "with", `false` = "without" — the anti-join, which is the expensive one. */
  includesObject?: boolean;
  primaryEntityField?: string;
  relatedEntity?: string;
  relatedEntityJoinField?: string;
  criteria?: unknown[];
}

interface ReportDescribe {
  /** Column-level detail keyed by column name; `dataType` is what the
   *  performance rules read (`textarea`, `html`, …). */
  reportExtendedMetadata?: {
    detailColumnInfo?: Record<string, { label?: string; dataType?: string }>;
  };
  reportMetadata?: {
    id?: string;
    name?: string;
    reportType?: { type?: string; label?: string };
    reportFormat?: string;
    reportFilters?: ReportFilter[];
    crossFilters?: CrossFilter[];
    /** Bucket fields are evaluated for every row at run time. */
    buckets?: unknown[];
    /** Custom summary formulas; a keyed map in the API. */
    customSummaryFormula?: Record<string, unknown> | unknown[] | null;
    /** Row-level formulas; recalculated for every row at run time. */
    customDetailFormula?: Record<string, unknown> | unknown[] | null;
    /** `[{ name: 'open', value: 'all' }, …]`. Verified shape; may be null. */
    standardFilters?: { name?: string; value?: string }[] | null;
    /**
     * Joined (`MULTI_BLOCK`) reports keep their filters *per block* here, and
     * leave every top-level filter array empty. Modelled only so the analyzer
     * can recognise the shape and decline to judge it — see `isUnfiltered`.
     */
    blocks?: unknown[];
    reportBooleanFilter?: string | null;
    topRows?: { rowLimit?: number } | null;
    standardDateFilter?: { column?: string; durationValue?: string; startDate?: string; endDate?: string } | null;
    detailColumns?: string[];
    groupingsDown?: { name?: string }[];
    groupingsAcross?: { name?: string }[];
    scope?: string;
    userOrHierarchyFilterId?: string | null;
    hasDetailRows?: boolean;
  };
}

type ReportMetadata = NonNullable<ReportDescribe['reportMetadata']>;

interface ReportTypeFolder {
  label: string;
  reportTypes?: { type?: string; label?: string; isHidden?: boolean; isHistorical?: boolean }[];
  'report-types'?: { type?: string; label?: string; isHidden?: boolean; isHistorical?: boolean }[];
}

/** Salesforce Help: Improve Report Performance. */
const PERF_DOC =
  'https://help.salesforce.com/s/articleView?id=analytics.improving_report_performance.htm&type=5';

/** Columns beyond which a report reads as a data extract rather than a report. */
const MAX_COLUMNS = 20;

/** Days beyond which a resolved date range counts as wide (two years). */
const WIDE_RANGE_DAYS = 731;

const RULES = {
  abandoned: {
    id: 'reports.abandoned',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'report has' : 'reports have'} not been run in over a year`,
    rationale:
      'Reports that nobody runs still appear in every folder picker and every report chooser, and they still ' +
      'have to be migrated and tested when the underlying objects change. LastRunDate is the only org-wide ' +
      'signal Salesforce exposes — view timestamps are per-user and cannot answer "has anyone opened this".',
    remediation:
      'Move them to an archive folder for a release. If nobody asks, delete them.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_report.htm',
    weight: 12,
  },
  neverRun: {
    id: 'reports.never-run',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report has' : 'reports have'} never been run`,
    rationale:
      'A report with no LastRunDate has not executed since the field started being populated. These are usually ' +
      'abandoned copies made during a project.',
    remediation: 'Confirm with the owning team, then delete.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000384824&type=1',
    weight: 6,
  },
  unfiltered: {
    id: 'reports.no-filters',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'report scans' : 'reports scan'} the whole object with no filter`,
    rationale:
      'With no report filters, no cross filters, no row limit, and no effective date range, the report reads ' +
      'every record the running user can see. On a large object this times out, and when it does run it puts ' +
      'sustained load on the org for every user who opens it.',
    remediation:
      'Add a date range filter (the standard date filter is the cheapest) or a scope filter such as My Records or a status.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.improving_report_performance.htm&type=5',
    weight: 22,
  },
  hiddenReportType: {
    id: 'reports.hidden-report-type',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'report uses' : 'reports use'} a hidden report type`,
    rationale:
      'The report type has been hidden in Setup, so it no longer appears when creating a report. Existing ' +
      'reports on it keep working, but nobody can build a replacement, and hidden usually precedes removal.',
    remediation:
      'Either unhide the report type or migrate these reports to a supported one before it is deleted.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.reports_hide_report_types.htm&type=5',
    weight: 14,
  },
  privateFolder: {
    id: 'reports.private-folder',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report lives' : 'reports live'} in a personal folder`,
    rationale:
      'Reports in a user’s private folder cannot be shared, are invisible to everyone else, and are lost when ' +
      'that user is deactivated.',
    remediation: 'Move anything the team relies on into a shared folder.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.analytics_sharing.htm&type=5',
    weight: 6,
  },
  unfiled: {
    id: 'reports.unfiled-public',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report sits' : 'reports sit'} in Unfiled Public Reports`,
    rationale:
      'The Unfiled Public Reports folder cannot be shared selectively — everyone with report access sees ' +
      'everything in it. It is also where reports land when nobody chose a folder.',
    remediation: 'File these into a folder with deliberate sharing.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000385538&type=1',
    weight: 5,
  },
  duplicates: {
    id: 'reports.duplicate-candidates',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'group of reports looks' : 'groups of reports look'} duplicated`,
    rationale:
      'These reports share a report type, the same columns, and the same groupings. Usually somebody cloned a ' +
      'report rather than adding a filter to the original. Salesforce offers no duplicate-detection API, so ' +
      'this is a structural comparison of the describe payloads.',
    remediation: 'Keep one, add filters for the variations, and delete the clones.',
    weight: 5,
  },
  brokenComponent: {
    id: 'dashboards.broken-component',
    // A warning, not critical: what the scan can prove is only that the
    // report was not visible to it. Only a person can tell whether viewers
    // are actually seeing a broken chart.
    severity: 'warning',
    title: (n) => `${n} dashboard ${n === 1 ? 'component points' : 'components point'} at a report this scan could not find`,
    rationale:
      'The component references a report id that neither the shared listing nor the private-folder sweep ' +
      'returned. Salesforce will not delete a report while a dashboard component uses it, so the report most ' +
      'likely still exists in a folder this scan could not see. Either way the component cannot be checked, ' +
      'and dashboards tend to be the most-watched screens in the org.',
    remediation:
      'Open the report by the id in the finding. If it exists, move it to a folder the dashboard’s viewers can ' +
      'see; if it does not, repoint the component at another report or remove it.',
    weight: 12,
  },
  staleDashboard: {
    id: 'dashboards.stale',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'dashboard has' : 'dashboards have'} not refreshed recently`,
    rationale:
      'A dashboard showing months-old numbers is worse than no dashboard: people make decisions on it without ' +
      'noticing the date. Dashboards only refresh on a schedule or when someone clicks Refresh.',
    remediation: 'Set a refresh schedule, or retire the dashboard if nobody needs it current.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.dashboards_refresh.htm&type=5',
    weight: 12,
  },
  dynamicDashboard: {
    id: 'dashboards.running-user',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'dashboard runs' : 'dashboards run'} as a fixed user`,
    rationale:
      'Every viewer sees the data of the running user, not their own. That is often intended — and often a ' +
      'quiet data-visibility problem, because it can show viewers records their own permissions would hide.',
    remediation:
      'Confirm the running user is deliberate. Switch to "run as the logged-in user" where viewers should see only their own data.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.dashboards_view_as.htm&type=5',
    weight: 8,
  },
  emptyDashboard: {
    id: 'dashboards.no-components',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'dashboard has' : 'dashboards have'} no components`,
    rationale: 'An empty dashboard is a leftover from a project that was started and abandoned.',
    remediation: 'Delete them.',
    weight: 4,
  },
  joinedNotChecked: {
    id: 'reports.joined-not-checked',
    severity: 'info',
    title: (n) => `${n} joined ${n === 1 ? 'report was' : 'reports were'} not checked for filters`,
    rationale:
      'A joined report keeps its filters and date ranges inside each block, and leaves every top-level ' +
      'filter array empty. Judging one by its top-level metadata would report every joined report in the ' +
      'org as an unfiltered full scan, so they are listed here instead of guessed at.',
    remediation: 'Open each report and confirm every block carries a date range or filter.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.reports_joined_format_concepts.htm&type=5',
    weight: 0,
  },

  /* --- Performance: Salesforce's "Improve Report Performance" guidance ---- */
  perfInefficientFilters: {
    id: 'reports.perf.inefficient-filters',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'report filters' : 'reports filter'} with operators that cannot drive an index`,
    rationale:
      '"Contains", "does not contain", "not equal to" and "excludes" cannot be answered from an index ' +
      'on the filtered field, so that filter contributes nothing to narrowing the scan — the rows are ' +
      'read and tested one by one unless another, selective filter on the report does the narrowing. ' +
      'Salesforce’s report-performance guidance recommends exact-value filters on selective fields for ' +
      'this reason. Whether a given report is actually slow depends on its other filters and its ' +
      'volume; this rule flags the shape, not a measurement.',
    remediation:
      'Rewrite the filter as "equals" or "starts with" only where the answer stays the same; "contains" and ' +
      '"starts with" are different questions. Where the text search is unavoidable, add a selective filter ' +
      'on a picklist or an indexed field alongside it, so the optimizer has an index it can drive from.',
    docUrl: PERF_DOC,
    weight: 10,
  },
  perfWideDateRange: {
    id: 'reports.perf.wide-date-range',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'report covers' : 'reports cover'} more than two years of data`,
    rationale:
      'The standard date filter is the cheapest limit a report has, and All Time or a multi-year range ' +
      'reads every record in scope even when other filters are present. These reports already have some ' +
      'filter — the full-scan rule covers the ones with none — so this is the next thing to narrow.',
    remediation:
      'Set a relative range such as THIS YEAR or LAST N DAYS. Clone the report for historical analysis rather than widening the one people run daily.',
    docUrl: PERF_DOC,
    weight: 8,
  },
  perfCrossFilters: {
    id: 'reports.perf.cross-filters',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report uses' : 'reports use'} cross filters`,
    rationale:
      'A cross filter resolves as a join against the related object — a semi-join for "with", and for ' +
      '"without" an anti-join, which has to establish the absence of a match rather than find one. ' +
      '"Without" is the expensive form, and stacking two or more multiplies the cost. Salesforce ' +
      'advises against multiple cross filters and against any cross filter on an object with millions of rows.',
    remediation:
      'Keep one cross filter at most. Where a "without" is doing the work, capture the fact on the parent ' +
      'instead: a roll-up summary count on a master-detail relationship, otherwise a count or checkbox ' +
      'maintained by a record-triggered flow. A plain formula field cannot count child records.',
    docUrl: PERF_DOC,
    weight: 6,
  },
  perfManyColumns: {
    id: 'reports.perf.many-columns',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report has' : 'reports have'} more than ${MAX_COLUMNS} columns`,
    rationale:
      'Every column is fetched, formatted and transmitted for every row. Salesforce’s performance guidance ' +
      'says to remove columns nobody reads, and a report this wide is rarely read as a table. Salesforce ' +
      `names no column count, so ${MAX_COLUMNS} is an OrgTriage recommendation derived from that guidance.`,
    remediation: 'Remove columns that are not used for filtering, grouping or a decision. Split it into two reports if two audiences need different columns.',
    docUrl: PERF_DOC,
    weight: 5,
  },
  perfLongTextColumns: {
    id: 'reports.perf.long-text-columns',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report includes' : 'reports include'} long text or rich text columns`,
    rationale:
      'Long text area and rich text fields hold up to 131,072 characters each and are the widest values a ' +
      'report can carry. One of them can outweigh every other column on the row, and the payload is paid on ' +
      'both the run and the render.',
    remediation: 'Remove them from the report columns; open the record for the full text when needed.',
    docUrl: PERF_DOC,
    weight: 5,
  },
  correctnessLongTextFilter: {
    id: 'reports.correctness.long-text-filter',
    severity: 'warning',
    title: (n) =>
      `${n} ${n === 1 ? 'report filters' : 'reports filter'} on a long text field, which a filter searches only to its first 255 characters (custom) or 1,000 (standard)`,
    rationale:
      'This is a wrong-answers problem, not a slow-reports problem. A report filter on a custom Long Text ' +
      'Area or Rich Text Area field searches only the first 255 characters of it (Salesforce\u2019s rich text page ' +
      'says 254 for "contains"; neither number has been measured by OrgTriage, and the difference does not ' +
      'change the advice); on a standard long text ' +
      'field such as Description or Solution Details, the first 1,000. The field itself holds up to 131,072. ' +
      'A record whose match sits past the cut-off is simply absent from the results — no error, no warning, ' +
      'and nothing on the report to suggest the rows exist. Someone builds a report, gets twelve rows, and ' +
      'has no reason to think there are fifty. The field types come from the org\'s own field catalogue, so ' +
      'this covers filters on fields the report never displays — and does not fire on a plain 255-character ' +
      'Text Area, where the cut-off costs at most the last character.',
    remediation:
      'Stop filtering on the long text field. Compute the answer once, on save, into a field the database ' +
      'can actually search: a formula field where the logic allows, otherwise a checkbox or picklist set by ' +
      'a record-triggered flow, and filter on that instead. It is also indexable, which the long text field ' +
      'never will be.',
    // Salesforce Help, "Filter Restrictions for Text Area (Long) Fields in
    // Salesforce" — the article that states the 255-character limit on the
    // `contains` operator for custom fields. The Rich Text Area considerations
    // page says 254; the rule quotes the article it links to (FACTS, "254 or
    // 255"). Confirmed against the article index before citing.
    docUrl: 'https://help.salesforce.com/s/articleView?id=000386801&language=en_US&type=1',
    weight: 14,
  },
  perfRuntimeFormulas: {
    id: 'reports.perf.runtime-formulas',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report leans' : 'reports lean'} on row-level or many summary formulas`,
    rationale:
      'Row-level and custom summary formulas are recalculated on every run, for every row. Salesforce ' +
      'recommends moving frequently used row-level report formulas into formula fields on the object. ' +
      'A formula field is still evaluated when read, but the report no longer carries the logic, and the ' +
      'same field serves every report that needs it.',
    remediation:
      'Promote a row-level formula that several reports repeat into a field, where its logic fits an object ' +
      'formula. Summary formulas work on groupings and stay in the report.',
    docUrl: PERF_DOC,
    weight: 5,
  },
  perfDetailRows: {
    id: 'reports.perf.detail-rows',
    severity: 'info',
    title: (n) => `${n} summary or matrix ${n === 1 ? 'report shows' : 'reports show'} detail rows`,
    rationale:
      'A summary or matrix report exists for its subtotals. With Details on, every underlying row is also ' +
      'fetched and rendered, which is the bulk of the run time on a large report and is rarely what a ' +
      'dashboard viewer needs.',
    remediation: 'Turn off "Detail Rows" in the report builder. Use a tabular report where the rows themselves are the point.',
    docUrl: PERF_DOC,
    weight: 4,
  },
  perfNoRowLimit: {
    id: 'reports.perf.no-row-limit',
    severity: 'info',
    title: (n) => `${n} tabular ${n === 1 ? 'report has' : 'reports have'} no row limit`,
    rationale:
      'A tabular report with no "Rows to Display" limit returns every matching row up to the platform cap. ' +
      'Most tabular reports are read from the top; a limit with a sort gives the same answer for a fraction of the work.',
    remediation: 'Set Rows to Display with a sort order, or convert to a summary report.',
    docUrl: PERF_DOC,
    weight: 4,
  },
  perfOrLogic: {
    id: 'reports.perf.or-logic',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report combines' : 'reports combine'} filters with OR`,
    rationale:
      'OR does not rule out an index, it raises the bar for one: the optimizer can use an index across an OR ' +
      'only when every field in the condition is indexed and each one clears its own selectivity threshold. ' +
      'A single unindexed or unselective branch drops the whole condition to a full scan.',
    remediation:
      'Check that every field named in the OR is indexed and selective on its own. Where that is not achievable, ' +
      'replace OR across different fields with one picklist or checkbox that captures the same condition and filter with equals.',
    docUrl: PERF_DOC,
    weight: 4,
  },
  perfBuckets: {
    id: 'reports.perf.bucket-fields',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report has' : 'reports have'} two or more bucket fields`,
    rationale:
      'A bucket exists only inside the report, so the database knows nothing about it: the rows are fetched ' +
      'first and bucketed afterwards, and no index can apply to a bucket filter. One is fine; several on a ' +
      'large report add up.',
    remediation: 'Promote a bucket that reports reuse into a formula or picklist field on the object.',
    docUrl: PERF_DOC,
    weight: 4,
  },
  perfDeepGroupings: {
    id: 'reports.perf.deep-groupings',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'report groups' : 'reports group'} three or more levels deep`,
    rationale:
      'Every grouping level is another sort and another set of subtotals over the whole result. Three row ' +
      'groupings is as deep as a summary report goes, so a report at three is at the ceiling with nothing ' +
      'left to add — and most readers stop at two.',
    remediation: 'Drop the innermost grouping, or move it to a filter so the report answers one question.',
    docUrl: PERF_DOC,
    weight: 3,
  },
  perfUnindexedFilters: {
    id: 'reports.perf.unindexed-filters',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'report filters' : 'reports filter'} on custom fields with no index`,
    rationale:
      'A filter on an unindexed field cannot drive the query; the database reads every candidate row and ' +
      'tests each one. Salesforce indexes the record Id, Name, RecordTypeId, Division, CreatedDate, ' +
      'SystemModstamp, lookup and master-detail fields (Owner among them), and any field marked External ID ' +
      'or Unique. Note what is not on that list: LastModifiedDate is not a standard index — SystemModstamp ' +
      'is the indexed one, and a "last modified" filter is a common way to end up scanning. Any other custom ' +
      'field needs a custom index, which only Salesforce Support can add. A report is not written in SOQL, ' +
      'but it runs as a database query through the same query optimizer, so the indexing rules are the same ' +
      'ones Salesforce documents for queries. This check names custom fields only — standard report-type ' +
      'columns do not map back to a field API name.',
    remediation:
      'Add a selective filter on an indexed field, or mark the field External ID if it holds unique keys, ' +
      'or open a Support case for a custom index on it. Where the filter sits in the list does not matter — ' +
      'the query optimizer picks what drives the query by selectivity, not by order.',
    // Salesforce Help, "Improve Report Performance" — the report-side article
    // an admin reads. The custom-index mechanics come from the SOQL articles
    // recorded in FACTS.md ("Filter ORDER does not affect report performance"),
    // which an earlier version linked here; an admin who cannot write SOQL
    // found that link beside the point, and they were right.
    docUrl: PERF_DOC,
    weight: 8,
  },
  largeObjects: {
    id: 'reports.large-objects',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'object holds' : 'objects hold'} more than a million records`,
    rationale:
      'Past a million rows, report tuning has limits of its own: selective filters and indexes keep a ' +
      'report usable, but every unfiltered report, every "All Time" range and every cross filter on the ' +
      'object pays the full price. At this size the conversation is also about archiving, skinny tables ' +
      'and Big Objects, which only a plan can arrange.',
    remediation:
      'Treat every report on these objects as a candidate for the filter rules above, and plan data volume management: archive closed records, request a skinny table for the hottest report, or move history to a Big Object.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.salesforce_large_data_volumes_bp.meta/salesforce_large_data_volumes_bp/ldv_deployments_introduction.htm',
    weight: 4,
  },
  dashboardInactiveRunningUser: {
    id: 'dashboards.inactive-running-user',
    severity: 'warning',
    title: (n) =>
      `${n} ${n === 1 ? 'dashboard runs' : 'dashboards run'} as a deactivated user`,
    rationale:
      'A dashboard with a fixed running user shows everyone that user’s data, and deactivating the user ' +
      'does not switch the dashboard off — it stops the refresh. The components keep displaying whatever ' +
      'they last held, with a refresh date most people never look at, so the failure presents as numbers ' +
      'that quietly stopped moving rather than as an error. It is the same shape as a scheduled job whose ' +
      'owner left.',
    remediation:
      'Set a running user who is active — an integration or service account rather than a person, so the ' +
      'next leaver does not take the dashboard with them — and confirm every viewer is entitled to see ' +
      'that user’s data before you pick one. Then refresh and check the date moves.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.dashboards_view_as.htm&type=5',
    weight: 12,
  },
  dashboardFilterLoad: {
    id: 'dashboards.filter-load',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'dashboard multiplies' : 'dashboards multiply'} report runs through its filters`,
    rationale:
      'A filter selection is not free: a dashboard caches the result of the selection it was refreshed with, so ' +
      'every other combination a viewer picks runs each component’s source report again. Filter values are ' +
      'therefore a multiplier on how many distinct runs the dashboard can require — up to components × ' +
      'selections — against the org’s shared hourly report allowance. Salesforce publishes no per-refresh ' +
      'figure, so the count below is that worst case, not a measurement. Dynamic dashboards make it worse: they ' +
      'cannot be scheduled and are refreshed by hand.',
    remediation:
      'Trim filter options nobody selects, keep the number of filters down, feed several components from one report, ' +
      'and schedule the refresh off-peak where the running user allows it.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=analytics.dashboard_filters_overview.htm&type=5',
    weight: 5,
  },
} satisfies Record<string, RuleSpec>;

/** Every rule id this analyzer can raise — the playbook is checked against it. */
export const REPORT_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

/** Rules driven by {@link performanceIssues}, keyed by the issue it reports. */
const PERF_RULES = {
  inefficientFilters: RULES.perfInefficientFilters,
  wideDateRange: RULES.perfWideDateRange,
  crossFilters: RULES.perfCrossFilters,
  manyColumns: RULES.perfManyColumns,
  longTextColumns: RULES.perfLongTextColumns,
  longTextFilter: RULES.correctnessLongTextFilter,
  runtimeFormulas: RULES.perfRuntimeFormulas,
  detailRows: RULES.perfDetailRows,
  noRowLimit: RULES.perfNoRowLimit,
  orLogic: RULES.perfOrLogic,
  buckets: RULES.perfBuckets,
  deepGroupings: RULES.perfDeepGroupings,
} as const;

export type PerformanceIssue = keyof typeof PERF_RULES;

export const reportsAnalyzer: Analyzer = {
  id: 'reports',
  label: 'Reports',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const skip = (reason: string) => warnings.push(reason);
    const outcomes: RuleOutcome[] = [];

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading report inventory', fraction: 0.05 };

    const reportResult = await tryQuery(
      () =>
        ctx.client.query<ReportRow>(
          'SELECT Id, Name, DeveloperName, FolderName, Format, LastRunDate, LastViewedDate, ' +
            'Description, OwnerId FROM Report',
        ),
      skip,
      'Report inventory',
    );
    if (!reportResult) {
      for (const rule of Object.values(RULES)) {
        outcomes.push(inconclusive('reports', rule, 'The report inventory could not be read, so no report or dashboard was examined.'));
      }
      const summary = summarise(RULES, outcomes);
      return {
        metrics: { Reports: { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }
    const reports = reportResult.records;

    // Ids only, over `USING SCOPE allPrivate`, purely so the dashboard
    // cross-reference below can tell "this report is in someone's private
    // folder" from "this report was deleted". Without it, a rep's private
    // dashboard over their own private report is reported as a critical
    // broken component — the default query scope cannot see either.
    const privateIds = await tryQuery(
      () => ctx.client.query<{ Id: string }>('SELECT Id FROM Report USING SCOPE allPrivate'),
      skip,
      'Private report visibility (needs "Manage All Private Reports and Dashboards")',
    );

    const reportIds = new Set(reports.map((r) => r.Id));
    /** Every report id we know exists, visible to this user or not. */
    const knownReportIds = new Set(reportIds);
    for (const row of privateIds?.records ?? []) knownReportIds.add(row.Id);

    warnings.push(
      'Report view counts are per-user in Salesforce, so "nobody has opened this" cannot be determined. ' +
        'Abandonment here is based on LastRunDate, which is org-wide.',
    );

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading dashboards', fraction: 0.25 };

    const dashboardResult = await tryQuery(
      () =>
        ctx.client.query<DashboardRow>(
          'SELECT Id, Title, DeveloperName, FolderId, FolderName, RunningUserId, Type, ' +
            'Description, DashboardResultRefreshedDate FROM Dashboard',
        ),
      skip,
      'Dashboard inventory',
    );
    const dashboards = dashboardResult?.records ?? [];

    // DashboardComponent gives the dashboard→report edges in one query, but the
    // CustomReportId field requires "Manage All Private Reports and Dashboards".
    // Without it the bulk path silently yields nulls, so a failure here is
    // reported rather than treated as "no broken components".
    const componentResult = await tryQuery(
      () =>
        ctx.client.query<DashboardComponentRow>(
          'SELECT Id, Name, DashboardId, CustomReportId FROM DashboardComponent',
        ),
      skip,
      'Dashboard component mapping (needs "Manage All Private Reports and Dashboards")',
    );
    const components = componentResult?.records ?? [];

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading report types', fraction: 0.4 };

    const hiddenTypes = await readHiddenReportTypes(ctx, skip);

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Describing reports', fraction: 0.55 };

    // Describe is one call per report and there is no bulk alternative, so
    // prioritise the reports most likely to be actively hurting: recently run
    // first, since an unfiltered report nobody runs costs nothing.
    const describeTargets = capped(
      [...reports].sort((a, b) => (Date.parse(b.LastRunDate ?? '') || 0) - (Date.parse(a.LastRunDate ?? '') || 0)),
      ctx.detailBudget,
      (dropped) =>
        warnings.push(
          `Filter analysis covered the ${ctx.detailBudget} most recently run reports; ${dropped} more were not described.`,
        ),
    );

    const describeRun = yield* describeReports(ctx, describeTargets, skip);
    const describes = describeRun.describes;
    /** Did the describe pass produce enough to judge filters at all? */
    const describesUsable = describes.size > 0;

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Evaluating rules', fraction: 0.85 };

    /* --- Report inventory rules -------------------------------------- */
    const abandoned: FindingItem[] = [];
    const neverRun: FindingItem[] = [];
    const privateFolder: FindingItem[] = [];
    const unfiled: FindingItem[] = [];

    for (const report of reports) {
      const age = daysSince(report.LastRunDate);
      if (report.LastRunDate === null) {
        neverRun.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          setupUrl: recordUrl(ctx.lightningHost, report.Id),
          evidence: { Folder: report.FolderName, Format: report.Format },
        });
      } else if (age !== null && age > ABANDONED_DAYS) {
        abandoned.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          setupUrl: recordUrl(ctx.lightningHost, report.Id),
          evidence: { 'Days since run': age, Folder: report.FolderName, Format: report.Format },
        });
      }

      // OwnerId is the folder: 005 = a user's private folder, 00D = Unfiled Public.
      if (report.OwnerId?.startsWith('005')) {
        privateFolder.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          evidence: { 'Owner (folder)': report.OwnerId, 'Last run': report.LastRunDate },
        });
      } else if (report.OwnerId?.startsWith('00D')) {
        unfiled.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          evidence: { Folder: 'Unfiled Public Reports', 'Last run': report.LastRunDate },
        });
      }
    }

    outcomes.push(finding('reports', RULES.abandoned, abandoned.sort(byEvidenceDesc('Days since run'))));
    outcomes.push(finding('reports', RULES.neverRun, neverRun));
    outcomes.push(finding('reports', RULES.privateFolder, privateFolder));
    outcomes.push(finding('reports', RULES.unfiled, unfiled));

    /* --- Describe-derived rules -------------------------------------- */
    const unfiltered: FindingItem[] = [];
    const joined: FindingItem[] = [];
    const hidden: FindingItem[] = [];
    const signatures = new Map<string, ReportRow[]>();
    const perfItems: Record<PerformanceIssue, FindingItem[]> = {
      inefficientFilters: [],
      wideDateRange: [],
      crossFilters: [],
      manyColumns: [],
      longTextColumns: [],
      longTextFilter: [],
      runtimeFormulas: [],
      detailRows: [],
      noRowLimit: [],
      orLogic: [],
      buckets: [],
      deepGroupings: [],
    };
    /** Reports with at least one performance issue, for the metric. */
    const perfFlagged = new Set<string>();
    /** Did any describe carry column data types? Without them the long-text rule cannot run. */
    let sawColumnInfo = false;

    for (const report of describeTargets) {
      const describe = describes.get(report.Id);
      if (!describe?.reportMetadata) continue;
      const meta = describe.reportMetadata;
      if (describe.reportExtendedMetadata?.detailColumnInfo) sawColumnInfo = true;

      const issues = performanceIssues(meta, describe.reportExtendedMetadata);
      if (issues) {
        for (const issue of issues) {
          perfFlagged.add(report.Id);
          perfItems[issue.key].push({
            id: report.Id,
            name: report.DeveloperName,
            label: report.Name,
            setupUrl: recordUrl(ctx.lightningHost, report.Id),
            evidence: { ...issue.evidence, 'Last run': report.LastRunDate, Folder: report.FolderName },
          });
        }
      }

      const verdict = isUnfiltered(meta);
      if (verdict === null) {
        joined.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          setupUrl: recordUrl(ctx.lightningHost, report.Id),
          evidence: { Format: meta.reportFormat ?? 'MULTI_BLOCK', Reason: 'Filters are per block' },
        });
      } else if (verdict) {
        unfiltered.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          setupUrl: recordUrl(ctx.lightningHost, report.Id),
          evidence: {
            'Report type': meta.reportType?.label ?? meta.reportType?.type,
            Format: meta.reportFormat,
            Columns: meta.detailColumns?.length ?? 0,
            'Last run': report.LastRunDate,
          },
        });
      }

      const typeName = meta.reportType?.type;
      if (typeName && hiddenTypes?.has(typeName)) {
        hidden.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          evidence: { 'Report type': meta.reportType?.label ?? typeName, Hidden: true },
        });
      }

      const signature = describeSignature(meta);
      if (signature) {
        const bucket = signatures.get(signature);
        if (bucket) bucket.push(report);
        else signatures.set(signature, [report]);
      }
    }

    /* --- Unindexed filter fields ------------------------------------- */
    // Custom fields named in report filters, grouped by object, so one
    // FieldDefinition query per object answers "is it indexed" for all of
    // them. Only custom fields: standard report-type columns (CLOSE_DATE,
    // ACCOUNT.NAME) do not carry the field API name.
    checkCancelled(ctx);
    yield { phase: 'Checking filter fields for indexes', fraction: 0.62 };
    const customCols = new Map<string, Set<string>>();
    for (const report of describeTargets) {
      const meta = describes.get(report.Id)?.reportMetadata;
      if (!meta) continue;
      // Every filtered field's object, not only the custom ones: the long-text
      // rule needs standard fields (Description, Solution Details) and the
      // catalogue query returns the whole object anyway, so this widens the
      // object set without adding a field-level cost.
      for (const { object, field } of filterColumns(meta)) {
        const set = customCols.get(object) ?? new Set<string>();
        set.add(field);
        customCols.set(object, set);
      }
    }
    let fieldIndex: Map<string, FieldIndexInfo> | null = new Map();
    const indexObjects = [...customCols.keys()].slice(0, MAX_INDEX_OBJECTS);
    for (const object of indexObjects) {
      const rows = await tryQuery(
        () =>
          ctx.client.query<FieldDefinitionRow>(
            'SELECT QualifiedApiName, IsIndexed, IsCalculated, DataType FROM FieldDefinition ' +
              `WHERE EntityDefinition.QualifiedApiName = '${object}'`,
          ),
        skip,
        `Field index lookup for ${object}`,
      );
      if (!rows) {
        fieldIndex = null;
        break;
      }
      for (const row of rows.records) {
        fieldIndex.set(`${object}.${row.QualifiedApiName}`, {
          indexed: row.IsIndexed === true,
          calculated: row.IsCalculated === true,
          dataType: row.DataType,
        });
      }
    }
    if (customCols.size > indexObjects.length) {
      warnings.push(
        `Filter fields on ${customCols.size - indexObjects.length} more objects were not checked for ` +
          `indexes (capped at ${MAX_INDEX_OBJECTS} objects per scan).`,
      );
    }
    /* --- Filters on text deeper than the search cut-off ---------------- */
    // Its own pass, because it needs the field catalogue built just above.
    // Doing it here rather than in the performance loop is what lets it see
    // filters on fields the report does not display — which is most of them.
    for (const report of describeTargets) {
      const describe = describes.get(report.Id);
      const meta = describe?.reportMetadata;
      if (!meta) continue;
      const deepText = longTextFilterFields(
        meta,
        fieldIndex,
        describe?.reportExtendedMetadata?.detailColumnInfo,
      );
      if (!deepText) continue;
      perfFlagged.add(report.Id);
      perfItems.longTextFilter.push({
        id: report.Id,
        name: report.DeveloperName,
        label: report.Name,
        setupUrl: recordUrl(ctx.lightningHost, report.Id),
        evidence: {
          Fields: deepText.label,
          Operators: deepText.operators.join(', '),
          // `contains` is the operator Salesforce documents the 255-character
          // limit against. Others are listed because a filter on a field this
          // wide is worth a look whatever the operator, but the confirmed case
          // is the one to lead with.
          Documented: deepText.operators.some((op) => /contains/i.test(op))
            ? 'contains — confirmed'
            : 'other operator',
          'Last run': report.LastRunDate,
          Folder: report.FolderName,
        },
      });
    }

    const unindexed: FindingItem[] = [];
    if (fieldIndex) {
      for (const report of describeTargets) {
        const meta = describes.get(report.Id)?.reportMetadata;
        if (!meta) continue;
        const evidence = unindexedFilterEvidence(meta, fieldIndex);
        if (!evidence) continue;
        perfFlagged.add(report.Id);
        unindexed.push({
          id: report.Id,
          name: report.DeveloperName,
          label: report.Name,
          setupUrl: recordUrl(ctx.lightningHost, report.Id),
          evidence: { ...evidence, 'Last run': report.LastRunDate, Folder: report.FolderName },
        });
      }
    }
    if (!describesUsable && describeTargets.length > 0) {
      outcomes.push(
        inconclusive('reports', RULES.perfUnindexedFilters, 'No report could be described, so filter fields could not be checked.'),
      );
    } else if (!fieldIndex) {
      outcomes.push(
        inconclusive(
          'reports',
          RULES.perfUnindexedFilters,
          'FieldDefinition could not be queried, so filter fields could not be checked for indexes.',
        ),
      );
    } else {
      outcomes.push(finding('reports', RULES.perfUnindexedFilters, unindexed));
    }

    /* --- Data volume --------------------------------------------------- */
    // One call: the recordCount limits resource answers for every object at
    // once. The high-volume standard objects plus whatever custom objects the
    // reports filter on.
    checkCancelled(ctx);
    yield { phase: 'Reading record counts', fraction: 0.68 };
    const volumeObjects = [...new Set([...STANDARD_VOLUME_OBJECTS, ...customCols.keys()])].filter((o) =>
      /^[A-Za-z][A-Za-z0-9_]*$/.test(o),
    );
    const counts = await tryQuery(
      () =>
        ctx.client.get<{ sObjects?: { name: string; count: number }[] }>(
          `/limits/recordCount?sObjects=${volumeObjects.join(',')}`,
        ),
      skip,
      'Record counts',
    );
    if (!counts) {
      outcomes.push(inconclusive('reports', RULES.largeObjects, 'The recordCount resource could not be read.'));
    } else {
      outcomes.push(
        finding(
          'reports',
          RULES.largeObjects,
          (counts.sObjects ?? [])
            .filter((o) => o.count >= LARGE_OBJECT_ROWS)
            .sort((a, b) => b.count - a.count)
            .map((o) => ({
              name: o.name,
              setupUrl: setupUrl(ctx.lightningHost, `ObjectManager/${o.name}/Details/view`),
              evidence: {
                Records: o.count,
                'Reports filtering on its custom fields': customCols.get(o.name)?.size ? describeTargets.filter((r) => customFilterColumns(describes.get(r.Id)?.reportMetadata ?? {}).some((c) => c.object === o.name)).length : 0,
              },
            })),
        ),
      );
    }

    if (!describesUsable && describeTargets.length > 0) {
      outcomes.push(
        inconclusive(
          'reports',
          RULES.unfiltered,
          'No report could be described, so no report could be checked for filters. ' +
            'Describing a report needs read access to it.',
        ),
      );
    } else {
      outcomes.push(finding('reports', RULES.unfiltered, unfiltered));
    }
    outcomes.push(finding('reports', RULES.joinedNotChecked, joined));
    outcomes.push(
      hiddenTypes === null
        ? inconclusive(
            'reports',
            RULES.hiddenReportType,
            'The report type catalogue could not be read, so no report could be checked against hidden types.',
          )
        : finding('reports', RULES.hiddenReportType, hidden),
    );

    if (describes.size === 0 && reports.length > 0) {
      outcomes.push(
        inconclusive(
          'reports',
          RULES.unfiltered,
          'No report describes could be retrieved, so filter coverage was not assessed.',
        ),
      );
    }

    /* --- Performance rules (describe-derived) ------------------------- */
    for (const [key, rule] of Object.entries(PERF_RULES) as [PerformanceIssue, RuleSpec][]) {
      if (!describesUsable && describeTargets.length > 0) {
        outcomes.push(
          inconclusive('reports', rule, 'No report could be described, so performance was not assessed.'),
        );
        continue;
      }
      // longTextFilter is not gated on column info: it prefers the field
      // catalogue, which covers filters on fields the report never displays.
      if (key === 'longTextColumns' && describesUsable && !sawColumnInfo) {
        outcomes.push(
          inconclusive(
            'reports',
            rule,
            'The describe responses carried no column data types (reportExtendedMetadata.detailColumnInfo), ' +
              'so long text fields could not be identified.',
          ),
        );
        continue;
      }
      outcomes.push(finding('reports', rule, perfItems[key]));
    }

    outcomes.push(
      finding(
        'reports',
        RULES.duplicates,
        [...signatures.values()]
          .filter((group) => group.length > 1)
          .sort((a, b) => b.length - a.length)
          .map((group) => ({
            name: group[0]!.DeveloperName,
            label: `${group.length} reports with identical structure`,
            evidence: {
              Count: group.length,
              Names: group.map((r) => r.Name).slice(0, 5).join(', '),
              Folders: [...new Set(group.map((r) => r.FolderName ?? '—'))].join(', '),
            },
          })),
      ),
    );

    /* --- Dashboard rules --------------------------------------------- */
    const componentsByDashboard = groupBy(components, (c) => c.DashboardId);

    // O(1) lookup; `dashboards.find` inside a `.map` was O(n·m).
    const dashboardById = new Map(dashboards.map((d) => [d.Id, d]));

    // Only ids absent from *both* the default-scope query and the allPrivate
    // sweep are genuinely gone. A report in another user's private folder is
    // invisible to the default scope and is not a broken component.
    const broken = components
      .filter((c) => c.CustomReportId && !knownReportIds.has(c.CustomReportId))
      .map((c) => {
        const dashboard = dashboardById.get(c.DashboardId);
        return {
          id: c.Id,
          name: c.Name ?? 'Untitled component',
          label: dashboard?.Title,
          setupUrl: dashboard ? recordUrl(ctx.lightningHost, dashboard.Id) : undefined,
          evidence: { Dashboard: dashboard?.Title ?? c.DashboardId, 'Report id': c.CustomReportId },
        };
      });
    outcomes.push(finding('reports', RULES.brokenComponent, broken));

    const everyComponentIdIsNull =
      components.length > 0 && components.every((c) => !c.CustomReportId);

    if (!componentResult && dashboards.length > 0) {
      outcomes.push(
        inconclusive(
          'reports',
          RULES.brokenComponent,
          'DashboardComponent.CustomReportId requires the "Manage All Private Reports and Dashboards" permission.',
        ),
      );
    } else if (everyComponentIdIsNull) {
      // The permission-degraded shape: the query succeeds, and every id comes
      // back null. Only a *failed* query used to be handled, so this state read
      // as "no dashboard component is broken" — a clean bill of health derived
      // from having seen nothing.
      outcomes.push(
        inconclusive(
          'reports',
          RULES.brokenComponent,
          `All ${components.length} dashboard components returned a null report id, which is what ` +
            'Salesforce returns without the "Manage All Private Reports and Dashboards" permission. ' +
            'No component could be checked.',
        ),
      );
    } else if (!privateIds && broken.length > 0) {
      warnings.push(
        'Private reports could not be listed, so a dashboard component pointing at a report in ' +
          "another user's private folder may appear here as missing.",
      );
    }

    /* --- Filter load ------------------------------------------------- */
    // Filters live only in the Analytics describe, one call per dashboard
    // and not composite-eligible, so only dashboards that have components
    // are described, under a cap.
    checkCancelled(ctx);
    yield { phase: 'Describing dashboards', fraction: 0.85 };
    const filterLoad: FindingItem[] = [];
    let dashboardDescribes = 0;
    let dashboardDescribeFailures = 0;
    const describeDashboards = componentResult
      ? dashboards
          .filter((d) => (componentsByDashboard.get(d.Id)?.length ?? 0) > 0)
          .slice(0, Math.min(MAX_DASHBOARD_DESCRIBES, ctx.detailBudget))
      : [];
    for (const d of describeDashboards) {
      checkCancelled(ctx);
      try {
        const describe = await ctx.client.get<DashboardDescribe>(`/analytics/dashboards/${d.Id}/describe`);
        dashboardDescribes += 1;
        const load = dashboardFilterLoad(describe);
        if (!load) continue;
        filterLoad.push({
          id: d.Id,
          name: d.DeveloperName,
          label: d.Title,
          setupUrl: recordUrl(ctx.lightningHost, d.Id),
          evidence: {
            Components: load.components,
            Filters: load.filters,
            'Filter values': load.values,
            'Report runs, worst case': load.worstCaseRuns,
            /* An upper bound, not a measurement. Salesforce does not publish how
               many source-report runs a filtered refresh costs, and OrgTriage will
               not execute the reports to find out. What can be stated is the
               shape: one fewer filter value removes one selection a viewer can
               pick, and with it up to `components` runs. Report *timings* are
               not knowable from metadata at all, so none are claimed. */
            'Each filter value you remove drops': `up to ${load.components} report ${
              load.components === 1 ? 'run' : 'runs'
            }`,
            Type: d.Type === 'LoggedInUser' ? 'Dynamic (refreshes on open)' : 'Scheduled or manual',
            Folder: d.FolderName,
          },
        });
      } catch (err: unknown) {
        if (err instanceof SalesforceError && (err.code === 'BUDGET_EXHAUSTED' || err.code === 'THROTTLED')) {
          throw err;
        }
        dashboardDescribeFailures += 1;
      }
    }
    if (describeDashboards.length > 0 && dashboardDescribes === 0) {
      outcomes.push(
        inconclusive(
          'reports',
          RULES.dashboardFilterLoad,
          `None of ${describeDashboards.length} dashboards could be described, so filter load was not assessed.`,
        ),
      );
    } else {
      if (dashboardDescribeFailures > 0) {
        warnings.push(`${dashboardDescribeFailures} dashboard describes could not be read; those dashboards were not checked for filter load.`);
      }
      outcomes.push(
        finding(
          'reports',
          RULES.dashboardFilterLoad,
          filterLoad.sort(byEvidenceDesc('Report runs, worst case')),
        ),
      );
    }

    const stale = dashboards
      .map((d) => ({ d, age: daysSince(d.DashboardResultRefreshedDate) }))
      .filter((x) => x.age !== null && x.age > STALE_DASHBOARD_DAYS)
      .sort((a, b) => (b.age ?? 0) - (a.age ?? 0))
      .map(({ d, age }) => ({
        id: d.Id,
        name: d.DeveloperName,
        label: d.Title,
        setupUrl: recordUrl(ctx.lightningHost, d.Id),
        evidence: { 'Days since refresh': age, Folder: d.FolderName, Type: d.Type },
      }));
    outcomes.push(finding('reports', RULES.staleDashboard, stale));

    // Whether each fixed running user is still active. One query for the whole
    // rule, and only for the users actually named as running users.
    const runningUserIds = [
      ...new Set(
        dashboards
          .filter((d) => d.Type === 'SpecifiedUser' && d.RunningUserId)
          .map((d) => d.RunningUserId),
      ),
    ];
    const runningUserResult =
      runningUserIds.length > 0
        ? await tryQuery(
            () =>
              ctx.client.query<{ Id: string; Name: string; IsActive: boolean }>(
                `SELECT Id, Name, IsActive FROM User WHERE Id IN (${runningUserIds
                  .map((id) => `'${id}'`)
                  .join(',')})`,
              ),
            skip,
            'Dashboard running users',
          )
        : { records: [], totalSize: 0, truncated: false };
    const runningUsers = new Map(
      (runningUserResult?.records ?? []).map((u) => [u.Id, u]),
    );

    if (runningUserIds.length > 0 && !runningUserResult) {
      outcomes.push(
        inconclusive(
          'reports',
          RULES.dashboardInactiveRunningUser,
          'The running users could not be read, so whether any of them is deactivated is unknown.',
        ),
      );
    } else {
      outcomes.push(
        finding(
          'reports',
          RULES.dashboardInactiveRunningUser,
          dashboards
            .filter((d) => d.Type === 'SpecifiedUser' && d.RunningUserId)
            // A user we could not read is not evidence of deactivation: only
            // an explicit IsActive === false counts.
            .filter((d) => runningUsers.get(d.RunningUserId)?.IsActive === false)
            .map((d) => ({
              id: d.Id,
              name: d.DeveloperName,
              label: d.Title,
              setupUrl: recordUrl(ctx.lightningHost, d.Id),
              evidence: {
                'Runs as': runningUsers.get(d.RunningUserId)?.Name ?? d.RunningUserId,
                Folder: d.FolderName,
                'Last refreshed': d.DashboardResultRefreshedDate ?? 'never',
              },
            })),
        ),
      );
    }

    outcomes.push(
      finding(
        'reports',
        RULES.dynamicDashboard,
        dashboards
          .filter((d) => d.Type === 'SpecifiedUser')
          .map((d) => ({
            id: d.Id,
            name: d.DeveloperName,
            label: d.Title,
            evidence: { 'Runs as': d.RunningUserId, Type: 'Fixed running user', Folder: d.FolderName },
          })),
      ),
    );

    if (componentResult) {
      outcomes.push(
        finding(
          'reports',
          RULES.emptyDashboard,
          dashboards
            .filter((d) => (componentsByDashboard.get(d.Id)?.length ?? 0) === 0)
            .map((d) => ({
              id: d.Id,
              name: d.DeveloperName,
              label: d.Title,
              evidence: { Components: 0, Folder: d.FolderName },
            })),
        ),
      );
    }

    /* ---------------------------------------------------------------- */
    const metrics: AnalyzerOutput['metrics'] = {
      Reports: { value: reports.length },
      Dashboards: { value: dashboards.length },
      'Not run in a year': {
        value: abandoned.length + neverRun.length,
        sub: `${Math.round(((abandoned.length + neverRun.length) / Math.max(1, reports.length)) * 100)}% of reports`,
        meter: (abandoned.length + neverRun.length) / Math.max(1, reports.length),
      },
      'Unfiltered scans': { value: unfiltered.length, sub: `of ${describes.size} described` },
      'Performance flags': {
        value: perfFlagged.size,
        sub: `of ${describes.size} described`,
        meter: perfFlagged.size / Math.max(1, describes.size),
      },
      'Broken components': { value: broken.length },
      'Dashboard components': { value: components.length },
    };

    const summary = summarise(RULES, outcomes);
    if (summary.unevaluated.length > 0) {
      warnings.push(
        `${summary.unevaluated.length} check(s) in this area could not be evaluated and are not ` +
          `reflected in the findings: ${summary.unevaluated.join(', ')}. The score is held back ` +
          'accordingly.',
      );
    }

    return {
      metrics,
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      examined: reports.length + dashboards.length,
      truncated:
        describeTargets.length < reports.length
          ? {
              reason: 'The per-report describe budget was reached.',
              examined: describeTargets.length,
              total: reports.length,
            }
          : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Standard filters whose value is not a narrowing choice.
 *
 * Verified against a live org: an Opportunity report the user has not touched
 * still describes as `[{name:"open",value:"all"}, {name:"probability",value:">0"}]`,
 * and an Activity report as `[{name:"units",value:"h"}]`. So the presence of a
 * standard filter says nothing at all — the previous rule tested
 * `standardFilters.length > 0` and therefore never fired on Opportunity, Case
 * or Activity reports, which are exactly the ones worth catching.
 */
const NON_LIMITING_STANDARD_FILTER_VALUES = new Set(['all']);

/**
 * `units` selects how a Duration column is displayed (h/m/d). It is listed
 * among the standard filters but narrows nothing.
 */
const DISPLAY_ONLY_STANDARD_FILTERS = new Set(['units']);

function hasLimitingStandardFilter(
  filters: NonNullable<ReportDescribe['reportMetadata']>['standardFilters'],
): boolean {
  if (!filters) return false;
  return filters.some((f) => {
    const name = (f.name ?? '').toLowerCase();
    if (DISPLAY_ONLY_STANDARD_FILTERS.has(name)) return false;
    const value = (f.value ?? '').toLowerCase();
    return value !== '' && !NON_LIMITING_STANDARD_FILTER_VALUES.has(value);
  });
}

/**
 * Does the report's standard date filter actually limit the range?
 *
 * Verified against a live org. A report set to **All Time** describes as
 * `{ column: "…", durationValue: "CUSTOM", startDate: null, endDate: null }` —
 * `durationValue` is populated, so the old test (`!durationValue`) concluded
 * "filtered" for precisely the report the rule exists to catch. A genuine
 * limit — `THIS_FISCAL_QUARTER`, or a hand-entered range — always arrives with
 * both `startDate` and `endDate` resolved to concrete dates.
 *
 * So the dates are the signal, and `durationValue` is not consulted at all.
 */
function hasDateLimit(
  dateFilter: NonNullable<ReportDescribe['reportMetadata']>['standardDateFilter'],
): boolean {
  if (!dateFilter) return false;
  return Boolean(dateFilter.startDate) || Boolean(dateFilter.endDate);
}

/** Scope values that mean "every record in the org", verified in a live org —
 *  which returns both spellings. Anything else ("mine", "team", …) narrows. */
const ORG_WIDE_SCOPES = new Set(['organization', 'org']);

/**
 * A report is treated as an unfiltered full scan only when *every* limiting
 * mechanism is absent. Being conservative matters: this is the highest-severity
 * report rule, and a false positive on a legitimately broad report would train
 * admins to ignore it.
 *
 * Returns `null` when the report's shape cannot be judged, which the caller
 * must not read as a pass.
 */
export function isUnfiltered(meta: NonNullable<ReportDescribe['reportMetadata']>): boolean | null {
  // Joined reports keep filters per block; every top-level array is empty, so
  // every predicate below would pass and each one would be reported as a
  // critical full scan. Evaluating blocks properly is a separate piece of work.
  if (meta.reportFormat === 'MULTI_BLOCK' || (meta.blocks?.length ?? 0) > 0) return null;

  const noFilters = (meta.reportFilters?.length ?? 0) === 0;
  const noCrossFilters = (meta.crossFilters?.length ?? 0) === 0;
  const noStandardFilters = !hasLimitingStandardFilter(meta.standardFilters);
  const noBooleanLogic = !meta.reportBooleanFilter;
  const noRowLimit = !meta.topRows?.rowLimit;
  const noHierarchyFilter = !meta.userOrHierarchyFilterId;
  const noDateLimit = !hasDateLimit(meta.standardDateFilter);
  // A report scoped to "My records" or "My team's" is bounded by the running
  // user's data no matter what its filters say.
  const orgWideScope = ORG_WIDE_SCOPES.has((meta.scope ?? 'organization').toLowerCase());

  return (
    noFilters &&
    noCrossFilters &&
    noStandardFilters &&
    noBooleanLogic &&
    noRowLimit &&
    noHierarchyFilter &&
    noDateLimit &&
    orgWideScope
  );
}

/**
 * Filter operators that defeat index use. Analytics API operator names,
 * verified spelling for `equals`; the rest per the REST API reference
 * (`notEqual`, `contains`, `notContain`, `excludes`; `startsWith` is *not*
 * listed here because a leading-anchored match can seek).
 */
const NON_SEEKABLE_OPERATORS = new Set(['contains', 'notcontain', 'notequal', 'excludes', 'notlike']);

/** Column data types that carry long or rich text. */
const LONG_TEXT_TYPES = new Set(['textarea', 'html', 'richtextarea', 'longtextarea']);

function countFormulas(value: Record<string, unknown> | unknown[] | null | undefined): number {
  if (!value) return 0;
  return Array.isArray(value) ? value.length : Object.keys(value).length;
}

function rangeDays(
  dateFilter: NonNullable<ReportDescribe['reportMetadata']>['standardDateFilter'],
): number | null {
  if (!dateFilter?.startDate || !dateFilter.endDate) return null;
  const start = Date.parse(dateFilter.startDate);
  const end = Date.parse(dateFilter.endDate);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Compare one report's describe metadata with Salesforce's "Improve Report
 * Performance" guidance and return every point where it departs from it.
 *
 * Pure: nothing here executes a report. Returns `null` for a joined report,
 * whose filters and columns live per block and cannot be judged from the
 * top-level metadata — the same reason {@link isUnfiltered} declines them.
 *
 * The full-scan rule and this one are deliberately disjoint on the date
 * range: a report with *no* filter at all is a critical full scan and is not
 * also listed here as "wide"; a report that has some filter but reads All
 * Time or more than two years is listed here and not there.
 */
export function performanceIssues(
  meta: NonNullable<ReportDescribe['reportMetadata']>,
  extended?: ReportDescribe['reportExtendedMetadata'],
): { key: PerformanceIssue; evidence: Record<string, string | number | boolean | null | undefined> }[] | null {
  const unfilteredVerdict = isUnfiltered(meta);
  if (unfilteredVerdict === null) return null;

  const issues: { key: PerformanceIssue; evidence: Record<string, string | number | boolean | null | undefined> }[] = [];
  const format = (meta.reportFormat ?? '').toUpperCase();
  const columns = meta.detailColumns ?? [];

  const badOperators = (meta.reportFilters ?? [])
    .filter((f) => NON_SEEKABLE_OPERATORS.has((f.operator ?? '').toLowerCase()))
    .map((f) => `${f.column ?? '?'} ${f.operator}`);
  if (badOperators.length > 0) {
    issues.push({
      key: 'inefficientFilters',
      evidence: { Filters: badOperators.slice(0, 4).join('; '), Count: badOperators.length },
    });
  }

  const days = rangeDays(meta.standardDateFilter);
  if (!unfilteredVerdict) {
    if (!hasDateLimit(meta.standardDateFilter)) {
      issues.push({ key: 'wideDateRange', evidence: { Range: 'All Time', 'Date field': meta.standardDateFilter?.column } });
    } else if (days !== null && days > WIDE_RANGE_DAYS) {
      issues.push({
        key: 'wideDateRange',
        evidence: { Range: meta.standardDateFilter?.durationValue, Days: days, 'Date field': meta.standardDateFilter?.column },
      });
    }
  }

  const cross = meta.crossFilters ?? [];
  if (cross.length > 0) {
    const without = cross.filter((c) => c.includesObject === false).length;
    issues.push({
      key: 'crossFilters',
      evidence: {
        'Cross filters': cross.length,
        '"Without" filters': without,
        Objects: cross.map((c) => c.relatedEntity ?? '?').join(', '),
      },
    });
  }

  if (columns.length > MAX_COLUMNS) {
    issues.push({ key: 'manyColumns', evidence: { Columns: columns.length } });
  }

  const columnInfo = extended?.detailColumnInfo;
  if (columnInfo) {
    const longText = columns.filter((c) => LONG_TEXT_TYPES.has((columnInfo[c]?.dataType ?? '').toLowerCase()));
    if (longText.length > 0) {
      issues.push({
        key: 'longTextColumns',
        evidence: { Columns: longText.map((c) => columnInfo[c]?.label ?? c).join(', '), Count: longText.length },
      });
    }
  }

  const rowLevel = countFormulas(meta.customDetailFormula);
  const summaryFormulas = countFormulas(meta.customSummaryFormula);
  if (rowLevel > 0 || summaryFormulas >= 3) {
    issues.push({
      key: 'runtimeFormulas',
      evidence: { 'Row-level formulas': rowLevel, 'Summary formulas': summaryFormulas },
    });
  }

  if ((format === 'SUMMARY' || format === 'MATRIX') && meta.hasDetailRows === true) {
    issues.push({ key: 'detailRows', evidence: { Format: format, 'Detail rows': 'on' } });
  }

  if (format === 'TABULAR' && !meta.topRows?.rowLimit && !unfilteredVerdict) {
    issues.push({ key: 'noRowLimit', evidence: { Format: format, 'Row limit': 'none' } });
  }

  if (/\bOR\b/i.test(meta.reportBooleanFilter ?? '')) {
    issues.push({ key: 'orLogic', evidence: { 'Filter logic': meta.reportBooleanFilter } });
  }

  const buckets = meta.buckets?.length ?? 0;
  if (buckets >= 2) {
    issues.push({ key: 'buckets', evidence: { 'Bucket fields': buckets } });
  }

  const depth = (meta.groupingsDown?.length ?? 0) + (meta.groupingsAcross?.length ?? 0);
  if (depth >= 3) {
    issues.push({
      key: 'deepGroupings',
      evidence: { 'Row groupings': meta.groupingsDown?.length ?? 0, 'Column groupings': meta.groupingsAcross?.length ?? 0 },
    });
  }

  return issues;
}

/** Structural fingerprint used for duplicate detection. */
function describeSignature(meta: NonNullable<ReportDescribe['reportMetadata']>): string | null {
  const type = meta.reportType?.type;
  const columns = meta.detailColumns;
  if (!type || !columns || columns.length === 0) return null;
  const groupings = [
    ...(meta.groupingsDown ?? []).map((g) => g.name ?? ''),
    '|',
    ...(meta.groupingsAcross ?? []).map((g) => g.name ?? ''),
  ].join(',');
  return `${type}::${[...columns].sort().join(',')}::${groupings}`;
}

/**
 * Fetch report describes.
 *
 * **One describe is one API call.** `/composite` does *not* accept an Analytics
 * subrequest — verified against a live org, where
 * `/services/data/v67.0/analytics/reports/{id}/describe` inside a composite
 * returns `404 NOT_FOUND` for every subrequest while the same URL called
 * directly returns 200. The documented composite subresources are sObject
 * operations and `query`; `sobjects/{obj}/describe/layouts` works (the layouts
 * analyzer relies on it) and `limits/` does not.
 *
 * That makes describes the most expensive thing this analyzer does, so they are
 * hard-capped by `detailBudget` and the shortfall is reported rather than
 * silently swallowed. `describe` does not execute the report, so it is not
 * subject to the 500 synchronous runs per hour cap — but it does consume the
 * org's ordinary request allocation.
 */
/**
 * A generator rather than a plain async function so the runner's slice
 * deadline applies *inside* the loop. Three hundred sequential describes at
 * two seconds each is ten minutes, and the deadline is only checked when the
 * analyzer yields — a plain function held the whole phase in one slice.
 */
async function* describeReports(
  ctx: AnalyzerContext,
  reports: ReportRow[],
  skip: (reason: string) => void,
): AsyncGenerator<Phase, { describes: Map<string, ReportDescribe>; attempted: number; failed: number }, void> {
  const describes = new Map<string, ReportDescribe>();
  if (reports.length === 0) return { describes, attempted: 0, failed: 0 };

  const wanted = reports.slice(0, ctx.detailBudget);
  let failed = 0;
  /** Why describes failed, so the warning can say "403 INSUFFICIENT_ACCESS ×20"
   *  rather than leaving the admin to guess between permissions and a bug. */
  const reasons = new Map<string, number>();

  for (const [index, report] of wanted.entries()) {
    if (ctx.signal.aborted) break;
    if (index % 10 === 0) {
      yield {
        phase: `Describing reports (${index} of ${wanted.length})`,
        fraction: 0.55 + 0.3 * (index / wanted.length),
      };
    }
    try {
      const body = await ctx.client.get<ReportDescribe>(`/analytics/reports/${report.Id}/describe`);
      describes.set(report.Id, body);
    } catch (err) {
      // A budget stop is org-wide; every later describe would fail the same way.
      if ((err as { code?: string }).code === 'BUDGET_EXHAUSTED') throw err;
      failed++;
      const e = err as { code?: string; status?: number };
      const reason = [e.status, e.code].filter((x) => x !== undefined && x !== 0).join(' ') || 'unknown error';
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }

  if (failed > 0) {
    const detail = [...reasons.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([reason, n]) => `${reason} ×${n}`)
      .join(', ');
    skip(
      `${failed} of ${wanted.length} report describes could not be read (${detail}); those reports were not ` +
        'checked for filters or performance. A 403 usually means the report is in a folder this user cannot ' +
        'access, or a managed package restricts it.',
    );
  }
  return { describes, attempted: wanted.length, failed };
}


/** Report types an administrator has hidden from the report builder. */
async function readHiddenReportTypes(
  ctx: AnalyzerContext,
  skip: (reason: string) => void,
): Promise<Set<string> | null> {
  const hidden = new Set<string>();
  const folders = await tryQuery(
    () => ctx.client.get<ReportTypeFolder[]>('/analytics/report-types'),
    skip,
    'Report type catalog',
  );
  // Null, not an empty set: "no hidden types" and "could not look" must not
  // produce the same clean verdict downstream.
  if (!folders) return null;

  for (const folder of folders) {
    const types = folder.reportTypes ?? folder['report-types'] ?? [];
    for (const type of types) {
      if (type.isHidden && type.type) hidden.add(type.type);
    }
  }
  return hidden;
}

function byEvidenceDesc(key: string) {
  return (a: FindingItem, b: FindingItem): number => {
    const av = Number(a.evidence?.[key] ?? 0);
    const bv = Number(b.evidence?.[key] ?? 0);
    return bv - av;
  };
}

/* -------------------------------------------------------------------------- */
/* Filter field indexes                                                        */
/* -------------------------------------------------------------------------- */

/** Standard objects that reach large data volumes in ordinary orgs. */
const STANDARD_VOLUME_OBJECTS = [
  'Account', 'Contact', 'Lead', 'Opportunity', 'OpportunityLineItem', 'Case', 'Task', 'Event',
  'EmailMessage', 'ContentVersion', 'FeedItem', 'Campaign', 'CampaignMember', 'Order', 'Asset',
];

/** Rows past which an object is reported as large. */
const LARGE_OBJECT_ROWS = 1_000_000;

/** Objects whose FieldDefinition is queried per scan; one API call each. */
const MAX_INDEX_OBJECTS = 25;

/** Dashboards described per scan for filter load; one API call each. */
const MAX_DASHBOARD_DESCRIBES = 100;

interface FieldDefinitionRow {
  QualifiedApiName: string;
  IsIndexed: boolean | null;
  IsCalculated: boolean | null;
  DataType: string | null;
}

export interface FieldIndexInfo {
  indexed: boolean;
  calculated: boolean;
  dataType?: string | null;
}

/**
 * A custom field's filter column carries its API name in the form
 * `Object.Field__c` (standard report types) or `Object$Field__c` (custom
 * report types). Anything else is a report-type column name and is skipped.
 * Names are validated to the API-name alphabet so they can go into SOQL.
 */
const CUSTOM_COLUMN = /^([A-Za-z][A-Za-z0-9_]*)[.$]([A-Za-z][A-Za-z0-9_]*__c)$/;

/** The same shape, but for any field — standard fields included. */
const ANY_COLUMN = /^([A-Za-z][A-Za-z0-9_]*)[.$]([A-Za-z][A-Za-z0-9_]*)$/;

/**
 * Every `Object.Field` pair a report filters on, custom and standard.
 *
 * The unindexed-filter rule deliberately looks at custom fields only, because
 * the standard ones it would name are mostly indexed already. The long-text
 * rule cannot: `Description` and `Solution Details` are standard, and they are
 * the two most commonly filtered long text fields there are.
 */
export function filterColumns(
  meta: ReportMetadata,
): { column: string; object: string; field: string }[] {
  const seen = new Set<string>();
  const out: { column: string; object: string; field: string }[] = [];
  for (const filter of meta.reportFilters ?? []) {
    const column = filter.column ?? '';
    const match = ANY_COLUMN.exec(column);
    if (!match || seen.has(column)) continue;
    seen.add(column);
    out.push({ column, object: match[1]!, field: match[2]! });
  }
  return out;
}

export function customFilterColumns(
  meta: ReportMetadata,
): { column: string; object: string; field: string }[] {
  const seen = new Set<string>();
  const out: { column: string; object: string; field: string }[] = [];
  for (const filter of meta.reportFilters ?? []) {
    const column = filter.column ?? '';
    const match = CUSTOM_COLUMN.exec(column);
    if (!match || seen.has(column)) continue;
    seen.add(column);
    out.push({ column, object: match[1]!, field: match[2]! });
  }
  return out;
}

/**
 * Does this field hold more text than a report filter will search?
 *
 * `FieldDefinition.DataType` is a display string — "Text Area(Long)",
 * "Text Area(Rich)" — rather than an enum, and the exact wording is not
 * documented, so the match is deliberately tolerant of spacing and of the
 * shorter forms the Analytics API uses. What it must NOT do is match a plain
 * 255-character Text Area: filtering one of those loses at most the last
 * character, which is not worth a finding.
 */
export function isDeepTextType(dataType: string | null | undefined): boolean {
  const text = (dataType ?? '').toLowerCase();
  if (!text) return false;
  if (/text\s*area\s*\(\s*(long|rich)\s*\)/.test(text)) return true;
  // Forms seen from the Analytics describe rather than FieldDefinition.
  return ['longtextarea', 'richtextarea', 'html'].includes(text.replace(/[\s()]/g, ''));
}

/**
 * Reports whose filters touch a field deeper than the search cut-off.
 *
 * Two sources, in order of authority. `FieldDefinition` is the better one: it
 * covers every filtered field, including ones the report does not display, and
 * its data type distinguishes a Long Text Area from a plain Text Area.
 * `detailColumnInfo` is the fallback for objects the field catalogue could not
 * be read for, and it only knows about displayed columns.
 */
export function longTextFilterFields(
  meta: ReportMetadata,
  fields: Map<string, FieldIndexInfo> | null,
  columnInfo: Record<string, { label?: string; dataType?: string }> | undefined,
): { label: string; operators: string[] } | null {
  const hits: string[] = [];
  const operators = new Set<string>();

  for (const filter of meta.reportFilters ?? []) {
    const column = filter.column ?? '';
    if (!column) continue;

    const match = ANY_COLUMN.exec(column);
    const catalogued = match ? fields?.get(`${match[1]}.${match[2]}`) : undefined;
    const deep = catalogued
      ? isDeepTextType(catalogued.dataType)
      : isDeepTextType(columnInfo?.[column]?.dataType);

    if (!deep) continue;
    hits.push(columnInfo?.[column]?.label ?? match?.[2] ?? column);
    operators.add(filter.operator ?? '?');
  }

  if (hits.length === 0) return null;
  return { label: [...new Set(hits)].join(', '), operators: [...operators] };
}

/**
 * Evidence for the unindexed-filter rule, or null when every custom field
 * the report filters on is indexed or unknown. Unknown fields (not returned
 * by FieldDefinition) are never counted: absence of evidence is not evidence.
 */
export function unindexedFilterEvidence(
  meta: ReportMetadata,
  fields: Map<string, FieldIndexInfo>,
): Record<string, string | number> | null {
  const bad: string[] = [];
  for (const { object, field } of customFilterColumns(meta)) {
    const info = fields.get(`${object}.${field}`);
    if (!info || info.indexed) continue;
    bad.push(`${object}.${field}${info.calculated ? ' (formula)' : ''}`);
  }
  if (bad.length === 0) return null;
  return { 'Unindexed fields': bad.join(', '), 'Filters on them': bad.length };
}

/* -------------------------------------------------------------------------- */
/* Dashboard filter load                                                       */
/* -------------------------------------------------------------------------- */

export interface DashboardDescribe {
  filters?: { name?: string; options?: unknown[] }[];
  components?: unknown[];
}

/** Worst-case run count above which a dashboard is worth a story. */
const DASHBOARD_RUNS_THRESHOLD = 50;

/**
 * Upper bound on the distinct source-report runs a filtered dashboard can
 * require: one selection per filter value, plus the unfiltered view, times the
 * components. It is deliberately a bound rather than a per-refresh figure —
 * Salesforce documents neither the caching granularity nor a run count, and a
 * value nobody selects costs nothing. Reports null when the dashboard has no
 * filters or the bound is modest.
 */
export function dashboardFilterLoad(
  d: DashboardDescribe,
): { filters: number; values: number; components: number; worstCaseRuns: number } | null {
  const filters = d.filters ?? [];
  const components = d.components?.length ?? 0;
  if (filters.length === 0 || components === 0) return null;
  const values = filters.reduce((n, f) => n + (f.options?.length ?? 0), 0);
  const worstCaseRuns = components * (values + 1);
  if (worstCaseRuns < DASHBOARD_RUNS_THRESHOLD && filters.length < 3) return null;
  return { filters: filters.length, values, components, worstCaseRuns };
}
