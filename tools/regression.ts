/**
 * Regression tests over real org payloads.
 *
 * Each test names the defect it locks down and asserts against a response
 * captured from a live org (`src/dev/org-payloads/`), not against a shape
 * inferred from the docs — because every bug here was a case of the two
 * disagreeing.
 *
 * Run with `npm test`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { orgPayloads } from '@/dev/orgPayloads';
import { lintSlds,
  countEagerComponents,
  findDurationFields,
} from '@/analyzers/layouts';
import { isManaged, scoreDomain, summarise, finding, inconclusive } from '@/analyzers/framework';
import type { RuleSpec } from '@/analyzers/framework';
import {
  countRegionComponents,
  pageRegions,
  type FlexiPageMetadata,
} from '@/analyzers/layouts';
import { isUnfiltered, performanceIssues, REPORT_RULE_IDS, customFilterColumns, unindexedFilterEvidence, dashboardFilterLoad, longTextFilterFields, isDeepTextType, filterColumns } from '@/analyzers/reports';
import { isValidId18, findHardcodedIds, FLOW_RULE_IDS } from '@/analyzers/flows';
import {
  LFS_CORE_VERSION,
  LFS_DISABLED,
  LFS_ENABLED_RULES,
  LFS_RULES,
  foldScanResults,
  rulesExecutedFor,
  scanFlowMetadata,
} from '@/analyzers/flowscan';
import { toScanResult, type AnalyzerContext } from '@/analyzers/framework';
import type { AnalyzerId } from '@/shared/types';
import { chunkComposite, SalesforceError } from '@/background/sfClient';
import { assertNoCredential } from '../tools/cli/sfClient';
import { durationUnitOf, averagePageTimes } from '@/analyzers/layouts';
import lfsScanner from '@flow-scanner/lightning-flow-scanner-core';
import orgtriagePackage from '../package.json';
import { basename, extname } from '@/shims/path';
import { ANALYZERS } from '@/background/scanRunner';
import { lightningHostFor } from '../tools/cli/sfClient';
import { APEX_RULE_IDS } from '@/analyzers/apex';
import { LAYOUT_RULE_IDS, countComponentsNamed, REPORT_CHART_COMPONENTS } from '@/analyzers/layouts';
import { OPS_RULE_IDS, stackedHours, isApiLogin, interviewFlowName, hardcodedHostsIn, openReleaseUpdates, pastDuePending, nascentUpdates } from '@/analyzers/ops';
import { ACCESS_RULE_IDS, holdersOf, grantLabel, licenseUtilisation } from '@/analyzers/access';
import { LIMITS_RULE_IDS, estimatedMb, humanLimit, recordKb, usableLimits } from '@/analyzers/limits';
import { SECURITY_RULE_IDS, humanSetting, riskLabel, riskRank, meetsStandard, cleanHealthCheckValue } from '@/analyzers/security';
import {
  MIN_R2,
  MIN_SAMPLE,
  annualHoursSaved,
  fitLinear,
  fitProvenance,
  isQuotable,
  savedMs,
  type Point,
} from '@/shared/savings';
import { FIELDS_RULE_IDS, fieldKey, referencedFieldNames } from '@/analyzers/fields';
import {
  APEXLINT_RULE_IDS,
  declaresSharing,
  emptyCatchLines,
  hardcodedIds,
  loopsWithQueries,
  stripCommentsAndStrings,
  unboundedQueries,
} from '@/analyzers/apexlint';
import { comparable, diffAgainst, digestOf, summariseDiff, MAX_DIGEST_ITEMS } from '@/shared/diff';
import type { Finding, ScanResult, Severity } from '@/shared/types';
import { isNumericLike, isNumericColumn } from '@/panel/views/analyzer';
import { PLAYBOOK } from '@/shared/playbook';
import {
  AREA_LABEL,
  AREA_ORDER,
  DAYS_PER_SPRINT,
  HOURS_PER_PERSON_DAY,
  buildPlan,
  effortSize,
  estimateHours,
  planToGenericCsv,
  planToJiraCsv,
  planToJson,
  planToMarkdown,
  storyPoints,
  docLabel,
} from '@/shared/plan';
import { scans, orgContext } from '@/dev/fixtures';
import { SETUP_LINKS, setupLinkFor } from '@/shared/setupLinks';

/* -------------------------------------------------------------------------- */
/* Reports — the full-table-scan rule                                          */
/* -------------------------------------------------------------------------- */

const describes = orgPayloads.reportDescribes as Record<string, any>;
const byName = (name: string): any =>
  Object.values(describes).find((m) => m.name === name);

test('All Time is durationValue CUSTOM with null dates, and reads as unfiltered', () => {
  const report = byName('Asset Names and Locations');
  assert.equal(report.standardDateFilter.durationValue, 'CUSTOM');
  assert.equal(report.standardDateFilter.startDate, null);
  assert.equal(report.standardDateFilter.endDate, null);
  // The bug: `durationValue` is truthy, so testing it concluded "filtered" for
  // exactly the report the rule exists to catch.
  assert.equal(isUnfiltered(report), true);
});

test('a resolved date range reads as filtered', () => {
  const report = byName('Sample Report: # of Opportunities');
  assert.equal(report.standardDateFilter.durationValue, 'THIS_FISCAL_QUARTER');
  assert.ok(report.standardDateFilter.startDate);
  assert.equal(isUnfiltered(report), false);
});

test('default standard filters do not suppress the rule', () => {
  const cases = byName('Sample Report: # of Cases');
  // Salesforce returns `[{name:"units",value:"h"}]` on an untouched Activity
  // report; `units` is a display choice, not a filter.
  assert.deepEqual(cases.standardFilters, [{ name: 'units', value: 'h' }]);
  assert.equal(isUnfiltered(cases), true, 'a display-only standard filter must not count as a limit');

  const openDeals = byName('Sample Report: Open Deals');
  // `open: open` genuinely narrows.
  assert.ok(openDeals.standardFilters.some((f: any) => f.name === 'open' && f.value === 'open'));
  assert.equal(isUnfiltered(openDeals), false);
});

test('the rule fires on the org: it used to fire on nothing', () => {
  const verdicts = Object.values(describes).map((m) => isUnfiltered(m));
  const unfiltered = verdicts.filter((v) => v === true).length;
  assert.ok(unfiltered >= 4, `expected several full scans, found ${unfiltered}`);
  assert.ok(verdicts.some((v) => v === false), 'and it must not fire on everything');
});

test('both spellings of an org-wide scope are recognised', () => {
  const scopes = new Set(Object.values(describes).map((m: any) => m.scope));
  assert.ok(scopes.has('organization') && scopes.has('org'), 'org returns both spellings');
  assert.equal(isUnfiltered(byName('Sample Report: # of Leads')), true, "scope 'org' is org-wide");
});

/* -------------------------------------------------------------------------- */
/* Layouts — FlexiPage region counting                                         */
/* -------------------------------------------------------------------------- */

test('facets are flat, and a region resolves them transitively', () => {
  const metadata = orgPayloads.flexiPage.metadata as unknown as FlexiPageMetadata;
  const all = metadata.flexiPageRegions ?? [];
  const { regions, byName: lookup } = pageRegions(metadata);

  assert.equal(all.length, 29, 'the page has 29 flexiPageRegions entries');
  assert.equal(regions.length, 3, 'but only 3 of them are real regions; the rest are facets');

  const main = regions.find((r) => r.name === 'main')!;
  const count = countRegionComponents(main, lookup);
  // The bug: without following facet references this returned 1, so a region
  // four components short of the 100 limit was reported as nearly empty.
  assert.equal(count, 96);
});

test('a container property value is a facet name, not a count or a list', () => {
  const metadata = orgPayloads.flexiPage.metadata as any;
  const fieldSection = metadata.flexiPageRegions
    .flatMap((r: any) => r.itemInstances ?? [])
    .map((i: any) => i.componentInstance)
    .find((c: any) => c?.componentName === 'flexipage:fieldSection');
  const columns = fieldSection.componentInstanceProperties.find((p: any) => p.name === 'columns');

  assert.equal(typeof columns.value, 'string');
  assert.match(columns.value, /^Facet-/);
  assert.equal(columns.valueList, null, 'valueList is null; reading it as an array yields nothing');
});

/* -------------------------------------------------------------------------- */
/* Flows — hard-coded id detection                                             */
/* -------------------------------------------------------------------------- */

test('half of real key prefixes are not lowercase', () => {
  const prefixes = orgPayloads.keyPrefixes as string[];
  const rejected = prefixes.filter((p) => !/^[0-9a-z]{3}$/.test(p));
  // The bug: the old regex required `^[0-9a-z]{3}`, so it could not match a
  // hard-coded Queue (00G) or Permission Set (0PS) id — the two most common.
  assert.ok(rejected.length > prefixes.length * 0.4, `${rejected.length}/${prefixes.length} rejected`);
  for (const prefix of ['00G', '00D', '00Q', '00T', '00O']) {
    assert.ok(prefixes.includes(prefix), `${prefix} is a real prefix in this org`);
  }
});

test('the 18-character checksum accepts real ids and rejects near-misses', () => {
  for (const id of [
    '00Diw000000vCKbEAM',
    '01piw0000014Y8zAAE',
    '0M0iw000000OPaSCAW',
    '301iw000002mB56AAE',
  ]) {
    assert.equal(isValidId18(id), true, id);
  }
  for (const notId of [
    '00Diw000000vCKbEAX', // one character of a real id corrupted
    'MyFlowElement12345',
    'Get_Account_Record',
  ]) {
    assert.equal(isValidId18(notId), false, notId);
  }
});

/* -------------------------------------------------------------------------- */
/* Flows — the borrowed static analyser                                        */
/* -------------------------------------------------------------------------- */

test('the flow scanner is pinned to the version its mapping was written against', () => {
  // Not pedantry. Our snapshot diff keys on rule ids and the score divides by
  // the weight of the rules that could fire, so a rule appearing or vanishing
  // in a new release moves a grade with no change in the org. Bumping the
  // dependency means re-reading LFS_RULES, and this is what says so.
  const declared = (orgtriagePackage as { dependencies: Record<string, string> }).dependencies[
    '@flow-scanner/lightning-flow-scanner-core'
  ];
  assert.equal(
    declared,
    LFS_CORE_VERSION,
    'package.json must pin the scanner exactly, to the version flowscan.ts was written against',
  );
  assert.ok(
    /^\d+\.\d+\.\d+$/.test(declared),
    `the pin must be exact, not a range: got ${declared}`,
  );
});

test('every rule the scanner ships is either mapped or refused with a reason', () => {
  const rules = (lfsScanner as { getRules: (n?: string[], o?: object) => Array<{ name: string }> })
    .getRules(undefined, { betaMode: true, systemRules: true });
  const unaccounted = rules
    .map((r) => r.name)
    .filter((name) => !(name in LFS_RULES) && !(name in LFS_DISABLED));
  assert.deepEqual(
    unaccounted,
    [],
    'a scanner rule is neither mapped to an OrgTriage rule nor listed in LFS_DISABLED with a reason',
  );
});

test('a rule is never both mapped and refused', () => {
  const both = Object.keys(LFS_RULES).filter((name) => name in LFS_DISABLED);
  assert.deepEqual(both, [], 'these rules are in LFS_RULES and LFS_DISABLED at once');
});

test('borrowed rules carry OrgTriage advice, not the scanner’s one-liners', () => {
  for (const [name, spec] of Object.entries(LFS_RULES)) {
    assert.ok(spec.id.startsWith('flows.lfs.'), `${name} should be namespaced flows.lfs.*`);
    assert.ok(spec.rationale.length > 120, `${name} has no real rationale`);
    assert.ok(spec.remediation.length > 60, `${name} has no real remediation`);
    assert.ok(spec.weight > 0, `${name} must carry weight or it cannot be scored`);
  }
});

