/**
 * Apex analyzer — classes and triggers.
 *
 * Every query here is Tooling API. Two facts shape the whole module:
 *
 *  1. Coverage percentage is not stored anywhere. `ApexCodeCoverageAggregate`
 *     gives `NumLinesCovered` / `NumLinesUncovered` and you compute the rest —
 *     guarding the class with zero executable lines.
 *  2. An empty `ApexCodeCoverageAggregate` means *no tests have been run since
 *     the last coverage reset*, not "zero percent". Reporting 0% there would be
 *     a lie, so the rule goes inconclusive and shows org-wide coverage instead.
 *
 * Docs:
 *   https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apexclass.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apextrigger.htm
 *   https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apexcodecoverageaggregate.htm
 */

import type { Finding } from '@/shared/types';
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
  isFinding,
  isManaged,
  percent,
  setupUrl,
  tryQuery,
  type Analyzer,
  type AnalyzerContext,
  type AnalyzerOutput,
  type Phase,
  type RuleSpec,
} from './framework';

/** Deployment gate: Salesforce requires 75% org-wide coverage to deploy. */
const REQUIRED_ORG_COVERAGE = 75;

/** Per-component coverage floor Salesforce enforces on each trigger. */
const REQUIRED_TRIGGER_COVERAGE = 1;

/** OrgTriage's own recommendation, not a Salesforce rule: how many releases
 *  behind an Apex component may fall before it is worth flagging. ~3 years. */
const API_VERSION_LAG_THRESHOLD = 9;

/** Characters (excluding comments) above which a class is worth splitting.
 *  A recommendation, not a platform limit. */
const LARGE_CLASS_CHARS = 20_000;

/** Days without a test run before the org's coverage data is presumed stale. */
const STALE_TEST_RUN_DAYS = 90;

/**
 * The one part of `ApexClass.SymbolTable` this analyzer reads.
 *
 * Verified against a live org: `tableDeclaration.annotations[].name` is
 * `'IsTest'` for a test class, and the whole `SymbolTable` comes back null for
 * most managed classes — so a missing table means "unknown", never "not a test".
 */
interface SymbolTable {
  tableDeclaration?: {
    annotations?: { name: string }[] | null;
    modifiers?: string[] | null;
  } | null;
}

interface ApexClassRow {
  Id: string;
  Name: string;
  ApiVersion: number;
  Status: string;
  LengthWithoutComments: number;
  NamespacePrefix: string | null;
  ManageableState: string | null;
  IsValid: boolean;
}

interface ApexTriggerRow {
  Id: string;
  Name?: string;
  ApiVersion: number;
  Status: string;
  EntityDefinitionId: string | null;
  LengthWithoutComments: number;
  ManageableState: string | null;
  IsValid: boolean;
  UsageBeforeInsert: boolean;
  UsageAfterInsert: boolean;
  UsageBeforeUpdate: boolean;
  UsageAfterUpdate: boolean;
  UsageBeforeDelete: boolean;
  UsageAfterDelete: boolean;
  UsageAfterUndelete: boolean;
}

interface CoverageRow {
  ApexClassOrTriggerId: string;
  NumLinesCovered: number;
  NumLinesUncovered: number;
}

interface TestRunRow {
  Id: string;
  Status: string;
  StartTime: string | null;
  EndTime: string | null;
  MethodsEnqueued: number;
  MethodsCompleted: number;
  MethodsFailed: number;
  IsAllTests: boolean;
}

