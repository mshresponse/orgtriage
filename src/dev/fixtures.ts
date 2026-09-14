/**
 * Fixture data for the dev preview.
 *
 * Modelled on what a mid-sized, genuinely untidy org looks like — the point of
 * the preview is to check that dense, awkward data still reads well, so these
 * fixtures are deliberately unflattering rather than a tidy demo.
 *
 * Dev-only. Never imported by the extension bundles.
 */

import { scoreDomain } from '@/analyzers/framework';
import { digestOf, type SnapshotDigest } from '@/shared/diff';
import type { AnalyzerId, Finding, OrgContext, ScanResult } from '@/shared/types';

export const orgContext: OrgContext = {
  orgId: '00Dau0000012ABCEA2',
  apiHost: 'northwind.my.salesforce.com',
  lightningHost: 'northwind.lightning.force.com',
  orgName: 'Northwind Trading',
  instanceName: 'NA142',
  organizationType: 'Enterprise Edition',
  isSandbox: false,
  apiVersion: '67.0',
  userId: '005au000001BcDeAAK',
  userName: 'Dana Okonkwo',
  limitedAccess: false,
  orgNamespace: null,
};

function build(
  analyzer: AnalyzerId,
  examined: number,
  metrics: ScanResult['metrics'],
  findings: Finding[],
  warnings: string[],
  ageMinutes: number,
  apiCalls: number,
): ScanResult {
  return {
    analyzer,
    orgId: orgContext.orgId,
    completedAt: Date.now() - ageMinutes * 60_000,
    durationMs: 42_000,
    apiCalls,
    apiVersion: '67.0',
    score: scoreDomain(analyzer, findings, examined),
    metrics,
    findings,
    warnings,
  };
}

const apexFindings: Finding[] = [
  {
    id: 'apex.org-coverage-below-75',
    analyzer: 'apex',
    severity: 'critical',
    title: 'Org-wide Apex coverage is below the 75% deployment gate',
    rationale:
      'Salesforce blocks production deployments when org-wide test coverage is under 75%. Below the gate, any change — including an urgent fix — cannot be deployed until coverage is raised.',
    remediation:
      'Run all tests to refresh coverage, then add tests to the least-covered classes until the org clears 75%.',
    weight: 34,
    items: [
      {
        name: 'Org-wide coverage',
        evidence: { Current: '68%', Required: '75%', Shortfall: '7 points' },
      },
    ],
  },
  {
    id: 'apex.no-coverage',
    analyzer: 'apex',
    severity: 'critical',
    title: '6 Apex components have no test coverage',
    rationale:
      'Uncovered Apex is untested Apex. It also drags the org-wide percentage down, so a single large uncovered class can block every deployment in the org.',
    remediation: 'Write tests for these components, or delete them if they are dead code.',
    weight: 26,
    items: [
      { name: 'InvoiceBatchScheduler', evidence: { 'API version': 45, Size: 18422, Coverage: 'no data' } },
      { name: 'LegacyPricingEngine', evidence: { 'API version': 41, Size: 24106, Coverage: '0%' } },
      { name: 'OpportunitySyncHandler', evidence: { 'API version': 58, Size: 9312, Coverage: '0%' } },
      { name: 'ContactMergeUtil', evidence: { 'API version': 52, Size: 4188, Coverage: 'no data' } },
      { name: 'QuoteApprovalRouter', evidence: { 'API version': 61, Size: 7734, Coverage: '0%' } },
      { name: 'ShipmentWebhookAdapter', evidence: { 'API version': 49, Size: 3021, Coverage: 'no data' } },
    ],
  },
  {
    id: 'apex.multiple-triggers-per-object',
    analyzer: 'apex',
    severity: 'warning',
    title: '3 objects have more than one active trigger',
    rationale:
      'Salesforce does not guarantee the execution order of multiple triggers on the same object. Order-dependent logic split across them produces defects that are intermittent and very hard to reproduce.',
    remediation:
      'Consolidate to one trigger per object that delegates to a handler class, so execution order is explicit in code.',
    weight: 16,
    items: [
      {
        name: 'Opportunity',
        evidence: {
          Triggers: 4,
          Names: 'OppBeforeInsert, OppAfterUpdate, OppLegacySync, OppRollup',
          Events: 'before insert, after insert, after update',
        },
      },
      {
        name: 'Account',
        evidence: { Triggers: 2, Names: 'AccountTrigger, AccountDedupe', Events: 'before insert, before update' },
      },
      {
        name: 'Shipment__c',
        evidence: { Triggers: 2, Names: 'ShipmentTrigger, ShipmentAudit', Events: 'after insert, after update' },
      },
    ],
  },
  {
    id: 'apex.old-api-version',
    analyzer: 'apex',
    severity: 'warning',
    title: '4 Apex components are on an old API version',
    rationale:
      'A class pinned to an old API version keeps the runtime behaviour of that release. Salesforce retires API versions on a rolling schedule, and retired versions stop working outright.',
    remediation: 'Raise the API version on these components and re-run their tests.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/api_rest_eol.htm',
    weight: 12,
    items: [
      { name: 'LegacyPricingEngine', evidence: { 'API version': 41, 'Releases behind': 26 } },
      { name: 'DataLoaderShim', evidence: { 'API version': 43, 'Releases behind': 24 } },
      { name: 'InvoiceBatchScheduler', evidence: { 'API version': 45, 'Releases behind': 22 } },
      { name: 'TerritoryAssignment', evidence: { 'API version': 47, 'Releases behind': 20 } },
    ],
  },
  {
    id: 'apex.no-exception-recipients',
    analyzer: 'apex',
    severity: 'warning',
    title: 'Unhandled Apex exceptions reach only the last editor of each class',
    rationale:
      'With no ApexEmailNotification entries, unhandled exception emails go only to the last user who modified the failing class. In practice that means production failures reach nobody who is watching.',
    remediation: 'Setup > Apex Exception Email — add a monitored address or a support user.',
    weight: 12,
    items: [{ name: 'Apex Exception Email', evidence: { 'Recipients configured': 0 } }],
  },
];