test('the scanner finds the anti-patterns the hand-written rules used to find', () => {
  const metadata = {
    apiVersion: 55,
    label: 'Contact Sync',
    processType: 'AutoLaunchedFlow',
    status: 'Active',
    start: { connector: { targetReference: 'Loop_Contacts' }, object: 'Contact', triggerType: 'RecordAfterSave' },
    loops: [
      {
        name: 'Loop_Contacts',
        label: 'Loop Contacts',
        collectionReference: 'contacts',
        nextValueConnector: { targetReference: 'Update_Contact' },
      },
    ],
    recordUpdates: [
      {
        name: 'Update_Contact',
        label: 'Update Contact',
        object: 'Contact',
        connector: { targetReference: 'Loop_Contacts' },
      },
    ],
    variables: [{ name: 'unused_var', dataType: 'String' }],
  };

  const out = scanFlowMetadata([
    { id: '300xx', name: 'Contact_Sync', label: 'Contact Sync', metadata },
  ]);

  assert.equal(out.failed.length, 0, 'the flow parsed');
  assert.deepEqual(out.unmapped, [], 'no rule fired that the mapping does not know');

  // DML in a loop and a missing fault path are the two the hand-written rules
  // covered; the scanner finds both, plus ones they never did.
  assert.ok(out.byRule.has('DMLStatementInLoop'), 'DML in loop');
  assert.ok(out.byRule.has('MissingFaultPath'), 'missing fault path');
  assert.ok(out.byRule.has('MissingRecordTriggerFilter'), 'no entry criteria');
  assert.ok(out.byRule.has('UnusedVariable'), 'a check the hand-written rules never had');

  const hit = out.byRule.get('DMLStatementInLoop')?.[0];
  assert.ok(hit, 'the DML-in-loop finding names the flow it was found in');
  assert.equal(hit.id, '300xx');
  assert.equal(hit.name, 'Contact_Sync');
  assert.ok(String(hit.evidence?.Elements).includes('Update_Contact'), 'names the element to open');
});

test('the enabled list is exactly what runs — no more, no fewer', () => {
  const ran = rulesExecutedFor({ processType: 'AutoLaunchedFlow', status: 'Active', label: 'x', start: {} });
  assert.deepEqual(ran, [...LFS_ENABLED_RULES].sort());
  // Isolated mode was the fix; before it, every rule the scanner ships ran
  // and the "disabled" ones were discarded afterwards.
  for (const name of Object.keys(LFS_DISABLED)) assert.ok(!ran.includes(name), `${name} must not run`);
});

test('a rule that crashed is an error, not a pass', () => {
  const acc = { byRule: new Map(), unmapped: new Set<string>(), ruleErrors: new Map() };
  const input = { id: '300', name: 'Broken', label: 'Broken', metadata: {} };
  foldScanResults(input, [
    {
      ruleResults: [
        // What LFS returns when a rule throws: occurs false, details empty,
        // and the only trace in errorMessage. Read as clean, it was a pass.
        { ruleName: 'DMLStatementInLoop', occurs: false, severity: 'error', details: [], errorMessage: 'TypeError: x is undefined' },
        { ruleName: 'MissingFaultPath', occurs: true, severity: 'error', details: [{ name: 'Update_1' }] },
      ],
    },
  ], acc);
  assert.ok(!acc.byRule.has('DMLStatementInLoop'), 'a crashed rule produces no finding');
  assert.deepEqual(acc.ruleErrors.get('DMLStatementInLoop'), [{ name: 'Broken', reason: 'TypeError: x is undefined' }]);
  assert.ok(acc.byRule.has('MissingFaultPath'), 'a rule that ran is unaffected');
});

test('a flow the scanner cannot parse is recorded, not silently dropped', () => {
  const out = scanFlowMetadata([
    { id: '1', name: 'Fine', metadata: { processType: 'Flow', status: 'Active' } },
    // A getter that throws stands in for metadata the scanner chokes on.
    { id: '2', name: 'Broken', metadata: new Proxy({}, { get() { throw new Error('bad'); } }) },
  ]);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0]?.name, 'Broken');
  // The reason is the point: "two flows failed" with no cause is not
  // actionable, which is what the first real org produced.
  assert.match(out.failed[0]?.reason ?? '', /bad/);
});

test('the path shim behaves like node:path for the names we hand the scanner', () => {
  assert.equal(basename('Contact_Sync.flow-meta.xml'), 'Contact_Sync.flow-meta.xml');
  assert.equal(extname('Contact_Sync.flow-meta.xml'), '.xml');
  assert.equal(basename('Contact_Sync.flow-meta.xml', '.xml'), 'Contact_Sync.flow-meta');
  // A leading dot is a name, not an extension — the case that makes a naive
  // lastIndexOf('.') implementation wrong.
  assert.equal(extname('.flowrc'), '');
});

test("a flow's own element names are not reported as ids", () => {
  const metadata = {
    recordCreates: [{ name: 'Create_Account1', connector: null }],
    assignments: [{ name: 'Set_Owner_12345', assignmentItems: [{ value: { stringValue: '00G5f000000abcdEAA' } }] }],
  } as any;
  const found = findHardcodedIds(metadata, new Set(['00G']));
  assert.deepEqual(found, ['00G5f000000abcdEAA']);
  assert.ok(!found.includes('Set_Owner_12345'), 'element names are excluded');
});

/* -------------------------------------------------------------------------- */
/* Layouts — SLDS lint                                                         */
/* -------------------------------------------------------------------------- */

test('lint does not flag the remediation it recommends', () => {
  const result = lintSlds('.a { color: var(--slds-g-color-surface-1, #fff); }');
  assert.deepEqual(result.hardcodedColors, [], 'a var() fallback is the fix, not the defect');
  assert.deepEqual(result.hooksWithoutFallback, []);
});

test('lint ignores strings, url() contents and the SLDS scope container', () => {
  assert.deepEqual(lintSlds('.a::after { content: "#abc"; }').hardcodedColors, []);
  assert.deepEqual(
    lintSlds('.a { background: url(/resource/slds-icons--v2/x.svg); }').bemDoubleDash,
    [],
  );
  assert.deepEqual(lintSlds('.slds-scope { color: red; }').classOverrides, []);
});

test('lint still catches the genuine article', () => {
  const result = lintSlds(
    '.slds-button { color: #ff0000; --slds-c-button-color-background: red; } ' +
      '.slds-grid--vertical { --lwc-brand: blue; color: var(--slds-g-color-surface-1); }',
  );
  assert.ok(result.hardcodedColors.includes('#ff0000'));
  assert.ok(result.componentHooks.includes('--slds-c-button-color-background'));
  assert.ok(result.bemDoubleDash.includes('slds-grid--vertical'));
  assert.ok(result.lwcTokens.includes('--lwc-brand'));
  assert.ok(result.classOverrides.includes('.slds-button'));
  assert.equal(result.hooksWithoutFallback.length, 1);
});

test('rgba() wrapping a var() is matched whole', () => {
  assert.deepEqual(lintSlds('.a { background: rgba(var(--x), .5); }').hardcodedColors, [
    'rgba(var(--x), .5)',
  ]);
});

test('every real org stylesheet lints without throwing', () => {
  for (const sheet of orgPayloads.stylesheets as any[]) {
    assert.doesNotThrow(() => lintSlds(sheet.source), sheet.filePath);
  }
});

/* -------------------------------------------------------------------------- */
/* Apex — test-class identification                                            */
/* -------------------------------------------------------------------------- */

test('IsTest is PascalCase, and a managed class has no symbol table at all', () => {
  const rows = orgPayloads.apexSymbolTables as any[];
  const testClass = rows.find((r) => r.Id === 'MANAGED_TEST_CLASS');
  assert.ok(testClass, 'fixture includes a class annotated @isTest');
  assert.deepEqual(
    testClass.SymbolTable.tableDeclaration.annotations.map((a: any) => a.name),
    ['IsTest'],
  );

  const nullTable = rows.find((r) => r.Id === 'MANAGED_NULL_TABLE');
  // The trap: a null table must read as "unknown", never as "not a test class".
  assert.equal(nullTable.SymbolTable, null);
});

/* -------------------------------------------------------------------------- */
/* Composite eligibility                                                       */
/* -------------------------------------------------------------------------- */

test('composite takes query and describe/layouts, but not Analytics or limits', () => {
  const { analytics_report_describe: analytics, mixed } = orgPayloads.compositeEligibility as any;
  assert.equal(analytics.r0, 404, 'an Analytics describe is not an eligible subrequest');
  assert.equal(analytics.r1, 404);
  assert.equal(mixed.q0, 200, '/query/ is eligible');
  assert.equal(mixed.l0, 200, 'sobjects/{obj}/describe/layouts is eligible');
  assert.equal(mixed.lim, 404, '/limits/ is not');
});

/* -------------------------------------------------------------------------- */
/* Framework — managed detection and honest scoring                            */
/* -------------------------------------------------------------------------- */

test('ManageableState decides, not NamespacePrefix', () => {
  // Verified in a live org: installed components carry both; the org's own
  // code carries neither. A namespaced org's own components carry a namespace
  // with ManageableState 'unmanaged'.
  assert.equal(isManaged({ NamespacePrefix: 'omnistudio', ManageableState: 'installed' }), true);
  assert.equal(isManaged({ NamespacePrefix: null, ManageableState: 'unmanaged' }), false);
  assert.equal(
    isManaged({ NamespacePrefix: 'acme', ManageableState: 'unmanaged' }),
    false,
    "a namespaced org's own code is not a managed package",
  );
  assert.equal(
    isManaged({ NamespacePrefix: 'acme', ManageableState: 'released' }, 'acme'),
    false,
    'nor is it when the namespace is the org’s own',
  );
});

const RULES = {
  a: { id: 'r.a', severity: 'critical', title: () => 'a', rationale: '', remediation: '', weight: 40 },
  b: { id: 'r.b', severity: 'warning', title: () => 'b', rationale: '', remediation: '', weight: 30 },
  c: { id: 'r.c', severity: 'warning', title: () => 'c', rationale: '', remediation: '', weight: 30 },
} satisfies Record<string, RuleSpec>;

/**
 * A client on which every call fails the way a permission-starved user's
 * would. Anything an analyzer concludes on top of it is a conclusion drawn
 * from nothing — the class of bug an external review found five instances of.
 */
function deniedClient() {
  const deny = () => Promise.reject(new SalesforceError('INSUFFICIENT_ACCESS', 'denied', 403));
  return {
    apiVersion: '67.0',
    apiCalls: 0,
    budget: { max: null, remaining: null, usedByOrgTriage: 0, observedAt: null },
    query: deny,
    queryOne: deny,
    get: deny,
    composite: deny,
    retrieveMany: deny,
    getLimits: deny,
  } as unknown as AnalyzerContext['client'];
}

function deniedContext(): AnalyzerContext {
  return {
    client: deniedClient(),
    orgId: '00D000000000000AAA',
    lightningHost: 'example.lightning.force.com',
    includeManaged: false,
    orgNamespace: null,
    detailBudget: 300,
    signal: new AbortController().signal,
  };
}

test('when every call is denied, no analyzer reports a single rule as evaluated', async () => {
  for (const [id, analyzer] of Object.entries(ANALYZERS)) {
    const generator = analyzer.run(deniedContext());
    let output;
    try {
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          output = next.value;
          break;
        }
      }
    } catch (err) {
      // A permission failure must degrade to "not evaluated", never abort the
      // whole area: an admin without one permission still gets the rest.
      assert.fail(`${id} threw on a denied call instead of degrading: ${(err as Error).message}`);
    }
    const clean = output.findings.filter((f) => !f.inconclusive);
    assert.deepEqual(
      clean.map((f) => f.id),
      [],
      `${id}: a rule reached a verdict with no evidence`,
    );
    assert.equal(output.coverage?.evaluatedWeight ?? 0, 0, `${id}: evaluated weight must be zero`);
    const score = toScanResult(id as AnalyzerId, deniedContext(), output, Date.now()).score;
    assert.equal(score.score, null, `${id}: no grade without evidence`);
  }
});

