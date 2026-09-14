/**
 * The remediation playbook: for every rule OrgTriage can raise, how the work is
 * classified, roughly what it costs, the steps that fix it, and what "done"
 * looks like.
 *
 * Kept apart from the analyzers on purpose. A rule's *detection* lives next to
 * the query that finds it; the *cure* is editorial content that changes as
 * Salesforce changes its Setup screens, and an old cached snapshot should pick
 * up the newer guidance rather than carry a stale copy around. The report page
 * and the sidebar both read from here by rule id.
 *
 * Effort figures are planning estimates for an experienced admin or developer
 * working in a sandbox with a normal deployment process. They are inputs to a
 * backlog conversation, not a quote.
 */

/**
 * How a finding lands on a backlog.
 *
 *  - `bug`     — users or deployments are affected today.
 *  - `debt`    — nothing is broken yet, but risk or cost accrues while it waits.
 *  - `hygiene` — clutter; the fix is tidy-up rather than engineering. Shown as
 *    "Maintenance": the key stays for stored plans and the JSON export.
 */
export type StoryKind = 'bug' | 'debt' | 'hygiene';

export type StoryRole = 'admin' | 'developer' | 'admin or developer';

export interface Playbook {
  kind: StoryKind;
  role: StoryRole;
  /**
   * Planning hours: `fixed` once per story plus `perItem` for each affected
   * component. Either may be zero.
   */
  effort: { fixed: number; perItem: number };
  /** Ordered, concrete steps. Setup paths are Lightning Experience paths. */
  steps: string[];
  /** The rule-specific definition of done, in addition to "the rule no longer fires". */
  acceptance: string;
}

export const KIND_LABEL: Record<StoryKind, string> = {
  bug: 'Bug',
  debt: 'Tech debt',
  hygiene: 'Maintenance',
};

/** Jira label for a kind: lowercase, hyphenated, the convention Jira teams filter on. */
export const KIND_SLUG: Record<StoryKind, string> = {
  bug: 'bug',
  debt: 'tech-debt',
  hygiene: 'maintenance',
};

const APEX_TEST_EXECUTION = 'Setup > Custom Code > Application Test Execution';
const APEX_TEST_HISTORY = 'Setup > Custom Code > Application Test History';
const APEX_CLASSES = 'Setup > Custom Code > Apex Classes';