const RULES = {
  orgCoverage: {
    id: 'apex.org-coverage-below-75',
    severity: 'critical',
    title: () => `Org-wide Apex coverage is below the ${REQUIRED_ORG_COVERAGE}% deployment gate`,
    rationale:
      `Salesforce requires ${REQUIRED_ORG_COVERAGE}% test coverage to deploy Apex to production: org-wide when a ` +
      'deployment runs the default test set, or per deployed class and trigger when it runs specified tests. ' +
      'Below the gate, a deployment that carries Apex — including an urgent fix — is blocked until coverage is ' +
      'raised. Changes with no Apex in them are not affected.',
    remediation:
      'Run all tests to refresh coverage, then add tests to the least-covered classes until the org clears 75%.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_code_coverage_intro.htm',
    weight: 34,
  },
  noCoverage: {
    id: 'apex.no-coverage',
    severity: 'critical',
    title: (n) => `${n} Apex ${n === 1 ? 'component has' : 'components have'} no test coverage`,
    rationale:
      'Uncovered Apex is untested Apex. It also drags the org-wide percentage down, so a single large ' +
      'uncovered class can block every deployment in the org.',
    remediation:
      'Write tests for these components, or delete them if they are dead code. Confirm with a full test run.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_code_coverage_intro.htm',
    weight: 26,
  },
  lowCoverage: {
    id: 'apex.low-coverage',
    severity: 'warning',
    title: (n) => `${n} Apex ${n === 1 ? 'component is' : 'components are'} under 75% coverage`,
    rationale:
      'Each component under 75% pulls the org-wide figure toward the deployment gate, and low coverage ' +
      'usually means the failure paths are the untested ones.',
    remediation: 'Add tests for the uncovered branches, prioritising the largest components first.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_code_coverage_intro.htm',
    weight: 14,
  },
  triggerNoCoverage: {
    id: 'apex.trigger-no-coverage',
    severity: 'critical',
    title: (n) => `${n} ${n === 1 ? 'trigger has' : 'triggers have'} no coverage at all`,
    rationale:
      'Salesforce requires every trigger to have at least some coverage before a deployment is allowed. ' +
      'A trigger at 0% blocks deployment regardless of the org-wide percentage.',
    remediation: 'Add at least one test that exercises each trigger.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=000385650&type=1',
    weight: 22,
  },
  multipleTriggers: {
    id: 'apex.multiple-triggers-per-object',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'object has' : 'objects have'} more than one active trigger`,
    rationale:
      'Salesforce does not guarantee the execution order of multiple triggers on the same object. Order-dependent ' +
      'logic split across them produces defects that are intermittent and very hard to reproduce.',
    remediation:
      'Consolidate to one trigger per object that delegates to a handler class, so execution order is explicit in code.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_triggers_bestpract.htm',
    weight: 16,
  },
  oldApiVersion: {
    id: 'apex.old-api-version',
    severity: 'warning',
    title: (n) => `${n} Apex ${n === 1 ? 'component is' : 'components are'} on an old API version`,
    rationale:
      'A class pinned to an old API version keeps the runtime behaviour of that release, so it misses ' +
      'behaviour changes and security hardening that later versions bring, and it diverges from the rest of ' +
      'the codebase. Apex on an old version keeps compiling and running — unlike a retired REST or SOAP ' +
      'endpoint, which stops answering — so this is technical debt rather than an outage waiting to happen. ' +
      `Salesforce sets no maximum lag; ${API_VERSION_LAG_THRESHOLD} releases behind — about three years — is ` +
      'an OrgTriage recommendation.',
    remediation:
      'Raise the API version on these components and re-run their tests. Do it a few at a time — behaviour can change between versions.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/api_rest_eol.htm',
    weight: 12,
  },
  unmeasured: {
    id: 'apex.coverage-unmeasured',
    severity: 'warning',
    title: (n) => `${n} ${n === 1 ? 'class has' : 'classes have'} no coverage measurement`,
    rationale:
      'Salesforce stores coverage per class and discards it when the class is redeployed, so a class with no ' +
      'coverage row was not measured by the most recent test run. That is not the same as being uncovered — ' +
      'deploying forty classes and then running one test class leaves thirty-nine in this state.',
    remediation:
      'Run all tests in Setup > Apex Test Execution, then rescan. Anything still listed genuinely has no test ' +
      'exercising it.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_code_coverage_intro.htm',
    weight: 10,
  },
  invalid: {
    id: 'apex.needs-recompile',
    severity: 'info',
    title: (n) => `${n} Apex ${n === 1 ? 'component is' : 'components are'} awaiting recompilation`,
    rationale:
      'IsValid is false, which means metadata the component depends on has changed since it was last compiled. ' +
      'This is routine: any deploy touching a base class flips every dependent to invalid until a later ' +
      'deployment or Compile all classes recompiles it. It is worth knowing about — a class ' +
      'that stays invalid may no longer compile — but it is not a defect on its own.',
    remediation:
      'Usually nothing. If the same components stay invalid across scans, run "Compile all classes" in ' +
      'Setup > Apex Classes and fix whatever fails.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apexclass.htm',
    weight: 6,
  },
  inactiveTrigger: {
    id: 'apex.inactive-trigger',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'trigger is' : 'triggers are'} inactive`,
    rationale:
      'Inactive triggers still count as metadata, still need coverage to deploy, and are frequently forgotten ' +
      'code that was disabled during an incident and never removed.',
    remediation: 'Delete them if they are obsolete, or document why they are kept.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.api_tooling.meta/api_tooling/tooling_api_objects_apextrigger.htm',
    weight: 5,
  },
  largeClass: {
    id: 'apex.large-class',
    severity: 'info',
    title: (n) => `${n} ${n === 1 ? 'class exceeds' : 'classes exceed'} ${LARGE_CLASS_CHARS.toLocaleString()} characters`,
    rationale:
      'Very large classes are harder to test to a high standard and are more likely to hit the per-transaction ' +
      'governor limits. This threshold is an OrgTriage recommendation, not a Salesforce limit.',
    remediation: 'Split responsibilities into separate classes with focused tests.',
    weight: 6,
  },
  noExceptionEmail: {
    id: 'apex.no-exception-recipients',
    severity: 'warning',
    title: () => 'Unhandled Apex exceptions reach only the last editor of each class',
    rationale:
      'With no Apex Exception Email recipients configured, Salesforce sends unhandled exception emails only to ' +
      'the last user who modified the failing class. Nothing guarantees that person still works on it, or ' +
      'that anyone watches that mailbox; a monitored address is the only way to know failures are seen.',
    remediation:
      'Setup > Apex Exception Email — add a monitored address or a support user.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.code_apex_exceptions.htm&type=5',
    weight: 12,
  },
  staleTests: {
    id: 'apex.stale-test-run',
    severity: 'warning',
    title: () => `No Apex test run recorded in the last ${STALE_TEST_RUN_DAYS} days`,
    rationale:
      'Coverage figures come from the last test run. If that run is months old, every coverage number in this ' +
      'report — and the number Salesforce will use at deployment time — reflects code that has since changed. ' +
      `Salesforce sets no expiry on a test run; ${STALE_TEST_RUN_DAYS} days is an OrgTriage recommendation.`,
    remediation: 'Run all tests in Setup > Apex Test Execution to refresh coverage.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_code_coverage_intro.htm',
    weight: 10,
  },
  failingTests: {
    id: 'apex.failing-tests',
    severity: 'critical',
    title: (n) => `${n} test ${n === 1 ? 'method' : 'methods'} failed in the most recent run`,
    rationale:
      'Failing tests block deployment and usually mean either the code or the test is wrong. Either way the ' +
      'org cannot ship until it is resolved.',
    remediation: 'Open Setup > Apex Test Execution, review the failures, and fix the code or the assertions.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_code_coverage_intro.htm',
    weight: 24,
  },
} satisfies Record<string, RuleSpec>;