test('a rule that is later found unevaluable loses its earlier clean verdict', () => {
  const both = summarise(RULES, [
    finding('apex', RULES.a, []),
    inconclusive('apex', RULES.a, 'the rows behind that verdict were never read'),
    finding('apex', RULES.b, []),
  ]);
  assert.equal(both.findings.length, 1);
  assert.ok(both.findings[0]?.inconclusive, 'the inconclusive outcome is the one that survives');
  // r.c was never mentioned at all, and is unevaluated for that reason.
  assert.deepEqual(both.unevaluated.sort(), ['r.a', 'r.c']);
  // Order does not matter: the same pair the other way round.
  const reversed = summarise(RULES, [
    inconclusive('apex', RULES.a, 'never read'),
    finding('apex', RULES.a, [{ name: 'x' }]),
  ]);
  assert.equal(reversed.findings.length, 1);
  assert.ok(reversed.findings[0]?.inconclusive);
});

test('a snapshot carries only its own API spend, not the session total', () => {
  const ctx = deniedContext();
  (ctx.client as { apiCalls: number }).apiCalls = 130;
  const output = { metrics: {}, findings: [], warnings: [], examined: 1 };
  assert.equal(toScanResult('apex', ctx, output, Date.now(), 100).apiCalls, 30);
  assert.equal(toScanResult('apex', ctx, output, Date.now()).apiCalls, 130, 'no baseline: the whole counter');
});

test('a composite chunk carries at most five query subrequests', () => {
  const q = (i: number) => ({ method: 'GET' as const, url: `/services/data/v67.0/query/?q=SELECT+${i}`, referenceId: `q${i}` });
  const g = (i: number) => ({ method: 'GET' as const, url: `/services/data/v67.0/sobjects/Flow/${i}`, referenceId: `g${i}` });
  const chunks = chunkComposite([q(1), q(2), q(3), q(4), q(5), q(6), g(1), g(2)]);
  for (const chunk of chunks) {
    assert.ok(chunk.filter((s) => s.url.includes('/query/')).length <= 5, 'five queries per chunk');
  }
  assert.equal(chunks.flat().length, 8, 'nothing is dropped');
  assert.equal(chunkComposite(Array.from({ length: 30 }, (_, i) => g(i))).length, 2, '25 per chunk otherwise');
});

test('the CLI refuses to read output that carries a credential', () => {
  assert.throws(() => assertNoCredential('{"result":{"accessToken":"00D!AQ…"}}', 'sf org display'), /credential/);
  assert.doesNotThrow(() => assertNoCredential('{"organization_id":"00D…","urls":{}}', 'sf api request rest'));
});


test('every documentation link is an HTML article on a Salesforce documentation host', () => {
  // Machine-readable variants (.md, .txt, llms.txt) exist for our scripts; a
  // person clicking a finding must always land on the rendered article.
  const files = [
    'src/analyzers/access.ts', 'src/analyzers/apex.ts', 'src/analyzers/apexlint.ts', 'src/analyzers/fields.ts',
    'src/analyzers/flows.ts', 'src/analyzers/flowscan.ts', 'src/analyzers/layouts.ts', 'src/analyzers/limits.ts',
    'src/analyzers/ops.ts', 'src/analyzers/reports.ts', 'src/analyzers/security.ts', 'src/shared/playbook.ts',
  ];
  // Two third-party rule catalogues are allowed beside Salesforce's own pages:
  // Lightning Flow Scanner (whose engine the extension runs) and PMD (the
  // reference Apex linter). Both are cited as their authors' recommendations.
  const hosts = /^https:\/\/(help\.salesforce\.com|developer\.salesforce\.com|trailhead\.salesforce\.com|v1\.lightningdesignsystem\.com|www\.lightningdesignsystem\.com|flow-scanner\.github\.io|docs\.pmd-code\.org)\//;
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const m of source.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      const url = m[0];
      if (!/salesforce\.com|lightningdesignsystem\.com|flow-scanner\.github\.io|pmd-code\.org/.test(url)) continue;
      assert.match(url, hosts, `${file}: ${url} is not on a documentation host`);
      assert.doesNotMatch(url, /\.(md|txt|json)(\?|#|$)/, `${file}: ${url} is a machine-readable variant, not an article`);
    }
  }
});

test('every help.salesforce.com citation has been opened in a browser and recorded in the link snapshot', () => {
  // Help renders nothing for a headless browser, so a Help link can only be
  // verified by a person (or the browser session) and recorded in
  // docs/doc-links.json with the article heading they saw. A link that is
  // not there is a guess, and guesses reached the report twice in one day
  // (two 404s beside a story). New Help citations now fail here until the
  // snapshot carries them.
  const snapshot = JSON.parse(readFileSync(new URL('../docs/doc-links.json', import.meta.url), 'utf8')) as Record<
    string,
    { ok: boolean; heading: string }
  >;
  const files = [
    'src/analyzers/access.ts', 'src/analyzers/apex.ts', 'src/analyzers/apexlint.ts', 'src/analyzers/fields.ts',
    'src/analyzers/flows.ts', 'src/analyzers/flowscan.ts', 'src/analyzers/layouts.ts', 'src/analyzers/limits.ts',
    'src/analyzers/ops.ts', 'src/analyzers/reports.ts', 'src/analyzers/security.ts', 'src/shared/playbook.ts',
  ];
  for (const file of files) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    // The two third-party catalogues are held to the same rule as Help.
    for (const m of source.matchAll(/https:\/\/(?:help\.salesforce\.com|flow-scanner\.github\.io|docs\.pmd-code\.org)\/[^\s'"`)]+/g)) {
      const url = m[0];
      const entry = snapshot[url];
      assert.ok(entry, `${file}: ${url} is not in docs/doc-links.json — open it in a browser and record the heading first`);
      assert.equal(entry.ok, true, `${file}: ${url} is recorded as not resolving`);
      assert.ok(entry.heading && entry.heading !== 'Salesforce Help | Article', `${file}: ${url} has no browser-read heading`);
    }
  }
});

test('a link outside Salesforce is never labelled "Salesforce documentation"', () => {
  assert.equal(docLabel('https://help.salesforce.com/s/articleView?id=x'), 'Salesforce documentation');
  assert.equal(docLabel('https://developer.salesforce.com/docs/x'), 'Salesforce documentation');
  assert.equal(docLabel('https://v1.lightningdesignsystem.com/x'), 'Salesforce documentation');
  assert.equal(docLabel('https://flow-scanner.github.io/lightning-flow-scanner/'), 'Lightning Flow Scanner documentation');
  assert.equal(docLabel('https://docs.pmd-code.org/latest/pmd_rules_apex_errorprone.html#emptycatchblock'), 'PMD documentation');
  assert.equal(docLabel('https://example.com/'), 'Documentation');
  // and every shipped docUrl resolves to a label that names its host truthfully
  for (const file of ['src/analyzers/flowscan.ts', 'src/analyzers/apexlint.ts']) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const m of source.matchAll(/docUrl:\s*'([^']+)'/g)) {
      const url = m[1] ?? '';
      const label = docLabel(url);
      if (/salesforce\.com|lightningdesignsystem\.com/.test(url)) assert.equal(label, 'Salesforce documentation');
      else assert.notEqual(label, 'Salesforce documentation', `${url} would be labelled as Salesforce`);
    }
  }
});

test('tile links are resolved at render time from the shared table, on the org host', () => {
  // A result scanned by an older build carries no link data; the panel looks
  // the label up when it draws the tile, so links never wait for a rescan.
  const link = setupLinkFor('limits', 'Data storage', orgContext.lightningHost);
  assert.equal(link?.label, 'Storage Usage');
  assert.equal(link?.url, `https://${orgContext.lightningHost}/lightning/setup/CompanyResourceDisk/home`);
  const tab = setupLinkFor('reports', 'Reports', orgContext.lightningHost);
  assert.equal(tab?.url, `https://${orgContext.lightningHost}/lightning/o/Report/home?queryScope=everything`);
  assert.equal(setupLinkFor('limits', 'Limits reported', orgContext.lightningHost), null);
  // Every label in the table is one its analyzer's source actually emits, so
  // a renamed tile cannot silently lose its link. The "(7d)" labels are
  // written as templates over RECENT_DAYS in ops.ts.
  for (const [analyzer, links] of Object.entries(SETUP_LINKS)) {
    const source = readFileSync(new URL(`../src/analyzers/${analyzer}.ts`, import.meta.url), 'utf8');
    for (const label of Object.keys(links)) {
      const templated = label.replace('(7d)', '(${RECENT_DAYS}d)');
      const emitted =
        source.includes(`'${label}'`) ||
        source.includes(`${label}:`) ||
        source.includes(`\`${templated}\``);
      assert.ok(emitted, `${analyzer}: tile "${label}" has a link but ${analyzer}.ts emits no such tile`);
    }
  }
});

test('an area where nothing could be checked is not an A', () => {
  // Every rule inconclusive: the old scorer deducted nothing and returned 100.
  const nothing = summarise(RULES, [
    inconclusive('apex', RULES.a, 'no permission'),
    inconclusive('apex', RULES.b, 'no permission'),
    inconclusive('apex', RULES.c, 'no permission'),
  ]);
  assert.equal(nothing.coverage.evaluatedWeight, 0);
  const score = scoreDomain('apex', nothing.findings, 100, nothing.coverage);
  assert.equal(score.score, null);
  assert.equal(score.grade, null);
  assert.ok(score.ungradedReason);
});

test('a clean run scores 100, and a partial run is held back', () => {
  const clean = summarise(RULES, [
    finding('apex', RULES.a, []),
    finding('apex', RULES.b, []),
    finding('apex', RULES.c, []),
  ]);
  assert.equal(clean.coverage.evaluatedWeight, clean.coverage.totalWeight);
  assert.equal(scoreDomain('apex', clean.findings, 100, clean.coverage).score, 100);

  // 40% of the weight evaluated: below the floor, so no grade at all. The
  // previous behaviour scored this 55 — an F for a clean org, on the strength
  // of what could not be checked rather than what could.
  const partial = summarise(RULES, [
    finding('apex', RULES.a, []),
    inconclusive('apex', RULES.b, 'describe failed'),
    inconclusive('apex', RULES.c, 'describe failed'),
  ]);
  const ungraded = scoreDomain('apex', partial.findings, 100, partial.coverage);
  assert.equal(ungraded.score, null, 'checking 40% of the weight is not enough evidence for a grade');
  assert.match(ungraded.ungradedReason ?? '', /40%/);
  assert.deepEqual(partial.unevaluated.sort(), ['r.b', 'r.c']);

  // 60%: above the floor, graded, and held back from 100.
  const mostly = summarise(RULES, [
    finding('apex', RULES.a, []),
    finding('apex', RULES.b, []),
    inconclusive('apex', RULES.c, 'describe failed'),
  ]);
  const held = scoreDomain('apex', mostly.findings, 100, mostly.coverage);
  assert.ok(held.score !== null && held.score < 100, 'checking 60% of the weight is a grade, but not a perfect one');
});

test('examining nothing is never a grade', () => {
  const clean = summarise(RULES, [finding('apex', RULES.a, [])]);
  const score = scoreDomain('apex', clean.findings, 0, clean.coverage);
  assert.equal(score.score, null, 'a namespaced org used to score 100/A on zero components');
  assert.match(score.ungradedReason ?? '', /Nothing was in scope/);
});

/* -------------------------------------------------------------------------- */
/* Reports — performance guidance                                              */
/* -------------------------------------------------------------------------- */