export const PLAYBOOK: Record<string, Playbook> = {
  /* ------------------------------------------------------------------------ */
  /* Apex                                                                     */
  /* ------------------------------------------------------------------------ */
  'apex.org-coverage-below-75': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 6, perItem: 0 },
    steps: [
      `Refresh the figure first: in ${APEX_CLASSES} click Run All Tests, or open ${APEX_TEST_EXECUTION} and select all namespaces (or run \`sf apex run test --test-level RunLocalTests --code-coverage\`). Stale coverage from a months-old run often accounts for several points.`,
      `In ${APEX_CLASSES}, click "Estimate your organization's code coverage", then sort the class list by uncovered lines. Coverage is line-weighted, so the largest uncovered classes move the org-wide number most.`,
      'For each of the top classes, decide whether it is still used: query the MetadataComponentDependency Tooling object (which Salesforce marks Beta, not for production use) or search the metadata for references. Delete dead code through a deployment with destructiveChanges rather than writing tests for it.',
      'Write tests for what remains: one method per public entry point, covering the success path and at least one failure path, with assertions on the outcome rather than on execution alone.',
      'Run all tests again and repeat until the org clears 75% with margin. OrgTriage suggests aiming for 80% so a single new class cannot push it back under the gate; Salesforce requires only the 75%.',
    ],
    acceptance:
      'A full test run in the target org reports org-wide coverage of at least 75%, and the run has no failures.',
  },
  'apex.no-coverage': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 1, perItem: 3 },
    steps: [
      `Run all tests (Run All Tests on ${APEX_CLASSES}, or ${APEX_TEST_EXECUTION}) before touching anything: a class deployed after the last run has no coverage row at all, and reads as uncovered when it is merely unmeasured.`,
      'For each component still listed, check whether anything references it: the MetadataComponentDependency Tooling object (Beta, not for production use, in Salesforce’s words) or a search of the metadata. Unreferenced classes with no scheduled, batch or REST entry point are usually dead.',
      'Remove dead code with a destructiveChanges deployment from a sandbox, and record the removal in the release notes.',
      'For live code, add a test class named after the component (`AccountServiceTest`) with @TestSetup data, one method per public method, and assertions on results. Use Test.startTest/stopTest around asynchronous calls.',
      'Run the new tests with coverage and confirm each component appears in the coverage list with lines covered.',
    ],
    acceptance:
      'Every component listed either has a coverage row with covered lines above zero (target 75%) or has been deleted.',
  },
  'apex.low-coverage': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'Open each component in the Developer Console and use its Code Coverage menu to see which lines are uncovered.',
      'Uncovered lines are usually the exception handlers and the else-branches. Write a test per branch, forcing the condition with test data or by inserting records that fail validation.',
      'Prefer positive assertions on the outcome (a field value, a record count, an exception message) over bare execution.',
      'Re-run the affected test classes with coverage and check the component now reads 75% or better. Per-component 75% is OrgTriage\'s target: Salesforce applies 75% org-wide for a default-test deployment and per deployed class or trigger when a deployment runs specified tests, so confirm which test level your releases use.',
    ],
    acceptance: 'Each listed component reports at least 75% line coverage (OrgTriage\'s per-component target) after a fresh test run, and the org meets Salesforce\'s requirement for the deployment test level it uses.',
  },
  'apex.trigger-no-coverage': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'Confirm the trigger is still wanted. A trigger nobody can explain is a candidate for deletion, not for a test.',
      'Write a test that performs the DML the trigger listens for — insert, update, delete or undelete on that object — inside Test.startTest/stopTest, using at least 200 records (OrgTriage\'s suggested bulk test size, one DML batch) so bulk behaviour is exercised.',
      'Assert on the effect the trigger is meant to have (a populated field, a related record, a validation error), not merely that the DML succeeded.',
      'Run the test with coverage and confirm the trigger shows covered lines.',
    ],
    acceptance: 'Every listed trigger has at least one covered line, and a full test run completes without failures.',
  },
  'apex.multiple-triggers-per-object': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 2, perItem: 6 },
    steps: [
      'List every active trigger on the object and the events each handles (before insert, after update, and so on). Note any logic that assumes another trigger has already run.',
      'Create one handler class per object (`AccountTriggerHandler`) with a method per event, and move each trigger body into the matching method in the order the business logic requires.',
      'Create a single trigger on the object that fires on every event the old triggers covered and delegates to the handler. Add a static recursion guard if any handler updates the same object.',
      'Run the existing tests plus a bulk test of 200 records (OrgTriage\'s suggested test size, one DML batch) through each event. Fix ordering assumptions the consolidation exposes — that is the point of the exercise.',
      'Deploy the handler and new trigger, then delete the old triggers in the same release with destructiveChanges so there is no window with both active.',
    ],
    acceptance:
      'Each listed object has exactly one active trigger, delegating to a handler class, and all tests pass.',
  },
  'apex.old-api-version': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 1, perItem: 0.5 },
    steps: [
      'Sort the list by API version and start with the oldest. Group work by feature so a behaviour change between versions is easy to attribute.',
      `Raise the version in each class or trigger's metadata file (\`<apiVersion>\` in the .cls-meta.xml, or Version Settings on the component's page in ${APEX_CLASSES}) to the org's current version, a few components at a time.`,
      'Compile and run the tests for the changed components. Read the release notes for any version boundary the tests trip over — differences in SOQL semantics, null handling and JSON serialisation are the usual causes.',
      'Deploy from a sandbox once tests pass. Note the new baseline in the team\'s coding standard so new components start at the current version.',
    ],
    acceptance:
      'No listed component remains more than nine releases behind the org\'s current API version (the OrgTriage threshold this check uses; a stricter team target is fine, labelled as your own), and all tests pass.',
  },
  'apex.coverage-unmeasured': {
    kind: 'hygiene',
    role: 'admin or developer',
    effort: { fixed: 1, perItem: 0 },
    steps: [
      `In ${APEX_CLASSES} click Run All Tests (or open ${APEX_TEST_EXECUTION} and select all namespaces), or run \`sf apex run test --test-level RunLocalTests --code-coverage --wait 30\` from a terminal.`,
      'Wait for the run to finish (large orgs take an hour or more), then refresh the OrgTriage Apex scan.',
      'Anything still listed genuinely has no test exercising it: treat it under the no-coverage story.',
    ],
    acceptance: 'After a full test run, no class is reported as unmeasured.',
  },
  'apex.needs-recompile': {
    kind: 'hygiene',
    role: 'admin or developer',
    effort: { fixed: 0.5, perItem: 0 },
    steps: [
      'Rescan after the next deployment or test run: a deployment recompiles the classes that depend on what it changed.',
      `If the same components stay invalid, open ${APEX_CLASSES} and click "Compile all classes".`,
      'Investigate anything that fails to compile: a referenced field, object or class has been removed or renamed. Fix the reference and redeploy.',
    ],
    acceptance: 'Compile all classes completes without errors and the listed components report IsValid = true.',
  },
  'apex.inactive-trigger': {
    kind: 'hygiene',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'For each inactive trigger, find out from version control history or the last-modified user why it was disabled.',
      'If the logic has been replaced (by a flow or another trigger), delete the trigger with a destructiveChanges deployment. Inactive triggers still need coverage to deploy alongside.',
      'If it was disabled for an incident and the cause is fixed, reactivate it in a sandbox, run the tests, and deploy.',
      'If it must stay inactive, add a comment at the top of the trigger stating why and until when.',
    ],
    acceptance: 'Each listed trigger is either deleted, active again, or carries a dated comment explaining why it is kept inactive.',
  },
  'apex.large-class': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 1, perItem: 8 },
    steps: [
      'Read the class for responsibilities: data access, business rules, formatting and integration calls usually sit side by side in a class this size.',
      'Extract one responsibility at a time into a new class, starting with the one that has the clearest boundary (selector or service methods first). Keep the public method signatures on the original class as thin delegates so callers do not change.',
      'Write focused tests for each new class as it is extracted, and keep the original tests green throughout.',
      'Once callers are updated to use the new classes directly, remove the delegates.',
    ],
    acceptance:
      'No listed class exceeds the threshold, each extracted class has its own tests, and the full test run passes.',
  },
  'apex.no-exception-recipients': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0 },
    steps: [
      'Agree who should receive unhandled-exception emails: a monitored shared mailbox or a ticketing address is better than a person.',
      'Go to Setup > Custom Code > Apex Exception Email and add that address under External Email Addresses, or add a Salesforce user under Salesforce User Notifications.',
      'Trigger a test exception in a sandbox (a scheduled class that throws) and confirm the email arrives.',
      'Document the address in the runbook so it is updated when the team changes.',
    ],
    acceptance: 'At least one monitored address is configured and a test exception email is confirmed received.',
  },
  'apex.stale-test-run': {
    kind: 'hygiene',
    role: 'admin or developer',
    effort: { fixed: 1, perItem: 0 },
    steps: [
      `Run all tests: Run All Tests on ${APEX_CLASSES}, or ${APEX_TEST_EXECUTION} with every namespace selected (or \`sf apex run test --test-level RunLocalTests\`).`,
      'Fix or ticket any failures the run surfaces — see the failing-tests story if one appears.',
      'Schedule a recurring run: a nightly Apex job that calls the ApexTestQueueItem API, or a CI job that runs tests against the sandbox, so coverage never goes stale again.',
    ],
    acceptance: 'A full test run has completed within the last 30 days and a recurring run is scheduled.',
  },
  'apex.failing-tests': {
    kind: 'bug',
    role: 'developer',
    effort: { fixed: 1, perItem: 1.5 },
    steps: [
      `Open ${APEX_TEST_HISTORY} (or View Test History from ${APEX_TEST_EXECUTION}) and read each failure's message and stack trace.`,
      'Sort failures by cause: data assumptions (a required field or validation rule added since), org-dependent data (SeeAllData, hard-coded ids), and genuine regressions.',
      'Fix the code where the test is right and the code is wrong; fix the test where it depends on org data it should create itself. Never delete a failing test without a written reason.',
      'Re-run the affected classes, then a full run, before deploying.',
    ],
    acceptance: 'The most recent full test run has zero failed methods.',
  },

  /* ------------------------------------------------------------------------ */
  /* Flows                                                                    */
  /* ------------------------------------------------------------------------ */
  'flows.legacy-process-builder': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 2, perItem: 4 },
    steps: [
      'Inventory each process or workflow rule: object, criteria, actions and who owns the business rule. Retire any whose owner cannot explain them.',
      'Open Setup > Process Automation > Migrate to Flow, select the process, and let the tool generate a record-triggered flow.',
      'Review the generated flow in Flow Builder: check entry conditions, add a fault path, and set a trigger order if other flows exist on the object.',
      'Test in a sandbox with the process still active but the flow inactive, then swap: activate the flow and deactivate the process in one change so nothing runs twice.',
      'After a release cycle with no regressions, delete the process or workflow rule.',
    ],
    acceptance:
      'Every listed process or workflow rule is inactive, its replacement flow is active with a fault path, and the behaviour is verified in a sandbox.',
  },
  /* ---------------------------------------------------------------- *
   * Borrowed rules. Detection comes from Lightning Flow Scanner; every
   * step below is OrgTriage's, because a rule name is not a plan.
   * ---------------------------------------------------------------- */
  'flows.lfs.soql-in-loop': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 1, perItem: 3 },
    steps: [
      'Open the flow in Flow Builder and find the Get Records element inside the loop.',
      'Move it before the loop and widen its filter so one query returns every record the loop will need — usually an "In" filter against a collection of ids gathered beforehand.',
      'Inside the loop, replace the Get with a lookup against that collection: a Decision on a matching field, or a collection filter, depending on how the records line up.',
      'Test with a bulk load of at least 200 records (our test size) through the trigger point. Debug Logs in Setup (Quick Find: Debug Logs) shows the SOQL count in the transaction’s limit lines; it should no longer scale with the number of records.',
      'Activate the new version, then delete the old one once it has run clean for a cycle.',
    ],
    acceptance:
      'Each listed flow runs no Get Records inside a loop, and a 200-record bulk update completes with a SOQL count that does not grow with the batch size.',
  },
  'flows.lfs.dml-in-loop': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 1, perItem: 3 },
    steps: [
      'Open the flow and find the Create, Update or Delete element inside the loop.',
      'Add a record collection variable of the right object type.',
      'Inside the loop, replace the record operation with an Assignment that adds the record to that collection.',
      'After the loop, add one Create, Update or Delete element that operates on the collection.',
      'Test with a bulk load of at least 200 records (OrgTriage\'s suggested test size, one DML batch) and confirm from the debug log that the DML count is now a small constant rather than one per record.',
      'Activate the new version and delete the old one once verified.',
    ],
    acceptance:
      'Each listed flow performs no database operation inside a loop and processes a 200-record bulk update without a limit error.',
  },
  'flows.lfs.action-in-loop': {
    kind: 'bug',
    role: 'admin or developer',
    effort: { fixed: 1, perItem: 3 },
    steps: [
      'Identify the action, subflow or Apex invocable called inside the loop, and check whether it accepts a collection input — many do, and the fix is then to call it once after the loop.',
      'Where it does not, find out what it costs per call (its own queries and DML) before deciding: a callout in a loop is a different problem from an email alert in a loop, and the callout is the urgent one.',
      'For Apex actions, ask a developer to expose a second invocable action that takes the whole collection and does its queries and DML once. That is a smaller change than restructuring the flow around a per-record action.',
      'Where the action genuinely cannot be bulkified, move the work to an asynchronous path so it no longer shares the triggering transaction\'s limits — and bound the work per asynchronous transaction (chunk the collection), since the async transaction has limits of its own.',
      'Re-test with a bulk load and confirm the transaction stays inside its limits.',
    ],
    acceptance:
      'No listed flow calls an action, subflow or Apex invocable inside a loop in a synchronous path, and a 200-record bulk operation completes without a limit error.',
  },
  'flows.lfs.unsafe-running-context': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'Open the flow, then Edit its version properties and look at "How to Run the Flow".',
      'Establish what the setting is actually there for. Usually it was changed to clear a permission error rather than as a decision about data access, and the note in the flow description — if any — will say nothing about it.',
      'Switch it to run in user context, or to system context with sharing, and grant the running user the specific access it needs through a permission set instead.',
      'Test as a user with restricted access: the flow should now fail closed on records they cannot see, rather than silently reading them.',
      'Where system mode without sharing is genuinely required, leave it and write the reason in the flow description so the next audit does not re-open it.',
    ],
    acceptance:
      'Each listed flow either runs with sharing enforced, or carries a description stating why it must not and who approved that.',
  },
  'flows.lfs.hardcoded-secret': {
    kind: 'bug',
    role: 'admin or developer',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'Treat the value as compromised from the moment you find it: it is readable by anyone with access to the flow and it is in every sandbox made from this org.',
      'Create a Named Credential (with an External Credential) for the service if the secret authenticates a callout, and reference it from the flow. For anything else, choose a store that genuinely restricts reading: ordinary Custom Metadata and custom settings are readable by anyone who can read metadata, and Custom Metadata is protected only inside a managed package.',
      'Remove the literal from the flow, then activate and test the integration.',
      'Rotate the secret at the far end. Skipping this leaves the old value valid wherever the metadata has already travelled.',
      'Check whether the value also appears in Apex, custom settings or a static resource before closing the story.',
    ],
    acceptance:
      'No listed flow contains a credential literal, the value is stored in a Named Credential or protected Custom Metadata, and the original secret has been rotated.',
  },
  'flows.lfs.missing-fault-path': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the flow and, for each data element or action without one, drag a fault connector from the element.',
      'Route the fault to a Custom Error element (record-triggered flows) or a screen with a plain-language message (screen flows), including {!$Flow.FaultMessage} so support can diagnose it.',
      'Optionally send the fault to a shared mailbox or log it to a custom object so failures are visible without an email trail.',
      'Force a failure in a sandbox — a validation rule that blocks the update is the easiest way — and confirm the user sees the friendly message rather than an unhandled error.',
    ],
    acceptance:
      'Every data element and action in the listed flows has a fault path, verified by forcing one failure per flow.',
  },
  'flows.lfs.no-entry-criteria': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the flow\'s Start element and identify the fields the logic actually depends on.',
      'Add entry conditions that express that dependency (a status value, a checkbox, a field that changed) so the flow fires only when it has work to do.',
      'For update triggers, choose "Only when a record is updated to meet the condition requirements" if the business event is the record becoming eligible; if the flow must act on every qualifying edit while the conditions stay true, keep "Every time" and narrow the conditions to the fields that matter instead.',
      'Test in a sandbox: an unrelated field edit should no longer run the flow, and the intended change still should.',
    ],
    acceptance:
      'Each listed flow has entry conditions on its Start element and does not run on unrelated field edits.',
  },
  'flows.lfs.recursive-after-update': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'Confirm the flow is after-save and that the Update Records element targets the record that triggered it.',
      'Check whether every field it sets could be set before save instead — values derived from the record itself always can.',
      'Create a before-save version of the flow, replace the Update Records with an Assignment to $Record, and leave anything that must stay after save (related records, actions) in the original.',
      'Activate the before-save flow and deactivate the update in the after-save one in a single change, so nothing runs twice in between.',
      'Watch the object for a day: the second save should be gone, and the field values unchanged.',
    ],
    acceptance:
      'No listed after-save flow updates its own triggering record, and the field values it produced are still correct.',
  },
  'flows.lfs.same-record-update': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1.5 },
    steps: [
      'Check that every field the Update Records element sets belongs to the triggering record, and note everything else the flow does after that element — actions, emails, other records — which must stay in an after-save flow.',
      'Move only the same-record assignments into a before-save flow (an Assignment to $Record). If the flow does nothing else, change the whole flow; otherwise leave the after-save flow in place minus the update, and test the order the two run in.',
      'Remove the now-redundant Get Records if one was fetching the record the flow already had.',
      'Test a save and confirm the values still land; then compare save time on a bulk update before and after — this is one of the few flow changes with a directly measurable result.',
    ],
    acceptance:
      'Each listed flow sets its own record\'s fields through $Record in a before-save flow, with no Update Records element on the triggering record.',
  },
  'flows.lfs.missing-null-handler': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Find each Get Records whose result is used without being checked.',
      'Add a Decision immediately after it testing whether the record variable is null (Is Null = True).',
      'Give the not-found branch a defined outcome: a fault-style custom error, a default value, or an end — anything but falling through into logic that assumes a record.',
      'Test with input that matches nothing and confirm the flow behaves the way the branch says, rather than erroring.',
    ],
    acceptance:
      'Every Get Records in the listed flows is followed by a null check with a defined not-found path.',
  },
  'flows.lfs.duplicate-dml': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'Walk the flow as a user would, including pressing Previous: identify which record operation can be reached twice.',
      'Where possible, move the operation after the final screen so navigation cannot repeat it.',
      'Where it must stay mid-flow, add a boolean variable set to true once the work is done, and a Decision that skips the operation when it is already set.',
      'Test the back-and-forward path explicitly and confirm only one record is created or updated.',
    ],
    acceptance:
      'Navigating backward and forward through each listed flow produces exactly one record operation.',
  },
  'flows.lfs.no-start-reference': {
    kind: 'bug',
    role: 'admin or developer',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the flow in Flow Builder. A flow with no start element usually will not open cleanly, which itself confirms the finding.',
      'If it opens, connect the start element to the first element that should run, then save and activate.',
      'If it does not, redeploy the flow from source control or from a sandbox where it is intact — this is a broken definition, not a configuration choice.',
      'Check the deployment history for the change that produced it, in case other components landed half-deployed at the same time.',
    ],
    acceptance: 'Each listed flow opens in Flow Builder and has a connected start element.',
  },
  'flows.lfs.get-all-fields': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.5 },
    steps: [
      'Open each Get Records element set to store all fields and list the fields the flow actually references downstream.',
      'Switch it to "Choose fields and let Salesforce do the rest" and select only those.',
      'Watch for formula and long text fields in particular: they are the ones that cost most to fetch and are rarely the ones being used.',
      'Test the flow to confirm nothing downstream referenced a field you removed.',
    ],
    acceptance: 'No listed flow retrieves all fields on a Get Records element.',
  },
  'flows.lfs.transform-instead-of-loop': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Confirm the loop does nothing but assign values from each item to another collection — a loop with decisions or record operations in it is not a candidate.',
      'Add a Transform element and map the source collection to the target, field by field.',
      'Delete the loop and its assignment.',
      'Test with a collection large enough to notice, and compare the CPU time in the debug log.',
    ],
    acceptance: 'Each listed flow uses a Transform element in place of an assignment-only loop, with the same output.',
  },
  'flows.lfs.record-id-as-string': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 1 },
    steps: [
      'List every caller first — record page actions, quick actions, parent flows, Apex, buttons. A record-page launcher supplies recordId as Text by design and cannot pass a record; if any caller is one of those, keep the Text input and stop here.',
      'Where every caller can pass a record, change the input variable from Text to a record variable of the right object, and delete the Get Records that was fetching the record from the id, pointing its consumers at the input variable.',
      'Update every caller to pass the record instead of the id, in the same change.',
      'Test each caller: this change breaks them until they are updated, so none can be left behind.',
    ],
    acceptance: 'Each listed flow takes a record variable rather than an id string, and every caller passes one.',
  },
  'flows.lfs.hardcoded-url': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.5 },
    steps: [
      'Find the literal URL in the flow — usually in an email body, a screen\'s rich text, or an action input.',
      'For links back into this org, use a relative path so the link follows whichever org the flow is running in.',
      'For external systems, put the base URL in Custom Metadata and build the link from it, so each environment points at its own.',
      'Test from a sandbox and confirm the link no longer sends the user to production.',
    ],
    acceptance: 'No listed flow contains an org-specific or environment-specific URL literal.',
  },
  'flows.lfs.unconnected-element': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.5 },
    steps: [
      'Open the flow and find the elements with no incoming connector.',
      'Decide, with whoever owns the automation, whether each was meant to run. Something abandoned mid-change may be a missing feature rather than clutter.',
      'Connect the ones that should run; delete the rest.',
      'Save and activate. Where elements were deleted, nothing should behave differently — if it does, one was reachable after all. Where elements were connected, that is a deliberate change: test the newly reachable logic against what its owner expects.',
    ],
    acceptance: 'Each listed flow has no unreachable elements; deletions left behaviour unchanged, and any newly connected logic was approved and tested by its owner.',
  },
  'flows.lfs.unused-variable': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Open the Toolbox’s Manager tab in Flow Builder (its Unused filter lists resources nothing references) and check each variable the finding names.',
      'Take care with variables marked Available for Input or Output: a caller may set one even though nothing inside the flow reads it, and deleting it breaks the caller.',
      'Delete the rest, then save and activate.',
    ],
    acceptance: 'Each listed flow declares no unused variables, and no caller of an input/output variable was broken.',
  },
  'flows.lfs.copy-api-name': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Rename each element still carrying a copy name to say what it does.',
      'Check every formula and text template that mentions the old name, and fix any that still do.',
      'Save and activate.',
    ],
    acceptance: 'No element in the listed flows is named Copy_X_of_… and every reference still resolves.',
  },
  'flows.lfs.complexity': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 1, perItem: 4 },
    steps: [
      'Read the flow with its owner and mark the branches that belong together — a complex flow is usually two or three jobs that grew into one.',
      'Move each self-contained branch into a subflow named for the decision it makes, and pass only what it needs.',
      'Do it one branch at a time, activating and testing between each, rather than restructuring the whole flow in one change.',
      'Stop when a colleague can read the main flow and say what it does. The score is a prompt, not the target.',
    ],
    acceptance:
      'Each listed flow has been split so its main path is readable end to end, with the extracted logic in named subflows and behaviour unchanged.',
  },
  'flows.lfs.no-description': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Open the flow\'s version properties and write one or two sentences: what it is for, what triggers it, and what it must not break.',
      'Where nobody can say what a flow is for, that is the more important finding — record it and check whether the flow should be running at all.',
      'Save. The description travels with the version, so add it to the version you intend to keep.',
    ],
    acceptance: 'Every listed flow has a description that states its purpose and trigger, or has been retired.',
  },
  'flows.legacy-workflow-rules': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 1, perItem: 1.5 },
    steps: [
      'For each rule, open Setup > Workflow Rules and note the object, the evaluation criteria, and every action (field update, email alert, task, outbound message, time trigger).',
      'Use Migrate to Flow (Quick Find in Setup) to convert it. Email alerts, outbound messages and time-dependent actions migrate. Rebuild by hand what the tool declines: criteria with no actions, formulas that use global variables or fields on related records, record-type criteria, the does-not-contain, includes, excludes and within operators, Task actions, and relative dates.',
      'Test in a sandbox in two passes, never both active at once: with the rule active and the flow inactive, record the outcome (including time-dependent actions); then with the flow active and the rule inactive, confirm the same outcome. Running both together doubles side effects and proves nothing.',
      'Where several rules act on one object, migrate them into one record-triggered flow with ordered decisions rather than one flow per rule.',
      'Rules that were already inactive: ask their owner whether they are kept for rollback or future work; delete only with that answer, so the migration list matches the real list without losing anything deliberate.',
    ],
    acceptance: 'No active workflow rule remains, every migrated automation has been exercised in a sandbox, and no record save runs a field update twice.',
  },
  'flows.multiple-per-object': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'For each object and trigger point, list the flows involved and write down the order the business logic requires.',
      'Set each flow’s Trigger Order (1–2,000) in the save dialog when you save a new version, or in the version properties of a flow already saved. Leave gaps (10, 20, 30), which is Salesforce’s own advice, so future flows can slot in.',
      'Where two flows do closely related work, consider merging them into one flow with a Decision element — one flow per object and trigger point is easier to reason about.',
      'Save as a new version, activate, and test the ordered behaviour in a sandbox.',
    ],
    acceptance: 'Every record-triggered flow on the listed object and trigger point combinations has an explicit trigger order.',
  },
  'flows.never-activated': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.25 },
    steps: [
      'Check the last-modified date and user for each flow. Anything untouched for months with no active version is an abandoned draft.',
      'Ask the last editor whether it is still wanted. If yes, finish and activate it; if no, delete it from Setup > Process Automation > Flows.',
    ],
    acceptance: 'Each listed flow is either active or deleted.',
  },
  'flows.version-clutter': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Open the flow\'s version list from Setup > Process Automation > Flows.',
      'Agree with the flow\'s owner which versions must stay: the active one, the rollback candidate, any draft that is work in progress, and any version a paused interview still references (those cannot be deleted anyway). Export or version-control what you are about to remove.',
      'Delete only the versions the owner approved, then agree a team convention (for example, keep three versions) so the list does not regrow.',
    ],
    acceptance: 'No listed flow has more than the agreed number of versions.',
  },
  'flows.active-not-latest': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.5 },
    steps: [
      'Open the latest version and compare it with the active one (the version list shows dates and editors; Flow Builder shows the description).',
      'If the draft is a finished change that was never activated, test it in a sandbox and activate it.',
      'If the draft is abandoned, delete it so the active version is also the latest.',
    ],
    acceptance: 'For each listed flow the newer draft is either documented as work in progress, activated after testing, or deleted after being confirmed abandoned.',
  },
  'flows.old-api-version': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.75 },
    steps: [
      'Open the flow in Flow Builder, choose Save As > New Version, and in Advanced settings set the API version to the current one.',
      'Review the release notes for the versions being skipped: flow runtime behaviour changes are listed under "Flow" in each release.',
      'Test the new version in a sandbox, then activate it.',
    ],
    acceptance: 'Each listed flow\'s active version runs on the org\'s current API version.',
  },
  'flows.legacy-builder': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'Open the flow in Flow Builder (the modern builder opens Cloud Flow Designer flows read-only until saved).',
      'Walk through every element and compare against the original behaviour; note anything the new builder renders differently, particularly screen components and formulas.',
      'Save as a new version at the current API version, test it in a sandbox, and activate.',
    ],
    acceptance: 'Each listed flow has an active version saved from Flow Builder at the current API version.',
  },
  'flows.hardcoded-ids': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 1, perItem: 1.5 },
    steps: [
      'Open the flow and search the elements and formulas for the id values reported in the evidence. Confirm each one is a real record reference and not a false positive.',
      'Replace each id with a lookup: a Get Records element that finds the record by a stable key (Developer Name, Name or an external id), or a Custom Metadata / Custom Setting value read at run time.',
      'Test in a sandbox where the record ids differ from production; the flow should still resolve the right record.',
      'Activate the new version and note the pattern in the team\'s flow standards.',
    ],
    acceptance: 'No listed flow contains a hard-coded record id, verified by running it successfully in a sandbox with different ids.',
  },
  'flows.managed-not-analyzable': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0 },
    steps: [
      'These flows belong to installed packages and their definitions are not readable through the API. No change is possible in this org.',
      'If a package flow is suspected of slowing saves or failing, capture a debug log for the transaction and raise it with the package publisher.',
    ],
    acceptance: 'Recorded as reviewed; no change expected.',
  },

  /* ------------------------------------------------------------------------ */
  /* Reports and dashboards                                                   */
  /* ------------------------------------------------------------------------ */
  'reports.abandoned': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 1, perItem: 0.15 },
    steps: [
      'Create a folder named "Archive – <year>" with access restricted to admins.',
      'Move the listed reports into it (Reports tab > All Reports > select > Move), then open a dashboard or subscription that used one and confirm it still resolves.',
      'Announce the archive and a deletion date one release cycle out. Restore anything someone asks for.',
      'After the date, delete what remains. Deleted reports sit in the Recycle Bin for 15 days.',
    ],
    acceptance: 'Every listed report is either in the archive folder with a deletion date or has been deleted.',
  },
  'reports.never-run': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.1 },
    steps: [
      'Check the created date and creator. A never-run report created in the last few weeks may simply be new; the rest are leftovers.',
      'Confirm with the creator or owning team, then delete, or move to the archive folder alongside the abandoned reports.',
    ],
    acceptance: 'Each listed report is deleted or archived, except ones created within the last 30 days.',
  },
  'reports.no-filters': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Ask the report\'s audience what population it must cover before narrowing anything: a faster report that drops rows the reader relies on is a wrong report.',
      'Where a narrower population is acceptable, add a standard date filter in the report builder — Created Date or Close Date with a relative range such as THIS YEAR or LAST 90 DAYS. This is the cheapest limit a report can have.',
      'Where the report must stay all-time, add only a scope filter the requirement permits (My Records, an owner, a status, a record type), or record that it is intentionally unfiltered and treat its run time separately. For tabular reports whose readers use the top rows, add a Row Limit filter with a sort.',
      'Save and run: the row count should be a fraction of the object, and the run time noticeably shorter.',
    ],
    acceptance: 'Every listed report has a resolved date range or a narrowing filter, and none reads the whole object.',
  },
  'reports.hidden-report-type': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'In Setup, enter Reports and Dashboards Settings in Quick Find, choose Report Types, and open the type. Hidden here means its deployment status is In Development, not the Classic list of report types to hide. Find out from its description or last editor why.',
      'If the type is still valid, set it back to Deployed so reports can be built on it.',
      'If it is being retired, rebuild each listed report on a supported report type (there is no in-place migration: clone the columns, filters and groupings onto a new report), repoint any dashboard components, then delete the original.',
    ],
    acceptance: 'No listed report uses a report type that is hidden in Setup.',
  },
  'reports.private-folder': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.25 },
    steps: [
      'Ask each owner which of their private reports the team depends on (dashboard sources and subscriptions are the usual ones).',
      'Have the owner move those into a shared folder with the right sharing. An admin cannot move another user\'s private reports directly.',
      'Leave genuinely personal scratch reports where they are.',
    ],
    acceptance: 'No report that feeds a dashboard or subscription lives in a private folder.',
  },
  'reports.unfiled-public': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.15 },
    steps: [
      'Create or choose folders by audience (Sales, Service, Finance, Admin) with sharing set deliberately.',
      'Move each listed report into the right folder from the Reports tab.',
      'Consider removing Create and Customize Reports from profiles that do not need it, so new reports stop landing in Unfiled Public Reports.',
    ],
    acceptance: 'Unfiled Public Reports contains none of the listed reports.',
  },
  'reports.duplicate-candidates': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the reports in each group side by side and compare filters; the differences are usually one filter value.',
      'Keep one report, add a filter the user can change at run time, or a dashboard filter if the variants feed a dashboard.',
      'Repoint any dashboard components and subscriptions at the survivor, then delete the clones.',
    ],
    acceptance: 'Each listed group is reduced to one report, and no dashboard component references a deleted clone.',
  },
  'dashboards.broken-component': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Open the report by the id shown in the finding (paste it after your org’s URL). If it opens, the report exists and the problem is where it lives: note the folder.',
      'If it sits in a user’s private folder, have them move it to a folder shared with the dashboard’s viewers, or save a copy there and use that.',
      'If the id does not open, edit the dashboard component and select a replacement report, or remove the component.',
      'Refresh the dashboard and confirm every component renders.',
    ],
    acceptance: 'Every listed dashboard component renders without error after a refresh.',
  },
  'dashboards.stale': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Ask the dashboard\'s owner or the team named in the folder whether it is still used.',
      'If it is and it runs as a fixed user, open the dashboard, click Subscribe, and set a refresh schedule (daily before the working day is the common choice), adding recipients so it is seen. A dynamic dashboard (run as the viewer) cannot be scheduled: agree a manual refresh habit with its owner, or redesign it around a fixed running user if the visibility model allows.',
      'If not, move it to the archive folder and delete after a release cycle.',
    ],
    acceptance: 'Each listed dashboard either has a refresh schedule, is a dynamic dashboard with an agreed refresh practice, or has been archived.',
  },
  'dashboards.running-user': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Open the dashboard properties and note the running user and the folder\'s viewers.',
      'Compare what the running user can see with what the viewers should see. A dashboard run as an admin and shared with a wide audience shows every viewer whatever its source reports return under that admin — records and fields their own access would hide.',
      'Where viewers should see only their own data, change "View Dashboard As" to "The dashboard viewer". Where a fixed user is correct (an executive rollup), record the decision in the dashboard description.',
    ],
    acceptance: 'Each listed dashboard either runs as the viewer or has a documented reason for its fixed running user.',
  },
  'dashboards.no-components': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.1 },
    steps: ['Confirm with the creator, then delete each empty dashboard from the Dashboards tab.'],
    acceptance: 'Each listed dashboard is deleted.',
  },
  'reports.joined-not-checked': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Open each joined report and check every block for a date range or a narrowing filter — the API does not expose block-level filters, so this is a manual review.',
      'Treat any block with none under the unfiltered-report story.',
    ],
    acceptance: 'Each block of each listed joined report has been reviewed and carries a filter or a date range.',
  },

  /* --- Report performance ------------------------------------------------- */
  'reports.perf.inefficient-filters': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Open the report and find the filters using contains, does not contain, not equal to or excludes (the evidence column names them).',
      'Rewrite as equals or starts with only where the answer stays the same — contains "acme" and starts with "acme" are different questions. If the value being searched is really a category, add a picklist to the object and filter on that.',
      'If a contains search is unavoidable, add a selective filter beside it (owner, status, date range) on an indexed field, so the optimizer has an index to drive the query from and the text scan only runs over what survives it. Adding the filter is what matters, not where it sits in the list.',
      'Save and run, comparing the run time with the previous one.',
    ],
    acceptance:
      'No listed report relies on a non-indexable operator alone; each has a selective, indexable filter alongside it.',
  },
  'reports.perf.wide-date-range': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Open the report and change the standard date filter from All Time or a multi-year custom range to a relative range: THIS YEAR, LAST 12 MONTHS, or LAST N DAYS.',
      'If a historical view is needed, clone the report as "<name> – History" with the wide range, so the everyday report stays fast.',
      'Save and run.',
    ],
    acceptance: 'Each listed report\'s standard date filter covers two years or less.',
  },
  'reports.perf.cross-filters': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the report and review each cross filter; "without" filters are the expensive ones.',
      'Where the cross filter tests for the existence of related records (accounts without opportunities), capture that fact on the parent: a roll-up summary count where the relationship is master-detail, otherwise a count or checkbox maintained by a record-triggered flow that handles create, delete and reparenting. A plain formula field cannot count child records. Then filter on that field instead.',
      'Reduce the report to at most one cross filter.',
      'Save and run.',
    ],
    acceptance: 'No listed report has more than one cross filter, and none uses a cross filter on an object with millions of rows.',
  },
  'reports.perf.many-columns': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.5 },
    steps: [
      'Ask the report\'s audience which columns they actually read; a report this wide is usually being exported to a spreadsheet.',
      'Remove every column not used for a decision, a filter or a grouping. If two audiences need different columns, clone into two reports.',
      'Where the report exists to feed an export, consider a scheduled data export or a dataset instead of a report.',
    ],
    acceptance: 'Each listed report has 20 columns or fewer.',
  },
  'reports.perf.long-text-columns': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Open the report and remove the long text and rich text columns named in the evidence.',
      'If the text is needed occasionally, keep the record link column so a reader can open the record.',
      'Save and run.',
    ],
    acceptance: 'No listed report carries a long text area or rich text column.',
  },
  'reports.perf.runtime-formulas': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'List the row-level and custom summary formulas on the report and check which other reports repeat them.',
      'For each row-level formula that recurs and whose logic fits an object formula, create a formula field on the object (Setup > Object Manager > Fields & Relationships > New). Summary formulas work on groupings and subtotals and have no field equivalent; leave those in the report.',
      'Replace the report formula with the new field, update the other reports that repeated it, and compare run times: the field is still evaluated when read, so the gain is consistency and one less thing per report, not a guaranteed speed-up.',
      'Keep genuinely one-off analytical formulas on the report.',
    ],
    acceptance: 'No listed report repeats a formula that exists as a field, and each has at most a couple of report-level formulas.',
  },
  'reports.perf.detail-rows': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.15 },
    steps: [
      'Open the report in the report builder and switch Show Details off (on the run page the same toggle reads Hide Details).',
      'If the rows themselves matter to the reader, convert the report to tabular with a row limit instead of a summary with details.',
      'Save and run.',
    ],
    acceptance: 'Each listed summary or matrix report has Detail Rows turned off or has been converted to tabular.',
  },
  'reports.perf.no-row-limit': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.15 },
    steps: [
      'Open the tabular report, set a sort order that puts the important rows first, then add a Row Limit filter (10, 25 or a custom value).',
      'If every row is genuinely needed, convert the report to a summary format grouped by the field the reader scans for.',
      'Save and run.',
    ],
    acceptance: 'Each listed tabular report has a row limit or has been converted to a summary report.',
  },
  'reports.perf.or-logic': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the report\'s filter logic and list every field named in an OR condition.',
      'Check each of those fields in Setup > Object Manager > Fields: an OR can use an index only when every field in it is indexed and selective, so one unindexed or unselective branch is what makes the whole condition scan. If they are all indexed and selective, leave the report alone — the OR is not the problem.',
      'Where the OR is across values of one field, use a single filter with comma-separated values instead, which keeps the whole condition on one field.',
      'Where the OR expresses one business condition across several fields, add a field on the object that holds that condition — a checkbox or picklist set by a record-triggered flow, which can be indexed (External ID or a custom index from Support); a formula field qualifies only if it is deterministic. Replace the OR with one equals filter on it.',
      'Save, run, and compare the time against the note you took before the change.',
    ],
    acceptance:
      'For each listed report, either every field in its OR conditions is indexed and selective, or the OR has been replaced by a single filter on one field that is confirmed indexed.',
  },
  'reports.perf.bucket-fields': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'List the bucket fields on the report and check which other reports repeat the same bucketing.',
      'For each recurring bucket, create a formula or picklist field on the object with the same categories.',
      'Replace the bucket with the new field in this and the other reports.',
      'Keep at most one bucket field per report for genuinely ad-hoc grouping.',
    ],
    acceptance: 'No listed report has more than one bucket field.',
  },
  'reports.correctness.long-text-filter': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'Confirm the exposure before changing anything: find a record where the term appears late in the field, and check whether the report returns it. If the field is short everywhere in practice, the report is fine and this is a note rather than a fix.',
      'Decide what the filter is actually asking. Almost always it is a yes/no question — does this record mention X — being asked of up to 131,072 characters of prose (32,768 by default).',
      'Create a field that answers it directly. A formula checkbox where the logic allows one; otherwise a checkbox or picklist set by a record-triggered flow on create and edit. Salesforce cannot index a long text field, and it never will — the answer has to live somewhere else.',
      'Backfill the existing records, through a data loader update or a one-off batch, so the new field is right for history and not only for new records.',
      'Repoint the report filter at the new field and compare the row count against the old report. A jump is the measure of what was being missed.',
      'Check for other reports and list views filtering the same long text field; they have the same defect and nobody has noticed there either.',
    ],
    acceptance:
      'No listed report filters on a Long Text Area or Rich Text Area field, the replacement field is populated for existing records, and the row count has been compared before and after.',
  },
  'reports.perf.unindexed-filters': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 1, perItem: 0.75 },
    steps: [
      'Open the report and find the filters on the custom fields named in the evidence. Note which one is meant to do the narrowing.',
      'Add a selective filter on an indexed field — the standard date filter, Owner, Record Type, a lookup, or an External ID field. That gives the query optimizer an index to drive from, and the unindexed filter then only has to test the rows that survive it. Often this alone fixes the run time.',
      'If the custom field itself is the natural filter and holds unique keys (an account number, a policy id), mark it External ID in Setup > Object Manager: Salesforce indexes External ID fields without a Support case.',
      'Otherwise check selectivity: a custom index helps only when the filter matches under 10% of the first million rows and under 5% of the rest, to a maximum of 333,000 rows. If it does, open a Salesforce Support case asking for a custom index on the field. Support asks for the query the index is for, so quote the object, the field API name, and the filter the report applies to it. A custom index cannot be created on a multi-select picklist, a long text field, an encrypted or binary field, or a currency field in a multi-currency org.',
      'Fields marked "(formula)" cannot be indexed unless the formula is deterministic. Store the value in a real field instead — a flow or trigger that writes it on save — and filter on that.',
      'Re-run the report and compare the time. Do not spend any effort reordering the filters: Salesforce\'s query optimizer is cost-based and chooses which filter drives the query from selectivity statistics, so the order they appear in the report builder has no effect. What matters is that a selective, indexed filter is present at all.',
    ],
    acceptance:
      'Each listed report has at least one selective filter on an indexed field, or the custom field it depends on has been indexed (External ID or a custom index confirmed by Support).',
  },
  'dashboards.inactive-running-user': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the dashboard and check its refresh date. It is usually close to the day the running user was deactivated, which is the quickest way to confirm the diagnosis and to tell whoever relies on it how long they have been reading stale numbers.',
      'Decide who should run it. The right answer is almost never another person: pick an active integration or service account, so the next leaver does not take the dashboard with them.',
      'Check entitlement before you set it. Every viewer sees the running user\'s data, so a service account with broad access turns a stale dashboard into a data-visibility problem. If viewers should each see their own data, switch it to run as the logged-in user instead.',
      'Set the running user, save, and refresh. Confirm the refresh date moves.',
      'Look for the rest of the leaver\'s work while you are here — scheduled jobs, report subscriptions and other dashboards fail the same way and are listed elsewhere in this plan.',
    ],
    acceptance:
      'Every listed dashboard runs as an active user whose data all viewers are entitled to see, and each has refreshed successfully since the change.',
  },
  'dashboards.filter-load': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the dashboard and list its filters, the values on each, and the components. The evidence column "Report runs, worst case" is components × (values + 1): the runs the dashboard needs if viewers use every selection. It is a ceiling, not a per-refresh cost — a value nobody picks costs nothing — so treat it as the size of the exposure, not a bill.',
      'Find out which selections people actually use before cutting: ask the audience or the dashboard\'s subscribers. Remove the values nobody picks and keep the number of filters down.',
      'Feed several components from one source report where they show the same data cut different ways; one report serves them all in a single run.',
      'Retire components nobody reads. A dashboard past fifteen components is usually two dashboards for two audiences.',
      'If the dashboard is dynamic (runs as the viewer) Salesforce will not let you schedule its refresh — it has to be refreshed by hand. For a heavy dashboard, prefer a fixed running user with an off-peak refresh schedule and share the result, provided every viewer is allowed to see that user\'s data.',
      'Refresh and time it; then set or adjust the schedule so the refresh happens before the working day.',
    ],
    acceptance:
      'Each listed dashboard is under the worst-case run threshold, or has been split, and has a refresh schedule where its running user allows one.',
  },
  'reports.perf.deep-groupings': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.25, perItem: 0.25 },
    steps: [
      'Open the report and remove the innermost grouping level. If readers relied on it, add it as a filter so the report answers one question at a time, or create a second report grouped that way.',
      'Save and run.',
    ],
    acceptance: 'Each listed report groups at most two levels deep.',
  },

  'reports.large-objects': {
    kind: 'debt',
    role: 'admin or developer',
    effort: { fixed: 4, perItem: 8 },
    steps: [
      'For each object, list the reports and dashboards that read it (the filter, date-range and cross-filter stories above name most of them) and fix those first; on a large object every one of them matters.',
      'Agree a retention rule with the business: closed cases older than two years, tasks older than eighteen months, and so on. Archive by exporting to a Big Object or an external store, then delete in batches with a Batch Apex job or Data Loader, outside business hours.',
      'For the one or two reports that must stay fast on the full object, open a Salesforce Support case for a skinny table naming the object and the columns the report uses; Support maintains it thereafter.',
      'Check that the fields those reports filter on are indexed (the unindexed-filter story), and that sharing on the object is not so open that every report scans every row.',
      'Set a quarterly check on record counts so the plan is revisited before the next million.',
    ],
    acceptance: 'Each listed object has a written retention rule and an archiving job, and its most-used reports run with indexed filters.',
  },

  /* ------------------------------------------------------------------------ */
  /* Layouts, Lightning pages and SLDS                                        */
  /* ------------------------------------------------------------------------ */
  'flexipage.report-charts': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the page in Lightning App Builder and select each Report Chart component; note its source report and where on the page it sits. Budget against the documented allowance while you do: 100 chart refreshes per user per hour, 3,000 across the org per hour — a chart on a page someone opens all day spends a user\'s share by itself. A page can hold at most two report charts.',
      'If the chart is in the first region users see, move it to a tab that is not the default, so it renders only when opened.',
      'Open the source report and make sure it has a tight filter — for a record page, filter by the record ($Record) rather than showing an org-wide chart on every record.',
      'Where the chart is decorative or duplicates a dashboard, remove it and add a link to the dashboard instead.',
      'Save, activate, and open a few records to confirm the page settles faster and that no chart shows the stale-data notice.',
    ],
    acceptance: 'No listed page renders a Report Chart in its default view, and every remaining chart’s source report is filtered to the record or a narrow scope.',
  },
  'flexipage.region-over-limit': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 1, perItem: 4 },
    steps: [
      'Open the page in Lightning App Builder (Setup > User Interface > Lightning App Builder) and count the components in the affected region, remembering that a Field Section counts its columns and a Tabs component counts its tabs.',
      'Move components out of the region: to another top-level region, to a second record page reached from a Related Record component, or off the page. Tabs and Accordions defer rendering, but this check counts what sits inside them towards the same region, so wrapping components in a tab does not lower the count.',
      'Move rarely used components to a "More" tab, or split the page into a record page and a related page reached from a Related Record component.',
      'Save and activate, then open a record and confirm the page renders.',
    ],
    acceptance: 'No region on the listed pages exceeds 100 components, counted the way Salesforce counts them, and the page saves and renders.',
  },
  'flexipage.region-heavy': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'Open the page in Lightning App Builder and remove components nobody uses — check with the page\'s audience and the Lightning Usage app.',
      'Move secondary components into tabs so the region stays well under the limit and the first render is lighter.',
      'Save and activate.',
    ],
    acceptance: 'Each listed region is below the warning threshold.',
  },
  'layouts.field-heavy': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 1, perItem: 3 },
    steps: [
      'Export the field list from the layout and mark each field: always needed, sometimes, or never used (field-usage tools or a quick data check on fill rate help here).',
      'Remove the never-used fields from the layout. Move the sometimes fields into a collapsed section at the bottom, or onto a separate tab on the Lightning record page using Dynamic Forms.',
      'Order the remaining sections in the sequence the record is actually filled in.',
      'Review with two or three users before assigning the layout to everyone.',
    ],
    acceptance: 'Each listed layout is under the recommended field count, or its fields are split across Dynamic Forms tabs.',
  },
  'layouts.section-heavy': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open the layout and split the large section into labelled groups that match how the record is used — identification, commercial terms, dates, internal notes.',
      'Set the two-column layout where fields are short and one column where they are long text.',
      'Save and check the result on a record.',
    ],
    acceptance: 'No section on the listed layouts exceeds the recommended field count.',
  },
  'layouts.related-lists': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'List the related lists on the layout and check with users which ones they actually open. Every one the record page renders on load is rows fetched before the user sees anything.',
      'Remove the unused ones outright.',
      'Move the rest off the primary tab: a Tabs or Accordion region loads its contents only when opened, so put Related List — Single components for the two or three that matter on the first tab and let the others load on demand. Related List Quick Links gives users a way to reach them without loading them.',
      'Save, then time the record load before and after with the browser devtools Network panel, or read the page in Lightning Usage after a few days.',
    ],
    acceptance: 'Each listed layout is well under the related-list limit and its record page loads faster than before.',
  },
  'flexipage.no-usage-recorded': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.25 },
    steps: [
      'Open each page in Lightning App Builder and check Activation: an unassigned page has no org, app, or record type assignment.',
      'Delete unassigned pages that nobody claims. Keep newly created pages — usage metrics lag by days.',
    ],
    acceptance: 'Each listed page is either assigned somewhere or deleted.',
  },
  'slds.unsupported-component-hooks': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'Run the SLDS linter (`npx @salesforce-ux/slds-linter@latest lint`) over the component source to list every --slds-c-* hook in use.',
      'Replace each with the equivalent --slds-g-* global hook from the published global-hooks reference; where no equivalent exists, style your own selector rather than the component hook.',
      'Where a component genuinely needs per-component control that no global hook offers, Salesforce\'s own alternative is to keep that component on SLDS 1 for now. Take that route deliberately: write down which components are staying and why, so the decision is revisited rather than forgotten.',
      'Test the component under both the SLDS 1 and SLDS 2 (Cosmos) themes in a sandbox and in dark mode.',
      'Deploy and remove the linter warnings from the build.',
    ],
    acceptance: 'The listed stylesheets contain no --slds-c-* hooks and render correctly under SLDS 2, or the components that keep them are on a written list of deliberate SLDS 1 exceptions.',
  },
  'slds.private-hooks': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'Search the stylesheets for --slds-s- and --_slds- and list every reference.',
      'Replace each with a public --slds-g-* hook or with a value from your own design tokens. There is no supported private hook; each one must go.',
      'Test the component under SLDS 1 and SLDS 2 themes.',
      'Add the SLDS linter to the build so private hooks are rejected before they ship.',
    ],
    acceptance: 'No listed stylesheet references a private SLDS variable.',
  },
  'slds.lwc-design-tokens': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 1.5 },
    steps: [
      'Run the SLDS linter with the lwc-token-to-slds-hook rule; it names the replacement hook for each token.',
      'Apply the replacements (`npx @salesforce-ux/slds-linter@latest lint --fix` handles most), then review the diff.',
      'Test under both SLDS themes and deploy.',
    ],
    acceptance: 'No listed stylesheet uses a --lwc-* design token.',
  },
  'slds.deprecated-bem-syntax': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Run `npx @salesforce-ux/slds-linter@latest lint --fix` over the component source to rewrite slds-block--modifier class names to slds-block_modifier.',
      'Review the diff for class names built dynamically in JavaScript, which the linter cannot rewrite.',
      'Test the components and deploy.',
    ],
    acceptance: 'No listed file uses the double-dash SLDS BEM syntax.',
  },
  'slds.class-overrides': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 2 },
    steps: [
      'List every .slds-* selector redefined in the stylesheet and what each override changes.',
      'For each, apply the same change through a styling hook on your own component selector, or wrap the SLDS element in your own class and style that.',
      'Remove the override, test under both SLDS themes, and deploy.',
    ],
    acceptance: 'No listed stylesheet redefines an .slds-* selector.',
  },
  'slds.hardcoded-values': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'List the literal colour values in the stylesheet and map each to the nearest global styling hook (surface, on-surface, border, accent).',
      'Replace the literals with `var(--slds-g-…, <fallback>)`, keeping the original value as the fallback.',
      'Test in light and dark mode and deploy.',
    ],
    acceptance: 'No listed stylesheet contains a hard-coded colour outside a var() fallback.',
  },
  'slds.hooks-without-fallback': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.25, perItem: 0.5 },
    steps: [
      'Run the SLDS linter with the no-slds-var-without-fallback rule; it lists each var() lacking a fallback.',
      'Add a sensible fallback to each (`var(--slds-g-color-surface-1, #fff)`), then test and deploy.',
    ],
    acceptance: 'Every SLDS hook reference in the listed stylesheets has a fallback value.',
  },
};