/** Every rule id this analyzer can raise — the playbook is checked against it. */
export const APEX_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

export const apexAnalyzer: Analyzer = {
  id: 'apex',
  label: 'Apex',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const skip = (reason: string) => warnings.push(reason);
    const outcomes: RuleOutcome[] = [];

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading Apex classes', fraction: 0.05 };

    const classResult = await tryQuery(
      () =>
        ctx.client.query<ApexClassRow>(
          'SELECT Id, Name, ApiVersion, Status, LengthWithoutComments, NamespacePrefix, ' +
            'ManageableState, IsValid FROM ApexClass',
          { tooling: true },
        ),
      skip,
      'Apex class inventory',
    );
    if (!classResult) {
      // Nothing below can run without the inventory. Every rule is reported as
      // not evaluated rather than the area throwing: a user without the
      // Tooling API still gets the other nine areas, and this one says why.
      for (const rule of Object.values(RULES)) {
        outcomes.push(inconclusive('apex', rule, 'The Apex class inventory could not be read; this needs the Tooling API.'));
      }
      const summary = summarise(RULES, outcomes);
      return {
        metrics: { 'Apex classes': { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }
    const allClasses = classResult.records;
    const classes = ctx.includeManaged
      ? allClasses
      : allClasses.filter((c) => !isManaged(c, ctx.orgNamespace));

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading Apex triggers', fraction: 0.2 };

    const triggerRows = await tryQuery(() => readTriggers(ctx, skip), skip, 'Apex trigger inventory');
    const triggers = triggerRows ?? [];
    const scoped = ctx.includeManaged
      ? triggers
      : triggers.filter((t) => !isManaged(t, ctx.orgNamespace));

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading code coverage', fraction: 0.4 };

    const coverage = await tryQuery(
      () =>
        ctx.client.query<CoverageRow>(
          'SELECT ApexClassOrTriggerId, NumLinesCovered, NumLinesUncovered FROM ApexCodeCoverageAggregate',
          { tooling: true },
        ),
      skip,
      'Per-class code coverage (needs "View Setup and Configuration")',
    );

    // Which classes are test classes.
    //
    // `ApexClass` has no `IsTest` field, and Salesforce creates no coverage row
    // for a test class — so "no coverage row" is true of every test class in
    // every org, and the weight-26 critical used to fire on 30–50% of a typical
    // org's Apex. Two cheap sources are combined before anything is accused:
    //
    //  1. `ApexCodeCoverage.ApexTestClassId` — the test classes that have run.
    //  2. `ApexTestResult.ApexClassId` — same, from the result side.
    //
    // Neither is complete when tests have never run, so `readTestClassIds` also
    // reports whether it had any evidence at all. When it did not, the coverage
    // rules degrade to inconclusive rather than accusing everything.
    const testClasses = await readTestClassIds(ctx, skip);

    const orgCoverage = await tryQuery(
      () =>
        ctx.client.queryOne<{ PercentCovered: number }>(
          'SELECT PercentCovered FROM ApexOrgWideCoverage',
          { tooling: true },
        ),
      skip,
      'Org-wide code coverage (needs "View Setup and Configuration")',
    );

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Reading test history', fraction: 0.6 };

    const testRuns = await tryQuery(
      () =>
        // `LIMIT` is safe here. The client avoids it by default because the 16
        // Tooling *catalog* objects silently ignore LIMIT/OFFSET, but
        // ApexTestRunResult is a normal object and is not one of them —
        // fetching 2,000 rows to keep 5 was ~400x more expensive for nothing.
        // `NULLS LAST` because a Queued run has no StartTime and would
        // otherwise sort to the front and masquerade as the latest run.
        ctx.client.query<TestRunRow>(
          'SELECT Id, Status, StartTime, EndTime, MethodsEnqueued, MethodsCompleted, ' +
            'MethodsFailed, IsAllTests FROM ApexTestRunResult ' +
            "WHERE Status = 'Completed' ORDER BY StartTime DESC NULLS LAST LIMIT 5",
          { tooling: true, maxRecords: 5 },
        ),
      skip,
      'Apex test run history',
    );

    const exceptionRecipients = await tryQuery(
      () =>
        // Ids only: the rule needs to know whether any recipient exists, and
        // PRIVACY promises no email address is ever read.
        ctx.client.query<{ Id: string }>(
          'SELECT Id FROM ApexEmailNotification',
          { tooling: true },
        ),
      skip,
      'Apex exception email recipients',
    );

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Resolving trigger objects', fraction: 0.75 };

    const objectNames = await resolveEntityNames(ctx, scoped, skip);

    /* ---------------------------------------------------------------- */
    checkCancelled(ctx);
    yield { phase: 'Evaluating rules', fraction: 0.9 };

    const coverageById = new Map<string, { covered: number; uncovered: number; pct: number | null }>();
    for (const row of coverage?.records ?? []) {
      const total = row.NumLinesCovered + row.NumLinesUncovered;
      coverageById.set(row.ApexClassOrTriggerId, {
        covered: row.NumLinesCovered,
        uncovered: row.NumLinesUncovered,
        // A class with no executable lines is not "0% covered" — it is not
        // coverable. Percent stays null and the class is excluded from the rules.
        pct: total === 0 ? null : Math.round((row.NumLinesCovered / total) * 100),
      });
    }

    const coverageDataExists = (coverage?.records.length ?? 0) > 0;

    // Second pass: for the classes we would otherwise report as unmeasured,
    // read their symbol tables and pull out the ones annotated @isTest. Bounded
    // to the accusation set, so a healthy org pays nothing for it.
    if (coverageDataExists) {
      const candidates = classes
        .filter((c) => c.Status === 'Active')
        .filter((c) => !coverageById.has(c.Id) && !testClasses.ids.has(c.Id))
        .map((c) => c.Id);
      const pass = await markTestClassesBySymbolTable(ctx, candidates, testClasses.ids, skip);
      if (pass.inspected > 0) testClasses.reliable = true;
      if (candidates.length > pass.inspected) {
        warnings.push(
          `Only ${pass.inspected} of ${candidates.length} unmeasured classes could be checked for the ` +
            '@isTest annotation within the detail budget; the rest are reported as unmeasured.',
        );
      }
    }

    /** A class with no coverage row that we cannot prove is a test class. */
    const unexplainedNoRow = (id: string): boolean =>
      !coverageById.has(id) && !testClasses.ids.has(id);
    const currentVersion = Number.parseFloat(ctx.client.apiVersion);
    const versionFloor = currentVersion - API_VERSION_LAG_THRESHOLD;

    /* --- Coverage rules ---------------------------------------------- */
    if (!coverage) {
      outcomes.push(
        inconclusive(
          'apex',
          RULES.noCoverage,
          'Reading ApexCodeCoverageAggregate requires the "View Setup and Configuration" permission.',
        ),
      );
    } else if (!coverageDataExists) {
      outcomes.push(
        inconclusive(
          'apex',
          RULES.noCoverage,
          'No coverage data exists in this org. That means no Apex tests have been run since the last ' +
            'coverage reset — it does not mean coverage is zero. Run all tests, then rescan.',
        ),
      );
    } else {
      // Only classes with a coverage row that reads 0% are accused. A missing
      // row means one of three things and none of them is "0% covered":
      // the class is a test class, its row was dropped by a redeploy, or the
      // last run did not touch it. Those go to `unmeasured` below.
      const uncoveredClasses = classes
        .filter((c) => c.Status === 'Active')
        .filter((c) => !testClasses.ids.has(c.Id))
        .filter((c) => coverageById.get(c.Id)?.pct === 0)
        .map((c) => ({
          id: c.Id,
          name: c.Name,
          setupUrl: setupUrl(ctx.lightningHost, `ApexClasses/page?address=%2F${c.Id}`),
          evidence: {
            'API version': c.ApiVersion,
            Size: c.LengthWithoutComments,
            Coverage: '0%',
          },
        }));

      // Reported separately, as a warning, with the reason stated. Coverage
      // rows are per class and vanish on redeploy, so this list is large and
      // routine right after a deployment — it is a "go run all tests" signal,
      // not a defect in the class.
      const unmeasured = classes
        .filter((c) => c.Status === 'Active')
        .filter((c) => unexplainedNoRow(c.Id))
        .map((c) => ({
          id: c.Id,
          name: c.Name,
          setupUrl: setupUrl(ctx.lightningHost, `ApexClasses/page?address=%2F${c.Id}`),
          evidence: {
            Coverage: 'no data',
            'API version': c.ApiVersion,
            Size: c.LengthWithoutComments,
          },
        }));

      const lowCoverageClasses = classes
        .filter((c) => c.Status === 'Active')
        .map((c) => ({ cls: c, cov: coverageById.get(c.Id) }))
        .filter(
          (x): x is { cls: ApexClassRow; cov: { covered: number; uncovered: number; pct: number } } =>
            x.cov?.pct != null && x.cov.pct > 0 && x.cov.pct < REQUIRED_ORG_COVERAGE,
        )
        .sort((a, b) => a.cov.pct - b.cov.pct)
        .map(({ cls, cov }) => ({
          id: cls.Id,
          name: cls.Name,
          setupUrl: setupUrl(ctx.lightningHost, `ApexClasses/page?address=%2F${cls.Id}`),
          evidence: {
            Coverage: `${cov.pct}%`,
            'Lines uncovered': cov.uncovered,
            'API version': cls.ApiVersion,
          },
        }));

      const uncoveredTriggers = scoped
        .filter((t) => t.Status === 'Active')
        // Same rule as classes: a trigger with no row was not measured, not
        // proven uncovered. Triggers are never test classes, so anything with a
        // row below the threshold is a genuine finding.
        .filter((t) => (coverageById.get(t.Id)?.covered ?? null) !== null)
        .filter((t) => (coverageById.get(t.Id)?.covered ?? 0) < REQUIRED_TRIGGER_COVERAGE)
        .map((t) => ({
          id: t.Id,
          name: t.Name ?? t.Id,
          label: objectNames.get(t.EntityDefinitionId ?? '') ?? t.EntityDefinitionId ?? undefined,
          setupUrl: setupUrl(ctx.lightningHost, `ApexTriggers/page?address=%2F${t.Id}`),
          evidence: {
            Object: objectNames.get(t.EntityDefinitionId ?? '') ?? t.EntityDefinitionId,
            'API version': t.ApiVersion,
            Coverage: `${coverageById.get(t.Id)?.covered ?? 0} lines`,
          },
        }));

      outcomes.push(finding('apex', RULES.noCoverage, uncoveredClasses));
      outcomes.push(finding('apex', RULES.lowCoverage, lowCoverageClasses));
      outcomes.push(finding('apex', RULES.triggerNoCoverage, uncoveredTriggers));
      outcomes.push(finding('apex', RULES.unmeasured, unmeasured));

      if (!testClasses.reliable && unmeasured.length > 0) {
        warnings.push(
          `${unmeasured.length} class(es) have no coverage row. No Apex test has ever run in this ` +
            'org, so OrgTriage cannot tell a test class from an unmeasured one — they are reported ' +
            'as unmeasured rather than uncovered.',
        );
      }
    }

    // `PercentCovered` is 0 when no test has ever run, which is not the same as
    // "the code is uncovered". Firing a weight-34 critical there would
    // contradict the inconclusive the no-data branch above just emitted.
    if (!coverageDataExists) {
      outcomes.push(
        inconclusive(
          'apex',
          RULES.orgCoverage,
          'Org-wide coverage reads 0% because no Apex test has been run since the last coverage ' +
            'reset, not because the code is uncovered. Run all tests, then rescan.',
        ),
      );
    } else if (orgCoverage && orgCoverage.PercentCovered < REQUIRED_ORG_COVERAGE) {
      outcomes.push(
        finding('apex', RULES.orgCoverage, [
          {
            name: 'Org-wide coverage',
            evidence: {
              Current: `${orgCoverage.PercentCovered}%`,
              Required: `${REQUIRED_ORG_COVERAGE}%`,
              Shortfall: `${REQUIRED_ORG_COVERAGE - orgCoverage.PercentCovered} points`,
            },
          },
        ]),
      );
    }

    /* --- Structural rules -------------------------------------------- */
    const staleClasses = classes
      .filter((c) => c.Status === 'Active' && c.ApiVersion < versionFloor)
      .sort((a, b) => a.ApiVersion - b.ApiVersion)
      .map((c) => ({
        id: c.Id,
        name: c.Name,
        setupUrl: setupUrl(ctx.lightningHost, `ApexClasses/page?address=%2F${c.Id}`),
        evidence: { 'API version': c.ApiVersion, 'Releases behind': Math.round(currentVersion - c.ApiVersion) },
      }));

    const staleTriggers = scoped
      .filter((t) => t.Status === 'Active' && t.ApiVersion < versionFloor)
      .map((t) => ({
        id: t.Id,
        name: t.Name ?? t.Id,
        setupUrl: setupUrl(ctx.lightningHost, `ApexTriggers/page?address=%2F${t.Id}`),
        evidence: {
          'API version': t.ApiVersion,
          Object: objectNames.get(t.EntityDefinitionId ?? '') ?? t.EntityDefinitionId,
        },
      }));

    outcomes.push(finding('apex', RULES.oldApiVersion, [...staleClasses, ...staleTriggers]));

    // `Deleted` classes are in the recycle bin: they cannot be recompiled and
    // there is nothing to act on.
    const liveClasses = classes.filter((c) => c.Status !== 'Deleted');

    const invalid = [
      ...liveClasses.filter((c) => c.IsValid === false).map((c) => ({
        id: c.Id,
        name: c.Name,
        evidence: { Type: 'Class', 'API version': c.ApiVersion },
      })),
      ...scoped.filter((t) => t.IsValid === false).map((t) => ({
        id: t.Id,
        name: t.Name ?? t.Id,
        evidence: { Type: 'Trigger', Object: objectNames.get(t.EntityDefinitionId ?? '') ?? t.EntityDefinitionId },
      })),
    ];
    outcomes.push(finding('apex', RULES.invalid, invalid));

    // Trigger topology: more than one active trigger per object.
    const byObject = groupBy(
      scoped.filter((t) => t.Status === 'Active' && t.EntityDefinitionId),
      (t) => t.EntityDefinitionId!,
    );
    const crowded = [...byObject.entries()]
      .filter(([, list]) => list.length > 1)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([entityId, list]) => ({
        name: objectNames.get(entityId) ?? entityId,
        evidence: {
          Triggers: list.length,
          Names: list.map((t) => t.Name ?? t.Id).join(', '),
          Events: summariseEvents(list),
        },
      }));
    outcomes.push(finding('apex', RULES.multipleTriggers, crowded));

    outcomes.push(
      finding(
        'apex',
        RULES.inactiveTrigger,
        scoped
          .filter((t) => t.Status !== 'Active')
          .map((t) => ({
            id: t.Id,
            name: t.Name ?? t.Id,
            evidence: {
              Status: t.Status,
              Object: objectNames.get(t.EntityDefinitionId ?? '') ?? t.EntityDefinitionId,
            },
          })),
      ),
    );

    outcomes.push(
      finding(
        'apex',
        RULES.largeClass,
        liveClasses
          .filter((c) => c.LengthWithoutComments > LARGE_CLASS_CHARS)
          .sort((a, b) => b.LengthWithoutComments - a.LengthWithoutComments)
          .map((c) => ({
            id: c.Id,
            name: c.Name,
            setupUrl: setupUrl(ctx.lightningHost, `ApexClasses/page?address=%2F${c.Id}`),
            evidence: { Characters: c.LengthWithoutComments, Coverage: describeCoverage(coverageById.get(c.Id)) },
          })),
      ),
    );

    /* --- Operational rules ------------------------------------------- */
    if (exceptionRecipients && exceptionRecipients.records.length === 0) {
      outcomes.push(
        finding('apex', RULES.noExceptionEmail, [
          { name: 'Apex Exception Email', evidence: { 'Recipients configured': 0 } },
        ]),
      );
    }

    const latestRun = testRuns?.records[0];
    if (testRuns && testRuns.records.length === 0) {
      // The case the rule exists for, and the one it used to miss entirely: an
      // org where tests have never been run emits an empty result, and an empty
      // result used to produce no finding at all.
      outcomes.push(
        finding('apex', RULES.staleTests, [
          {
            name: 'Apex test run history',
            evidence: {
              'Completed runs': 0,
              Meaning: 'No Apex test run has ever completed in this org',
            },
          },
        ]),
      );
    } else if (latestRun) {
      const age = daysSince(latestRun.StartTime);
      if (age !== null && age > STALE_TEST_RUN_DAYS) {
        outcomes.push(
          finding('apex', RULES.staleTests, [
            {
              name: 'Most recent test run',
              evidence: {
                'Days ago': age,
                Status: latestRun.Status,
                'Methods run': latestRun.MethodsCompleted,
              },
            },
          ]),
        );
      }
      if (latestRun.MethodsFailed > 0) {
        outcomes.push(
          finding('apex', RULES.failingTests, [
            {
              name: 'Most recent test run',
              evidence: {
                Failed: latestRun.MethodsFailed,
                'Of methods': latestRun.MethodsEnqueued,
                Started: latestRun.StartTime,
                'All tests': latestRun.IsAllTests,
              },
            },
          ]),
        );
      }
    }

    /* ---------------------------------------------------------------- */
    const examined = classes.length + scoped.length;
    const covered = classes.filter((c) => (coverageById.get(c.Id)?.pct ?? 0) >= REQUIRED_ORG_COVERAGE).length;

    const metrics: AnalyzerOutput['metrics'] = {
      Classes: { value: classes.length, sub: ctx.includeManaged ? 'incl. managed' : 'excl. managed' },
      Triggers: { value: scoped.length },
      'Org-wide coverage': orgCoverage
        ? {
            value: `${orgCoverage.PercentCovered}%`,
            sub: orgCoverage.PercentCovered >= REQUIRED_ORG_COVERAGE ? 'above the gate' : 'below the 75% gate',
            meter: 1 - orgCoverage.PercentCovered / 100,
          }
        : { value: '—', sub: 'permission required' },
      'Classes ≥75%': {
        value: coverageDataExists ? `${percent(covered, Math.max(1, classes.length))}%` : '—',
        sub: coverageDataExists ? `${covered} of ${classes.length}` : 'no test run recorded',
      },
      'Objects with >1 trigger': { value: crowded.length },
      'Below API v': { value: versionFloor.toFixed(1), sub: `${staleClasses.length + staleTriggers.length} components` },
    };

    // Trigger rules with no trigger inventory: an empty list read as "no
    // uncovered triggers, no collisions". It is "not evaluated".
    if (triggerRows === null) {
      const triggerRules = new Set([RULES.triggerNoCoverage.id, RULES.multipleTriggers.id, RULES.inactiveTrigger.id]);
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        if (outcome && !isFinding(outcome) && triggerRules.has(outcome.cleanRuleId)) {
          const rule = Object.values(RULES).find((r) => r.id === outcome.cleanRuleId)!;
          outcomes[i] = inconclusive('apex', rule, 'The Apex trigger inventory could not be read.');
        }
      }
    }

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
      examined,
    };
  },
};