const issueKeys = (meta: any, ext?: any) => (performanceIssues(meta, ext) ?? []).map((i) => i.key);

test('a filtered All-Time report is a wide date range, not a full scan', () => {
  // Any org report that has a filter but no resolved date range.
  const report = Object.values(describes).find(
    (m: any) => (m.reportFilters?.length ?? 0) > 0 && !m.standardDateFilter?.startDate,
  ) as any;
  assert.ok(report, 'the org payloads include a filtered All-Time report');
  assert.equal(isUnfiltered(report), false, 'it has a filter, so it is not a full scan');
  const keys = issueKeys(report);
  assert.ok(keys.includes('wideDateRange'), `expected wideDateRange, got ${keys.join(',')}`);
  const wide = performanceIssues(report)!.find((i) => i.key === 'wideDateRange')!;
  assert.equal(wide.evidence.Range, 'All Time');
});

test('a resolved quarter range is not wide, and a full scan is not double-counted', () => {
  const quarter = byName('Sample Report: # of Opportunities');
  assert.ok(!issueKeys(quarter).includes('wideDateRange'));

  const scan = byName('Asset Names and Locations');
  assert.equal(isUnfiltered(scan), true);
  // The critical rule owns this report; the performance rule must stay silent
  // on its date range and its missing row limit, or the score pays twice.
  const keys = issueKeys(scan);
  assert.ok(!keys.includes('wideDateRange'), 'a full scan is not also a wide range');
  assert.ok(!keys.includes('noRowLimit'), 'a full scan is not also a missing row limit');
});

test('contains defeats an index; equals and startsWith do not', () => {
  const base = byName('Sample Report: # of Opportunities');
  const withOperator = (operator: string) => ({
    ...base,
    reportFilters: [{ column: 'ACCOUNT.NAME', operator, value: 'Acme', filterType: 'fieldValue' }],
  });
  assert.ok(issueKeys(withOperator('contains')).includes('inefficientFilters'));
  assert.ok(issueKeys(withOperator('notEqual')).includes('inefficientFilters'));
  assert.ok(!issueKeys(withOperator('equals')).includes('inefficientFilters'));
  assert.ok(!issueKeys(withOperator('startsWith')).includes('inefficientFilters'));
});

test('cross filters, wide columns, OR logic, and detail rows are each reported once', () => {
  const base = byName('Sample Report: # of Opportunities');
  const meta = {
    ...base,
    reportFormat: 'SUMMARY',
    hasDetailRows: true,
    crossFilters: [{ includesObject: false, relatedEntity: 'Task' }, { includesObject: true, relatedEntity: 'Event' }],
    reportBooleanFilter: '1 OR 2',
    detailColumns: Array.from({ length: 25 }, (_, i) => `COL_${i}`),
    customDetailFormula: { f1: {} },
  };
  const issues = performanceIssues(meta)!;
  const keys = issues.map((i) => i.key);
  for (const expected of ['crossFilters', 'manyColumns', 'orLogic', 'detailRows', 'runtimeFormulas']) {
    assert.equal(keys.filter((k) => k === expected).length, 1, `${expected} reported exactly once`);
  }
  assert.equal(issues.find((i) => i.key === 'crossFilters')!.evidence['"Without" filters'], 1);
});

test('joined reports are not judged for performance', () => {
  const base = byName('Sample Report: # of Opportunities');
  assert.equal(performanceIssues({ ...base, reportFormat: 'MULTI_BLOCK' }), null);
});

test('long text columns need column data types, and are found when present', () => {
  const base = byName('Sample Report: # of Opportunities');
  const meta = { ...base, detailColumns: ['NAME', 'DESCRIPTION'] };
  assert.ok(!issueKeys(meta).includes('longTextColumns'), 'no column info, no verdict');
  const ext = { detailColumnInfo: { NAME: { dataType: 'string' }, DESCRIPTION: { dataType: 'textarea', label: 'Description' } } };
  const found = performanceIssues(meta, ext)!.find((i) => i.key === 'longTextColumns');
  assert.ok(found);
  assert.equal(found!.evidence.Columns, 'Description');
});

/* -------------------------------------------------------------------------- */
/* Remediation plan — playbook coverage and exports                            */
/* -------------------------------------------------------------------------- */

const ALL_RULE_IDS = [
  ...APEX_RULE_IDS,
  ...FLOW_RULE_IDS,
  ...REPORT_RULE_IDS,
  ...LAYOUT_RULE_IDS,
  ...OPS_RULE_IDS,
  ...ACCESS_RULE_IDS,
  ...LIMITS_RULE_IDS,
  ...SECURITY_RULE_IDS,
  ...FIELDS_RULE_IDS,
  ...APEXLINT_RULE_IDS,
];

test('idle licence seats are counted per licence type from login dates, never by name', () => {
  const now = Date.parse('2026-09-09T00:00:00Z');
  const day = 86_400_000;
  const iso = (daysAgo: number) => new Date(now - daysAgo * day).toISOString();
  const licenses = [
    { Id: '100a', Name: 'Salesforce', MasterLabel: 'Salesforce', TotalLicenses: 50, UsedLicenses: 40, Status: 'Active' },
    { Id: '100b', Name: 'Salesforce Platform', MasterLabel: 'Salesforce Platform', TotalLicenses: 20, UsedLicenses: 20, Status: 'Active' },
    { Id: '100c', Name: 'Chatter Free', MasterLabel: 'Chatter Free', TotalLicenses: -1, UsedLicenses: 3, Status: 'Active' },
  ];
  const user = (license: string | null, lastLogin: number | null, createdDaysAgo = 400, IsActive = true, UserType = 'Standard') => ({
    IsActive,
    UserType,
    LastLoginDate: lastLogin === null ? null : iso(lastLogin),
    CreatedDate: iso(createdDaysAgo),
    Profile: license === null ? null : { Name: 'p', UserLicenseId: license },
  });
  const users = [
    user('100a', 3), // in use
    user('100a', 89), // one day short of dormant
    user('100a', 90), // dormant, on the boundary
    user('100a', 400), // dormant
    user('100a', null, 400), // never logged in, old account
    user('100a', null, 10), // never logged in but created inside the grace period: not idle
    user('100a', 400, 400, false), // inactive users hold no seat
    user('100b', 3),
    user(null, 400), // no licence on the profile: counted nowhere
    user('100c', null, 400, true, 'CsnOnly'), // Chatter Free user: not a standard user type, not counted
  ];

  const result = licenseUtilisation(licenses, users, now);
  assert.deepEqual(
    result.map((u) => [u.license.MasterLabel, u.total, u.used, u.free, u.idle, u.neverLoggedIn]),
    [
      ['Salesforce', 50, 40, 10, 3, 1],
      ['Chatter Free', null, 3, null, 0, 0],
      ['Salesforce Platform', 20, 20, 0, 0, 0],
    ],
  );
});

test('hard-coded org hosts are recognised in button URLs; shared Salesforce hosts and relative paths are not', () => {
  assert.deepEqual(hardcodedHostsIn('https://na139.salesforce.com/{!Account.Id}'), ['na139.salesforce.com']);
  assert.deepEqual(hardcodedHostsIn('https://acme.my.salesforce.com/apex/Foo?id={!Id}'), ['acme.my.salesforce.com']);
  assert.deepEqual(hardcodedHostsIn('HTTPS://Acme.Lightning.Force.com/lightning/r/Account/001/view'), ['acme.lightning.force.com']);
  assert.deepEqual(hardcodedHostsIn('https://acme--uat.sandbox.my.salesforce-sites.com/portal'), ['acme--uat.sandbox.my.salesforce-sites.com']);
  assert.deepEqual(hardcodedHostsIn('/apex/Foo?retURL=%2F001'), []);
  assert.deepEqual(hardcodedHostsIn('{!URLFOR($Action.Account.New)}'), []);
  assert.deepEqual(hardcodedHostsIn('https://login.salesforce.com/ and https://help.salesforce.com/s/'), []);
  assert.deepEqual(hardcodedHostsIn('https://www.example.com/track?id={!Id}'), []);
  // two hosts, once each
  assert.deepEqual(
    hardcodedHostsIn('https://acme.my.salesforce.com/a https://acme.my.salesforce.com/b https://cs12.salesforce.com/c'),
    ['acme.my.salesforce.com', 'cs12.salesforce.com'],
  );
});

test('release updates: Invocable ahead of its date and Pending inside a release cycle are work; the rest are counts', () => {
  const now = Date.parse('2026-09-10T00:00:00Z');
  const row = (id: string, Status: string, DueDate: string | null, NumSteps: number | null, NumCompSteps: number | null) => ({
    DurableId: id, Title: id, Category: null, DueDate, IsReleased: true, NumCompSteps, NumSteps, ReleaseLabel: 'Winter 27', Status,
  });
  const rows = [
    row('invoked', 'Invoked', '2027-01-01T00:00:00Z', 2, -1), // activated or enforced: not work
    row('info', 'Info', '2026-11-30T00:00:00Z', 7, -1), // nothing to activate
    row('nascent', 'Nascent', '2028-05-01T00:00:00Z', 2, -1), // announced, not yet available
    row('no-date', 'Invocable', null, 3, 0),
    row('later', 'Invocable', '2027-05-01T00:00:00Z', 5, -1),
    row('soon', 'Invocable', '2027-01-01T00:00:00Z', 3, 0),
    row('just-overdue', 'Pending', '2026-09-01T00:00:00Z', 3, -1), // 10 days past: still activatable before enforcement
    row('overdue-2020', 'Pending', '2020-08-19T00:00:00Z', 1, -1), // enforced years ago
    row('overdue-2025', 'Pending', '2025-01-01T00:00:00Z', 3, -1),
  ];
  const open = openReleaseUpdates(rows, now);
  assert.deepEqual(
    open.map((u) => [u.row.DurableId, u.daysToDue, u.stepsLeft]),
    [
      ['just-overdue', -9, null],
      ['soon', 113, 3],
      ['later', 233, null],
    ],
  );
  assert.equal(pastDuePending(rows, now), 2);
  assert.equal(nascentUpdates(rows), 1);
});

test('Health Check: MEETS_STANDARD is compliance, not a finding; missing labels are made readable', () => {
  assert.equal(meetsStandard('MEETS_STANDARD'), true);
  assert.equal(meetsStandard('meets_standard'), true);
  assert.equal(meetsStandard('MEDIUM_RISK'), false);
  assert.equal(meetsStandard(null), false);
  assert.equal(cleanHealthCheckValue('2 hours'), '2 hours');
  assert.equal(cleanHealthCheckValue(null), null);
  assert.equal(
    cleanHealthCheckValue('__MISSING LABEL__ PropertyFile - val SessionSettings.lockSessionsToIpDisabled not found in section Page_SessionSettings'),
    'Disabled (label missing in Salesforce)',
  );
  assert.equal(cleanHealthCheckValue('__MISSING LABEL__ PropertyFile - val Foo.bar not found'), 'value unlabelled by Salesforce');
});

test('every rule an analyzer can raise has a playbook entry, and no entry is orphaned', () => {
  assert.ok(ALL_RULE_IDS.length >= 90, `expected the full rule set, found ${ALL_RULE_IDS.length}`);
  const missing = ALL_RULE_IDS.filter((id) => !PLAYBOOK[id]);
  assert.deepEqual(missing, [], 'rules without a playbook entry');
  const orphaned = Object.keys(PLAYBOOK).filter((id) => !ALL_RULE_IDS.includes(id));
  assert.deepEqual(orphaned, [], 'playbook entries for rules that do not exist');
  for (const [id, entry] of Object.entries(PLAYBOOK)) {
    assert.ok(entry.steps.length >= 1, `${id} has steps`);
    assert.ok(entry.acceptance.length > 20, `${id} has an acceptance criterion`);
    assert.ok(entry.effort.fixed >= 0 && entry.effort.perItem >= 0, `${id} effort is non-negative`);
  }
});