/* -------------------------------------------------------------------------- */
/* Operations                                                                 */
/* -------------------------------------------------------------------------- */
Object.assign(PLAYBOOK, {
  'ops.async-job-failures': {
    kind: 'bug',
    role: 'developer',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'Open Apex Jobs in Setup (Quick Find: Apex Jobs; it lists the past seven days), filter by the class, and read the Status Details column of the failed runs; the first error message names the cause (a limit, a null reference, a locked row).',
      'Reproduce it in a sandbox with the same batch size. Limit errors usually mean the batch scope is too large or a query sits inside the execute loop; null references mean a record shape the code did not expect.',
      'Fix the class, add a test for the failing shape, and deploy.',
      'Re-run the job for the records the failed runs skipped — for a batch, the scope it was processing; for a queueable, the record ids in the failed job\'s parameters.',
      'Route future failures somewhere visible: a finalizer on queueables, a try/catch that writes to a log object, and the Apex Exception Email set to a monitored address.',
    ],
    acceptance: 'The listed classes have run clean for seven days, and the records their failed runs skipped have been processed.',
  },
  'ops.scheduled-job-errors': {
    kind: 'bug',
    role: 'admin or developer',
    effort: { fixed: 0.5, perItem: 0.75 },
    steps: [
      'Open Setup > Environments > Jobs > Scheduled Jobs and find each listed job; note its type, its class or report, and its owner.',
      'Find the cause in Apex Jobs (for scheduled Apex) or in the owner\'s email (for report and dashboard schedules). A deactivated owner, a deleted report, or a class that no longer compiles are the usual three.',
      'Delete the entry in ERROR, fix the cause, and reschedule it as an active admin or integration user. PAUSED and BLOCKED are passing states Salesforce clears on its own; leave those alone.',
      'Confirm the next run fires: check the job\'s Started time on the Scheduled Jobs page after the scheduled time, or CronTrigger.PreviousFireTime.',
    ],
    acceptance: 'No scheduled job is in ERROR, and each listed job has fired successfully since being rescheduled.',
  },
  'ops.scheduled-jobs-orphaned': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Decide which active user should own scheduled jobs — a dedicated integration or automation user with the permissions the jobs need, not a person.',
      'For each listed job, note its schedule and target (class, report or dashboard) from Setup > Scheduled Jobs, then delete it.',
      'Log in as (or use) the automation user and reschedule the job with the same timing: System.schedule from Developer Console or a setup Apex class for scheduled Apex; the report or dashboard\'s Subscribe dialog for the others.',
      'Confirm each job\'s next run time is set and, after it runs, that it shows a Started time (CronTrigger.PreviousFireTime).',
    ],
    acceptance: 'Every scheduled job is owned by an active user and has run at least once since being rescheduled.',
  },
  'ops.scheduled-jobs-stacked': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'List the jobs in the busy hour from Setup > Scheduled Jobs and note which depend on which — a dashboard refresh should follow the batch that produces its numbers.',
      'Reschedule the independent ones into quieter hours, keeping the dependent ones in order with a gap. Report subscriptions can move to any hour their readers accept.',
      'Prefer one chained batch (a finalizer or Database.executeBatch from finish()) over several jobs scheduled at the same minute.',
    ],
    acceptance: 'No hour of the day carries five or more scheduled jobs unless they are deliberately chained.',
  },
  'ops.flow-interviews-failed': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'Open Setup > Process Automation > Paused And Failed Flow Interviews and open a failed interview for each listed flow; the error and the element it failed on are shown.',
      'Fix the cause in the flow: a missing null check before a Get Records result is used, a required field left blank on a Create, a permission the running user lacks.',
      'Add a fault path from the failing element to a Custom Error (record-triggered) or a friendly screen (screen flow), and send the fault details somewhere monitored.',
      'Test with the record that failed, then activate the new version.',
      'Set the flow error email to a monitored address in Setup > Process Automation Settings rather than the last editor.',
    ],
    acceptance: 'The listed flows record no failed interviews for seven days after the fix, and each has a fault path on the element that failed.',
  },
  'ops.flow-interviews-paused': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open Setup > Process Automation > Paused And Failed Flow Interviews, filter by the flow, and sort by date; the oldest ones are waiting for something that is not going to happen.',
      'Decide per flow whether the wait still makes sense. Resume the interviews that do (select and Resume); delete the rest (select and Delete). Deleting a paused interview undoes nothing: the work done before the pause was committed when the interview paused.',
      'Open the flow and add a time-out to the wait: a second scheduled path or an alarm after a sensible number of days that ends the interview cleanly.',
      'Activate the new version and re-check in a month.',
    ],
    acceptance: 'No listed flow has interviews paused for more than seven days, and each wait element has a time-out path.',
  },
  'ops.approvals-stale': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.2 },
    steps: [
      'Open each record from the list and check the Approval History related list: who it is waiting on and since when.',
      'Ask the approver to approve or reject, or as an admin with Modify All Data reassign it to someone who will (Reassign on the approval item) or recall it (Recall Approval Request) so the record unlocks.',
      'For the approval process itself, set an approver that cannot go stale — a queue, a hierarchy field such as Manager, or a related user field (a role is not an option) — and consider a scheduled reminder or an auto-reject after N days.',
    ],
    acceptance: 'No approval request is pending for more than thirty days, and the process reminds or escalates automatically.',
  },
  'ops.approvals-inactive-approver': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.2 },
    steps: [
      'Open each record and, from the Approval History, reassign the pending item to an active approver (an admin with Modify All Data can reassign any item).',
      'If nobody can decide, recall the request so the record unlocks and the owner can resubmit.',
      'Open Setup > Process Automation > Approval Processes and change the step\'s approver from the named user to a queue, or to a hierarchy or related-user field on the record. That removes the named-person dependency; a related-user field can still point at someone who leaves, so keep the reassignment step in offboarding.',
      'Add "reassign pending approvals" to the user-deactivation checklist.',
    ],
    acceptance: 'No pending approval is assigned to a deactivated user, and the process no longer names an individual as an approver.',
  },
  'ops.release-updates-due': {
    kind: 'debt',
    role: 'admin or developer',
    effort: { fixed: 0.5, perItem: 1.5 },
    steps: [
      'Open Setup > Release Updates. Each update on the Needs Action and Due Soon tabs carries its own numbered steps from Salesforce (Get Started), a description of what changes, and often a Test Run; those steps are the instructions, not this list.',
      'Work soonest due first. For each update, read its description, then run its Test Run in a sandbox where one is offered and note every failure it reports.',
      'Fix what the test run surfaces — usually Apex, flows or integrations relying on the old behaviour — and re-run until the update’s own steps show complete.',
      'Activate in production before the due date, in a change window, and keep the revert option in mind for updates that support it.',
      'Put the next release’s updates on the sprint calendar as they appear, so none arrives as a surprise on its enforcement date.',
    ],
    acceptance: 'Every release update with a due date shows its steps complete in Setup > Release Updates and is activated ahead of that date, with any test run passing in a sandbox first.',
  },
  'ops.hardcoded-urls': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Open each button or link from the object’s Buttons, Links, and Actions page and read the URL or formula.',
      'Replace a full Salesforce host with a relative path (a URL starting with /) or with {!URLFOR(...)}, so the link follows the org it runs in.',
      'Replace a hard-coded record id with a merge field, a custom label, or a custom metadata record, so the link survives a sandbox refresh.',
      'If the button is a JavaScript button, rebuild it as a quick action, a flow, or a Lightning component; JavaScript buttons do not run in Lightning Experience.',
      'Click the repaired button in a sandbox and in production and confirm it opens the intended page.',
    ],
    acceptance: 'No custom button or link contains a Salesforce hostname or a record id, and each one has been clicked in a sandbox after the change.',
  },
  'ops.api-logins': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 1, perItem: 0 },
    steps: [
      'Review the list: an integration should appear under a dedicated integration user with one application; a person with hundreds of API logins is usually running a data tool or a script from their own account.',
      'Move each integration onto its own integration user with a Connected App and the minimum permission set, so its usage is visible and revocable on its own.',
      'For anyone whose count looks like a runaway job, check Setup > Login History for the application and IP, and ask.',
      'If the 24-hour API allowance is regularly tight, treat this list as a pointer, not a measurement: it counts API sessions, not calls. For calls per user and client, use the Classic API Usage Last 7 Days report or the ApiTotalUsage event log, which Developer, Enterprise, Unlimited and Performance editions get at no cost with one day of retention.',
    ],
    acceptance: 'Every integration runs under a dedicated user, and no personal login accounts for an unexplained share of API sessions.',
  },
} satisfies Record<string, Playbook>);