const flowFindings: Finding[] = [
  {
    id: 'flows.lfs.dml-in-loop',
    analyzer: 'flows',
    severity: 'critical',
    title: '3 flows perform a database operation inside a loop',
    rationale:
      'A Get, Create, Update, Delete, action, or subflow inside a loop runs once per iteration. Apex governor limits apply to the whole transaction: 100 SOQL queries, 150 DML statements, 10 seconds of CPU. A loop over a few hundred records will exceed them and the whole save fails for the user.',
    remediation:
      'Move Get Records before the loop and Create/Update/Delete after it, accumulating into a record collection variable.',
    docUrl: 'https://trailhead.salesforce.com/content/learn/modules/flow-implementation-1/avoid-flow-limits',
    weight: 30,
    items: [
      {
        name: 'Opportunity_Line_Rollup',
        label: 'Opportunity Line Rollup',
        evidence: {
          Operations: 3,
          Elements: 'Get Product in Loop Lines; Update Line in Loop Lines; Call Pricing in Loop Lines',
          Object: 'Opportunity',
        },
      },
      {
        name: 'Account_Hierarchy_Sync',
        label: 'Account Hierarchy Sync',
        evidence: { Operations: 1, Elements: 'Update Child in Loop Children', Object: 'Account' },
      },
      {
        name: 'Case_Escalation_Batch',
        label: 'Case Escalation Batch',
        evidence: { Operations: 2, Elements: 'Get Owner in Loop Cases; Update Case in Loop Cases', Object: 'Case' },
      },
    ],
  },
  {
    id: 'flows.legacy-process-builder',
    analyzer: 'flows',
    severity: 'warning',
    title: '3 active Process Builder processes or workflow-era automation',
    rationale:
      'Salesforce ended support for Workflow Rules and Process Builder on 31 December 2025. They still run, and Salesforce has announced no shutoff date — but bugs will not be fixed and support is unavailable. Mixing them with Flow also makes execution order across the record save much harder to reason about.',
    remediation:
      'Use Setup > Process Automation > Migrate to Flow to convert these, then retest and deactivate the original.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=001096524&language=en_US&type=1',
    weight: 18,
    items: [
      {
        name: 'Opportunity_Stage_Notify',
        label: 'Opportunity Stage Notify',
        evidence: { Kind: 'Process Builder (record change)', Object: 'Opportunity', 'Support ended': '2025-12-31' },
      },
      {
        name: 'Case_Auto_Assign',
        label: 'Case Auto Assign',
        evidence: { Kind: 'Process Builder (record change)', Object: 'Case', 'Support ended': '2025-12-31' },
      },
      {
        name: 'Lead_Score_Update',
        label: 'Lead Score Update',
        evidence: { Kind: 'Process Builder (invocable)', Object: null, 'Support ended': '2025-12-31' },
      },
    ],
  },
  {
    id: 'flows.lfs.no-entry-criteria',
    analyzer: 'flows',
    severity: 'warning',
    title: '3 record-triggered flows run on every save',
    rationale:
      'A record-triggered flow with no entry conditions executes on every insert or update of that object, including bulk loads and integration writes. It is the most common cause of slow saves and of flows firing in a recursive cascade.',
    remediation:
      'Add entry conditions on the Start element, and set "only when a record is updated to meet the condition" where appropriate.',
    weight: 16,
    items: [
      { name: 'Account_Audit_Stamp', evidence: { Object: 'Account', Trigger: 'RecordAfterSave', 'Runs on': 'CreateAndUpdate' } },
      { name: 'Contact_Normalise', evidence: { Object: 'Contact', Trigger: 'RecordBeforeSave', 'Runs on': 'CreateAndUpdate' } },
      { name: 'Shipment_Timestamp', evidence: { Object: 'Shipment__c', Trigger: 'RecordAfterSave', 'Runs on': 'Update' } },
    ],
  },
  {
    id: 'flows.lfs.missing-fault-path',
    analyzer: 'flows',
    severity: 'warning',
    title: '3 flows have database elements with no fault path',
    rationale:
      'Without a fault connector, an error in a Get/Create/Update/Delete or action surfaces to the user as an unhandled flow error and the transaction rolls back.',
    remediation: 'Add a fault path from each data element to a screen or a Custom Error that explains what went wrong.',
    weight: 15,
    items: [
      { name: 'Quote_Approval', evidence: { 'Elements without fault path': 5, Examples: 'Get Approver, Update Quote, Send Email' } },
      { name: 'Order_Fulfilment', evidence: { 'Elements without fault path': 4, Examples: 'Create Shipment, Update Order' } },
      { name: 'Renewal_Reminder', evidence: { 'Elements without fault path': 2, Examples: 'Get Contract, Create Task' } },
    ],
  },
  {
    id: 'flows.hardcoded-ids',
    analyzer: 'flows',
    severity: 'warning',
    title: '2 flows appear to contain hard-coded record IDs',
    rationale:
      'Record IDs differ between sandbox and production. A hard-coded ID silently points at the wrong record — or nothing at all — once the flow is deployed. Salesforce publishes no API for detecting this, so this check is a text heuristic over the flow definition and can produce false positives.',
    remediation:
      'Replace hard-coded IDs with Custom Metadata, Custom Settings, or a Get Records element that looks the record up by name.',
    weight: 12,
    items: [
      { name: 'Case_Auto_Assign', evidence: { Count: 3, Examples: '00G4A000001abcDUAQ, 005au000001BcDeAAK', Heuristic: 'yes' } },
      { name: 'Quote_Approval', evidence: { Count: 1, Examples: '0124A0000012xyzQAA', Heuristic: 'yes' } },
    ],
  },
];