test('effort tapers after fifty components and buckets on working days', () => {
  const pb = PLAYBOOK['reports.abandoned'];
  const fifty = estimateHours(pb, 50);
  const hundred = estimateHours(pb, 100);
  assert.ok(hundred < fifty * 2, 'the second fifty cost less than the first');
  assert.ok(hundred > fifty, 'but they still cost something');
  assert.equal(effortSize(2), 'XS');
  assert.equal(effortSize(8), 'S');
  assert.equal(effortSize(24), 'M');
  assert.equal(effortSize(80), 'L');
  assert.equal(effortSize(81), 'XL');
});

const fixturePlan = () =>
  buildPlan(
    {
      orgId: orgContext.orgId,
      orgName: orgContext.orgName,
      organizationType: orgContext.organizationType,
      isSandbox: false,
      instanceName: orgContext.instanceName,
      apiVersion: orgContext.apiVersion,
      lightningHost: orgContext.lightningHost,
      userName: orgContext.userName,
    },
    Object.values(scans),
    Date.UTC(2026, 8, 3),
  );

test('the plan orders stories by severity, keys them in that order, and lists the unevaluated separately', () => {
  const plan = fixturePlan();
  assert.ok(plan.stories.length > 0);
  assert.equal(plan.stories[0]!.key, 'OT-001');
  const ranks = plan.stories.map((s) => ({ critical: 0, warning: 1, info: 2, success: 3 })[s.severity]);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), 'critical first, info last');
  assert.ok(plan.stories.every((s) => s.steps.length > 0 && s.acceptance.length >= 2));
  assert.ok(plan.stories.every((s) => s.items.length > 0), 'a story always names components');
  // A zero-weight or inconclusive finding is never a story.
  assert.ok(plan.stories.every((s) => !s.ruleId.endsWith('not-checked') && !s.ruleId.endsWith('not-analyzable')));
  assert.equal(plan.totals.stories, plan.stories.length);
  assert.equal(plan.areas.length, AREA_ORDER.length, 'every scanned area is summarised');
});

test('the Jira CSV lists every epic before its own stories, with both hierarchy columns', () => {
  const plan = fixturePlan();
  const csv = planToJiraCsv(plan);
  const header = csv.split('\r\n')[0]!.split(',');

  for (const column of ['Issue ID', 'Parent', 'Epic Name', 'Epic Link', 'Story Points', 'Project key']) {
    assert.ok(header.includes(column), `${column} present`);
  }

  // Row order is the whole contract: Jira resolves Epic Link against epics that
  // already exist, so an epic after its children imports them unparented.
  const position = (key: string) => csv.indexOf(`\r\n${key},`) >= 0 ? csv.indexOf(`\r\n${key},`) : csv.indexOf(`${key},`);
  assert.ok(plan.epics.length > 0, 'the fixture plan has epics');
  for (const epic of plan.epics) {
    const epicAt = position(epic.key);
    assert.ok(epicAt >= 0, `${epic.key} present`);
    for (const storyKey of epic.storyKeys) {
      assert.ok(position(storyKey) > epicAt, `${storyKey} comes after ${epic.key}`);
    }
  }

  // Every story names its epic by both mechanisms.
  for (const story of plan.stories) {
    const epic = plan.epics.find((e) => e.key === story.epicKey)!;
    assert.ok(epic, `${story.key} has an epic`);
    assert.ok(csv.includes(`${story.key},${epic.key},`), `${story.key} carries Parent=${epic.key}`);
  }
  const epicNames = plan.epics.map((e) => e.name);
  assert.equal(new Set(epicNames).size, epicNames.length, 'epic names are unique — Jira matches Epic Link by name');

  assert.ok(!/(^|\r\n)[=+\-@]/.test(csv), 'no cell starts with a formula character');
  assert.ok(csv.includes(',High,') && !csv.includes('Highest'), 'priorities are the Jira names the report also uses');
});

test('the generic CSV is flat, one row per story, with no tool-specific columns', () => {
  const plan = fixturePlan();
  const csv = planToGenericCsv(plan);
  const lines = csv.split('\r\n').filter(Boolean);
  const header = lines[0]!;

  assert.ok(!header.includes('Epic Link') && !header.includes('Parent'), 'no Jira hierarchy columns');
  assert.ok(header.startsWith('Key,Title,Workstream'), 'plain column names');
  for (const story of plan.stories) assert.ok(csv.includes(`${story.key},`), `${story.key} present`);
  assert.ok(!/(^|\r\n)[=+\-@]/.test(csv), 'no cell starts with a formula character');
});

test('the JSON export carries the plan, its totals and the estimating assumptions', () => {
  const plan = fixturePlan();
  const parsed = JSON.parse(planToJson(plan));
  assert.equal(parsed.schema, 'orgtriage.plan/1');
  assert.equal(parsed.stories.length, plan.stories.length);
  assert.equal(parsed.epics.length, plan.epics.length);
  assert.equal(parsed.totals.points, plan.stories.reduce((n: number, s: { points: number }) => n + s.points, 0));
  // The assumptions have to travel with the numbers, or the numbers are unreadable.
  assert.equal(parsed.assumptions.hoursPerPersonDay, HOURS_PER_PERSON_DAY);
  assert.equal(parsed.assumptions.daysPerSprint, DAYS_PER_SPRINT);
});

test('story points are derived from the hours and never disagree with them', () => {
  assert.deepEqual([2, 4, 8, 16, 32, 64, 65].map(storyPoints), [1, 2, 3, 5, 8, 13, 21]);
  const plan = fixturePlan();
  for (const story of plan.stories) {
    assert.equal(story.points, storyPoints(story.effortHours), `${story.key} points match its hours`);
  }
  assert.equal(
    plan.totals.personDays,
    Math.round((plan.totals.hours / HOURS_PER_PERSON_DAY) * 10) / 10,
  );
});

test('every area OrgTriage can scan appears in the canonical order', () => {
  // The hand-kept copy of this list dropped `access` when that analyzer landed,
  // which sorted it to the front and left it out of the "not scanned" list.
  assert.deepEqual([...AREA_ORDER].sort(), Object.keys(AREA_LABEL).sort());
});

test('filter columns cover standard fields; the index rule stays custom-only', () => {
  const meta = {
    reportFilters: [
      { column: 'Contact.Description', operator: 'contains' },
      { column: 'Contact.Custom__c', operator: 'equals' },
      { column: 'CLOSE_DATE', operator: 'equals' },
    ],
  } as never;

  // The long-text rule needs standard fields: Description and Solution Details
  // are the two most commonly filtered long text fields there are.
  assert.deepEqual(
    filterColumns(meta).map((c) => c.field),
    ['Description', 'Custom__c'],
  );
  // The unindexed rule deliberately does not, because a standard report-type
  // column like CLOSE_DATE carries no field API name to check.
  assert.deepEqual(
    customFilterColumns(meta).map((c) => c.field),
    ['Custom__c'],
  );
});

test('a long text filter is caught even when the field is not a displayed column', () => {
  const meta = {
    reportFormat: 'TABULAR',
    detailColumns: ['Contact.Name'],
    reportFilters: [
      // The field being filtered on is deliberately NOT in detailColumns. This
      // is the case detailColumnInfo cannot see, and the one the field
      // catalogue was wired in to catch.
      { column: 'Contact.Description', operator: 'contains', value: 'boat' },
      { column: 'Contact.Name', operator: 'equals', value: 'Smith' },
    ],
    topRows: { rowLimit: 100 },
  } as never;

  const catalogue = new Map([
    ['Contact.Description', { indexed: false, calculated: false, dataType: 'Text Area(Long)' }],
    ['Contact.Name', { indexed: true, calculated: false, dataType: 'Text(121)' }],
  ]);

  const hit = longTextFilterFields(meta, catalogue, undefined);
  assert.ok(hit, 'a hidden filtered field is still a correctness risk');
  assert.equal(hit?.label, 'Description');
  assert.deepEqual(hit?.operators, ['contains']);
});

test('a plain 255-character Text Area is not reported as deep text', () => {
  // The old detailColumnInfo path matched the bare type "textarea", which is
  // what a plain Text Area reports too. Filtering one of those loses at most
  // the last character, so a finding would be noise.
  assert.equal(isDeepTextType('Text Area(Long)'), true);
  assert.equal(isDeepTextType('Text Area(Rich)'), true);
  assert.equal(isDeepTextType('text area ( long )'), true);
  assert.equal(isDeepTextType('longtextarea'), true);
  assert.equal(isDeepTextType('richtextarea'), true);
  assert.equal(isDeepTextType('Text Area'), false);
  assert.equal(isDeepTextType('Text(255)'), false);
  assert.equal(isDeepTextType(null), false);
  assert.equal(isDeepTextType(undefined), false);
});

test('the column-info fallback still works where the catalogue is missing', () => {
  const meta = {
    reportFilters: [{ column: 'Case.Custom_Notes__c', operator: 'contains', value: 'x' }],
  } as never;

  const viaColumnInfo = longTextFilterFields(meta, null, {
    'Case.Custom_Notes__c': { label: 'Custom Notes', dataType: 'longtextarea' },
  });
  assert.equal(viaColumnInfo?.label, 'Custom Notes');

  // Neither source: no claim. Guessing from the field name would be worse than
  // saying nothing.
  assert.equal(longTextFilterFields(meta, null, undefined), null);
});

test('the CLI runs exactly the analyzers the panel runs', () => {
  // scan.ts imports ANALYZERS rather than keeping its own list, so the two
  // cannot diverge by omission. What can still go wrong is an analyzer added to
  // the AnalyzerId union and never registered — it would typecheck, ship, and
  // simply never run. AREA_LABEL is keyed by AnalyzerId, so it stands in for
  // the union at runtime.
  assert.deepEqual(
    Object.keys(ANALYZERS).sort(),
    Object.keys(AREA_LABEL).sort(),
    'an analyzer is declared but not registered in ANALYZERS, or vice versa',
  );
});

test('the Lightning host is derived from the instance URL, or left alone', () => {
  assert.equal(lightningHostFor('https://acme.my.salesforce.com'), 'acme.lightning.force.com');
  assert.equal(
    lightningHostFor('https://acme--dev.sandbox.my.salesforce.com'),
    'acme--dev.sandbox.lightning.force.com',
  );
  assert.equal(lightningHostFor('https://acme.my.salesforce.com/'), 'acme.lightning.force.com');
  // An instance-style host has no Lightning equivalent worth guessing at.
  // Returning it unchanged keeps Setup links pointing somewhere real.
  assert.equal(lightningHostFor('https://na123.salesforce.com'), 'na123.salesforce.com');
});

test('the Markdown export carries the summary table, the backlog, and every item', () => {
  const plan = fixturePlan();
  const md = planToMarkdown(plan);
  assert.ok(md.startsWith(`# Remediation plan — ${orgContext.orgName}`));
  assert.ok(md.includes('## Summary') && md.includes('## Backlog') && md.includes('## Backlog items'));
  for (const s of plan.stories) assert.ok(md.includes(`### ${s.key} — ${s.title}`), `${s.key} in markdown`);
  assert.ok(md.includes('Acceptance criteria'));
});

/* -------------------------------------------------------------------------- */
/* Reports — unindexed filter fields and dashboard filter load                 */
/* -------------------------------------------------------------------------- */