/* -------------------------------------------------------------------------- */
/* Access & permissions                                                       */
/* -------------------------------------------------------------------------- */
/* Every step here is a Setup change a Salesforce admin can make and reverse.
   None of it is done by the extension: OrgTriage reads permissions and never
   writes them, so the work below is deliberately written to be handed to a
   person, with the check that proves it landed. */
Object.assign(PLAYBOOK, {
  'access.admin-sprawl': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 3, perItem: 0.35 },
    steps: [
      'Export the holder list below. For each person, write down the one task they use the permission for — "run the month-end export", "fix data after imports", "support tickets".',
      'Sort those tasks into the narrower permission that actually covers each: View All Data (read-only reporting), View All Users (support and lookups), Modify All on a single object (Setup > Permission Sets or Profiles > the set > Object Settings > the object), or Delegated Administration (Setup > Delegated Administration) for password resets and user creation.',
      'Create one permission set per task, named for the task rather than the person, and assign it to the people who need it.',
      'Remove Modify All Data from the profiles that carry it: Setup > Profiles > the profile > System Permissions. Leave it on the System Administrator profile and keep that profile to the people who genuinely administer the org.',
      'Where the grant arrives through a permission set group, either remove the member set from the group or add a muting permission set that mutes the permission; muting does disable the grant for the group\'s assignees. Note that this scan does not model muting, so a muted grant still appears here — check effective access in Setup before treating a listed user as a real holder.',
      'Re-scan this area. The count should be the number of named administrators, not the number of people who once needed something.',
    ],
    acceptance:
      'Modify All Data is held by a named, documented handful of administrators; everyone removed from it has a narrower permission set covering the task they actually do, and nobody has lost the ability to do their job.',
  },
  'access.admin-dormant': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.3 },
    steps: [
      'For each account, establish what it is: a person who has left, a person on leave, or an integration user.',
      'People who have left: deactivate the user (Setup > Users > Edit > uncheck Active). Do not delete — Salesforce keeps the record for audit history and ownership.',
      'Integration users: confirm the integration is retired before touching it. Freeze the user first (Setup > Users > the user > Freeze) and wait a full business cycle; freezing blocks login without releasing the licence and is undone with Unfreeze.',
      'People on extended leave: remove the permission for the duration rather than the account, so their record ownership and history stay intact.',
      'Add "deactivate the Salesforce user" to the offboarding checklist if these turn out to be leavers.',
    ],
    acceptance:
      'No account holding Modify All Data has been dormant for ninety days, and every privileged integration user is traced to a running integration.',
  },
  'access.password-never-expires': {
    kind: 'bug',
    role: 'admin or developer',
    effort: { fixed: 1, perItem: 0.5 },
    steps: [
      'Separate the list into people and integration accounts.',
      'For people: remove the permission (Setup > Permission Sets or Profiles > System Permissions > Password Never Expires) and let the org password policy apply.',
      'For integrations: the permission exists because a password rotation breaks the integration. Replace the password login with OAuth — a Connected App using the JWT bearer flow needs no password at all — then remove the permission.',
      'Where an integration cannot move to OAuth yet, keep the permission but record why, and put the account behind an IP range (Setup > Profiles > Login IP Ranges) so a leaked password is not enough on its own.',
      'Confirm the org password policy itself is set (Setup > Password Policies); the permission is only interesting because a policy exists to be exempted from.',
    ],
    acceptance:
      'No human account is exempt from the password policy, and every remaining exemption is an integration with a documented reason and an IP restriction.',
  },
  'access.view-all-data': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 2, perItem: 0.3 },
    steps: [
      'For each holder, find the report, list view or integration that motivated the grant.',
      'Replace it with the narrowest thing that works: a sharing rule for the records in question, or View All on the single object (Setup > Permission Sets or Profiles > the set > Object Settings). Sharing the report folder grants access to the report, not to the records it reads — the reader still needs record access from one of the first two.',
      'Remove View All Data from the profile or permission set once the replacement is in place and the person has confirmed their work still works.',
      'Watch for the grant returning through a permission set group; if it does, take the member set out of the group.',
    ],
    acceptance:
      'View All Data is held only by accounts that genuinely need org-wide read, and every other case is served by a sharing rule, a shared folder, or object-level View All.',
  },
  'access.author-apex': {
    kind: 'bug',
    role: 'developer',
    effort: { fixed: 1.5, perItem: 0.25 },
    steps: [
      'Confirm which org this is. In a sandbox, Author Apex on developers is correct and this finding can be accepted as expected — say so in the ticket.',
      'In production, list what each holder uses it for: an emergency fix path, a deployment account, or an inherited profile setting.',
      'Give the deployment path its own account: a dedicated deployment or CI user with Author Apex, used by the pipeline and by nobody interactively.',
      'Remove Author Apex from every human profile and permission set in production (Setup > Profiles / Permission Sets > System Permissions).',
      'Agree the break-glass procedure — who can grant it back, and for how long — so removing it does not leave the team unable to respond to an incident.',
    ],
    acceptance:
      'In production, Author Apex is held only by the deployment account, and a documented break-glass procedure exists for emergencies.',
  },
  'access.customize-application': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 2, perItem: 0.2 },
    steps: [
      'List the holders and what each configures — reports and dashboards, page layouts, flows, or nothing at all.',
      'Move report and dashboard authors to the report-specific permissions (Create and Customize Reports, Create and Customize Dashboards, Manage Dashboards in Public Folders) which do not carry Setup access.',
      'Keep Customize Application for the admin team, and make their changes in a sandbox with a deployment to production.',
      'Remove it from the profiles that carry it by inheritance rather than by decision.',
    ],
    acceptance:
      'Customize Application belongs to the admin team only, and configuration changes reach production by deployment rather than by direct edit.',
  },
  'access.manage-users': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 2, perItem: 0.2 },
    steps: [
      'Establish what the holders actually do: usually password resets and new-starter creation for their own team.',
      'Set up Delegated Administration (Setup > Delegated Administration): create a delegated group, add the delegated administrators, and specify the roles and profiles they may manage.',
      'Assign the team to the delegated group and remove the org-wide Manage Users permission from their profile or permission set.',
      'Verify that a delegated administrator can still reset a password for someone in scope, and cannot for someone out of scope.',
    ],
    acceptance:
      'Manage Users is held only by full administrators; everyone else who needs to reset passwords does it through a delegated administration group scoped to their own roles.',
  },
  'access.inactive-user-permsets': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.1 },
    steps: [
      'For each deactivated user, open Setup > Users > the user > Permission Set Assignments and remove the assignments.',
      'Where there are many, use the Permission Set page instead: Setup > Permission Sets > the set > Manage Assignments > select the inactive users > Remove Assignments.',
      'Add "remove permission set assignments" to the offboarding checklist so it happens at deactivation rather than at audit.',
      'If a returning-employee process exists, note that reactivation brings back the profile and any other grants that were left in place; the removed permission sets have to be re-granted deliberately.',
    ],
    acceptance:
      'No deactivated user holds a permission set assignment, and the offboarding checklist removes them at deactivation.',
  },
  'access.permset-unassigned': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.1 },
    steps: [
      'For each unassigned permission set, open it and read what it grants before deciding anything.',
      'Delete the ones that are finished with (Setup > Permission Sets > the set > Delete).',
      'For any kept deliberately — a set prepared for a future rollout — put the reason and the date in its Description so the next reader does not have to guess.',
      'Where several near-identical sets exist, consolidate to one and delete the rest.',
    ],
    acceptance:
      'Every permission set in the org is either assigned to someone or carries a description saying why it exists unassigned.',
  },
  'access.license-idle': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 1, perItem: 0.5 },
    steps: [
      'For each licence type listed, open Setup > Users with a list view filtered to that licence and Last Login older than ninety days (or blank), and sort the result into leavers, long-term absentees, integration accounts, and accounts created for something that never started.',
      'Leavers and never-started accounts: deactivate the user. Deactivation releases the seat immediately, though the org is billed for the same licences until the order changes; the record and its ownership history stay.',
      'Integration accounts: confirm the integration is retired before touching it, then freeze first and deactivate after a full business cycle, as with any privileged account.',
      'Long-term absentees: leave the account but count the seat as intentional, so the figure on Company Information and the number in this finding agree on purpose rather than by accident.',
      'Compare the released seats with the licence count on the next renewal quote and reduce the order; the seat total does not shrink on its own when users are deactivated.',
    ],
    acceptance:
      'Every active user on a paid licence has logged in within ninety days or is on a written exception list, and the next renewal order reflects the seats actually in use.',
  },
  'access.profile-unused': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 1, perItem: 0.25 },
    steps: [
      'Check each profile really has no users, including inactive ones (Setup > Profiles > the profile > Assigned Users).',
      'Delete the profiles with no users at all. If Salesforce refuses to delete one, a user, possibly inactive, still references it; move that user first.',
      'Where two profiles differ only by a permission or two, move their users onto one profile and grant the difference through a permission set, then delete the other.',
      'Record the intended profile list somewhere the team reads, so the next "just clone it for this one person" has something to argue with.',
    ],
    acceptance:
      'Every custom profile in the org has active users, and per-person differences are expressed as permission sets rather than as cloned profiles.',
  },
} satisfies Record<string, Playbook>);