const reportFindings: Finding[] = [
  {
    id: 'reports.no-filters',
    analyzer: 'reports',
    severity: 'critical',
    title: '3 reports scan the whole object with no filter',
    rationale:
      'With no report filters, no cross filters, no row limit, and no effective date range, the report reads every record the running user can see. On a large object this times out, and when it does run it puts sustained load on the org for every user who opens it.',
    remediation:
      'Add a date range filter (the standard date filter is the cheapest) or a scope filter such as My Records or a status.',
    weight: 22,
    items: [
      {
        name: 'All_Activities_Export',
        label: 'All Activities Export',
        evidence: { 'Report type': 'Tasks and Events', Format: 'TABULAR', Columns: 24, 'Last run': '2026-07-29T08:12:00Z' },
      },
      {
        name: 'Every_Contact',
        label: 'Every Contact',
        evidence: { 'Report type': 'Contacts & Accounts', Format: 'TABULAR', Columns: 18, 'Last run': '2026-07-30T16:44:00Z' },
      },
      {
        name: 'Full_Opportunity_Dump',
        label: 'Full Opportunity Dump',
        evidence: { 'Report type': 'Opportunities', Format: 'SUMMARY', Columns: 31, 'Last run': '2026-07-31T06:02:00Z' },
      },
    ],
  },
  {
    id: 'dashboards.broken-component',
    analyzer: 'reports',
    severity: 'warning',
    title: '3 dashboard components point at a report this scan could not find',
    rationale:
      'The component references a report id that neither the shared listing nor the private-folder sweep returned. Salesforce will not delete a report while a dashboard component uses it, so the report most likely still exists in a folder this scan could not see. Either way the component cannot be checked, and dashboards tend to be the most-watched screens in the org.',
    remediation:
      'Open the report by the id in the finding. If it exists, move it to a folder the dashboard’s viewers can see; if it does not, repoint the component at another report or remove it.',
    weight: 12,
    items: [
      {
        name: 'Pipeline by Stage',
        label: 'Executive Overview',
        evidence: { Dashboard: 'Executive Overview', 'Report id': '00O4A000009xyzQUAQ' },
      },
      {
        name: 'Win Rate Trend',
        label: 'Executive Overview',
        evidence: { Dashboard: 'Executive Overview', 'Report id': '00O4A000009abcQUAQ' },
      },
      {
        name: 'Open Cases by Priority',
        label: 'Support Health',
        evidence: { Dashboard: 'Support Health', 'Report id': '00O4A00000zzz11UAQ' },
      },
    ],
  },
  {
    id: 'reports.abandoned',
    analyzer: 'reports',
    severity: 'warning',
    title: '3 reports have not been run in over a year',
    rationale:
      'Reports that nobody runs still appear in every folder picker and every report chooser, and they still have to be migrated and tested when the underlying objects change. LastRunDate is the only org-wide signal Salesforce exposes — view timestamps are per-user and cannot answer "has anyone opened this".',
    remediation: 'Move them to an archive folder for a release. If nobody asks, delete them.',
    weight: 12,
    items: [
      { name: 'FY23_Territory_Plan', label: 'FY23 Territory Plan', evidence: { 'Days since run': 726, Folder: 'Sales Ops', Format: 'Matrix' } },
      { name: 'Old_Lead_Sources', label: 'Old Lead Sources', evidence: { 'Days since run': 611, Folder: 'Marketing', Format: 'Summary' } },
      { name: 'Q1_Pipeline_Copy_2', label: 'Q1 Pipeline Copy 2', evidence: { 'Days since run': 540, Folder: 'Unfiled Public Reports', Format: 'Summary' } },
    ],
  },
  {
    id: 'dashboards.stale',
    analyzer: 'reports',
    severity: 'warning',
    title: '2 dashboards have not refreshed recently',
    rationale:
      'A dashboard showing months-old numbers is worse than no dashboard: people make decisions on it without noticing the date.',
    remediation: 'Set a refresh schedule, or retire the dashboard if nobody needs it current.',
    weight: 12,
    items: [
      { name: 'Regional_Performance', label: 'Regional Performance', evidence: { 'Days since refresh': 214, Folder: 'Leadership', Type: 'SpecifiedUser' } },
      { name: 'Marketing_Funnel', label: 'Marketing Funnel', evidence: { 'Days since refresh': 158, Folder: 'Marketing', Type: 'LoggedInUser' } },
    ],
  },
  {
    id: 'reports.duplicate-candidates',
    analyzer: 'reports',
    severity: 'info',
    title: '1 group of reports looks duplicated',
    rationale:
      'These reports share a report type, the same columns, and the same groupings. Usually somebody cloned a report rather than adding a filter to the original.',
    remediation: 'Keep one, add filters for the variations, and delete the clones.',
    weight: 5,
    items: [
      {
        name: 'Q1_Pipeline',
        label: '4 reports with identical structure',
        evidence: { Count: 4, Names: 'Q1 Pipeline, Q1 Pipeline Copy, Q1 Pipeline Copy 2, Q1 Pipeline (Dana)', Folders: 'Sales Ops, Unfiled Public Reports' },
      },
    ],
  },
];