test('custom filter columns are recognised in both report-type spellings, and standard columns are not', () => {
  const meta = {
    reportFilters: [
      { column: 'CLOSE_DATE', operator: 'equals', value: 'x' },
      { column: 'Opportunity.Region__c', operator: 'equals', value: 'West' },
      { column: 'Account$Tier__c', operator: 'equals', value: 'A' },
      { column: 'Opportunity.Region__c', operator: 'notEqual', value: 'East' },
    ],
  };
  const cols = customFilterColumns(meta as any);
  assert.deepEqual(
    cols.map((c) => `${c.object}.${c.field}`),
    ['Opportunity.Region__c', 'Account.Tier__c'],
    'each custom field once, standard columns skipped',
  );
  assert.ok(cols.every((c) => /^[A-Za-z0-9_]+$/.test(c.object)), 'object names are SOQL-safe');
});

test('only fields FieldDefinition says are unindexed count; unknown fields never do', () => {
  const meta = {
    reportFilters: [
      { column: 'Opportunity.Region__c' },
      { column: 'Opportunity.Score__c' },
      { column: 'Opportunity.Ext_Id__c' },
      { column: 'Opportunity.Unknown__c' },
    ],
  } as any;
  const fields = new Map([
    ['Opportunity.Region__c', { indexed: false, calculated: false }],
    ['Opportunity.Score__c', { indexed: false, calculated: true }],
    ['Opportunity.Ext_Id__c', { indexed: true, calculated: false }],
  ]);
  const evidence = unindexedFilterEvidence(meta, fields)!;
  assert.equal(evidence['Unindexed fields'], 'Opportunity.Region__c, Opportunity.Score__c (formula)');
  assert.equal(evidence['Filters on them'], 2);
  assert.equal(unindexedFilterEvidence(meta, new Map()), null, 'no field info, no verdict');
});

test('dashboard filter load bounds runs by components times selections and stays quiet on small boards', () => {
  const small = { filters: [{ options: [{}, {}, {}] }], components: Array(5).fill({}) };
  assert.equal(dashboardFilterLoad(small), null, '5 × 4 = 20 runs is not worth a story');
  const heavy = { filters: [{ options: Array(12).fill({}) }, { options: Array(6).fill({}) }], components: Array(20).fill({}) };
  const load = dashboardFilterLoad(heavy)!;
  assert.deepEqual(load, { filters: 2, values: 18, components: 20, worstCaseRuns: 380 });
  assert.equal(dashboardFilterLoad({ filters: [], components: Array(30).fill({}) }), null, 'no filters, no multiplication');
  assert.ok(dashboardFilterLoad({ filters: [{ options: [] }, { options: [] }, { options: [] }], components: [{}] }), 'three filters always worth a look');
});

/* -------------------------------------------------------------------------- */
/* Ops and Lightning page census                                               */
/* -------------------------------------------------------------------------- */

test('stacked hours group scheduled jobs by UTC hour of next fire', () => {
  const jobs = [
    ...Array.from({ length: 6 }, (_, i) => ({ name: `Job ${i}`, next: '2026-09-04T06:15:00.000+0000' })),
    { name: 'Lonely', next: '2026-09-04T22:00:00.000+0000' },
    { name: 'Never', next: null },
  ];
  const stacked = stackedHours(jobs);
  assert.deepEqual(stacked.map((s) => [s.hour, s.jobs.length]), [[6, 6]]);
});

test('API logins are told from browser and SSO sessions by login type', () => {
  for (const t of ['Remote Access 2.0', 'Other Apex API', 'Partner Product', 'Data Loader Partner']) assert.equal(isApiLogin(t), true, t);
  for (const t of ['Application', 'SAML Sfdc Initiated SSO', null, '']) assert.equal(isApiLogin(t), false, String(t));
});

test('an interview label is reduced to its flow name', () => {
  assert.equal(interviewFlowName('Case Escalation Wait 9/1/2026, 2:14 PM'), 'Case Escalation Wait');
  assert.equal(interviewFlowName('Onboarding Reminder'), 'Onboarding Reminder');
  assert.equal(interviewFlowName(null), 'Unknown flow');
});

test('report charts are counted across regions and facets', () => {
  const metadata = orgPayloads.flexiPage.metadata as unknown as FlexiPageMetadata;
  assert.equal(countComponentsNamed(metadata, new Set(['flexipage:reportChart'])), 0, 'the fixture page has none');
  const withCharts = {
    flexiPageRegions: [
      { type: 'Region', itemInstances: [{ componentInstance: { componentName: 'flexipage:reportChart' } }] },
      { type: 'Facet', itemInstances: [{ componentInstance: { componentName: 'flexipage:reportChart' } }, { fieldInstance: {} }] },
    ],
  };
  assert.equal(countComponentsNamed(withCharts, REPORT_CHART_COMPONENTS), 2);
});

test('a column is right-aligned when its values read as numbers, a stray placeholder aside', () => {
  // The bug: `typeof value === "number"` put API version and Size right and
  // Coverage ("0%") left, in the same table.
  for (const v of [63, '1,292', '0%', '58.0', '3.1 d', '45 min'])
    assert.equal(isNumericLike(v), true, String(v));
  for (const v of ['FSLGetOpenWorkOrders', '2026-09-03T14:59:09Z', 'All Time', 'Private Reports', true])
    assert.equal(isNumericLike(v), false, String(v));
  for (const v of [null, undefined, '', 'no data', 'not coverable', 'unknown', 'none'])
    assert.equal(isNumericLike(v), null, `${String(v)} stands where a number would and does not vote`);

  // A stray placeholder must not left-align a column of percentages.
  assert.equal(isNumericColumn(['0%', '12%', 'no data', '100%']), true);
  // Half the column reading "no data" is what left-aligned Coverage next to a
  // right-aligned Size in the same table.
  assert.equal(isNumericColumn(['no data', '0%', '0%', 'no data', '0%', 'no data']), true);
  assert.equal(isNumericColumn([63, 66, null, 62]), true);
  assert.equal(isNumericColumn(['Opportunity', 'Account', '42']), false);
  assert.equal(isNumericColumn([null, undefined]), false, 'a column of nothing is not numeric');
});

/* -------------------------------------------------------------------------- */
/* Access analyzer — the permission join                                       */
/* -------------------------------------------------------------------------- */

const permSet = (over: Record<string, unknown>) => ({
  Id: 'x',
  Name: 'x',
  Label: 'x',
  Type: 'Regular',
  NamespacePrefix: null,
  IsOwnedByProfile: false,
  ProfileId: null,
  Profile: null,
  PermissionsModifyAllData: false,
  PermissionsViewAllData: false,
  PermissionsAuthorApex: false,
  PermissionsCustomizeApplication: false,
  PermissionsManageUsers: false,
  PermissionsPasswordNeverExpires: false,
  ...over,
});

const assignee = (over: Record<string, unknown> = {}) => ({
  Name: 'Dana',
  Username: 'dana@example.com',
  IsActive: true,
  UserType: 'Standard',
  LastLoginDate: '2026-08-01T00:00:00.000Z',
  ...over,
});

test('a permission reaches a user through a profile, a permission set, or a group', () => {
  const sets = [
    permSet({ Id: '0PS1', Name: 'Admin_Profile', IsOwnedByProfile: true, ProfileId: '00e1', Profile: { Name: 'System Administrator' }, PermissionsModifyAllData: true }),
    permSet({ Id: '0PS2', Name: 'Data_Steward', Label: 'Data Steward', PermissionsModifyAllData: true }),
    permSet({ Id: '0PS3', Name: 'Harmless', Label: 'Harmless' }),
  ];
  const assignments = [
    // direct assignment of a granting set
    { Id: 'a1', AssigneeId: '005b', PermissionSetId: '0PS2', PermissionSetGroupId: null, Assignee: assignee({ Name: 'Ines' }) },
    // group assignment: the group itself grants nothing, its member does
    { Id: 'a2', AssigneeId: '005c', PermissionSetId: '0PSG_agg', PermissionSetGroupId: '0PG1', Assignee: assignee({ Name: 'Boomi' }) },
    // an assignment that grants nothing must not produce a holder
    { Id: 'a3', AssigneeId: '005d', PermissionSetId: '0PS3', PermissionSetGroupId: null, Assignee: assignee({ Name: 'Nobody' }) },
  ];
  const groupMembers = new Map([['0PG1', ['0PS2']]]);
  const usersByProfile = new Map([
    ['00e1', [{ Id: '005a', Name: 'Dana', Username: 'dana@example.com', IsActive: true, UserType: 'Standard', LastLoginDate: null, ProfileId: '00e1', Profile: { Name: 'System Administrator' } }]],
  ]);

  const holders = holdersOf('PermissionsModifyAllData', sets as never, assignments as never, groupMembers, usersByProfile as never);
  const byId = new Map(holders.map((h) => [h.userId, h]));

  assert.deepEqual([...byId.keys()].sort(), ['005a', '005b', '005c']);
  assert.deepEqual([...byId.get('005a')!.via], ['Profile: System Administrator']);
  assert.deepEqual([...byId.get('005b')!.via], ['Permission set: Data Steward']);
  assert.deepEqual([...byId.get('005c')!.via], ['Permission set group → Data Steward']);
  assert.equal(byId.get('005a')!.lastLoginDate, null, 'never-logged-in is carried through, not defaulted');
});

test('a user holding a permission by two routes is listed once, with both routes', () => {
  const sets = [
    permSet({ Id: '0PS1', Name: 'Admin_Profile', IsOwnedByProfile: true, ProfileId: '00e1', Profile: { Name: 'System Administrator' }, PermissionsViewAllData: true }),
    permSet({ Id: '0PS2', Name: 'Reporting', Label: 'Reporting', PermissionsViewAllData: true }),
  ];
  const assignments = [
    { Id: 'a1', AssigneeId: '005a', PermissionSetId: '0PS2', PermissionSetGroupId: null, Assignee: assignee() },
  ];
  const usersByProfile = new Map([
    ['00e1', [{ Id: '005a', Name: 'Dana', Username: 'dana@example.com', IsActive: true, UserType: 'Standard', LastLoginDate: null, ProfileId: '00e1', Profile: { Name: 'System Administrator' } }]],
  ]);

  const holders = holdersOf('PermissionsViewAllData', sets as never, assignments as never, new Map(), usersByProfile as never);
  assert.equal(holders.length, 1);
  assert.deepEqual([...holders[0]!.via].sort(), ['Permission set: Reporting', 'Profile: System Administrator']);
});

test('the grant label names the profile for a profile-owned set and the label otherwise', () => {
  assert.equal(
    grantLabel(permSet({ IsOwnedByProfile: true, Profile: { Name: 'Sales User' }, Name: 'Sales_Profile' }) as never),
    'Profile: Sales User',
  );
  assert.equal(grantLabel(permSet({ Name: 'Deploy', Label: 'Deployment' }) as never), 'Permission set: Deployment');
});

/* -------------------------------------------------------------------------- */
/* Snapshot diffing                                                            */
/* -------------------------------------------------------------------------- */

const scanWith = (findings: Finding[], score: number): ScanResult => ({
  analyzer: 'apex',
  orgId: '00D000000000001AAA',
  completedAt: Date.UTC(2026, 8, 5),
  durationMs: 1000,
  apiCalls: 10,
  apiVersion: '67.0',
  score: {
    score,
    grade: 'B',
    counts: { critical: 0, warning: 0, info: 0, success: 0 },
    examined: 100,
  } as ScanResult['score'],
  metrics: {},
  findings,
  warnings: [],
});

const rule = (id: string, names: string[], severity: Severity = 'warning'): Finding => ({
  id,
  analyzer: 'apex',
  severity,
  title: `${names.length} things`,
  rationale: 'r',
  remediation: 'm',
  weight: 10,
  items: names.map((name) => ({ name, evidence: {} })),
});

test('snapshots are compared only when the same extension version produced both', () => {
  const a = { ...scanWith([rule('a', ['One'])], 70), build: '0.8.15' };
  const b = { ...scanWith([rule('a', ['One'])], 70), build: '0.8.16' };
  assert.equal(comparable(a, b), false, 'a rule change between versions must not read as progress');
  assert.equal(comparable(a, { ...a }), true);
  assert.equal(comparable(scanWith([], 70), scanWith([], 70)), false, 'snapshots from before the build was recorded are never compared');
  assert.equal(digestOf(a).build, '0.8.15');
});