/* -------------------------------------------------------------------------- */
/* Limits & storage                                                           */
/* -------------------------------------------------------------------------- */
Object.assign(PLAYBOOK, {
  'limits.data-storage': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 6, perItem: 1.5 },
    steps: [
      'Open Setup > Storage Usage and confirm the figure. That page is the authority; the estimate in this plan is a way to find the culprit without waiting for it.',
      'Work down the largest objects (listed in the storage-attribution story) and, for each, agree a retention period with the person who owns the data. This is the step that takes the time, and it cannot be skipped — deleting records nobody agreed to delete is how an audit becomes an incident.',
      'For records that must be kept but not queried day to day, archive rather than delete: a Big Object for platform-native archive, or an export to a data warehouse with a documented restore path.',
      'Delete in bulk through the Bulk API, in batches, outside business hours. A normal delete frees the storage straight away: records in the Recycle Bin do not count against it, and they stay restorable for 15 days. Use hard delete only where the agreed retention decision requires the records to be unrecoverable; never empty the whole org Recycle Bin for storage, since it holds other people’s recoverable records and frees nothing that a normal delete has not already freed.',
      'Re-check Setup > Storage Usage after the deletion has been processed; the figure is recalculated asynchronously, so give it a little time before concluding the cleanup fell short.',
      'Schedule the cleanup so it does not return: a scheduled Apex batch or a scheduled flow that deletes records older than the agreed retention.',
    ],
    acceptance:
      'Data storage is below 75% of the allocation (OrgTriage\'s suggested operating target; Salesforce enforces only the allocation itself), every object that was trimmed has a written retention period, and a scheduled job enforces it.',
  },
  'limits.file-storage': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 4, perItem: 1 },
    steps: [
      'Open Setup > Storage Usage and look at the largest files and their owners — file storage is usually a handful of very large items rather than many small ones.',
      'Identify what generated each large group of files (document generation, e-signature copies, integration payloads) and agree retention with its owner before touching anything. Signed copies and anything a regulation names are not regenerable, whatever produced them.',
      'Where the owner agrees, move generated documents to external storage — Files Connect, an S3 bucket, or the source system — and keep a link on the record rather than the file; confirm the copy exists before deleting the original.',
      'A document revised many times carries every version. Where the owner confirms the history is not needed, remove old versions only through a procedure you have tested in a sandbox and confirmed restores what it should; do not script deletes against ContentVersion on the strength of this finding.',
      'Agree a retention rule with the process owner and automate it, so this is not an annual clean-up.',
    ],
    acceptance:
      'File storage is below 75% of the allocation (OrgTriage\'s suggested operating target), and every process that generates files has a retention rule agreed with its owner that runs on a schedule.',
  },
  'limits.api-consumption': {
    kind: 'debt',
    role: 'admin or developer',
    effort: { fixed: 3, perItem: 0 },
    steps: [
      'Establish who is spending it. The Ops tab lists API logins by user and application, and the API usage report there gives calls per user per day.',
      'For each heavy consumer, find out what it does. The common causes are a row-at-a-time integration, a polling job running far more often than the data changes, and a report or dashboard refreshed by a script.',
      'Move row-at-a-time work onto the Bulk API 2.0 (one job for many records) or the Composite API (up to 25 subrequests per call). This is usually an order-of-magnitude reduction, not a trim.',
      'Reduce polling frequency to match how often the data actually changes, or replace polling with Platform Events or Change Data Capture so the org pushes instead of being asked.',
      'If the usage is legitimate after that, buy capacity: extra API calls or user licences come through the Your Account app or your account executive, not a support case. Bring the analysis above; it is what justifies the spend.',
    ],
    acceptance:
      'Rolling 24-hour API consumption peaks below 70% of the allocation (OrgTriage\'s suggested operating target, leaving room for a backfill or a bad day), and every integration above a documented threshold uses a bulk or composite pattern.',
  },
  'limits.near-ceiling': {
    kind: 'debt',
    role: 'admin or developer',
    effort: { fixed: 1, perItem: 0.75 },
    steps: [
      'Take each limit in turn — they are unrelated problems that happen to share a symptom, so there is no single fix.',
      'Find what consumes it. Async Apex executions come from batch, queueable and future methods; workflow emails from flows, workflow rules and approval processes; platform events from publishers you can list in Setup.',
      'Decide whether the consumption is proportionate to the work being done. A limit at 90% in an org that doubled its users last year is different from one at 90% because a flow fires on every save.',
      'Where it is disproportionate, fix the cause. Where it is legitimate, raise a case with Salesforce for an increase before it bites, and note the date you expect to hit the ceiling.',
      'Add the number to whatever the team already watches, so the next approach is noticed before the failure.',
    ],
    acceptance:
      'Every limit listed is either back above 20% headroom (OrgTriage\'s line, not a Salesforce figure) or has a raised case and a documented owner watching it.',
  },
  'limits.storage-heavy-objects': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 2, perItem: 1 },
    steps: [
      'Treat the estimate as a pointer, not a bill: Setup > Storage Usage has the org\'s real numbers, and Email Messages in particular vary with content (HTML or plain text) rather than costing a fixed amount.',
      'For each object, find out what creates the records. Activity objects (Task, Event) usually come from an email or calendar integration; custom log objects come from something an admin or developer added and forgot.',
      'Ask the owner what the records are used for beyond the last ninety days. In most orgs the honest answer for logs and completed activities is "nothing".',
      'Agree a retention period, then archive or delete per the data-storage story — the mechanics are the same and doing both at once avoids two rounds of approval.',
      'Where an object exists only to log something, consider whether the log belongs in Salesforce at all: an external log store is cheaper per gigabyte by orders of magnitude.',
    ],
    acceptance:
      'Every object named has a documented retention period and an owner, and the ones that were trimmed no longer sit above the reporting threshold.',
  },
} satisfies Record<string, Playbook>);