/* -------------------------------------------------------------------------- */
/* Query helpers                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Read triggers, preferring the query that includes `Name`.
 *
 * The published ApexTrigger field table does not list `Name` (unlike ApexClass),
 * so an org could reject it. Rather than assume either way, the richer query is
 * attempted first and the documented field set is the fallback — triggers then
 * show by id, which is ugly but honest.
 */
async function readTriggers(
  ctx: AnalyzerContext,
  skip: (reason: string) => void,
): Promise<ApexTriggerRow[]> {
  const documentedFields =
    'Id, ApiVersion, Status, EntityDefinitionId, NamespacePrefix, LengthWithoutComments, ' +
    'ManageableState, IsValid, UsageBeforeInsert, UsageAfterInsert, UsageBeforeUpdate, ' +
    'UsageAfterUpdate, UsageBeforeDelete, UsageAfterDelete, UsageAfterUndelete';

  try {
    const result = await ctx.client.query<ApexTriggerRow>(
      `SELECT Name, ${documentedFields} FROM ApexTrigger`,
      { tooling: true },
    );
    return result.records;
  } catch (err) {
    // Only a malformed-query error means `Name` is the problem. A permission
    // failure or a network error retried without `Name` would fail again and
    // report a misleading reason, so it is rethrown.
    if (!(err instanceof SalesforceError) || err.status !== 400) throw err;
    const result = await ctx.client.query<ApexTriggerRow>(
      `SELECT ${documentedFields} FROM ApexTrigger`,
      { tooling: true },
    );
    skip(`Trigger names were unavailable in this org (${err.code}); triggers are listed by id.`);
    return result.records;
  }
}

