/**
 * Flows analyzer — Flow Builder flows and the Process Builder / Workflow-era
 * automation that still runs alongside them.
 *
 * The inventory comes from the standard objects `FlowDefinitionView` and
 * `FlowVersionView`; the *structure* only exists in the Tooling `Flow` object's
 * `Metadata` field, which may only be selected when the query returns a single
 * record. That makes structural analysis inherently one request per flow, so it
 * goes through `/composite` (25 subrequests, one API call) and is bounded by an
 * explicit budget that the UI reports.
 *
 * Two accuracy commitments in the messaging:
 *  - Process Builder and Workflow Rules are *unsupported* (since 2025-12-31),
 *    not retired. Existing automation keeps running and Salesforce has announced
 *    no shutoff date. Saying otherwise would be scaremongering.
 *  - `Flow.Metadata` is null for managed-package flows, so those are reported as
 *    "not analyzable", never as "clean".
 *
 * Docs:
 *   https://developer.salesforce.com/docs/atlas.en-us.object_reference.meta/object_reference/sforce_api_objects_flowdefinitionview.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_flow.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.api_meta.meta/api_meta/meta_visual_workflow.htm
 */

import type { Finding, FindingItem } from '@/shared/types';
import {
  capped,
  checkCancelled,
  summarise,
  type RuleOutcome,
  finding,
  groupBy,
  inconclusive,
  isManaged,
  setupUrl,
  tryQuery,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzerOutput,
  type Phase,
  type RuleSpec,
} from './framework';
// Id recognition is shared: flows and validation rules must agree on what
// counts as a hard-coded id rather than each growing its own regex.
import { hardcodedIdsIn, isValidId18 } from '@/shared/salesforceIds';

export { isValidId18 };
import {
  LFS_CORE_VERSION,
  LFS_RULES,
  scanFlowMetadata,
  type FlowToScan,
} from './flowscan';

/** ProcessType values that identify Process Builder / Workflow-era automation. */
const LEGACY_PROCESS_TYPES = new Set(['Workflow', 'InvocableProcess', 'CustomEvent']);

/** Workflow rules listed before the inventory reports itself truncated. */
const MAX_WORKFLOW_RULES = 2000;
/**
 * Workflow rules whose `Metadata` is fetched to learn the active flag. The
 * Tooling API only returns `Metadata` one record at a time, so this is a
 * composite call per eight rules; beyond the budget a rule is listed with its
 * active flag "not checked" rather than dropped or assumed.
 */
const WORKFLOW_METADATA_BUDGET = 120;

/** TriggerType values that mean "this runs on every matching record save". */
const RECORD_TRIGGERS = new Set(['RecordBeforeSave', 'RecordAfterSave', 'RecordBeforeDelete']);

/** Element arrays that perform a database operation or a callout. */
const DML_ELEMENT_KEYS = [
  'recordLookups',
  'recordCreates',
  'recordUpdates',
  'recordDeletes',
  'actionCalls',
  'subflows',
] as const;

/** Every array of flow elements, used to build the name→node index. */
const ALL_ELEMENT_KEYS = [
  ...DML_ELEMENT_KEYS,
  'decisions',
  'assignments',
  'loops',
  'screens',
  'waits',
  'steps',
  'collectionProcessors',
  'orchestratedStages',
  'transforms',
  'customErrors',
] as const;

/** OrgTriage recommendation: version count above which a definition is cluttered. */
const VERSION_CLUTTER_THRESHOLD = 10;

/** OrgTriage recommendation: how many releases behind an active flow may fall. */
const API_VERSION_LAG_THRESHOLD = 9;

/** One row of the Tooling `WorkflowRule` inventory. The active flag is not a column. */
interface WorkflowRuleRow {
  Id: string;
  Name: string;
  TableEnumOrId: string | null;
  NamespacePrefix: string | null;
  ManageableState: string | null;
}

/** The per-record Tooling fetch of a workflow rule: `Metadata.active` is what this analyzer wants. */
interface WorkflowRuleRecord {
  Metadata?: { active?: boolean; triggerType?: string | null } | null;
}

interface FlowDefinitionRow {
  DurableId: string;
  ApiName: string;
  Label: string;
  ProcessType: string;
  TriggerType: string | null;
  RecordTriggerType: string | null;
  TriggerObjectOrEventId: string | null;
  TriggerObjectOrEventLabel: string | null;
  TriggerOrder: number | null;
  IsActive: boolean;
  ActiveVersionId: string | null;
  LatestVersionId: string | null;
  VersionNumber: number | null;
  Builder: string | null;
  ManageableState: string | null;
  NamespacePrefix: string | null;
  IsOutOfDate: boolean;
  Description: string | null;
}

interface FlowVersionRow {
  DurableId: string;
  Label: string;
  VersionNumber: number;
  ApiVersion: number | null;
  ApiVersionRuntime: number | null;
  Status: string;
  FlowDefinitionViewId: string;
  ProcessType: string;
  RunInMode: string | null;
}

interface FlowConnector {
  targetReference?: string;
  isGoTo?: boolean;
}

interface FlowNode {
  name?: string;
  label?: string;
  connector?: FlowConnector;
  faultConnector?: FlowConnector;
  defaultConnector?: FlowConnector;
  nextValueConnector?: FlowConnector;
  noMoreValuesConnector?: FlowConnector;
  rules?: { connector?: FlowConnector }[];
  object?: string;
  actionName?: string;
  actionType?: string;
  collectionReference?: string;
}