Object.assign(PLAYBOOK, {
  'limits.debug-log-storage': {
    kind: 'hygiene',
    role: 'admin or developer',
    effort: { fixed: 1, perItem: 0 },
    steps: [
      'Open Setup > Debug Logs and confirm the volume. The ceiling is org-wide and shared, so this is not one person\'s problem to solve quietly.',
      'Agree which logs can go: anything tied to an open incident stays until it is downloaded. Then delete the rest through Setup > Debug Logs or the Developer Console\'s Logs tab, which can select and delete in bulk; for tens of thousands, a data tool\'s ordinary delete of ApexLog records does the same job.',
      'Do not stop there — logs accumulate because trace flags were left on. Work the "trace flags still switched on" story at the same time, or this returns within a week.',
      'Salesforce keeps system debug logs for 24 hours and monitoring debug logs for seven days, so a one-off spike clears itself. A ceiling reached repeatedly means something is logging continuously.',
    ],
    acceptance:
      'Debug log volume is under half the 1,000 MB ceiling (OrgTriage\'s suggested target; the ceiling is Salesforce\'s), and any user in the org can add a trace flag without first deleting logs.',
  },
  'limits.trace-flags-active': {
    kind: 'hygiene',
    role: 'admin or developer',
    effort: { fixed: 0.5, perItem: 0.1 },
    steps: [
      'For each flag, find out who set it and whether anyone is still reading the logs. In practice most were set for one afternoon of debugging.',
      'Delete the ones nobody is watching: Setup > Debug Logs, or the Developer Console.',
      'Where logging is genuinely needed, set a short expiry rather than the maximum, and note who owns it.',
      'Check the log levels too — a flag at FINE or FINER for Database or Apex writes far more, and measurably slows the transactions being logged.',
    ],
    acceptance:
      'Every remaining trace flag has a named owner, a short expiry, and a reason; none is running at a fine log level without one.',
  },
  'limits.debug-log-owners': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.1 },
    steps: [
      'Take the list to the people on it. An integration user near the top usually means a trace flag was set on it to debug an integration and never removed.',
      'Ask whether the debugging is still in progress and whether any of the logs are needed. If not, remove the trace flag first, then delete that user\'s logs — deleting logs while the flag is still on just makes room for more.',
      'If one account produces most of the volume every time this is checked, treat that as the finding rather than the logs.',
    ],
    acceptance:
      'No single account is producing a disproportionate share of the org\'s debug logs without a documented reason.',
  },
} satisfies Record<string, Playbook>);