/**
 * The ids of classes that are Apex test classes.
 *
 * Salesforce never writes a coverage row for a test class, so without this
 * every test class in every org looks like a class with zero coverage — and the
 * highest-weight rule in the analyzer fired on 30–50% of a typical org's Apex.
 *
 * Three sources, cheapest first:
 *
 *  1. `ApexCodeCoverage.ApexTestClassId` — which class produced each coverage
 *     row. One query, and definitive for every test that has run.
 *  2. `ApexTestResult.ApexClassId` — the same fact from the result side, which
 *     survives when coverage rows have been cleared.
 *  3. `ApexClass.SymbolTable`, whose `tableDeclaration.annotations` contains
 *     `IsTest`. Verified against a live org. It is by far the most expensive —
 *     a symbol table is large — so it is fetched only for classes that are
 *     about to be accused, and only up to `detailBudget`.
 *
 * `reliable` is false when nothing has ever run and no symbol table could be
 * read, so the caller can degrade to inconclusive rather than guess.
 */
async function readTestClassIds(
  ctx: AnalyzerContext,
  skip: (reason: string) => void,
): Promise<{ ids: Set<string>; reliable: boolean }> {
  const ids = new Set<string>();
  let reliable = false;

  const coverageLinks = await tryQuery(
    () =>
      ctx.client.query<{ ApexTestClassId: string | null }>(
        'SELECT ApexTestClassId FROM ApexCodeCoverage',
        { tooling: true },
      ),
    skip,
    'Test-class identification from ApexCodeCoverage',
  );
  for (const row of coverageLinks?.records ?? []) {
    if (row.ApexTestClassId) ids.add(row.ApexTestClassId);
  }
  if ((coverageLinks?.records.length ?? 0) > 0) reliable = true;

  const testResults = await tryQuery(
    () =>
      ctx.client.query<{ ApexClassId: string | null }>(
        'SELECT ApexClassId FROM ApexTestResult',
        { tooling: true, maxRecords: 5_000 },
      ),
    skip,
    'Test-class identification from ApexTestResult',
  );
  for (const row of testResults?.records ?? []) {
    if (row.ApexClassId) ids.add(row.ApexClassId);
  }
  if ((testResults?.records.length ?? 0) > 0) reliable = true;

  return { ids, reliable };
}