interface FlowMetadata {
  label?: string;
  processType?: string;
  status?: string;
  apiVersion?: number;
  interviewLabel?: string;
  triggerOrder?: number;
  start?: {
    object?: string;
    triggerType?: string;
    recordTriggerType?: string;
    filters?: { field?: string; operator?: string; value?: unknown }[];
    filterLogic?: string;
    filterFormula?: string;
    doesRequireRecordChangedToMeetCriteria?: boolean;
    scheduledPaths?: unknown[];
  };
  [key: string]: unknown;
}

const RULES = {
  legacyAutomation: {
    id: 'flows.legacy-process-builder',
    severity: 'warning',
    title: (n) => `${n} active Process Builder ${n === 1 ? 'process' : 'processes'} or workflow-era automation`,
    rationale:
      'Salesforce ended support for Workflow Rules and Process Builder on 31 December 2025. They still run, and ' +
      'Salesforce has announced no shutoff date — but bugs will not be fixed and support is unavailable. Mixing ' +
      'them with Flow also makes execution order across the record save much harder to reason about.',
    remediation:
      'Use Setup > Process Automation > Migrate to Flow to convert these, then retest and deactivate the original.',
    // Salesforce Help KB "Salesforce Workflow Rules & Process Builder End of
    // Support" — the article that states the 31 December 2025 date and that
    // existing automation keeps running. Title confirmed against the article
    // index before citing; a wrong id is worse than none.
    docUrl: 'https://help.salesforce.com/s/articleView?id=000389396&language=en_US&type=1',
    weight: 18,
  },
  legacyWorkflowRules: {
    id: 'flows.legacy-workflow-rules',
    severity: 'warning',
    title: (n) => `${n} workflow ${n === 1 ? 'rule is' : 'rules are'} still in place`,
    rationale:
      'Workflow Rules left support with Process Builder on 31 December 2025: they keep running, Salesforce ' +
      'has announced no shutoff date, but there are no bug fixes and no new rules can be created. They also ' +
      'run outside Flow’s ordering: a workflow field update re-fires the object’s triggers and flows a ' +
      'second time in the same save, which is the usual answer to "why did this run twice".',
    remediation:
      'Use Setup > Process Automation > Migrate to Flow for each active rule, retest the record save, then ' +
      'deactivate the rule. Delete rules that are already inactive so the migration list is the real list.',
    // Same Salesforce Help KB as the Process Builder rule: it is the article
    // that states the date and that existing automation keeps running.
    docUrl: 'https://help.salesforce.com/s/articleView?id=000389396&language=en_US&type=1',
    weight: 14,
  },
  multiplePerObject: {
    id: 'flows.multiple-per-object',
    severity: 'warning',
    title: (n) => `${n} object/trigger ${n === 1 ? 'combination has' : 'combinations have'} several flows with unset run order`,
    rationale:
      'When two record-triggered flows share an object and trigger point and neither sets a trigger order, ' +
      'Salesforce runs them in the order of their activation dates. That order is implicit: nothing in either ' +
      'flow records it, and nobody reading the flows can see it.',
    remediation:
      'Set an explicit Trigger Order (1–2,000) on each flow, or consolidate them into one flow per object and trigger point.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_task_trigger_run_order.htm&type=5',
    weight: 14,
  },
  neverActivated: {
    id: 'flows.never-activated',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} never been activated`,
    rationale:
      'Flows with no active version are usually abandoned drafts. They are harmless at runtime but they clutter ' +
      'the flow list and make it harder to see what actually runs.',
    remediation: 'Activate them if they are wanted, delete them if they are not.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_distribute_activate.htm&type=5',
    weight: 4,
  },
  versionClutter: {
    id: 'flows.version-clutter',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} more than ${VERSION_CLUTTER_THRESHOLD} versions`,
    rationale:
      'Obsolete versions accumulate indefinitely and count toward metadata. This threshold is an OrgTriage ' +
      'recommendation, not a Salesforce limit.',
    remediation: 'Delete obsolete versions you will not roll back to.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit.htm&type=5',
    weight: 4,
  },
  outOfDate: {
    id: 'flows.active-not-latest',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow runs' : 'flows run'} a version older than the latest draft`,
    rationale:
      'The active version is not the most recently edited one. Someone has work in progress — or forgot to ' +
      'activate a change they believed was live.',
    remediation: 'Compare the draft against the active version and activate it if it is ready.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_distribute_activate.htm&type=5',
    weight: 5,
  },
  oldApiVersion: {
    id: 'flows.old-api-version',
    severity: 'warning',
    title: (n) => `${n} active flow ${n === 1 ? 'version is' : 'versions are'} on an old API version`,
    rationale:
      'A flow runs with the behaviour of its saved API version. Old versions miss later fixes to flow runtime ' +
      'behaviour, and Salesforce retires API versions on a rolling schedule. Salesforce sets no maximum lag; ' +
      `${API_VERSION_LAG_THRESHOLD} releases behind — three years — is an OrgTriage recommendation.`,
    remediation: 'Open each flow, save it at the current API version, and retest before activating.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_concepts_runtime_api_version.htm&type=5',
    weight: 10,
  },
  legacyBuilder: {
    id: 'flows.legacy-builder',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow was' : 'flows were'} built in the retired Cloud Flow Designer`,
    rationale:
      'These predate Flow Builder. They still run, but they cannot use anything added since, and editing them ' +
      'in the modern builder can change behaviour.',
    remediation: 'Open each in Flow Builder, review carefully, and save a new version.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_considerations_design_fb.htm&type=5',
    weight: 5,
  },
  hardcodedIds: {
    id: 'flows.hardcoded-ids',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'flow appears' : 'flows appear'} to contain hard-coded record IDs`,
    rationale:
      'Record IDs differ between sandbox and production. A hard-coded ID silently points at the wrong record — ' +
      'or nothing at all — once the flow is deployed. Salesforce publishes no API for detecting this, so this ' +
      'check is a text heuristic over the flow definition and can produce false positives. 18-character ids are ' +
      'recognised by their checksum; 15-character ones only when their prefix matches one of the org’s first ' +
      '2,000 object key prefixes.',
    remediation:
      'Replace hard-coded IDs with Custom Metadata, Custom Settings, or a Get Records element that looks the record up by name.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_prep_bestpractices.htm&type=5',
    weight: 12,
  },
  managedNotAnalyzable: {
    id: 'flows.managed-not-analyzable',
    severity: 'info',
    title: (n) => `${n} managed-package ${n === 1 ? 'flow could' : 'flows could'} not be inspected`,
    rationale:
      'Salesforce returns null metadata for flows inside managed packages, so their structure cannot be read. ' +
      'They are reported here as unexamined rather than counted as healthy.',
    remediation: 'None available — raise structural concerns with the package publisher.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_considerations_manage_install.htm&type=5',
    weight: 0,
  },
} satisfies Record<string, RuleSpec>;

/** Every rule id this analyzer can raise — the playbook is checked against it. */
/**
 * Every rule id this analyzer can raise, its own and the ones it borrows.
 * The playbook is checked against this list, so a borrowed rule without fix
 * steps fails the test suite rather than reaching a reader as a bare finding.
 */
export const FLOW_RULE_IDS: string[] = [
  ...Object.values(RULES).map((r) => r.id),
  ...Object.values(LFS_RULES).map((r) => r.id),
];

/** Own rules and borrowed rules together, for coverage and scoring. */
const ALL_RULES: Record<string, RuleSpec> = { ...RULES, ...LFS_RULES };

export const flowsAnalyzer: Analyzer = {
  id: 'flows',
  label: 'Flows',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const skip = (reason: string) => warnings.push(reason);
    const outcomes: RuleOutcome[] = [];

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading flow definitions', fraction: 0.05 };

    const definitions = await tryQuery(() => readDefinitions(ctx, skip), skip, 'Flow definition inventory');
    if (!definitions) {
      for (const rule of Object.values(ALL_RULES)) {
        outcomes.push(inconclusive('flows', rule, 'FlowDefinitionView could not be read, so no flow was examined.'));
      }
      const summary = summarise(ALL_RULES, outcomes);
      return {
        metrics: { Flows: { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }
    const scoped = ctx.includeManaged
      ? definitions
      : definitions.filter((d) => !isManaged(d, ctx.orgNamespace));

    // Managed-package flows are excluded by default: Salesforce returns no
    // structure for them and an admin cannot change them. An org whose flows
    // are *all* packaged then examines nothing, which reads like an org with
    // no automation unless the exclusion is said out loud. Measured against a
    // production org with 50+ flows, every one of them managed.
    const excludedFlows = definitions.length - scoped.length;
    if (excludedFlows > 0) {
      skip(
        `${excludedFlows} of ${definitions.length} ${definitions.length === 1 ? 'flow' : 'flows'} came from a ` +
          'managed package and were not examined: Salesforce does not expose their structure and an admin ' +
          'cannot change them. Options (in the status bar) has an "Include managed packages" setting.',
      );
    }

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading flow versions', fraction: 0.2 };

    // `FlowVersionView` **cannot be queried org-wide**. Verified against a live
    // org: any query without a filter on `FlowDefinitionViewId` or `DurableId`
    // fails with `MALFORMED_QUERY: a filter on a reified column is required`.
    // The previous unfiltered read therefore never returned a row in any org,
    // and both rules that depend on it — old API version and version clutter —
    // have silently had no data to work with. Scoping the read to the
    // definitions we already care about is both the only way it works and
    // cheaper than the org-wide read the review costed at ~11 API calls.
    const scopedVersions = await readFlowVersions(
      ctx,
      scoped.map((d) => d.DurableId),
      skip,
    );

    const versionsByDefinition = groupBy(scopedVersions, (v) => v.FlowDefinitionViewId);

    // Version *counts* come from a single Tooling aggregate rather than from
    // the rows above, so clutter is measured across every version a definition
    // has ever had — including those the scoped read did not fetch.
    const versionCounts = await readVersionCounts(ctx, skip);

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Fetching flow structure', fraction: 0.35 };

    // Only active versions are worth the per-flow cost: an obsolete draft's
    // anti-patterns are not running against anyone's data.
    const activeDefs = scoped.filter((d) => d.ActiveVersionId);
    const targets = capped(activeDefs, ctx.detailBudget, (dropped) =>
      warnings.push(
        `Structural analysis covered the first ${ctx.detailBudget} active flows; ${dropped} more were not inspected. ` +
          'Raise the detail budget in options to include them.',
      ),
    );

    // One query, and it is what makes the hard-coded-id rule trustworthy for
    // 15-character candidates.
    const keyPrefixes = await readKeyPrefixes(ctx, skip);

    const metadataRun = await fetchFlowMetadata(ctx, targets, skip);
    const metadataById = metadataRun.metadata;
    /** True when no flow structure could be read at all, so every structural
     *  rule below is unevaluable rather than clean. */
    const structureUnavailable = targets.length > 0 && metadataById.size === 0;

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Analysing flow structure', fraction: 0.75 };

    const hardcoded: FindingItem[] = [];
    const notAnalyzable: FindingItem[] = [];
    /** Inputs for the static analyser, built from metadata already in hand. */
    const toScan: FlowToScan[] = [];
    let elementTotal = 0;

    for (const def of targets) {
      const metadata = metadataById.get(def.ActiveVersionId!);
      if (!metadata) {
        notAnalyzable.push({
          id: def.DurableId,
          name: def.ApiName,
          label: def.Label,
          evidence: { Reason: 'Metadata not returned (managed package or access denied)' },
        });
        continue;
      }

      // Kept for the per-flow size metric; the anti-pattern rules that used to
      // walk this graph now come from Lightning Flow Scanner.
      const graph = buildGraph(metadata);
      elementTotal += graph.nodes.size;
      const link = flowSetupUrl(ctx, def);

      toScan.push({
        id: def.DurableId,
        name: def.ApiName,
        label: def.Label,
        setupUrl: link,
        metadata,
      });

      // Hard-coded ids stay OrgTriage's own check rather than LFS's: this one
      // validates each candidate against the key prefixes the org itself
      // reports, so a 15-character string that merely looks like an id is not
      // reported as one. See LFS_DISABLED.HardcodedId.
      const ids = findHardcodedIds(metadata, keyPrefixes);
      if (ids.length > 0) {
        hardcoded.push({
          id: def.DurableId,
          name: def.ApiName,
          label: def.Label,
          setupUrl: link,
          evidence: { Count: ids.length, Examples: ids.slice(0, 4).join(', '), Heuristic: 'yes' },
        });
      }
    }

    outcomes.push(
      structureUnavailable
        ? inconclusive(
            'flows',
            RULES.hardcodedIds,
            'No flow metadata could be read, so no flow was searched for hard-coded ids.',
          )
        : finding('flows', RULES.hardcodedIds, hardcoded),
    );
    // Not gated on structureUnavailable: this rule *is* the report that the
    // metadata could not be read, so it has a verdict either way.
    outcomes.push(finding('flows', RULES.managedNotAnalyzable, notAnalyzable));

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Scanning flow structure', fraction: 0.85 };

    // Static analysis over metadata already fetched: no further API calls.
    const scanned = scanFlowMetadata(toScan);
    const structureParsed = scanned.scanned;
    const structureFailed = scanned.failed.length;

    for (const [lfsName, spec] of Object.entries(LFS_RULES)) {
      const errored = scanned.ruleErrors.get(lfsName) ?? [];
      if (structureUnavailable) {
        outcomes.push(
          inconclusive(
            'flows',
            spec,
            'No flow metadata could be read, so the structure of these flows was never examined.',
          ),
        );
        continue;
      }
      // Metadata was fetched but the scanner could not parse a single flow:
      // there is nothing to be clean about. Seen on 13 of 66 managed flows in
      // one org; if it were all of them, every structural rule read as clean.
      if (scanned.scanned === 0 && scanned.failed.length > 0) {
        outcomes.push(
          inconclusive(
            'flows',
            spec,
            `The structure scanner could not parse any of the ${scanned.failed.length} flows it was given, so this rule has no verdict.`,
          ),
        );
        continue;
      }
      // The scanner catches a rule's own exception and hands back an empty
      // result that looks exactly like a clean flow. A rule that threw on every
      // flow it saw has no verdict; one that threw on some has a partial one.
      if (scanned.scanned > 0 && errored.length >= scanned.scanned) {
        outcomes.push(
          inconclusive(
            'flows',
            spec,
            `The structure scanner failed on every flow for this rule (${errored[0]?.reason ?? 'unknown error'}).`,
          ),
        );
        continue;
      }
      if (errored.length > 0) {
        warnings.push(
          `${spec.id}: the structure scanner failed on ${errored.length} of ${scanned.scanned} flows ` +
            `(${errored[0]?.reason ?? 'unknown error'}); those flows are not counted for this rule.`,
        );
      }
      outcomes.push(finding('flows', spec, scanned.byRule.get(lfsName) ?? []));
    }

    if (scanned.failed.length > 0) {
      // The same scanner error repeated once per flow filled the banner with
      // five copies of one JavaScript message. Say the reason once, then name
      // the flows.
      const reasons = new Map<string, number>();
      for (const f of scanned.failed) reasons.set(f.reason, (reasons.get(f.reason) ?? 0) + 1);
      const commonest = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown error';
      const names = scanned.failed.slice(0, 5).map((f) => f.name).join(', ');
      warnings.push(
        `${scanned.failed.length} ${scanned.failed.length === 1 ? 'flow' : 'flows'} could not be parsed by ` +
          'the structure scanner, so they were not checked for the patterns it looks for. ' +
          `The scanner reported: ${commonest}. ` +
          `Affected: ${names}${scanned.failed.length > 5 ? `, and ${scanned.failed.length - 5} more` : ''}.`,
      );
    }

    // A rule OrgTriage has no mapping for means the pinned scanner was upgraded
    // without the mapping being revisited. Say so rather than scoring it.
    if (scanned.unmapped.length > 0) {
      warnings.push(
        `The flow scanner reported rules OrgTriage does not map and therefore did not score: ` +
          `${scanned.unmapped.join(', ')}. This usually means the scanner was upgraded past ` +
          `version ${LFS_CORE_VERSION}.`,
      );
    }

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Evaluating inventory rules', fraction: 0.92 };

    const legacy = scoped
      .filter((d) => LEGACY_PROCESS_TYPES.has(d.ProcessType) && d.ActiveVersionId)
      .map((d) => ({
        id: d.DurableId,
        name: d.ApiName,
        label: d.Label,
        setupUrl: flowSetupUrl(ctx, d),
        evidence: {
          Kind: describeProcessType(d.ProcessType),
          Object: d.TriggerObjectOrEventLabel,
          'Support ended': '2025-12-31',
        },
      }));
    outcomes.push(finding('flows', RULES.legacyAutomation, legacy));

    /* --- Workflow rules ----------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading workflow rules', fraction: 0.94 };
    const workflowRules = await tryQuery(
      () =>
        ctx.client.query<WorkflowRuleRow>(
          'SELECT Id, Name, TableEnumOrId, NamespacePrefix, ManageableState FROM WorkflowRule',
          { tooling: true, maxRecords: MAX_WORKFLOW_RULES },
        ),
      skip,
      'Workflow rules',
    );
    let workflowCount: number | null = null;
    let workflowActive: number | null = null;
    if (!workflowRules) {
      outcomes.push(
        inconclusive('flows', RULES.legacyWorkflowRules, 'WorkflowRule could not be read through the Tooling API.'),
      );
    } else {
      const rulesInScope = workflowRules.records.filter((r) => ctx.includeManaged || !isManaged(r, ctx.orgNamespace));
      workflowCount = rulesInScope.length;
      const excludedRules = workflowRules.records.length - rulesInScope.length;
      if (excludedRules > 0) {
        skip(
          `${excludedRules} workflow ${excludedRules === 1 ? 'rule belongs' : 'rules belong'} to a managed ` +
            'package and were not examined.',
        );
      }
      const detailIds = rulesInScope.slice(0, WORKFLOW_METADATA_BUDGET).map((r) => r.Id);
      const detail =
        detailIds.length > 0
          ? await tryQuery(
              () => ctx.client.retrieveMany<WorkflowRuleRecord>('WorkflowRule', detailIds, { tooling: true, chunkSize: 8 }),
              skip,
              'Workflow rule detail',
            )
          : null;
      const workflowItems: FindingItem[] = [];
      for (const rule of rulesInScope) {
        const meta = detail?.records.get(rule.Id)?.Metadata;
        // Three states, kept apart: known active, known inactive, not read.
        const active: boolean | null = meta ? meta.active !== false : null;
        if (active === false) continue;
        workflowItems.push({
          id: rule.Id,
          name: rule.Name,
          setupUrl: setupUrl(ctx.lightningHost, 'WorkflowRules/home'),
          evidence: {
            Object: rule.TableEnumOrId,
            Active: active === null ? 'not checked' : true,
            Trigger: meta?.triggerType ?? null,
            'Support ended': '2025-12-31',
          },
        });
      }
      workflowActive = workflowItems.filter((i) => i.evidence?.Active === true).length;
      if (rulesInScope.length > WORKFLOW_METADATA_BUDGET) {
        warnings.push(
          `Only the first ${WORKFLOW_METADATA_BUDGET} of ${rulesInScope.length} workflow rules had their active flag read; ` +
            'the rest are listed with it "not checked" rather than dropped.',
        );
      }
      if (detail && detail.failedChunks > 0) {
        warnings.push(
          `${detail.failedChunks} batch(es) of workflow rule detail could not be read; those rules are listed with their active flag not checked.`,
        );
      }
      if (workflowRules.truncated) {
        warnings.push(`Only the first ${MAX_WORKFLOW_RULES.toLocaleString()} workflow rules were read.`);
      }
      outcomes.push(finding('flows', RULES.legacyWorkflowRules, workflowItems));
    }

    outcomes.push(
      finding(
        'flows',
        RULES.neverActivated,
        scoped
          .filter((d) => !d.ActiveVersionId)
          .map((d) => ({
            id: d.DurableId,
            name: d.ApiName,
            label: d.Label,
            evidence: { Type: d.ProcessType, Versions: versionsByDefinition.get(d.DurableId)?.length ?? 0 },
          })),
      ),
    );

    outcomes.push(
      finding(
        'flows',
        RULES.outOfDate,
        scoped
          .filter((d) => d.ActiveVersionId && d.LatestVersionId && d.ActiveVersionId !== d.LatestVersionId)
          .map((d) => ({
            id: d.DurableId,
            name: d.ApiName,
            label: d.Label,
            setupUrl: flowSetupUrl(ctx, d),
            evidence: { 'Latest version': d.VersionNumber, 'Out of date': d.IsOutOfDate },
          })),
      ),
    );

    outcomes.push(
      finding(
        'flows',
        RULES.versionClutter,
        scoped
          .map((def) => ({
            def,
            total: versionCounts.get(def.DurableId) ?? versionsByDefinition.get(def.DurableId)?.length ?? 0,
            fetched: versionsByDefinition.get(def.DurableId) ?? [],
          }))
          .filter((x) => x.total > VERSION_CLUTTER_THRESHOLD)
          .sort((a, b) => b.total - a.total)
          .map(({ def, total, fetched }) => ({
            id: def.DurableId,
            name: def.ApiName,
            label: def.Label,
            evidence: {
              Versions: total,
              Obsolete: fetched.filter((v) => v.Status === 'Obsolete').length,
            },
          })),
      ),
    );

    outcomes.push(
      finding(
        'flows',
        RULES.legacyBuilder,
        scoped
          .filter((d) => d.Builder === 'Cloud Flow Designer')
          .map((d) => ({
            id: d.DurableId,
            name: d.ApiName,
            label: d.Label,
            evidence: { Builder: d.Builder, Active: Boolean(d.ActiveVersionId) },
          })),
      ),
    );

    // Trigger-order collisions: same object + trigger point, >1 active flow, and
    // at least two of them without an explicit order.
    const triggered = scoped.filter(
      (d) => d.ActiveVersionId && RECORD_TRIGGERS.has(d.TriggerType ?? ''),
    );
    // Group on the object's **API name**, not its label: two different objects
    // can share a label (a custom object called "Order" and the standard
    // Order), and merging them invents a collision that cannot happen.
    //
    // The trigger point is normalised too. A Create-only and an Update-only
    // after-save flow never execute in the same save, so they are not an
    // ordering hazard; `CreateAndUpdate` overlaps both, so it is expanded into
    // the two saves it participates in and grouped with each.
    const collisionKeys = (d: FlowDefinitionRow): string[] => {
      const object = d.TriggerObjectOrEventId ?? d.TriggerObjectOrEventLabel ?? '(unknown)';
      const point = d.TriggerType ?? '';
      const record = d.RecordTriggerType ?? 'CreateAndUpdate';
      const saves =
        record === 'CreateAndUpdate' ? ['Create', 'Update'] : [record];
      return saves.map((save) => `${object}|${point}|${save}`);
    };

    const byCollisionKey = new Map<string, FlowDefinitionRow[]>();
    for (const def of triggered) {
      for (const key of collisionKeys(def)) {
        const bucket = byCollisionKey.get(key);
        if (bucket) bucket.push(def);
        else byCollisionKey.set(key, [def]);
      }
    }

    const collisions = [...byCollisionKey.entries()]
      .filter(([, list]) => list.length > 1 && list.filter((d) => d.TriggerOrder == null).length > 1)
      .map(([key, list]) => {
        const [object, trigger, save] = key.split('|');
        return {
          name: `${object} · ${trigger} · ${save}`,
          evidence: {
            Flows: list.length,
            'Without run order': list.filter((d) => d.TriggerOrder == null).length,
            Names: list.map((d) => d.ApiName).join(', '),
          },
        };
      });
    outcomes.push(finding('flows', RULES.multiplePerObject, collisions));

    // Old API version, from the active version rows.
    const currentVersion = Number.parseFloat(ctx.client.apiVersion);
    const floor = currentVersion - API_VERSION_LAG_THRESHOLD;
    const activeVersionIds = new Set(scoped.map((d) => d.ActiveVersionId).filter(Boolean));
    const staleVersions = scopedVersions
      .filter((v) => v.Status === 'Active' || activeVersionIds.has(v.DurableId))
      .filter((v) => {
        const effective = v.ApiVersionRuntime ?? v.ApiVersion;
        return effective != null && effective < floor;
      })
      .map((v) => ({
        id: v.DurableId,
        name: v.Label,
        evidence: {
          Version: v.VersionNumber,
          'Saved at': v.ApiVersion,
          'Runs at': v.ApiVersionRuntime,
          'Releases behind': v.ApiVersionRuntime ? Math.round(currentVersion - v.ApiVersionRuntime) : null,
        },
      }));
    // One outcome, not two: this used to emit the clean verdict and then the
    // inconclusive one, and the clean verdict was the one that counted.
    if (scoped.length > 0 && scopedVersions.length === 0) {
      outcomes.push(
        inconclusive(
          'flows',
          RULES.oldApiVersion,
          'No flow version rows could be read, so the API version each flow runs at is unknown.',
        ),
      );
    } else {
      outcomes.push(finding('flows', RULES.oldApiVersion, staleVersions));
    }

    /* ---------------------------------------------------------------- */
    const active = scoped.filter((d) => d.ActiveVersionId).length;

    const metrics: AnalyzerOutput['metrics'] = {
      Flows: { value: scoped.length, sub: `${active} active` },
      'Record-triggered': { value: triggered.length },
      'Process Builder': { value: legacy.length, sub: 'unsupported since Dec 2025' },
      'Workflow rules': {
        value: workflowCount ?? '—',
        sub: workflowActive === null ? undefined : `${workflowActive} active, unsupported since Dec 2025`,
      },
      // `metadataById.size` counts flows whose metadata came back, including
      // any the scanner then choked on. Reporting those as analysed produced
      // "13 analysed, 0 average elements" on an org where all thirteen failed.
      'Structure analysed': {
        value: structureParsed,
        sub:
          structureFailed > 0
            ? `${structureFailed} could not be parsed`
            : targets.length < activeDefs.length
              ? `of ${activeDefs.length} active`
              : 'all active flows',
      },
      'Avg elements': {
        value: structureParsed > 0 && elementTotal > 0 ? Math.round(elementTotal / structureParsed) : '—',
        sub: 'per analysed flow',
      },
      'Flow versions': {
        value: scoped.reduce((n, d) => n + (versionCounts.get(d.DurableId) ?? 0), 0) || scopedVersions.length,
        sub: 'across all definitions',
      },
    };

    const summary = summarise(ALL_RULES, outcomes);
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
      examined: scoped.length + (workflowCount ?? 0),
      truncated:
        targets.length < activeDefs.length
          ? {
              reason: 'The per-flow structural analysis budget was reached.',
              examined: targets.length,
              total: activeDefs.length,
            }
          : undefined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Queries                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Read `FlowDefinitionView`, degrading the field list if the org's API version
 * predates any of the newer columns (`ApiVersion` is v59+, `TriggerOrder` and
 * `RecordTriggerType` are v54+, `Builder` is v47+).
 */
async function readDefinitions(
  ctx: AnalyzerContext,
  skip: (reason: string) => void,
): Promise<FlowDefinitionRow[]> {
  const full =
    'SELECT DurableId, ApiName, Label, ProcessType, TriggerType, RecordTriggerType, ' +
    'TriggerObjectOrEventId, TriggerObjectOrEventLabel, TriggerOrder, IsActive, ActiveVersionId, ' +
    'LatestVersionId, VersionNumber, Builder, ManageableState, NamespacePrefix, IsOutOfDate, ' +
    'Description FROM FlowDefinitionView';
  const minimal =
    'SELECT DurableId, ApiName, Label, ProcessType, IsActive, ActiveVersionId, ' +
    'LatestVersionId, NamespacePrefix FROM FlowDefinitionView';

  try {
    return (await ctx.client.query<FlowDefinitionRow>(full)).records;
  } catch {
    skip('This org did not accept the full FlowDefinitionView field list; some flow checks were reduced.');
    return (await ctx.client.query<FlowDefinitionRow>(minimal)).records;
  }
}

/**
 * Flow versions for a known set of definitions.
 *
 * `FlowVersionView` requires a filter on `FlowDefinitionViewId` (or
 * `DurableId`) — verified against a live org, where an unfiltered query returns
 * `MALFORMED_QUERY: FlowVersionView: a filter on a reified column is required`.
 * Ids are sent in batches so the SOQL stays under the URL length limit.
 */
async function readFlowVersions(
  ctx: AnalyzerContext,
  definitionIds: string[],
  skip: (reason: string) => void,
): Promise<FlowVersionRow[]> {
  if (definitionIds.length === 0) return [];
  const fields =
    'DurableId, Label, VersionNumber, ApiVersion, ApiVersionRuntime, Status, ' +
    'FlowDefinitionViewId, ProcessType, RunInMode';
  const out: FlowVersionRow[] = [];
  const CHUNK = 100;

  for (let i = 0; i < definitionIds.length; i += CHUNK) {
    const list = definitionIds.slice(i, i + CHUNK).map((id) => `'${id}'`).join(',');
    const rows = await tryQuery(
      () =>
        ctx.client.query<FlowVersionRow>(
          `SELECT ${fields} FROM FlowVersionView WHERE FlowDefinitionViewId IN (${list})`,
        ),
      skip,
      'Flow version inventory',
    );
    if (!rows) return out;
    out.push(...rows.records);
  }
  return out;
}

/**
 * How many versions each flow definition has, as one aggregate query.
 *
 * The Tooling `Flow` object holds one row per version and supports
 * `GROUP BY DefinitionId`, so the clutter count costs a single call instead of
 * a row per version — an org with 1,500 flows averaging 15 versions each would
 * otherwise be 22,000 rows fetched to produce a handful of counts.
 */
async function readVersionCounts(
  ctx: AnalyzerContext,
  skip: (reason: string) => void,
): Promise<Map<string, number>> {
  const rows = await tryQuery(
    () =>
      ctx.client.query<{ DefinitionId: string | null; c: number }>(
        'SELECT DefinitionId, COUNT(Id) c FROM Flow GROUP BY DefinitionId',
        { tooling: true },
      ),
    skip,
    'Flow version counts',
  );
  const counts = new Map<string, number>();
  for (const row of rows?.records ?? []) {
    if (row.DefinitionId) counts.set(row.DefinitionId, row.c);
  }
  return counts;
}

/**
 * Retrieve `Metadata` for each active flow version.
 *
 * `Flow.Metadata` cannot be selected in a multi-record query, so this is a
 * genuine N+1. `/composite` collapses several of those into one API call, which
 * is the difference between a scan an admin can afford and one they cannot.
 *
 * Reports how much it lost, because every structural flow rule — DML in a loop,
 * missing fault paths, hard-coded ids — is silently unevaluable for a flow
 * whose metadata did not arrive.
 */
async function fetchFlowMetadata(
  ctx: AnalyzerContext,
  definitions: FlowDefinitionRow[],
  skip: (reason: string) => void,
): Promise<{ metadata: Map<string, FlowMetadata>; failedChunks: number; chunks: number }> {
  const ids = definitions.map((d) => d.ActiveVersionId!).filter(Boolean);
  const out = new Map<string, FlowMetadata>();
  if (ids.length === 0) return { metadata: out, failedChunks: 0, chunks: 0 };

  // Eight per composite, not 25. A single Flow record's `Metadata` runs to
  // hundreds of KB on a large flow, so 25 of them is a multi-megabyte response
  // against a fixed 25-second abort — and the orgs with flows that big are
  // exactly the ones this analyzer exists for. A lost chunk now costs eight
  // flows instead of the whole retrieval.
  const outcome = await tryQuery(
    () =>
      ctx.client.retrieveMany<{ Metadata?: FlowMetadata }>('Flow', ids, {
        tooling: true,
        chunkSize: 8,
      }),
    skip,
    'Flow structure retrieval',
  );
  if (!outcome) return { metadata: out, failedChunks: 1, chunks: 1 };

  for (const [id, record] of outcome.records) {
    if (record?.Metadata) out.set(id, record.Metadata);
  }
  return { metadata: out, failedChunks: outcome.failedChunks, chunks: outcome.chunks };
}

function flowSetupUrl(ctx: AnalyzerContext, def: FlowDefinitionRow): string {
  return setupUrl(ctx.lightningHost, `Flows/page?address=%2F${def.ActiveVersionId ?? def.DurableId}`);
}

function describeProcessType(processType: string): string {
  switch (processType) {
    case 'Workflow':
      return 'Process Builder (record change)';
    case 'InvocableProcess':
      return 'Process Builder (invocable)';
    case 'CustomEvent':
      return 'Process Builder (event)';
    default:
      return processType;
  }
}

/* -------------------------------------------------------------------------- */
/* Structural analysis                                                        */
/* -------------------------------------------------------------------------- */

interface FlowGraph {
  nodes: Map<string, { node: FlowNode; kind: string }>;
}

/** Index every element by its `name`, which is what connectors reference. */
function buildGraph(metadata: FlowMetadata): FlowGraph {
  const nodes = new Map<string, { node: FlowNode; kind: string }>();
  for (const key of ALL_ELEMENT_KEYS) {
    const list = metadata[key];
    if (!Array.isArray(list)) continue;
    for (const node of list as FlowNode[]) {
      if (typeof node?.name === 'string') nodes.set(node.name, { node, kind: key });
    }
  }
  return { nodes };
}

function outgoing(node: FlowNode, opts: { includeFault?: boolean } = {}): string[] {
  const targets: (FlowConnector | undefined)[] = [
    node.connector,
    node.defaultConnector,
    node.nextValueConnector,
    node.noMoreValuesConnector,
    ...(node.rules ?? []).map((r) => r.connector),
  ];
  if (opts.includeFault) targets.push(node.faultConnector);
  return targets
    .map((c) => c?.targetReference)
    .filter((t): t is string => typeof t === 'string' && t.length > 0);
}


/**
 * Every name the flow gives to something of its own — elements, variables,
 * choices, formulas, and so on.
 *
 * The docblock on the old implementation promised to exclude these and the code
 * did not, so a 15-character element name containing a digit was reported to
 * the admin as a hard-coded id.
 */
function collectFlowNames(metadata: FlowMetadata): Set<string> {
  const names = new Set<string>();
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of ['name', 'apiName', 'targetReference', 'elementReference']) {
      const value = record[key];
      if (typeof value === 'string') names.add(value);
    }
    for (const value of Object.values(record)) walk(value);
  };
  walk(metadata);
  return names;
}

/**
 * Heuristic scan for hard-coded Salesforce record ids in the flow definition.
 *
 * There is no API for this, so it is a text scan over the serialised metadata.
 * Two classes of candidate, held to different standards:
 *
 *  - **18 characters** — accepted only when the checksum validates. Effectively
 *    exact.
 *  - **15 characters** — no checksum exists, so these are accepted only when
 *    their three-character prefix is one the *org itself* reports through
 *    `EntityDefinition.KeyPrefix`. When that catalogue could not be read,
 *    15-character candidates are skipped rather than guessed at.
 *
 * The flow's own element and variable names are excluded in both cases.
 */
export function findHardcodedIds(metadata: FlowMetadata, keyPrefixes: Set<string> | null): string[] {
  return hardcodedIdsIn(JSON.stringify(metadata), keyPrefixes, collectFlowNames(metadata));
}

/**
 * The org's object key prefixes, for validating 15-character id candidates.
 *
 * `EntityDefinition` is one of the Tooling catalog objects that does not
 * support `queryMore()` — without a `LIMIT` it fails outright with
 * `EXCEEDED_ID_LIMIT` rather than paging — so this asks for a single 2,000-row
 * batch. A truncated set can only cause a 15-character id to go unrecognised;
 * 18-character ids are validated by their checksum and need no catalogue.
 */
export async function readKeyPrefixes(
  ctx: AnalyzerContext,
  skip: (reason: string) => void,
): Promise<Set<string> | null> {
  const rows = await tryQuery(
    () =>
      ctx.client.query<{ KeyPrefix: string | null }>(
        'SELECT KeyPrefix FROM EntityDefinition WHERE KeyPrefix != null LIMIT 2000',
        { tooling: true },
      ),
    skip,
    'Object key prefixes (used to validate 15-character ids)',
  );
  if (!rows) return null;

  const prefixes = new Set<string>();
  for (const row of rows.records) {
    if (row.KeyPrefix) prefixes.add(row.KeyPrefix);
  }
  if (rows.records.length >= 2000) {
    skip(
      'This org has more than 2,000 objects, so the key-prefix catalogue used to spot 15-character ' +
        'hard-coded ids is incomplete and some may be missed.',
    );
  }
  return prefixes;
}

