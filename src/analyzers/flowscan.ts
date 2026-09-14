/**
 * Flow static analysis, delegated to Lightning Flow Scanner Core.
 *
 * Why borrow rather than write: LFS is MIT, actively maintained, and its rule
 * set is a strict superset of the per-flow checks OrgTriage had hand-written. It
 * runs on the `Flow.Metadata` JSON the flows analyzer already fetches, so the
 * whole engine costs **zero additional API calls** — the reason it is worth
 * having at all.
 *
 * What is *not* delegated, and the distinction that matters:
 *
 *  - LFS scans one flow in isolation. Anything that compares flows to each
 *    other (two record-triggered flows colliding on an object), compares
 *    versions of one definition (clutter, active-not-latest), or reads the
 *    inventory rather than the metadata (never activated, Process Builder,
 *    API version) stays in `flows.ts`. LFS structurally cannot see those.
 *  - The *advice* stays ours. LFS gives a name, a severity and a sentence.
 *    Every rationale and remediation below was written and audited here, in
 *    the same pass that produced the ADVICE AUDIT section of docs/FACTS.md.
 *    We take the detection and none of the prose.
 *
 * Version discipline: the LFS rule set changes between releases, and our
 * snapshot diff keys on rule ids while the score divides by the weight of the
 * rules that *could* fire. A rule appearing or vanishing under us would move a
 * grade with no change in the org. So the dependency is pinned exactly, the
 * enabled set is an explicit allow-list, and anything LFS reports that is not
 * in {@link LFS_RULES} is surfaced as a warning rather than scored or dropped.
 */

import pkg from '@flow-scanner/lightning-flow-scanner-core';
import type { RuleSpec } from '@/analyzers/framework';
import type { FindingItem } from '@/shared/types';

/*
 * Two build notes, both established by measurement rather than assumption:
 *
 *  - The package is CommonJS, so named ESM imports are not available from it.
 *  - It pulls in `fast-xml-parser` (77 KB of the 204 KB this dependency adds),
 *    which looks unreachable from the JSON path and is not: LFS calls
 *    `toXMLString()` internally while scanning. Stubbing the parser out still
 *    produces correct findings, but logs a caught "Unable to write xml" a dozen
 *    times per flow and loses violation line numbers. It stays.
 *
 * `node:path` and `node:fs` are aliased to shims in src/shims — see those files
 * for why a stub is right there and wrong here.
 */
const { Flow, ParsedFlow, scan, getRules } = pkg as unknown as {
  Flow: new (path?: string, data?: unknown) => object;
  ParsedFlow: new (uri: string, flow?: object, errorMessage?: string) => object;
  getRules: (names?: string[], options?: Record<string, unknown>) => Array<{ name: string; ruleId: string }>;
  scan: (
    parsed: object[],
    options?: Record<string, unknown>,
  ) => Array<{
    ruleResults: Array<{
      occurs: boolean;
      ruleName: string;
      severity: string;
      details: Array<{ name: string; type?: string; metaType?: string }>;
      /**
       * Set when the rule threw while scanning this flow. LFS catches the
       * exception itself and returns an empty result with this message —
       * `occurs` is false, exactly as it is for a clean flow. Omitting this
       * field from the type is how a crashed rule was scored as a pass.
       */
      errorMessage?: string;
    }>;
  }>;
};

/**
 * The exact version this mapping was written against. Bumping the dependency
 * without re-reading {@link LFS_RULES} is how a scoring drift gets shipped, so
 * the value is asserted in the test suite.
 */
export const LFS_CORE_VERSION = '6.19.4';

/**
 * The complexity score LFS flags above, restated so the rationale can cite the
 * number the reader will see. It is LFS's default, not a Salesforce limit.
 */
export const LFS_COMPLEXITY_THRESHOLD = 25;