const layoutFindings: Finding[] = [
  {
    id: 'slds.private-hooks',
    analyzer: 'layouts',
    severity: 'critical',
    title: '2 custom stylesheets reference private SLDS variables',
    rationale:
      'Variables named --slds-s-* or --_slds-* are Salesforce-internal. Their use is explicitly prohibited, they carry no compatibility guarantee, and they can be renamed or removed in any release without notice.',
    remediation: 'Replace every private variable with a public global styling hook (--slds-g-*).',
    docUrl: 'https://v1.lightningdesignsystem.com/platforms/lightning/new-global-styling-hooks-guidance/',
    weight: 22,
    items: [
      { name: 'quoteBuilder/quoteBuilder.css', label: 'LWC', evidence: { Occurrences: 7, Examples: '--_slds-c-card-color-background, --slds-s-button-radius', Type: 'LWC' } },
      { name: 'shipmentTracker', label: 'Aura', evidence: { Occurrences: 3, Examples: '--_slds-g-spacing-2', Type: 'Aura' } },
    ],
  },
  {
    id: 'flexipage.region-over-limit',
    analyzer: 'layouts',
    severity: 'critical',
    title: '1 Lightning page region exceeds the 100-component limit',
    rationale:
      'Salesforce documents a hard limit of 100 components per Lightning page region. Past it, the page may fail to save or fail to render. Note the counting rules: a two-column Field Section counts as three components and a three-tab Tabs component counts as four, so the visible count understates the real one.',
    remediation: 'Move components into tabs or accordion sections in a different region, or split the page.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_flexipage.htm',
    weight: 26,
    items: [
      {
        name: 'Account_Record_Page_v4',
        label: 'Account Record Page v4 · main',
        evidence: { 'Components (counted)': 118, Region: 'main', 'Page type': 'RecordPage', Limit: 100 },
      },
    ],
  },
  {
    id: 'slds.unsupported-component-hooks',
    analyzer: 'layouts',
    severity: 'warning',
    title: '3 custom stylesheets use SLDS 1 component styling hooks',
    rationale:
      'Component styling hooks (--slds-c-*) exist only in SLDS 1. SLDS 2 with the Cosmos theme went GA in Winter ’26 and does not support them, so these components will not pick up the new theme and will drift visually from the rest of the org as it migrates.',
    remediation: 'Replace --slds-c-* with the global equivalents (--slds-g-*), which work in both SLDS 1 and SLDS 2.',
    docUrl: 'https://developer.salesforce.com/docs/platform/lwc/guide/create-components-css-slds1-slds2.html',
    weight: 14,
    items: [
      { name: 'quoteBuilder/quoteBuilder.css', label: 'LWC', evidence: { Occurrences: 22, Examples: '--slds-c-card-color-background, --slds-c-button-brand-color-background', Type: 'LWC' } },
      { name: 'orderSummary/orderSummary.css', label: 'LWC', evidence: { Occurrences: 14, Examples: '--slds-c-tabs-item-text-color', Type: 'LWC' } },
      { name: 'legacyDashlet', label: 'Aura', evidence: { Occurrences: 9, Examples: '--slds-c-badge-color-background', Type: 'Aura' } },
    ],
  },
  {
    id: 'layouts.field-heavy',
    analyzer: 'layouts',
    severity: 'warning',
    title: '3 page layouts carry a very large number of fields',
    rationale:
      'Layouts above roughly 60 fields take longer to render and are difficult to use, and long single-column layouts make people scroll past what matters. Salesforce publishes no maximum field count — this threshold is an OrgTriage recommendation.',
    remediation: 'Split rarely-used fields into collapsible sections, or move them to a Lightning page tab.',
    weight: 12,
    items: [
      { name: 'Opportunity Layout', label: 'Opportunity', evidence: { Fields: 143, Required: 11, Sections: 4, 'Related lists': 22 } },
      { name: 'Account (Sales)', label: 'Account', evidence: { Fields: 97, Required: 6, Sections: 3, 'Related lists': 18 } },
      { name: 'Shipment Layout', label: 'Shipment__c', evidence: { Fields: 88, Required: 14, Sections: 2, 'Related lists': 4 } },
    ],
  },
  {
    id: 'slds.lwc-design-tokens',
    analyzer: 'layouts',
    severity: 'warning',
    title: '1 custom stylesheet uses deprecated --lwc design tokens',
    rationale:
      'Design tokens are not supported in SLDS 2. The official SLDS linter reports --lwc-* usage as an error (rule lwc-token-to-slds-hook).',
    remediation: 'Replace each --lwc-* token with the corresponding --slds-g-* global styling hook.',
    docUrl: 'https://developer.salesforce.com/docs/platform/slds-linter/guide/reference-rules.html',
    weight: 12,
    items: [
      { name: 'orderSummary/orderSummary.css', label: 'LWC', evidence: { Occurrences: 31, Examples: '--lwc-colorTextDefault, --lwc-brandAccessible', Type: 'LWC' } },
    ],
  },
  {
    id: 'flexipage.no-usage-recorded',
    analyzer: 'layouts',
    severity: 'info',
    title: '2 Lightning pages have no recorded usage',
    rationale:
      'These pages do not appear in LightningUsageByFlexiPageMetrics. That means no usage was recorded — which is a strong hint that the page is unassigned, but is not proof it is unused.',
    remediation: 'Check the page’s activation in Lightning App Builder before deleting anything.',
    weight: 4,
    items: [
      { name: 'Account_Record_Page_v2', label: 'Account Record Page v2', evidence: { Type: 'RecordPage', 'Usage records': 0 } },
      { name: 'Old_Home_Page', label: 'Old Home Page', evidence: { Type: 'HomePage', 'Usage records': 0 } },
    ],
  },
];