Object.assign(PLAYBOOK, {
  'flexipage.page-load-heavy': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 1, perItem: 1.5 },
    steps: [
      'Open the page in Lightning App Builder and use Analyze (in the toolbar) to see Salesforce\'s own performance reading before you change anything. That is the number to move.',
      'Decide what a user genuinely needs in the first few seconds of opening this record. In most orgs that is the highlights panel, a handful of fields, and one or two related lists.',
      'Add a Tabs component if the page does not have one, leave the essentials on the first tab, and move everything else onto the others. Content on any tab but the first loads only when opened.',
      'For field-heavy pages, use Dynamic Forms to break the record detail into field sections, then move the secondary sections into tabs or an accordion.',
      'Remove components nobody uses rather than deferring them — the Lightning Usage app shows which pages get traffic, and a component nobody opens is worth deleting, not hiding.',
      'Re-run Analyze in App Builder and compare. Then check the Lightning Usage app after a full day of real traffic, because that is the measurement that counts.',
    ],
    acceptance:
      'Each page listed loads noticeably fewer components before first interaction, App Builder\'s Analyze panel agrees, and no functionality was removed — only deferred.',
  },
  'flexipage.page-defer-opportunity': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.75 },
    steps: [
      'These pages are not slow enough to be urgent; they are the cheap wins. Take them when the page is open for another reason.',
      'Add a Tabs component and move the secondary content — history, related lists nobody opens first, supporting field sections — onto tabs after the first.',
      'Confirm nothing that a user needs immediately ended up behind a tab; a fast page that hides the thing people came for is worse than a slow one.',
    ],
    acceptance:
      'Each page keeps its essentials on the first tab and defers the rest, with no loss of functionality.',
  },
  'flexipage.measured-slow': {
    kind: 'bug',
    role: 'admin or developer',
    effort: { fixed: 2, perItem: 1.5 },
    steps: [
      'Start here rather than with the estimated checks: this list is what real users actually waited for.',
      'Open the Lightning Usage app (App Launcher > Lightning Usage) and look at the page over time. A page that is slow only for some users is usually a browser, a network, or a permission-driven difference in what renders.',
      'Open the page in App Builder and look for the usual causes in order: a Report Chart component (each one runs a report on every page view), a custom Lightning component doing its own queries, many components loading at once, and a very large record detail.',
      'Where a custom component is implicated, profile it — a debug log with the Apex and Database levels raised will show the queries it runs per page view.',
      'Defer or remove what you can, then wait a full day and re-check the Lightning Usage app rather than trusting the immediate impression.',
    ],
    acceptance:
      'Every page listed is back under three seconds in the Lightning Usage app across a full day of traffic, and the cause of each is written down.',
  },
} satisfies Record<string, Playbook>);