/** Rules LFS ships that OrgTriage deliberately does not run, and why. */
export const LFS_DISABLED: Record<string, string> = {
  APIVersion:
    'OrgTriage reads the API version from FlowVersionView for every flow in the inventory, ' +
    'including ones whose metadata was never fetched. flows.old-api-version is the broader check.',
  InactiveFlow:
    'OrgTriage only fetches metadata for active versions, so LFS would never see an inactive flow. ' +
    'flows.never-activated reads the inventory and does see them.',
  ProcessBuilder:
    'flows.legacy-process-builder reads ProcessType from the inventory, so it catches legacy ' +
    'automation whose metadata was not fetched. Same finding, wider net.',
  TriggerOrder:
    'Fires on every record-triggered flow that has no explicit order, which in most orgs is nearly ' +
    'all of them. flows.multiple-per-object fires only where two flows actually collide on one ' +
    'object — the case where the order is load-bearing.',
  HardcodedId:
    'OrgTriage keeps its own hard-coded-id check. Both are heuristics over the same metadata, but ' +
    'flows.hardcoded-ids validates every candidate against the key prefixes the org itself reports, ' +
    'so a 15-character string that merely looks like an id is not reported as one. Running both would ' +
    'double-count the flows they agree on.',
  FlowName:
    'Checks names against a regular expression. Whose convention is a matter for the org, not for us, ' +
    'and a rule that fires on every flow in a shop with a different standard teaches people to ignore findings.',
  AutoLayout:
    'A canvas layout preference. It says nothing about whether the org works.',
  MissingMetadataDescription:
    'Element-level descriptions. Fires many times per flow and would swamp the plan; ' +
    'flows.lfs.no-description covers the flow itself, which is the one that matters at handover.',
  CognitiveComplexity:
    'Measures the same flows as CyclomaticComplexity by a different formula. Running both counts one ' +
    'complicated flow twice.',
};

/**
 * LFS rule name → the OrgTriage rule it becomes.
 *
 * Severities and weights are ours: LFS calls a missing flow description an
 * "error", which is not how it ranks against a flow that will blow a governor
 * limit on the next bulk load.
 */