/**
 * Second pass: read symbol tables for the classes still unaccounted for and
 * pull out the ones annotated `@isTest`.
 *
 * Kept separate from {@link readTestClassIds} because it is only worth paying
 * for when there are classes we would otherwise accuse, and because a symbol
 * table comes back null for managed classes — 51 of 60 in the org this was
 * verified against — so a null must never be read as "not a test class".
 */
async function markTestClassesBySymbolTable(
  ctx: AnalyzerContext,
  candidateIds: string[],
  into: Set<string>,
  skip: (reason: string) => void,
): Promise<{ inspected: number; unreadable: number }> {
  if (candidateIds.length === 0) return { inspected: 0, unreadable: 0 };

  const budget = Math.min(candidateIds.length, ctx.detailBudget);
  const wanted = candidateIds.slice(0, budget);
  let unreadable = 0;

  // 200 ids per query keeps the SOQL under the URL length limit; symbol tables
  // are large, so this is deliberately not one big query.
  const CHUNK = 200;
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const chunk = wanted.slice(i, i + CHUNK);
    const list = chunk.map((id) => `'${id}'`).join(',');
    const rows = await tryQuery(
      () =>
        ctx.client.query<{ Id: string; SymbolTable: SymbolTable | null }>(
          `SELECT Id, SymbolTable FROM ApexClass WHERE Id IN (${list})`,
          { tooling: true },
        ),
      skip,
      'Reading symbol tables to identify test classes',
    );
    if (!rows) return { inspected: i, unreadable: unreadable + (wanted.length - i) };

    for (const row of rows.records) {
      const annotations = row.SymbolTable?.tableDeclaration?.annotations;
      if (!annotations) {
        unreadable++;
        continue;
      }
      if (annotations.some((a) => a.name === 'IsTest')) into.add(row.Id);
    }
  }
  return { inspected: wanted.length, unreadable };
}