/* -------------------------------------------------------------------------- */
/* Security settings, field usage, Apex code quality                          */
/* -------------------------------------------------------------------------- */
Object.assign(PLAYBOOK, {
  'security.health-check-high': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 1, perItem: 0.5 },
    steps: [
      'Open Setup > Security > Health Check. Every row here appears there with the org\'s value beside the recommended one, so work from that page rather than from this list.',
      'Take the high-risk group in order. Most are a single field: a session timeout, a password length, an HttpOnly flag.',
      'Before changing session or password settings, tell the people it affects — shortening a session timeout logs everyone out sooner, and that is a support call if it arrives unannounced.',
      'For each setting you deliberately leave off-baseline, record the reason. Health Check lets you set a custom baseline, which is the supported way to say "this is a decision, not an oversight".',
      'Re-open Health Check and confirm the score moved.',
    ],
    acceptance:
      'No setting remains in the high-risk group except ones recorded in a custom baseline with a written reason.',
  },
  'security.health-check-medium': {
    kind: 'debt',
    role: 'admin',
    effort: { fixed: 1, perItem: 0.25 },
    steps: [
      'Work these in one sitting after the high-risk group — they are individually small and collectively worth a real jump in the score.',
      'Read each recommended value before applying it; a few (lockout periods, password history) interact with how the business actually works.',
      'Record any you deliberately leave alone in a custom baseline.',
    ],
    acceptance:
      'The medium-risk group is empty or every remaining entry is in the custom baseline with a reason.',
  },
  'security.health-check-low': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 0.1 },
    steps: [
      'Review the whole group at once rather than one at a time.',
      'Accept or correct each, and note the ones deliberately left alone.',
    ],
    acceptance: 'Every low-risk difference has been looked at once and consciously accepted or fixed.',
  },
  'fields.unreferenced': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 2, perItem: 0.25 },
    steps: [
      'Treat this as a candidate list, not a delete list. The check searched only the Apex, active flows and validation rules it fetched: page layouts, Lightning pages, report columns, list views, other automation and anything outside Salesforce were not read, so a field used only there appears here too.',
      'Search each API name in whatever is outside Salesforce: integration code, ETL mappings, external reporting tools, the data warehouse. This is the step that prevents an outage.',
      'For survivors, check the field\'s data: if it is populated on many records, someone is writing to it and you have not found who yet.',
      'Check the places the scan did not: the field\'s page layouts and Lightning pages, reports and list views that show or filter on it, and permissions that reference it. Then, with the owner\'s agreement, remove it from layouts and set field-level security to hidden for every profile, and leave it for a release. Anything that breaks, breaks visibly and reversibly.',
      'Delete only after that release and a separate approval from the owner. A deleted field keeps its data for the recycle period and then loses it permanently, so take an export first.',
      'Where a field must stay but is not in use, put that in its description so the next review does not re-litigate it.',
    ],
    acceptance:
      'Every field on the list has been traced outside Salesforce, and each is either deleted, documented as deliberately retained, or shown to be in use by something the metadata scan could not see.',
  },
  'fields.validation-hardcoded-ids': {
    kind: 'bug',
    role: 'admin',
    effort: { fixed: 0.5, perItem: 1 },
    steps: [
      'Open each named validation rule in Setup > Object Manager > <object> > Validation Rules and find the id in the error condition formula. This check matches the shape of an id, so confirm it is one before changing anything.',
      'Work out what the id points at. In our reference list a 012 prefix is a record type, 00e a profile and 00G a queue; for anything else, paste the id after your org URL and see what opens.',
      'Replace it with something that survives a deployment: RecordType.Name or RecordType.DeveloperName for a record type (Salesforce advises against $RecordType outside default-value formulas), a custom permission rather than a profile name, and Custom Metadata for anything else, so each org supplies its own value.',
      'Test in a sandbox by saving a record that should trip the rule and one that should not. A rule carrying a foreign id has usually been silently inert there, so expect the sandbox behaviour to change.',
      'Check whether records were saved while the rule was not firing. That is the actual damage, and it is invisible until someone looks.',
    ],
    acceptance:
      'No listed validation rule contains a record id, each has been tested in a sandbox for both the passing and failing case, and any records saved while the rule was inert have been identified.',
  },
  'fields.undocumented': {
    kind: 'hygiene',
    role: 'admin',
    effort: { fixed: 1, perItem: 0.05 },
    steps: [
      'Do not try to do all of them. Start with the objects people use daily and the fields that appear on layouts.',
      'One sentence each: what it holds, what sets it, and what it is used for. "Set by the Boomi order sync; do not edit manually" is worth more than a paragraph of prose.',
      'Field descriptions can be set in bulk through the Metadata API or a deployment, which is far faster than the Setup UI for hundreds of fields.',
      'Add "description required" to whatever checklist governs new fields, or this list regrows at the rate the org does.',
    ],
    acceptance:
      'Every field on a page layout of a frequently used object has a description, and new fields cannot be created without one.',
  },
  'apexlint.soql-in-loop': {
    kind: 'bug',
    role: 'developer',
    effort: { fixed: 1, perItem: 2 },
    steps: [
      'Open each component at the line given and confirm the finding — this is a text-level check and a query inside a loop that runs once is not a bug.',
      'For a query: collect the ids the loop needs before it runs, query once outside the loop, and put the results in a Map<Id, SObject>. Inside the loop, look up from the Map.',
      'For DML: build a List inside the loop and perform one insert or update after it. Use Database.insert with allOrNone false where partial success is acceptable, and handle the results.',
      'Write a test that exercises the path with at least 200 records (OrgTriage\'s suggested test size, one DML batch). That is the test that would have caught this, and without it the pattern comes back.',
      'Deploy from a sandbox with the bulk test passing, not as a hotfix in production.',
    ],
    acceptance:
      'No query or DML statement remains inside a loop in the components listed, and each has a test that processes 200 records without hitting a governor limit.',
  },
  'apexlint.sharing-not-declared': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 1, perItem: 0.4 },
    steps: [
      'Sort the classes into entry points (controllers, @AuraEnabled, @RestResource, invocable methods, schedulable) and utilities called by other Apex.',
      'Entry points get `with sharing` — they act on behalf of a user and should see what that user sees.',
      'Utilities get `inherited sharing`, so they run in whatever context called them rather than silently escalating.',
      'Where system access is genuinely required, use `without sharing` and put a comment above it saying why. An explicit decision is fine; an omission is not.',
      'Run the full test suite: adding `with sharing` to a class that was quietly relying on system access will fail tests, and that failure is the finding.',
    ],
    acceptance:
      'Every class declares a sharing mode, and each `without sharing` carries a comment explaining the need.',
  },
  'apexlint.empty-catch': {
    kind: 'bug',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 0.75 },
    steps: [
      'Open each catch block and work out what it was hiding. Often the answer is "an error the author could not reproduce".',
      'Decide per block: if the failure is genuinely recoverable, handle it and say so in a comment. If it is not, let it propagate.',
      'Where the exception must be swallowed for the transaction to continue, log it — a custom log object, a platform event, or at minimum System.debug with context.',
      'If there is no error-logging mechanism in the org, that is the real story: one log object and a helper class serves every future case.',
    ],
    acceptance:
      'No catch block discards an exception silently; every one either handles it deliberately with a comment or records it somewhere a person will see.',
  },
  'apexlint.hardcoded-id': {
    kind: 'bug',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 0.5 },
    steps: [
      'Check each literal — the match is by shape, so some will be legitimate constants rather than ids.',
      'For a real id, work out what it points at: a record type, a profile, a queue, a specific record.',
      'Record types resolve by developer name through Schema describe; queues by a query on Group with Type = \'Queue\' and DeveloperName; profiles by a query on Profile.Name only as a last resort (Profile has no DeveloperName, and a standard profile\'s Name is localised, so it breaks in a non-English org) — better to test the capability the code needs (PermissionsModifyAllData, a custom permission) or map profiles in Custom Metadata; anything else belongs in Custom Metadata so it can differ per org without a code change.',
      'Check the sandbox as well as production — an id that works in both is a coincidence, not a fix.',
      'Add the pattern to whatever review checklist exists, because this one recurs.',
    ],
    acceptance:
      'No Salesforce id is written into Apex; every one resolves at run time or comes from Custom Metadata, and the code deploys unchanged to a fresh sandbox.',
  },
  'apexlint.query-without-limit': {
    kind: 'debt',
    role: 'developer',
    effort: { fixed: 0.5, perItem: 0.3 },
    steps: [
      'This is the lowest-confidence check here. Read each query first — one bounded by a selective WHERE does not need a LIMIT.',
      'Where the query really is unbounded, decide whether the object can grow. A query over a configuration object with twelve rows is fine forever; one over Task is not.',
      'Add a LIMIT where a bound makes sense, or move the work into Batch Apex where the query is a QueryLocator and the platform chunks it.',
      'For queries feeding a list the user sees, add pagination rather than a silent cap — a truncated list with no indication is worse than a slow one.',
    ],
    acceptance:
      'Every query over an object that grows is bounded, by a LIMIT, a selective filter, or a batch context.',
  },
} satisfies Record<string, Playbook>);

export function playbookFor(ruleId: string): Playbook | undefined {
  return PLAYBOOK[ruleId];
}