test('hidden Apex bodies are not clean code: none readable means inconclusive, not an A', async () => {
  // Codex, 2026-09-11: one class returned as "(hidden)" plus an empty trigger
  // query scored 100/A with every rule counted as evaluated.
  const client = {
    ...deniedClient(),
    query: async (soql: string) =>
      soql.includes('FROM ApexClass')
        ? { records: [{ Id: '01p000000000001AAA', Name: 'Hidden', Body: '(hidden)', NamespacePrefix: null, ApiVersion: 60 }], totalSize: 1, truncated: false }
        : { records: [], totalSize: 0, truncated: false },
  } as unknown as AnalyzerContext['client'];
  const generator = ANALYZERS.apexlint.run({ ...deniedContext(), client });
  let output;
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      output = next.value;
      break;
    }
  }
  const result = toScanResult('apexlint', deniedContext(), output, Date.now());
  assert.equal(output.metrics['Components read']?.value, 0, 'a hidden body was not read');
  assert.equal(result.score.grade !== 'A' || result.score.ungradedReason !== undefined, true, 'no readable source cannot grade an A');
  assert.equal(output.findings.every((f) => f.inconclusive), true, 'every clean verdict is withheld');
});

test('one hidden class beside a readable clean trigger cannot clear the class-only sharing rule', async () => {
  // Codex second pass, 2026-09-11: a readable trigger used to let every clean
  // verdict stand, including the sharing rule that only classes can satisfy.
  const client = {
    ...deniedClient(),
    query: async (soql: string) =>
      soql.includes('FROM ApexClass')
        ? { records: [{ Id: '01p000000000001AAA', Name: 'Hidden', Body: '(hidden)', NamespacePrefix: null, ApiVersion: 60 }], totalSize: 1, truncated: false }
        : { records: [{ Id: '01q000000000001AAA', Name: 'Clean', Body: 'trigger Clean on Account (before insert) { }', NamespacePrefix: null, TableEnumOrId: 'Account' }], totalSize: 1, truncated: false },
  } as unknown as AnalyzerContext['client'];
  const generator = ANALYZERS.apexlint.run({ ...deniedContext(), client });
  let output;
  for (;;) {
    const next = await generator.next();
    if (next.done) {
      output = next.value;
      break;
    }
  }
  assert.equal(output.metrics['Components read']?.value, 1, 'only the readable trigger counts');
  assert.equal(output.findings.every((f) => f.inconclusive), true, 'nothing found is not a verdict on the hidden class');
});

test('a smaller detail budget is a different scope, so a vanished finding is not a fix', () => {
  // Codex, 2026-09-11: budgets 300 and 25 produced identical scope strings, so
  // a component the second scan never described read as "1 fixed".
  const ctx = deniedContext();
  const wide = toScanResult('reports', { ...ctx, detailBudget: 300 }, { metrics: {}, findings: [], warnings: [], examined: 1 }, Date.now());
  const narrow = toScanResult('reports', { ...ctx, detailBudget: 25 }, { metrics: {}, findings: [], warnings: [], examined: 1 }, Date.now());
  assert.notEqual(wide.scope, narrow.scope);
  assert.equal(comparable({ build: 'x', scope: wide.scope }, { build: 'x', scope: narrow.scope }), false);
  assert.equal(comparable({ build: 'x', scope: wide.scope }, { build: 'x', scope: wide.scope }), true);
});

test('snapshots taken under different scan scope are not compared', () => {
  // Measured 2026-09-11: turning on "include managed packages" and rescanning
  // one area produced "96 new" in an org nothing had happened to.
  const unmanaged = { ...scanWith([rule('a', ['One'])], 70), build: '0.8.32', scope: 'unmanaged' };
  const withManaged = { ...unmanaged, scope: 'with-managed' };
  assert.equal(comparable(unmanaged, withManaged), false, 'a settings change is not the org changing');
  assert.equal(comparable(unmanaged, { ...unmanaged }), true);
  assert.equal(digestOf(withManaged).scope, 'with-managed');
});

test('a diff says when Salesforce moved the org to a new API version', () => {
  // A release upgrade genuinely puts more flows on an old API version; the
  // diff must not hide that, but it must say whose doing it was.
  const before = { ...scanWith([rule('a', ['One'])], 70), build: '0.8.32', scope: 'unmanaged', apiVersion: '67.0' };
  const after = { ...before, apiVersion: '68.0' };
  assert.deepEqual(diffAgainst(digestOf(before), after).platformMoved, { from: '67.0', to: '68.0' });
  assert.equal(diffAgainst(digestOf(before), { ...before }).platformMoved, undefined);
});

test('the diff separates rules that appeared, resolved, and changed size', () => {
  const before = digestOf(scanWith([rule('a', ['One', 'Two', 'Three']), rule('b', ['Gone'])], 70));
  const after = scanWith([rule('a', ['One', 'Four']), rule('c', ['Fresh'])], 78);
  const diff = diffAgainst(before, after);

  assert.equal(diff.scoreDelta, 8);
  assert.deepEqual(diff.appeared.map((r) => r.ruleId), ['c']);
  assert.deepEqual(diff.resolved.map((r) => r.ruleId), ['b']);
  assert.deepEqual(diff.changed.map((r) => r.ruleId), ['a']);

  const changed = diff.changed[0]!;
  assert.equal(changed.delta, -1);
  assert.deepEqual(changed.appeared, ['Four'], 'a component newly flagged is named');
  assert.deepEqual(changed.cleared, ['Two', 'Three'], 'components no longer flagged are named');
  assert.equal(diff.unchanged, false);
});

test('a rule with the same components in both scans produces no row at all', () => {
  const findings = [rule('a', ['One', 'Two'])];
  const diff = diffAgainst(digestOf(scanWith(findings, 80)), scanWith(findings, 80));
  assert.deepEqual([diff.appeared, diff.resolved, diff.changed], [[], [], []]);
  assert.equal(diff.unchanged, true);
  assert.equal(summariseDiff(diff), 'No change since the previous scan');
});

test('an inconclusive rule is never reported as resolved', () => {
  // "We could not check this" must not read as "this is fixed" — that is the
  // one failure mode a progress report cannot have.
  const fired = rule('a', ['One']);
  const notChecked: Finding = { ...fired, items: [], weight: 0, inconclusive: { reason: 'no permission' } };
  const diff = diffAgainst(digestOf(scanWith([fired], 70)), scanWith([notChecked], 70));
  assert.deepEqual(diff.resolved, [], 'the rule vanished from the digest rather than being resolved');
  assert.deepEqual(diff.appeared, []);
  assert.deepEqual(diff.changed, []);
});

test('above the digest cap the diff keeps counts and says the names are incomplete', () => {
  const many = Array.from({ length: MAX_DIGEST_ITEMS + 5 }, (_, i) => `Item${i}`);
  const before = digestOf(scanWith([rule('a', many)], 60));
  assert.equal(before.rules['a']!.items, null, 'names above the cap are not stored');
  assert.equal(before.rules['a']!.count, MAX_DIGEST_ITEMS + 5);

  const diff = diffAgainst(before, scanWith([rule('a', many.slice(0, 10))], 60));
  const changed = diff.changed[0]!;
  assert.equal(changed.delta, -(MAX_DIGEST_ITEMS - 5));
  assert.equal(changed.namesIncomplete, true);
  assert.deepEqual(changed.cleared, [], 'no names are invented when one side was capped');
});

/* -------------------------------------------------------------------------- */
/* Limits & storage                                                            */
/* -------------------------------------------------------------------------- */

test('record size follows the published rates, and unpriced objects are not estimated', () => {
  assert.equal(recordKb('Account'), 2, 'the standard rate applies to anything not named');
  assert.equal(recordKb('Campaign'), 8);
  assert.equal(recordKb('CampaignMember'), 1);
  // Email Messages are billed at their actual size, so an estimate would be invented.
  assert.equal(recordKb('EmailMessage'), null);
  assert.equal(estimatedMb('EmailMessage', 1_000_000), null);
  assert.equal(estimatedMb('Account', 1024 * 512), 1024, '512K records at 2 KB is 1 GB');
});

test('only real limit pairs are read from the limits payload', () => {
  const raw = {
    DataStorageMB: { Max: 10240, Remaining: 1626 },
    DailyApiRequests: { Max: 100000, Remaining: 21588 },
    // Per-namespace maps and zero-max entries are not limits this area reports.
    DailyDurableGenericStreamingApiEvents: { Max: 0, Remaining: 0 },
    PermissionSets: { 'my_ns': { Max: 10, Remaining: 10 } },
    NotAnObject: 42,
    Missing: { Max: 5 },
  };
  const names = usableLimits(raw as Record<string, unknown>).map(([n]) => n);
  assert.deepEqual(names.sort(), ['DailyApiRequests', 'DataStorageMB']);
});

test('limit names are made readable without mangling the API acronym', () => {
  assert.equal(humanLimit('DailyApiRequests'), 'Daily API requests');
  assert.equal(humanLimit('DailyAsyncApexExecutions'), 'Daily async apex executions');
  assert.equal(humanLimit('DataStorageMB'), 'Data storage mb');
});

/* -------------------------------------------------------------------------- */
/* Lightning page weight                                                       */
/* -------------------------------------------------------------------------- */

/** A page with a tabset: three tabs, each holding two components. */
const tabbedPage = {
  flexiPageRegions: [
    {
      name: 'main',
      type: 'Region',
      itemInstances: [
        { componentInstance: { componentName: 'flexipage:highlightsPanel' } },
        {
          componentInstance: {
            componentName: 'flexipage:tabset',
            componentInstanceProperties: [{ name: 'tabs', value: 'maintabs' }],
          },
        },
      ],
    },
    {
      name: 'maintabs',
      type: 'Facet',
      itemInstances: [
        { componentInstance: { componentName: 'flexipage:tab', componentInstanceProperties: [{ name: 'body', value: 'tab1body' }] } },
        { componentInstance: { componentName: 'flexipage:tab', componentInstanceProperties: [{ name: 'body', value: 'tab2body' }] } },
        { componentInstance: { componentName: 'flexipage:tab', componentInstanceProperties: [{ name: 'body', value: 'tab3body' }] } },
      ],
    },
    { name: 'tab1body', type: 'Facet', itemInstances: [{ componentInstance: { componentName: 'force:relatedListSingle' } }, { componentInstance: { componentName: 'force:detailPanel' } }] },
    { name: 'tab2body', type: 'Facet', itemInstances: [{ componentInstance: { componentName: 'force:relatedListSingle' } }, { componentInstance: { componentName: 'force:relatedListSingle' } }] },
    { name: 'tab3body', type: 'Facet', itemInstances: [{ componentInstance: { componentName: 'force:relatedListSingle' } }, { componentInstance: { componentName: 'force:relatedListSingle' } }] },
  ],
};

test('a tabset defers every tab but the first, and the total still counts them all', () => {
  const { regions, byName } = pageRegions(tabbedPage as never);
  assert.equal(regions.length, 1, 'facets are not regions in their own right');

  // total: highlights + tabset + 3 tab headers + 6 bodies = 11
  assert.equal(countRegionComponents(regions[0]!, byName), 11);
  // eager: highlights + tabset + 3 tab headers + the first tab's 2 = 7
  assert.equal(countEagerComponents(regions[0]!, byName), 7);
});