/**
 * Map `EntityDefinitionId` values to readable object names.
 *
 * EntityDefinition is one of the sixteen Tooling objects where `LIMIT`, `OR`,
 * and `NOT` are unsupported — and `LIMIT` is *silently ignored* rather than
 * rejected — so this is an unfiltered, cursor-paginated read of the catalog.
 */
async function resolveEntityNames(
  ctx: AnalyzerContext,
  triggers: ApexTriggerRow[],
  skip: (reason: string) => void,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const needed = new Set(triggers.map((t) => t.EntityDefinitionId).filter((id): id is string => !!id));
  if (needed.size === 0) return names;

  // Many orgs return the object's API name directly; those need no lookup.
  const unresolved = [...needed].filter((id) => /^[a-zA-Z0-9_]{15,18}$/.test(id));
  for (const id of needed) if (!unresolved.includes(id)) names.set(id, id);
  if (unresolved.length === 0) return names;

  const result = await tryQuery(
    () =>
      ctx.client.query<{ DurableId: string; QualifiedApiName: string; Label: string }>(
        // `LIMIT` is mandatory here, not optional: EntityDefinition does not
        // support queryMore(), and an unbounded query fails outright with
        // EXCEEDED_ID_LIMIT rather than returning a first page. 2,000 is the
        // ceiling; a larger org silently gets a subset, which can only leave a
        // trigger labelled by id, never mislabelled.
        'SELECT DurableId, QualifiedApiName, Label FROM EntityDefinition LIMIT 2000',
        { tooling: true },
      ),
    skip,
    'Object name lookup',
  );

  for (const row of result?.records ?? []) {
    names.set(row.DurableId, row.QualifiedApiName);
  }
  return names;
}

function summariseEvents(triggers: ApexTriggerRow[]): string {
  const events = new Set<string>();
  for (const t of triggers) {
    if (t.UsageBeforeInsert) events.add('before insert');
    if (t.UsageAfterInsert) events.add('after insert');
    if (t.UsageBeforeUpdate) events.add('before update');
    if (t.UsageAfterUpdate) events.add('after update');
    if (t.UsageBeforeDelete) events.add('before delete');
    if (t.UsageAfterDelete) events.add('after delete');
    if (t.UsageAfterUndelete) events.add('after undelete');
  }
  return [...events].join(', ');
}

function describeCoverage(cov: { pct: number | null } | undefined): string {
  if (!cov) return 'no data';
  return cov.pct === null ? 'not coverable' : `${cov.pct}%`;
}