export const scans: Record<AnalyzerId, ScanResult> = {
  security: build(
    'security',
    46,
    {
      'Health Check score': { value: '68%', sub: 'Salesforce’s own score', meter: 0.68 },
      'High risk': { value: 4 },
      'Medium risk': { value: 9 },
      'Low risk': { value: 3 },
      'Settings compared': { value: 46 },
    },
    [
      {
        id: 'security.health-check-high',
        analyzer: 'security',
        severity: 'critical',
        title: '4 security settings are a high risk against Salesforce’s baseline',
        rationale: 'These are the settings Salesforce itself classifies as high risk in Health Check.',
        remediation: 'Open Setup > Security > Health Check and work down the high-risk group.',
        weight: 26,
        items: [
          { name: 'Session timeout', label: 'Session Settings', evidence: { Group: 'Session Settings', 'Your value': '12 hours', 'Salesforce baseline': '2 hours', Risk: 'High risk' } },
          { name: 'Require HttpOnly attribute', label: 'Session Settings', evidence: { Group: 'Session Settings', 'Your value': 'Disabled', 'Salesforce baseline': 'Enabled', Risk: 'High risk' } },
          { name: 'Minimum password length', label: 'Password Policies', evidence: { Group: 'Password Policies', 'Your value': '5', 'Salesforce baseline': '8', Risk: 'High risk' } },
        ],
      },
      {
        id: 'security.health-check-medium',
        analyzer: 'security',
        severity: 'warning',
        title: '9 security settings are a medium risk against Salesforce’s baseline',
        rationale: 'Medium-risk settings lower the cost of an incident that starts somewhere else.',
        remediation: 'Work these after the high-risk group.',
        weight: 12,
        items: [
          { name: 'Password question requirement', label: 'Password Policies', evidence: { Group: 'Password Policies', 'Your value': 'Not enforced', 'Salesforce baseline': 'Cannot contain password', Risk: 'Medium risk' } },
          { name: 'Lockout effective period', label: 'Password Policies', evidence: { Group: 'Password Policies', 'Your value': '15 minutes', 'Salesforce baseline': 'Forever', Risk: 'Medium risk' } },
        ],
      },
    ],
    [],
    54,
    3,
  ),
  fields: build(
    'fields',
    1_284,
    {
      'Custom fields': { value: 1284 },
      'Objects inspected': { value: 34 },
      Unreferenced: { value: 41 },
      'No description': { value: 906 },
      'References seen': { value: 743, sub: 'distinct field names in metadata' },
    },
    [
      {
        id: 'fields.unreferenced',
        analyzer: 'fields',
        severity: 'info',
        title: '41 custom fields are referenced by no Apex, flow or validation rule',
        rationale: 'Every custom field costs something permanently, and these are paying it for nothing.',
        remediation: 'Confirm before deleting — a field written only by an integration appears here too.',
        weight: 6,
        items: [
          { name: 'Account.Legacy_Tax_Id__c', label: 'Legacy Tax Id', evidence: { Object: 'Account', Type: 'Text', Created: '1,402 days ago', Checked: 'layouts, pages, reports, flows, Apex, validation rules' } },
          { name: 'Opportunity.Temp_Margin__c', label: 'Temp Margin', evidence: { Object: 'Opportunity', Type: 'Currency', Created: '911 days ago', Checked: 'layouts, pages, reports, flows, Apex, validation rules' } },
        ],
      },
      {
        id: 'fields.undocumented',
        analyzer: 'fields',
        severity: 'info',
        title: '906 custom fields have no description',
        rationale: 'A field’s description is the only place its meaning lives where the next admin will find it.',
        remediation: 'Write one sentence per field, starting with the ones people actually use.',
        weight: 3,
        items: [
          { name: 'Account.Region_Code__c', label: 'Region Code', evidence: { Object: 'Account', Type: 'Picklist', Label: 'Region Code' } },
        ],
      },
    ],
    [
      'This area answers "is anything referencing this field", not "does this field hold data". Confirm each before deleting.',
    ],
    22,
    38,
  ),
  apexlint: build(
    'apexlint',
    412,
    {
      'Components read': { value: 412 },
      'Lines analysed': { value: '84,116' },
      'Query or DML in a loop': { value: 7 },
      'No sharing declared': { value: 63 },
      'Silently swallowed errors': { value: 11 },
    },
    [
      {
        id: 'apexlint.soql-in-loop',
        analyzer: 'apexlint',
        severity: 'critical',
        title: '7 Apex components appear to query or write inside a loop',
        rationale: 'One governor-limit unit per iteration: works on three records, fails on two hundred.',
        remediation: 'Move the query above the loop into a Map; collect DML into a List and write once after it.',
        weight: 24,
        items: [
          { name: 'OpportunitySyncHandler', label: 'class', evidence: { 'Loops affected': 2, 'First at line': 84, Type: 'class' } },
          { name: 'OpportunityCloseWonTrigger', label: 'trigger', evidence: { 'Loops affected': 1, 'First at line': 48, Type: 'trigger' } },
        ],
      },
      {
        id: 'apexlint.sharing-not-declared',
        analyzer: 'apexlint',
        severity: 'warning',
        title: '63 Apex classes do not declare a sharing mode',
        rationale: 'An entry point without a sharing keyword runs in system context — every record, ignoring sharing rules.',
        remediation: 'Add `with sharing`, or `inherited sharing` for utilities called from both contexts.',
        weight: 14,
        items: [
          { name: 'BillingIntegrationService', evidence: { 'API version': 52, Declaration: 'none' } },
          { name: 'ContactMergeUtil', evidence: { 'API version': 49, Declaration: 'none' } },
        ],
      },
      {
        id: 'apexlint.empty-catch',
        analyzer: 'apexlint',
        severity: 'warning',
        title: '11 Apex components swallow an exception without handling it',
        rationale: 'An empty catch turns a failure into silence — the most expensive pattern to debug.',
        remediation: 'Log it, let it propagate, or record the failure somewhere a person will see.',
        weight: 12,
        items: [
          { name: 'ShipmentWebhookAdapter', label: 'class', evidence: { 'Empty catch blocks': 3, 'First at line': 122 } },
        ],
      },
    ],
    [
      'These checks read the source as text rather than parsing Apex, and are biased towards under-reporting.',
    ],
    64,
    9,
  ),
  limits: build(
    'limits',
    247,
    {
      'Data storage': { value: '84%', sub: '8,614 of 10,240 MB', meter: 0.84 },
      'File storage': { value: '61%', sub: '6,297 of 10,240 MB', meter: 0.61 },
      'API used, last 24 hours': { value: '78%', sub: '78,412 of 100,000 calls', meter: 0.78 },
      'Limits reported': { value: 39 },
      'Objects counted': { value: 208 },
      'Debug logs': { value: '81%', sub: '812.4 of 1,000 MB · 6,140 logs', meter: 0.81 },
      'Active trace flags': { value: 4 },
      'Limits near ceiling': { value: 2, sub: 'under 20% left' },
    },
    [
      {
        id: 'limits.storage-heavy-objects',
        analyzer: 'limits',
        severity: 'info',
        title: '3 objects account for most of the data storage in use',
        rationale: 'Storage problems are almost always concentrated: a few objects hold the records.',
        remediation: 'Agree a retention period per object with its owner, then archive or hard-delete.',
        weight: 6,
        items: [
          { name: 'Task', evidence: { Records: 2_611_004, 'Estimated MB': 5099.6, 'Share of allocation': '50%', Rate: '2 KB/record (estimate)' } },
          { name: 'EmailMessage', evidence: { Records: 411_882, 'Estimated MB': null, 'Share of allocation': '—', Rate: 'billed at actual size' } },
          { name: 'Audit_Log__c', evidence: { Records: 903_117, 'Estimated MB': 1763.9, 'Share of allocation': '17%', Rate: '2 KB/record (estimate)' } },
        ],
      },
      {
        id: 'limits.debug-log-storage',
        analyzer: 'limits',
        severity: 'warning',
        title: 'Debug logs are using 81% of the org’s 1,000 MB ceiling',
        rationale:
          'Past 1,000 MB accumulated, no user in the org can add or edit a trace flag until somebody deletes logs.',
        remediation: 'Delete old logs from Setup > Debug Logs, then remove the trace flags that are still on.',
        weight: 12,
        items: [
          { name: 'Debug log storage', evidence: { Used: '812.4 MB', Ceiling: '1,000 MB', 'Percent used': '81%', Logs: 6140, 'At the ceiling': 'nobody in the org can add or edit a trace flag' } },
        ],
      },
      {
        id: 'limits.trace-flags-active',
        analyzer: 'limits',
        severity: 'warning',
        title: '4 debug trace flags are still switched on',
        rationale: 'A trace flag keeps writing logs until it expires or someone removes it.',
        remediation: 'Delete the flags nobody is watching; set a short expiry where logging is needed.',
        weight: 8,
        items: [
          { name: 'Extension Flow Profiler', label: '005au000001XyZaAAK', evidence: { Type: 'USER_DEBUG', 'Traced entity': '005au000001XyZaAAK', Expires: '2026-12-31T23:59:00.000Z', 'Apex level': 'FINE', 'Database level': 'FINE' } },
          { name: 'SFDC_DevConsole', label: '005au000001PqRsBBB', evidence: { Type: 'DEVELOPER_LOG', 'Traced entity': '005au000001PqRsBBB', Expires: 'no expiry set', 'Apex level': 'FINEST', 'Database level': 'FINEST' } },
        ],
      },
      {
        id: 'limits.near-ceiling',
        analyzer: 'limits',
        severity: 'warning',
        title: '2 org limits have less than 20% headroom left',
        rationale: 'Every one of these is a ceiling something will hit.',
        remediation: 'Decide whether the consumption is legitimate, then request an increase or find what is spending it.',
        weight: 10,
        items: [
          { name: 'Daily async Apex executions', label: 'DailyAsyncApexExecutions', evidence: { Used: '221,455', Allocation: '250,000', 'Headroom left': '11%' } },
          { name: 'Daily workflow emails', label: 'DailyWorkflowEmails', evidence: { Used: '8,410', Allocation: '10,000', 'Headroom left': '16%' } },
        ],
      },
    ],
    [
      'Data storage is 84% full, below the 85% threshold this check fires at. Worth watching.',
      'Email Message records are billed at their actual size rather than a fixed rate, so they are counted but not estimated.',
    ],
    8,
    2,
  ),
  access: build(
    'access',
    412,
    {
      'Active users': { value: 386 },
      'Modify All Data': { value: 19, sub: '5 or fewer is typical', meter: 1 },
      'Permission sets': { value: 74 },
      Profiles: { value: 23 },
      'Unused profiles': { value: 6 },
      'Dormant admins': { value: 3, sub: 'no login in 90d' },
    },
    [
      {
        id: 'access.admin-sprawl',
        analyzer: 'access',
        severity: 'critical',
        title: '19 active users have Modify All Data',
        rationale:
          'Modify All Data ignores every sharing rule, field-level security setting and validation-driven process in the org.',
        remediation: 'List the holders and move the ones who do not need it onto a profile without it.',
        weight: 26,
        items: [
          { name: 'Dana Whitfield', label: 'dana@northwind.example', evidence: { Username: 'dana@northwind.example', 'Granted by': 'Profile: System Administrator', 'Last login': '2 days ago' } },
          { name: 'Ines Okafor', label: 'ines@northwind.example', evidence: { Username: 'ines@northwind.example', 'Granted by': 'Permission set: Data Steward', 'Last login': '9 days ago' } },
          { name: 'Integration — Boomi', label: 'boomi@northwind.example', evidence: { Username: 'boomi@northwind.example', 'Granted by': 'Permission set group → Integration Full', 'Last login': '1 days ago' } },
        ],
      },
      {
        id: 'access.admin-dormant',
        analyzer: 'access',
        severity: 'critical',
        title: '3 users hold Modify All Data and have not logged in for 90 days',
        rationale: 'A privileged account nobody uses is the one nobody notices being used.',
        remediation: 'Deactivate the user or remove the permission.',
        weight: 22,
        items: [
          { name: 'Marcus Bell', label: 'marcus@northwind.example', evidence: { Username: 'marcus@northwind.example', 'Granted by': 'Profile: System Administrator', 'Last login': '318 days ago', Status: 'Dormant' } },
        ],
      },
      {
        id: 'access.profile-unused',
        analyzer: 'access',
        severity: 'info',
        title: '6 custom profiles have no active users',
        rationale: 'Unused custom profiles accumulate from cloning.',
        remediation: 'Delete the ones with no users.',
        weight: 4,
        items: [
          { name: 'Sales User (2019 clone)', evidence: { Licence: 'Salesforce', 'Active users': 0 } },
          { name: 'Contract Reader', evidence: { Licence: 'Salesforce Platform', 'Active users': 0 } },
        ],
      },
    ],
    [
      'Permission set groups are expanded into their member sets. Muting permission sets inside a group are not modelled.',
    ],
    31,
    18,
  ),
  ops: build(
    'ops',
    93,
    {
      'Scheduled jobs': { value: 41 },
      'Failed Apex jobs (7d)': { value: 6 },
      'Failed interviews': { value: 2, sub: 'flows affected' },
      'Paused interviews': { value: 318 },
      'Pending approvals': { value: 27 },
      'API logins (7d)': { value: 4_812 },
      'API used, last 24 hours': { value: '61,204', sub: 'of 100,000 calls', meter: 0.61 },
    },
    [
      {
        id: 'ops.async-job-failures',
        analyzer: 'ops',
        severity: 'critical',
        title: '2 Apex classes have batch, queueable or future jobs failing in the last 7 days',
        rationale: 'A failed batch or queueable job usually means records were not processed and nobody was told.',
        remediation: 'Open Setup > Apex Jobs, read the error for each failing class, fix the cause, and re-run the job for the records it missed.',
        weight: 24,
        items: [
          { name: 'NightlyAccountRollupBatch', evidence: { 'Failed jobs': 4, 'Jobs with errors': 1, 'Job type': 'BatchApex', 'Last failure': '2026-09-03T02:14:09Z', Error: 'First error: Too many SOQL queries: 101' } },
          { name: 'ContractRenewalQueueable', evidence: { 'Failed jobs': 1, 'Jobs with errors': 0, 'Job type': 'Queueable', 'Last failure': '2026-09-01T02:03:41Z', Error: 'System.NullPointerException: Attempt to de-reference a null object' } },
        ],
      },
      {
        id: 'ops.scheduled-jobs-orphaned',
        analyzer: 'ops',
        severity: 'warning',
        title: '3 scheduled jobs are owned by a deactivated user',
        rationale: 'A scheduled job runs as the user who scheduled it.',
        remediation: 'Reschedule each job as an active integration or admin user, then delete the original entry.',
        weight: 10,
        items: [
          { name: 'Nightly Account Rollup', evidence: { Owner: 'Priya Raman', Type: 'Scheduled Apex', State: 'WAITING', 'Next run': '2026-09-04T02:00:00Z' } },
          { name: 'Weekly Pipeline Digest', evidence: { Owner: 'Priya Raman', Type: 'Report run', State: 'WAITING', 'Next run': '2026-09-08T06:00:00Z' } },
          { name: 'Exec Dashboard Refresh', evidence: { Owner: 'Tom Achebe', Type: 'Dashboard refresh', State: 'WAITING', 'Next run': '2026-09-04T05:30:00Z' } },
        ],
      },
      {
        id: 'ops.approvals-inactive-approver',
        analyzer: 'ops',
        severity: 'critical',
        title: '5 approval requests are assigned to a deactivated user',
        rationale: 'The approver has left, so the request can never be approved or rejected through the normal path.',
        remediation: 'Reassign each request to an active approver.',
        weight: 18,
        items: Array.from({ length: 5 }, (_, i) => ({
          name: `006au00000${1000 + i}AAA`,
          label: 'Discount Approval',
          evidence: { Process: 'Discount Approval', 'Days pending': 44 + i * 9, Approver: 'Tom Achebe', 'Approver status': 'Deactivated' },
        })),
      },
      {
        id: 'ops.flow-interviews-paused',
        analyzer: 'ops',
        severity: 'warning',
        title: '2 flows have interviews paused for more than 7 days',
        rationale: 'Paused interviews wait for a resume event or a scheduled path.',
        remediation: 'Review the paused interviews per flow; resume the ones that still make sense and delete the rest.',
        weight: 10,
        items: [
          { name: 'Case Escalation Wait', evidence: { Interviews: 291, 'Oldest (days)': 412, 'Latest element': 'Wait_for_Response' } },
          { name: 'Onboarding Reminder', evidence: { Interviews: 27, 'Oldest (days)': 88, 'Latest element': 'Wait_3_days' } },
        ],
      },
      {
        id: 'ops.scheduled-jobs-stacked',
        analyzer: 'ops',
        severity: 'info',
        title: '1 hour of the day has 5 or more scheduled jobs',
        rationale: 'Scheduled Apex, report subscriptions and dashboard refreshes share the org’s async queue.',
        remediation: 'Spread jobs across the night.',
        weight: 4,
        items: [{ name: '06:00 UTC', evidence: { Jobs: 11, Names: 'Weekly Pipeline Digest, Exec Dashboard Refresh, Territory Sync, …' } }],
      },
    ],
    ['LoginHistory was skipped: insufficient access rights on cross-reference id (needs Manage Users).'],
    12,
    9,
  ),
  apex: build(
    'apex',
    412,
    {
      Classes: { value: 348, sub: 'excl. managed' },
      Triggers: { value: 64 },
      'Org-wide coverage': { value: '68%', sub: 'below the 75% gate', meter: 0.32 },
      'Classes ≥75%': { value: '54%', sub: '188 of 348' },
      'Objects with >1 trigger': { value: 3 },
      'Below API v': { value: '58.0', sub: '31 components' },
    },
    apexFindings,
    ['Per-class code coverage reflects the last test run, which was 4 days ago.'],
    18,
    41,
  ),
  flows: build(
    'flows',
    237,
    {
      Flows: { value: 237, sub: '164 active' },
      'Record-triggered': { value: 71 },
      'Process Builder': { value: 9, sub: 'unsupported since Dec 2025' },
      'Structure analysed': { value: 164, sub: 'all active flows' },
      'Avg elements': { value: 23, sub: 'per analysed flow' },
      'Flow versions': { value: 618 },
    },
    flowFindings,
    ['3 managed-package flows returned null metadata and were not analysed.'],
    52,
    37,
  ),
  reports: build(
    'reports',
    1893,
    {
      Reports: { value: 1741 },
      Dashboards: { value: 152 },
      'Not run in a year': { value: 284, sub: '16% of reports', meter: 0.16 },
      'Unfiltered scans': { value: 11, sub: 'of 300 described' },
      'Broken components': { value: 3 },
      'Dashboard components': { value: 604 },
    },
    reportFindings,
    [
      'Report view counts are per-user in Salesforce, so "nobody has opened this" cannot be determined. Abandonment here is based on LastRunDate, which is org-wide.',
      'Filter analysis covered the 300 most recently run reports; 1441 more were not described.',
    ],
    1_490,
    78,
  ),
  layouts: build(
    'layouts',
    521,
    {
      'Page layouts': { value: 214, sub: '96 described' },
      'Lightning pages': { value: 68 },
      'Avg fields / layout': { value: 41, sub: 'recommendation ≤ 60' },
      'Regions over limit': { value: 1, sub: 'limit 100/region' },
      'Stylesheets scanned': { value: 239, sub: 'Aura + LWC' },
      'SLDS 2 blockers': { value: 21, sub: 'files needing migration' },
    },
    layoutFindings,
    ['Layout structure was described for the first objects only; 43 objects were skipped.'],
    73,
    59,
  ),
};