export const LFS_RULES: Record<string, RuleSpec> = {
  SOQLQueryInLoop: {
    id: 'flows.lfs.soql-in-loop',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'flow queries' : 'flows query'} records inside a loop`,
    rationale:
      'A Get Records element inside a loop runs once per iteration, and the 100-query limit applies to ' +
      'the whole transaction. The flow works in testing against three records and fails on the day ' +
      'someone imports two hundred, with an error naming a limit rather than the flow.',
    remediation:
      'Move the Get Records outside the loop, retrieve the whole set once, and look up each item from ' +
      'that collection inside the loop.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit_transaction.htm&type=5',
    weight: 20,
  },
  DMLStatementInLoop: {
    id: 'flows.lfs.dml-in-loop',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'flow creates, updates or deletes' : 'flows create, update or delete'} records inside a loop`,
    rationale:
      'Each Create, Update or Delete inside a loop is one of the transaction’s 150 DML statements, and ' +
      'the loop decides how many. This is a common reason a flow that passed testing ' +
      'fails a bulk load, and when it fails the whole save is rolled back for the user who triggered it.',
    remediation:
      'Assign the changed records into a collection inside the loop, then place one Update Records ' +
      'element after the loop that writes the collection in a single statement.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit_transaction.htm&type=5',
    weight: 22,
  },
  ActionCallsInLoop: {
    id: 'flows.lfs.action-in-loop',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'flow calls' : 'flows call'} an action inside a loop`,
    rationale:
      'An Apex action, email alert or subflow invoked per iteration multiplies whatever that action ' +
      'costs — its own queries, its own DML, its own CPU — by the size of the collection. The limits ' +
      'are shared across the transaction, so the action does not get its own budget.',
    remediation:
      'Call the action once with a collection if it accepts one. Where it does not, gather the work and ' +
      'hand it to an autolaunched flow or Apex that is built to run in bulk.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_considerations_limit_transaction.htm&type=5',
    weight: 18,
  },
  UnsafeRunningContext: {
    id: 'flows.lfs.unsafe-running-context',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'flow runs' : 'flows run'} in system mode without sharing`,
    rationale:
      'The flow reads and writes every record regardless of the sharing rules the org was configured ' +
      'with. That is occasionally the intent, and it is the setting most often chosen to make a ' +
      'permission error go away — after which the flow quietly shows or edits data the running user ' +
      'was never meant to reach.',
    remediation:
      'Set the flow to run in user context, or in system context *with* sharing, and grant the running ' +
      'user the access it genuinely needs. Where system mode without sharing is deliberate, say so in ' +
      'the flow description so the next reviewer does not have to guess.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_distribute_context.htm&type=5',
    weight: 20,
  },
  HardcodedSecret: {
    id: 'flows.lfs.hardcoded-secret',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'flow appears to contain' : 'flows appear to contain'} a credential`,
    rationale:
      'An API key or token written into a flow is readable by anyone who can open it in Setup, travels ' +
      'into every sandbox refresh, and appears in any metadata export. Rotating it means editing and ' +
      'redeploying automation rather than changing one setting.',
    remediation:
      'Move the value into a Named Credential, or into protected Custom Metadata or a Custom Setting, ' +
      'and reference it from the flow. Then rotate the exposed value — it must be assumed compromised.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=xcloud.named_credentials_about.htm&type=5',
    weight: 20,
  },
  MissingFaultPath: {
    id: 'flows.lfs.missing-fault-path',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} elements with no fault path`,
    rationale:
      'Without a fault connector, a failure in a record operation or action surfaces as an unhandled ' +
      'flow error: the transaction rolls back, the user gets a screen of technical text, and the admin ' +
      'finds out from an email to whoever last edited the flow, if at all.',
    remediation:
      'Add a fault path to each element that touches records or calls out. Send it somewhere a person ' +
      'will look — a screen with a readable message for screen flows, a custom error or a notification ' +
      'for the rest — and record enough detail to identify the record that failed.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_build_logic_fault.htm&type=5',
    weight: 14,
  },
  MissingRecordTriggerFilter: {
    id: 'flows.lfs.no-entry-criteria',
    severity: 'warning',
    title: (n) => `${n} record-triggered ${n === 1 ? 'flow runs' : 'flows run'} on every save`,
    rationale:
      'With no entry conditions and no filter on changed fields, the flow executes on every insert and ' +
      'every update of the object — including bulk loads, integration writes, and the saves made by ' +
      'other automation. It is the most common cause of slow saves and of flows re-triggering each other.',
    remediation:
      'Set entry conditions so the flow runs only when the records it cares about change, and where the ' +
      'flow reacts to one field, use "Only when a record is updated to meet the condition requirements".',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.automate_flow_build_working_with_conditions_record_triggered_flows.htm&type=5',
    weight: 14,
  },
  RecursiveAfterUpdate: {
    id: 'flows.lfs.recursive-after-update',
    severity: 'warning',
    title: (n) => `${n} after-save ${n === 1 ? 'flow updates' : 'flows update'} the record that triggered it`,
    rationale:
      'An after-save flow that updates its own triggering record causes a second save, which can trigger ' +
      'the flow again. Salesforce stops the recursion eventually, but the cost is paid on every save in ' +
      'the meantime, and the intermediate states are visible to other automation.',
    remediation:
      'Move the field changes into a before-save flow, where assigning to $Record writes the values as ' +
      'part of the original save with no second DML at all. That is both the fix and a performance win.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_concepts_trigger_record.htm&type=5',
    weight: 12,
  },
  SameRecordFieldUpdates: {
    id: 'flows.lfs.same-record-update',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'flow uses' : 'flows use'} an update element to change its own triggering record`,
    rationale:
      'Updating the triggering record through an Update Records element costs a full extra save. ' +
      'A before-save flow assigns straight to $Record and the value is written as part of the save ' +
      'already in progress — no second DML statement, and measurably faster on bulk operations.',
    remediation:
      'Convert the flow to run before save and replace the Update Records element with an Assignment to ' +
      '$Record. Only field changes on the triggering record can move; anything else stays after save.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_concepts_trigger_record.htm&type=5',
    weight: 10,
  },
  MissingNullHandler: {
    id: 'flows.lfs.missing-null-handler',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'flow uses' : 'flows use'} a Get Records result without checking it found anything`,
    rationale:
      'Get Records returns null when nothing matches. The flow carries on, and the next element that ' +
      'reads a field off that empty result fails — or worse, silently writes a blank. The failure ' +
      'appears only for the records where the lookup misses, which is why it survives testing.',
    remediation:
      'Add a Decision immediately after the Get that tests whether the record was found, and give the ' +
      'not-found branch a defined outcome rather than letting it fall through.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_ref_elements_data_get.htm&type=5',
    weight: 12,
  },
  DuplicateDMLOperation: {
    id: 'flows.lfs.duplicate-dml',
    severity: 'warning',
    title: (n) => `${n} screen ${n === 1 ? 'flow can repeat' : 'flows can repeat'} a record operation`,
    rationale:
      'The flow performs a record operation between screens, so a user who navigates back and forward ' +
      'again runs it a second time. The result is duplicate records or repeated updates, created by ' +
      'ordinary use of the Previous button rather than by any error.',
    remediation:
      'Move record operations to after the last screen, or guard them with a boolean variable the flow ' +
      'sets once the work is done and checks before repeating it.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000380596&type=1',
    weight: 12,
  },
  MissingStartReference: {
    id: 'flows.lfs.no-start-reference',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} no start element`,
    rationale:
      'The flow definition does not say which element runs first. This is a structurally broken flow ' +
      'rather than a style problem, and it usually means a partial deployment or a hand-edited file.',
    remediation:
      'Open the flow in Flow Builder and connect the start element. If it cannot be opened, redeploy the ' +
      'flow from source control.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_ref_elements_start.htm&type=5',
    weight: 12,
  },
  GetRecordAllFields: {
    id: 'flows.lfs.get-all-fields',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow retrieves' : 'flows retrieve'} all fields on a Get Records`,
    rationale:
      'Automatically storing all fields fetches every column on the object, including long text areas ' +
      'and formulas that have to be calculated. It also puts data the flow never asked for into a ' +
      'variable that later elements — and anyone debugging — can read.',
    remediation:
      'Switch the Get Records element to choose fields manually and select only the ones the flow uses.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_ref_elements_data_get.htm&type=5',
    weight: 6,
  },
  TransformInsteadOfLoop: {
    id: 'flows.lfs.transform-instead-of-loop',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow loops' : 'flows loop'} to do work a Transform element does in bulk`,
    rationale:
      'The loop exists only to assign values item by item. A Transform element maps a whole collection ' +
      'at once, which is fewer elements to maintain and avoids the per-iteration cost that makes loops ' +
      'the first thing to hit CPU time on a large collection.',
    remediation:
      'Replace the loop and its assignment with a Transform element that maps the source collection to ' +
      'the target one.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_ref_elements_transform.htm&type=5',
    weight: 5,
  },
  RecordIdAsString: {
    id: 'flows.lfs.record-id-as-string',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow takes' : 'flows take'} a record id as text instead of a record`,
    rationale:
      'Lightning Flow Scanner’s rule “Record ID as String”, and its reasoning: passing an id as a String means the flow has to ' +
      'fetch the record itself, so every caller pays an extra query for something the caller already had. ' +
      'A record-typed variable carries the fields with it.',
    remediation:
      'Change the input variable to the record type and pass the record. Where the flow is launched from ' +
      'a record page or another flow, the record is already available to hand over.',
    docUrl: 'https://flow-scanner.github.io/lightning-flow-scanner/',
    weight: 4,
  },
  HardcodedUrl: {
    id: 'flows.lfs.hardcoded-url',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow contains' : 'flows contain'} a hard-coded URL`,
    rationale:
      'A full URL written into a flow carries the instance or the org’s domain with it, so it breaks on ' +
      'a domain change, a sandbox refresh, or a migration — pointing users at production from a sandbox ' +
      'in the worst case.',
    remediation:
      'Build the link from $Api.Partner_Server_URL_x or a relative path, or keep the base in Custom ' +
      'Metadata so each org supplies its own.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000387070&type=1',
    weight: 5,
  },
  UnconnectedElement: {
    id: 'flows.lfs.unconnected-element',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} elements nothing connects to`,
    rationale:
      'An unconnected element never runs. It is usually the remains of a change someone abandoned ' +
      'half-way, and it costs the next reader time working out whether it matters — sometimes by ' +
      'connecting it to find out.',
    remediation:
      'Delete the unreachable elements, or connect them if they were meant to run. Ask before deleting: ' +
      'an element abandoned mid-change is a missing feature, not clutter.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_ref_connectors.htm&type=5',
    weight: 4,
  },
  UnusedVariable: {
    id: 'flows.lfs.unused-variable',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow declares' : 'flows declare'} variables it never uses`,
    rationale:
      'Lightning Flow Scanner’s rule “Unused Variable”. Unused variables are clutter, and clutter in a flow is expensive: the ' +
      'next person to change it has to establish that each one really is unused before touching anything.',
    remediation:
      'Delete the variables nothing references. Check the ones marked Available for Input or Output ' +
      'first: a caller can set one even when nothing inside the flow reads it, and deleting those ' +
      'breaks the caller rather than tidying it.',
    docUrl: 'https://flow-scanner.github.io/lightning-flow-scanner/',
    weight: 3,
  },
  CopyAPIName: {
    id: 'flows.lfs.copy-api-name',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow contains' : 'flows contain'} elements still named Copy_X_of_…`,
    rationale:
      'An element left with its copy name tells the reader nothing about what it does, and two elements ' +
      'a copy apart are easy to confuse when debugging a live problem.',
    remediation:
      'Rename each one to say what it does. Flow Builder repoints references when you rename from the ' +
      'element itself, but check any formula or text template that names it by hand.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_prep_bestpractices.htm&type=5',
    weight: 3,
  },
  CyclomaticComplexity: {
    id: 'flows.lfs.complexity',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow is' : 'flows are'} unusually complex`,
    rationale:
      'The count of loops and decision branches in these flows is high enough that the number of paths ' +
      'through them is beyond what anyone will test by hand. Salesforce publishes no complexity limit — ' +
      `the threshold of ${LFS_COMPLEXITY_THRESHOLD} is Lightning Flow Scanner's default, kept as an ` +
      'OrgTriage recommendation.',
    remediation:
      'Split the flow: move a self-contained branch into a subflow with a name that says what it decides. ' +
      'The aim is a flow a colleague can read in one sitting, not a lower number.',
    docUrl: 'https://flow-scanner.github.io/lightning-flow-scanner/#excessive-cyclomatic-complexity',
    weight: 5,
  },
  FlowDescription: {
    id: 'flows.lfs.no-description',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'flow has' : 'flows have'} no description`,
    rationale:
      'The description is the only place a flow’s purpose can live where the next admin will find it. ' +
      'Without one, working out whether a flow can be changed — or switched off — starts with reading ' +
      'every element.',
    remediation:
      'Write one or two sentences saying what the flow is for and what triggers it. Say what it must not ' +
      'break, which is the part the next person actually needs.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_prep_bestpractices.htm&type=5',
    weight: 4,
  },
};

/** Every OrgTriage rule id this module can raise. */
export const LFS_RULE_IDS: string[] = Object.values(LFS_RULES).map((r) => r.id);

/** LFS rule names OrgTriage runs, in the order they are declared above. */
export const LFS_ENABLED_RULES: string[] = Object.keys(LFS_RULES);

/**
 * Rule name → the scanner's own rule id, read from its registry.
 *
 * Isolated mode resolves the configuration keys through the registry, and the
 * registry's legacy-name index does not know every rule by the name it
 * reports back (`MissingRecordTriggerFilter` resolves by id and not by name in
 * 6.19.4). Keying the configuration by id sidesteps the index; results are
 * still matched by name, which is what `ruleResults` carry.
 */
const LFS_SCANNER_IDS: Map<string, string> = new Map(
  getRules(undefined, { betaMode: true }).map((rule) => [rule.name, rule.ruleId]),
);

/** Enabled rules by scanner id, in the shape `scan()` takes. */
function enabledRuleConfig(): Record<string, { severity: string }> {
  return Object.fromEntries(
    LFS_ENABLED_RULES.map((name) => [LFS_SCANNER_IDS.get(name) ?? name, { severity: 'error' }]),
  );
}

export interface FlowToScan {
  /** FlowDefinitionView.DurableId. */
  id: string;
  /** ApiName, used as the flow name LFS reports against. */
  name: string;
  label?: string;
  setupUrl?: string;
  /** The `Flow.Metadata` payload, exactly as the Tooling API returned it. */
  metadata: unknown;
}

export interface FlowScanOutcome {
  /** LFS rule name → the flows that violated it. */
  byRule: Map<string, FindingItem[]>;
  /**
   * Rules LFS reported that this mapping does not know about — a new release
   * slipped in. Reported as a warning; never silently scored or dropped.
   */
  unmapped: string[];
  /**
   * Flows LFS could not process at all. The reason is kept: "two flows failed"
   * is not actionable, and the first real org this ran against produced exactly
   * that message with no way to find out why.
   */
  failed: Array<{ name: string; reason: string }>;
  /**
   * LFS rule name → the flows on which that rule threw. A rule that errors on
   * every flow it saw has no verdict; one that errors on some has a partial
   * one, and either way the caller must say so rather than report clean.
   */
  ruleErrors: Map<string, Array<{ name: string; reason: string }>>;
  /** Flows that LFS actually scanned (parsed and ran rules over). */
  scanned: number;
}

/**
 * Run the enabled LFS rules over already-fetched flow metadata.
 *
 * Pure and synchronous: it makes no requests, which is what lets the caller
 * treat it as free. A flow that throws is recorded in `failed` rather than
 * taking the scan down — one malformed definition should not cost the org its
 * whole flow verdict.
 */
export function scanFlowMetadata(flows: FlowToScan[]): FlowScanOutcome {
  const byRule = new Map<string, FindingItem[]>();
  const unmapped = new Set<string>();
  const failed: Array<{ name: string; reason: string }> = [];
  const ruleErrors = new Map<string, Array<{ name: string; reason: string }>>();
  let scanned = 0;

  for (const input of flows) {
    let results: ReturnType<typeof scan>;
    try {
      // The first argument is a path LFS derives a display name from; it never
      // touches a filesystem here. `.flow-meta.xml` matches what it expects to
      // strip, so the name it reports back is the flow's API name.
      const flow = new Flow(`${input.name}.flow-meta.xml`, input.metadata);
      results = scan([new ParsedFlow(input.name, flow)], {
        betaMode: true,
        // `isolated`: run exactly the rules named and no others. The default,
        // `merged`, treats the list as configuration overrides and still runs
        // every rule the scanner ships — measured against 6.19.4, where the
        // "disabled" rules were executing on every flow and being discarded.
        ruleMode: 'isolated',
        rules: enabledRuleConfig(),
      });
    } catch (error) {
      const reason = (error as Error)?.message ?? String(error);
      failed.push({ name: input.name, reason });
      continue;
    }
    scanned += 1;
    foldScanResults(input, results, { byRule, unmapped, ruleErrors });
  }

  return { byRule, unmapped: [...unmapped], failed, ruleErrors, scanned };
}

/** One scanner result set, folded into the outcome accumulators. Exported for the tests. */
export function foldScanResults(
  input: FlowToScan,
  results: ReturnType<typeof scan>,
  acc: {
    byRule: Map<string, FindingItem[]>;
    unmapped: Set<string>;
    ruleErrors: Map<string, Array<{ name: string; reason: string }>>;
  },
): void {
  for (const result of results) {
    for (const rule of result.ruleResults) {
      if (rule.errorMessage) {
        const list = acc.ruleErrors.get(rule.ruleName) ?? [];
        list.push({ name: input.name, reason: rule.errorMessage });
        acc.ruleErrors.set(rule.ruleName, list);
        continue;
      }
      if (!rule.occurs) continue;
      if (!(rule.ruleName in LFS_RULES)) {
        // Either a rule we deliberately disabled that ran anyway, or one a
        // newer LFS added. Only the second is worth telling anyone about.
        if (!(rule.ruleName in LFS_DISABLED)) acc.unmapped.add(rule.ruleName);
        continue;
      }
      const items = acc.byRule.get(rule.ruleName) ?? [];
      items.push({
        id: input.id,
        name: input.name,
        label: input.label,
        setupUrl: input.setupUrl,
        evidence: evidenceFor(rule.details),
      });
      acc.byRule.set(rule.ruleName, items);
    }
  }
}

/**
 * The rule names the scanner actually executes for one flow, for the test that
 * pins the allow-list: "enabled" must mean "the only ones that run".
 */
export function rulesExecutedFor(metadata: unknown): string[] {
  const flow = new Flow('probe.flow-meta.xml', metadata);
  const results = scan([new ParsedFlow('probe', flow)], { betaMode: true, ruleMode: 'isolated', rules: enabledRuleConfig() });
  return results.flatMap((r) => r.ruleResults.map((rule) => rule.ruleName)).sort();
}

/**
 * Turn LFS violation details into evidence columns.
 *
 * Element names are the useful part — they are what the reader searches for in
 * Flow Builder. Six is enough to recognise the problem without turning the
 * table into a wall; the count carries the rest.
 */
function evidenceFor(
  details: Array<{ name: string; type?: string; metaType?: string }>,
): Record<string, string | number> {
  const names = details.map((d) => d.name).filter((n) => n && n !== 'undefined');
  const evidence: Record<string, string | number> = { Occurrences: details.length };
  if (names.length > 0) {
    evidence.Elements = names.slice(0, 6).join(', ') + (names.length > 6 ? ` +${names.length - 6} more` : '');
  }
  return evidence;
}