test('with no deferring container, the eager count equals the total', () => {
  const flat = {
    flexiPageRegions: [
      {
        name: 'main',
        type: 'Region',
        itemInstances: [
          { componentInstance: { componentName: 'flexipage:highlightsPanel' } },
          { componentInstance: { componentName: 'force:detailPanel' } },
          { componentInstance: { componentName: 'force:relatedListSingle' } },
        ],
      },
    ],
  };
  const { regions, byName } = pageRegions(flat as never);
  assert.equal(countRegionComponents(regions[0]!, byName), 3);
  assert.equal(countEagerComponents(regions[0]!, byName), 3);
});

test('page time comes from SumEPT over RecordCountEPT, and from nothing else', () => {
  // The real describe lists histogram bins and a load count that all match a
  // loose /ept/ — the old pattern took the first one it saw.
  const real = [
    { name: 'PageName', type: 'string' },
    { name: 'EptBin1to3', type: 'int' },
    { name: 'RecordCountEPT', type: 'int' },
    { name: 'SumEPT', type: 'double' },
    { name: 'TotalCount', type: 'int' },
  ];
  assert.deepEqual(findDurationFields(real), { page: 'PageName', sum: 'SumEPT', count: 'RecordCountEPT' });
  // Without the pair there is no per-load time, and no rule.
  assert.equal(findDurationFields([{ name: 'PageName', type: 'string' }, { name: 'SumEPT', type: 'double' }]), null);
  assert.equal(findDurationFields([{ name: 'SumEPT', type: 'double' }, { name: 'RecordCountEPT', type: 'int' }]), null);
});

test('page averages are per load, summed across days, and skip rows with no loads', () => {
  // The rows measured in dev2 on 2026-09-09.
  const fields = { page: 'PageName', sum: 'SumEPT', count: 'RecordCountEPT' };
  const rows = [
    { PageName: 'Home', SumEPT: 25331, RecordCountEPT: 5 },
    { PageName: 'Home', SumEPT: 4713, RecordCountEPT: 3 },
    { PageName: 'Home', SumEPT: 5278, RecordCountEPT: 6 },
    { PageName: 'Home', SumEPT: 711, RecordCountEPT: 1 },
    { PageName: 'Report Reports', SumEPT: 7036, RecordCountEPT: 4 },
    { PageName: 'Opportunity markup://force:routingRetryPanel', SumEPT: 0, RecordCountEPT: 0 },
  ];
  const averages = averagePageTimes(rows, fields, 'ms');
  assert.equal(averages.get('home')?.loads, 15);
  assert.equal(Math.round(averages.get('home')!.averageMs), 2402, '36,033 ms over 15 loads');
  assert.equal(Math.round(averages.get('report reports')!.averageMs), 1759);
  assert.equal(averages.has('opportunity markup://force:routingretrypanel'), false, 'a zero-load row is not a timing');
  assert.equal(durationUnitOf('SumEPT'), 'ms', 'the one verified unit');
  assert.equal(durationUnitOf('DurationSum'), null, 'anything else is still unknown');
});

/* -------------------------------------------------------------------------- */
/* Apex source lint — the text analysis, which is where it can go wrong        */
/* -------------------------------------------------------------------------- */

test('comments and string literals are stripped before anything is matched', () => {
  const source = [
    "// SELECT Id FROM Account in a comment is not a query",
    "/* nor [SELECT Id FROM Contact]",
    "   across lines */",
    "String s = 'SELECT Id FROM Lead';",
    "List<Account> a = [SELECT Id FROM Account];",
  ].join('\n');
  const stripped = stripCommentsAndStrings(source);

  assert.equal((stripped.match(/SELECT/g) ?? []).length, 1, 'only the real query survives');
  assert.ok(stripped.includes('[SELECT Id FROM Account]'));
  // Line numbers must survive the strip, or every reported line is wrong.
  assert.equal(stripped.split('\n').length, source.split('\n').length);
});

test('a query or DML anywhere in a loop body is found, however long the body', () => {
  const source = `
    for (Account a : accounts) {
      if (a.Name != null) {
        System.debug(a);
      }
      List<Contact> cs = [SELECT Id FROM Contact WHERE AccountId = :a.Id];
    }
  `;
  assert.equal(loopsWithQueries(stripCommentsAndStrings(source)).length, 1);

  const dml = `for (Integer i = 0; i < 10; i++) { insert new Account(); }`;
  assert.equal(loopsWithQueries(stripCommentsAndStrings(dml)).length, 1);

  // A query before the loop is correct code and must not be reported.
  const fine = `
    List<Contact> cs = [SELECT Id FROM Contact];
    for (Contact c : cs) { c.LastName = 'x'; }
  `;
  assert.deepEqual(loopsWithQueries(stripCommentsAndStrings(fine)), []);
});

test('sharing is detected in every documented form', () => {
  for (const decl of ['with sharing', 'without sharing', 'inherited sharing']) {
    assert.ok(declaresSharing(`public ${decl} class Foo {}`), decl);
  }
  assert.equal(declaresSharing('public class Foo {}'), false);
});

test('an empty catch is reported and a handled one is not', () => {
  assert.equal(emptyCatchLines('try { x(); } catch (Exception e) { }').length, 1);
  assert.equal(emptyCatchLines('try { x(); } catch (Exception e) { log(e); }').length, 0);
});

test('id-shaped literals are matched by shape, and obvious non-ids are not', () => {
  const found = hardcodedIds("String rt = '0125000000ABCDE'; String w = 'abcdefghijklmno';");
  assert.deepEqual(found, ['0125000000ABCDE'], 'a word of the right length is not an id');
  assert.deepEqual(hardcodedIds("String s = 'short';"), []);
});

test('a query is only unbounded when it has neither LIMIT nor WHERE', () => {
  assert.equal(unboundedQueries('[SELECT Id FROM Account]'), 1);
  assert.equal(unboundedQueries('[SELECT Id FROM Account LIMIT 1]'), 0);
  assert.equal(unboundedQueries('[SELECT Id FROM Account WHERE Name = :n]'), 0);
});

/* -------------------------------------------------------------------------- */
/* Field references and Health Check risk bands                                */
/* -------------------------------------------------------------------------- */

test('field references are found wherever the API name appears', () => {
  const refs = referencedFieldNames([
    'SELECT Legacy_Tax_Id__c FROM Account',
    '{"metadata":{"field":"Temp_Margin__c"}}',
    'no fields here',
  ]);
  assert.ok(refs.has('legacy_tax_id__c'));
  assert.ok(refs.has('temp_margin__c'));
  assert.equal(refs.size, 2);
  // Comparison is case-insensitive and object-qualified names reduce to the field.
  assert.equal(fieldKey('Account.Legacy_Tax_Id__c'), 'legacy_tax_id__c');
});

test('an unknown Health Check risk band is treated as medium, never dropped', () => {
  assert.equal(riskRank('HIGH_RISK'), 0);
  assert.equal(riskRank('LOW_RISK'), 2);
  // A band added in a future release must surface, not vanish.
  assert.equal(riskRank('SOMETHING_NEW'), 1);
  assert.equal(riskLabel('MEDIUM_RISK'), 'Medium risk');
  assert.equal(humanSetting('SessionTimeout'), 'Session timeout');
});

/* -------------------------------------------------------------------------- */
/* Estimated savings — the module whose job is to refuse to guess              */
/* -------------------------------------------------------------------------- */

const line = (n: number, slope: number, intercept: number, noise = 0): Point[] =>
  Array.from({ length: n }, (_, i) => ({
    x: i + 5,
    y: intercept + slope * (i + 5) + (i % 2 === 0 ? noise : -noise),
  }));

test('a clean relationship yields the slope, the intercept and a near-perfect fit', () => {
  const fit = fitLinear(line(20, 60, 900));
  assert.ok(fit);
  assert.equal(Math.round(fit!.slopeMs), 60, 'ms per component');
  assert.equal(Math.round(fit!.interceptMs), 900);
  assert.ok(fit!.r2 > 0.99);
  assert.equal(fit!.n, 20);
  assert.ok(isQuotable(fit));
  assert.equal(savedMs(fit, 10), 600);
});

test('too few pages is not a fit, however clean the relationship', () => {
  // The danger this guards: three pages on a straight line look perfect.
  assert.equal(fitLinear(line(MIN_SAMPLE - 1, 60, 900)), null);
  assert.equal(savedMs(fitLinear(line(3, 60, 900)), 10), null);
});

test('a weak relationship is computed but refused for quoting', () => {
  // Page time unrelated to component count: the slope is noise.
  const scattered: Point[] = [
    { x: 5, y: 4000 }, { x: 6, y: 900 }, { x: 7, y: 3200 }, { x: 8, y: 1100 },
    { x: 9, y: 3800 }, { x: 10, y: 950 }, { x: 11, y: 2600 }, { x: 12, y: 1200 },
    { x: 13, y: 3900 }, { x: 14, y: 1000 },
  ];
  const fit = fitLinear(scattered);
  assert.ok(fit, 'a fit is still produced, so the reason can be reported');
  assert.ok(fit!.r2 < MIN_R2);
  assert.equal(isQuotable(fit), false);
  assert.equal(savedMs(fit, 10), null, 'nothing is quoted from a weak fit');
});

test('no saving is stated when more components did not cost more time', () => {
  const flat = Array.from({ length: 12 }, (_, i) => ({ x: i + 5, y: 1200 }));
  assert.equal(savedMs(fitLinear(flat), 10), null);
  // A negative slope is likelier to be an artefact than a discovery.
  const inverted = line(12, -40, 4000);
  assert.equal(savedMs(fitLinear(inverted), 10), null);
});

test('identical component counts across every page produce no fit', () => {
  const same = Array.from({ length: 12 }, () => ({ x: 20, y: 1500 }));
  assert.equal(fitLinear(same), null);
});

test('every saving can state where it came from', () => {
  const fit = fitLinear(line(30, 45, 800))!;
  const text = fitProvenance(fit);
  assert.ok(text.includes('30 pages'), 'the sample size travels with the number');
  assert.ok(/\d+% of the variation/.test(text), 'so does the fit quality');
  assert.ok(text.includes('45 ms per component'));
});

test('a saving becomes hours a year only when the view count is real', () => {
  // 500 ms saved on a page opened 400 times a day, over 250 working days.
  assert.equal(annualHoursSaved(500, 400), 13.9);
  assert.equal(annualHoursSaved(500, 0), null);
  assert.equal(annualHoursSaved(0, 400), null);
});

/* --- Tab reuse and cancel commit (Codex go/no-go, 2026-09-14) ------------- */

import { orgHosts, normalizeApiHost } from '@/shared/hosts';
import { commitScan, cancelScan } from '@/background/scanRunner';

test('the plan page matches every host a tab on the same org can be open at', () => {
  assert.deepEqual(orgHosts('acme.lightning.force.com'), [
    'acme.lightning.force.com',
    'acme.my.salesforce.com',
    'acme.my.salesforce-setup.com',
  ]);
  assert.deepEqual(orgHosts('acme--dev.sandbox.lightning.force.com'), [
    'acme--dev.sandbox.lightning.force.com',
    'acme--dev.sandbox.my.salesforce.com',
    'acme--dev.sandbox.my.salesforce-setup.com',
  ]);
  // Regional and Government Cloud hosts go through the same normalizer the
  // worker uses, so their API-host tab is matched too, not only the literal.
  assert.ok(orgHosts('acme.lightning.eu1.force.com').includes('acme.my.eu1.salesforce.com'));
  assert.ok(orgHosts('acme.lightning.force.mil').includes('acme.my.salesforce.mil'));
  assert.equal(normalizeApiHost('acme.my.salesforce-setup.com'), 'acme.my.salesforce.com');
});

test('a scan that nobody is running cannot be committed', () => {
  // The commit gate is what stops a cancel that lands after the last slice
  // from being followed by a snapshot write: no live job, no write.
  assert.equal(commitScan('00D000000000001', 'apex'), false);
  assert.equal(cancelScan('00D000000000001', 'apex'), false);
});