/* -------------------------------------------------------------------------- */
/* A previous generation, so the diff UI has something to render               */
/* -------------------------------------------------------------------------- */
/* Built by rewinding the current digests rather than by writing a second set
   of scans by hand: the point is to exercise the four cases the diff can
   produce — a rule that got worse, one that got better, one that has gone, and
   one that is new — without a fixture that can drift from the real shape. */

export const previousDigests: Partial<Record<AnalyzerId, SnapshotDigest>> = (() => {
  const rewind = (analyzer: AnalyzerId, edit: (d: SnapshotDigest) => void): SnapshotDigest => {
    const digest = digestOf(scans[analyzer]);
    digest.completedAt -= 9 * 24 * 60 * 60 * 1000;
    edit(digest);
    return digest;
  };

  return {
    apex: rewind('apex', (d) => {
      d.score = (d.score ?? 0) - 9;
      // Two classes have since been covered, and one rule is new this scan.
      const coverage = d.rules['apex.no-coverage'];
      if (coverage?.items) {
        coverage.items = [...coverage.items, 'LegacyQuoteSync', 'OrderImportBatch'];
        coverage.count = coverage.items.length;
      }
      delete d.rules['apex.multiple-triggers-per-object'];
      d.counts.critical += 1;
    }),
    access: rewind('access', (d) => {
      d.score = (d.score ?? 0) + 4;
      const dormant = d.rules['access.admin-dormant'];
      if (dormant?.items) {
        dormant.items = [];
        dormant.count = 0;
      }
    }),
  };
})();
