/**
 * Apex code quality — source-level checks over the org's own Apex.
 *
 * The Apex analyzer measures Apex from the outside: coverage, API version,
 * trigger topology, compile state. This one reads the source and looks for the
 * patterns that cause production incidents. It is the same class of check
 * Salesforce Code Analyzer (PMD) runs in a pipeline, applied to what is
 * actually deployed in the org — which is the version that matters and often
 * is not what is in the repository.
 *
 * **These are heuristics, and every finding says so.** Apex is not parsed here;
 * a real parser is a large dependency and a large surface for being subtly
 * wrong. The checks below are line- and brace-aware text analysis, deliberately
 * biased towards under-reporting: a pattern that cannot be recognised with
 * confidence is not reported at all. A finding is a place worth a developer's
 * eye, not a verdict.
 *
 * Comments and string literals are stripped before matching, because a SOQL
 * query inside a comment is not a SOQL query, and this is exactly the mistake
 * that makes naive source linting untrustworthy.
 */

import type { FindingItem } from '@/shared/types';
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

const MAX_ITEMS = 150;
/** Classes read per scan. Bodies are large, so this bounds both calls and memory. */
const MAX_BODIES = 400;

interface ApexBody {
  Id: string;
  Name: string;
  Body: string | null;
  NamespacePrefix: string | null;
  ApiVersion?: number | null;
  /** Triggers only. */
  TableEnumOrId?: string | null;
}

const RULES = {
  soqlInLoop: {
    id: 'apexlint.soql-in-loop',
    severity: 'critical',
    title: (n) => `${n} Apex ${n === 1 ? 'component appears' : 'components appear'} to query or write inside a loop`,
    rationale:
      'A SOQL query or a DML statement inside a loop consumes one of the transaction’s governor limits per ' +
      'iteration — 100 queries and 150 DML statements. The class works in a unit test with three records and ' +
      'fails in production on the day someone imports two hundred, with an error naming a limit rather than ' +
      'the cause.',
    remediation:
      'Move the query above the loop and collect its results into a Map keyed by id. Collect records to ' +
      'insert or update into a List inside the loop and perform one DML statement after it.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/langCon_apex_loops.htm',
    weight: 24,
  },
  noSharing: {
    id: 'apexlint.sharing-not-declared',
    severity: 'warning',
    title: (n) => `${n} Apex ${n === 1 ? 'class does' : 'classes do'} not declare a sharing mode`,
    rationale:
      'A class without `with sharing`, `without sharing` or `inherited sharing` runs in the sharing mode of ' +
      'whatever called it, and when it is itself the entry point — a trigger, a scheduled or batch job, a REST ' +
      'resource — that is system context: every record, ignoring the sharing rules the org was configured ' +
      'with. Some entry points apply their own default, so treat each one as a place to check rather than a ' +
      'proven leak; and note that sharing mode governs records only — it never enforces object or field ' +
      'permissions. The omission is almost always an oversight rather than a decision, and it is invisible ' +
      'until someone sees data they should not.',
    remediation:
      'Add `with sharing` to classes that act for a user, `inherited sharing` to utility classes called from ' +
      'both contexts, and `without sharing` only where system access is deliberate — with a comment saying why.',
    docUrl:
      'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_classes_keywords_sharing.htm',
    weight: 14,
  },
  emptyCatch: {
    id: 'apexlint.empty-catch',
    severity: 'warning',
    title: (n) => `${n} Apex ${n === 1 ? 'component swallows' : 'components swallow'} an exception without handling it`,
    rationale:
      'PMD’s Empty Catch Block rule: an exception is caught but nothing is done, which swallows a failure ' +
      'that should be acted on or reported. An empty catch block turns a failure into silence. The transaction continues as though the work ' +
      'succeeded, the records are not written, and nobody finds out until the numbers disagree weeks later. ' +
      'This is the single most expensive pattern to debug because there is no evidence it happened.',
    remediation:
      'At minimum log the exception. Better, let it propagate, or handle it explicitly and record the failure ' +
      'somewhere a person will see — a custom log object, an error email, a platform event.',
    docUrl: 'https://docs.pmd-code.org/latest/pmd_rules_apex_errorprone.html#emptycatchblock',
    weight: 12,
  },
  hardcodedId: {
    id: 'apexlint.hardcoded-id',
    severity: 'warning',
    title: (n) => `${n} Apex ${n === 1 ? 'component appears' : 'components appear'} to contain a hard-coded Salesforce id`,
    rationale:
      'A 15- or 18-character id written into code is valid in exactly one org. It survives the sandbox, it ' +
      'survives the deployment, and it fails in production or after a refresh — pointing at a record type, ' +
      'profile or queue that does not exist there. This check matches the shape of an id and cannot tell a ' +
      'real one from a coincidence, so treat each as a place to look.',
    remediation:
      'Replace with a query by developer name, a Custom Metadata Type record, or a Custom Setting — anything ' +
      'that resolves at run time in the org the code is running in.',
    docUrl: 'https://help.salesforce.com/s/articleView?id=platform.flow_prep_bestpractices.htm&type=5',
    weight: 10,
  },
  unboundedQuery: {
    id: 'apexlint.query-without-limit',
    severity: 'info',
    title: (n) => `${n} Apex ${n === 1 ? 'component runs' : 'components run'} a SOQL query with no LIMIT and no bound`,
    rationale:
      'A query with no LIMIT and no selective WHERE returns whatever the object holds, up to the 50,000 rows ' +
      'a transaction may retrieve through SOQL — and those rows still have to fit in the heap, 6 MB ' +
      'synchronously, which a wide object reaches long before the row ceiling. It works until the object ' +
      'grows. This is the lowest-confidence check here — a query bounded by a well-chosen WHERE is fine ' +
      'without a LIMIT — so it is informational.',
    remediation:
      'Add a LIMIT where a bound is sensible, or move the work to a Batch Apex class where the query is a ' +
      'QueryLocator and the platform chunks it.',
    docUrl: 'https://developer.salesforce.com/docs/atlas.en-us.apexcode.meta/apexcode/apex_gov_limits.htm',
    weight: 4,
  },
} satisfies Record<string, RuleSpec>;

export const APEXLINT_RULE_IDS: string[] = Object.values(RULES).map((r) => r.id);

/**
 * Remove comments and string literals from Apex source.
 *
 * Everything downstream depends on this: a `SELECT` inside a comment is not a
 * query, an id-shaped value inside a test's mock data is not a hard-coded id,
 * and a linter that reports either is one people learn to ignore. Written as a
 * single pass rather than a chain of regexes so that a `//` inside a string and
 * a quote inside a comment both come out right.
 */
export function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }
    if (two === '/*') {
      i += 2;
      while (i < n && source.slice(i, i + 2) !== '*/') {
        // Newlines are kept so that line numbers survive the strip.
        if (source[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (source[i] === "'") {
      out += "''"; // a placeholder, so `x = ''` still parses as an assignment
      i++;
      while (i < n && source[i] !== "'") {
        if (source[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

const LOOP_START = /\b(for|while)\s*\(/g;
const QUERY_OR_DML = /(\[\s*SELECT\b)|(\b(?:insert|update|delete|upsert|undelete)\s+[A-Za-z_])/i;

/**
 * Find loops whose body contains a query or a DML statement.
 *
 * Brace matching from the loop header rather than a line-window heuristic: a
 * loop body spanning forty lines with the DML at the bottom is the common case,
 * and a fixed window either misses it or produces false hits on the next
 * method. Returns the 1-based line of each offending loop.
 */
export function loopsWithQueries(stripped: string): number[] {
  const hits: number[] = [];
  LOOP_START.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOOP_START.exec(stripped)) !== null) {
    const open = stripped.indexOf('{', match.index);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (; end < stripped.length; end++) {
      if (stripped[end] === '{') depth++;
      else if (stripped[end] === '}' && --depth === 0) break;
    }
    const body = stripped.slice(open, end);
    if (QUERY_OR_DML.test(body)) {
      hits.push(stripped.slice(0, match.index).split('\n').length);
    }
  }
  return hits;
}

/** True when the class declaration carries no sharing keyword. */
export function declaresSharing(stripped: string): boolean {
  return /\b(with|without|inherited)\s+sharing\b/i.test(stripped);
}

/** Lines holding a `catch (...) { }` with nothing but whitespace inside. */
export function emptyCatchLines(stripped: string): number[] {
  const hits: number[] = [];
  const re = /catch\s*\([^)]*\)\s*\{\s*\}/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    hits.push(stripped.slice(0, match.index).split('\n').length);
  }
  return hits;
}

/**
 * Id-shaped literals.
 *
 * Salesforce ids are 15 or 18 characters of `[a-zA-Z0-9]`, and the first three
 * are a key prefix. Requiring the whole token to be exactly that length and to
 * start with three alphanumerics keeps most ordinary words out; a `Set<String>`
 * of eighteen-character constants will still match, which is why the rule says
 * it cannot tell a real id from a coincidence.
 */
export function hardcodedIds(source: string): string[] {
  const found = new Set<string>();
  const re = /'([a-zA-Z0-9]{15}|[a-zA-Z0-9]{18})'/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    const value = match[1]!;
    // An id always contains at least one digit and at least one letter; a
    // fifteen-letter word does not.
    if (!/\d/.test(value) || !/[a-zA-Z]/.test(value)) continue;
    found.add(value);
  }
  return [...found];
}

/** Queries with neither a LIMIT nor a WHERE. */
export function unboundedQueries(stripped: string): number {
  let count = 0;
  const re = /\[\s*SELECT\b([\s\S]*?)\]/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const body = match[1] ?? '';
    if (!/\bLIMIT\b/i.test(body) && !/\bWHERE\b/i.test(body)) count++;
  }
  return count;
}

export const apexLintAnalyzer: Analyzer = {
  id: 'apexlint',
  label: 'Code quality',

  async *run(ctx: AnalyzerContext): AsyncGenerator<Phase, AnalyzerOutput, void> {
    const warnings: string[] = [];
    const outcomes: RuleOutcome[] = [];
    const skip = (reason: string) => warnings.push(reason);
    let truncated: AnalyzerOutput['truncated'];

    checkCancelled(ctx);
    yield { phase: 'Reading Apex source', fraction: 0.3 };

    // An org's own namespace (a packaging org, or a customer on namespaced 2GP)
    // is local code, not a foreign package: keep it in scope alongside null.
    // The value comes from Organization.NamespacePrefix, never from a message,
    // and a namespace is 1–15 alphanumerics starting with a letter; anything
    // else is not interpolated.
    const ownNamespace = ctx.orgNamespace && /^[A-Za-z][A-Za-z0-9_]{0,14}$/.test(ctx.orgNamespace) ? ctx.orgNamespace : null;
    const managedFilter = ctx.includeManaged
      ? ''
      : ownNamespace
        ? ` WHERE (NamespacePrefix = null OR NamespacePrefix = '${ownNamespace}')`
        : ' WHERE NamespacePrefix = null';
    const classes = await tryQuery(
      () =>
        ctx.client.query<ApexBody>(
          `SELECT Id, Name, Body, NamespacePrefix, ApiVersion FROM ApexClass${managedFilter}`,
          { tooling: true, maxRecords: MAX_BODIES },
        ),
      skip,
      'Apex class source',
    );
    const triggers = await tryQuery(
      () =>
        ctx.client.query<ApexBody>(
          `SELECT Id, Name, Body, NamespacePrefix, TableEnumOrId FROM ApexTrigger${managedFilter}`,
          { tooling: true, maxRecords: MAX_BODIES },
        ),
      skip,
      'Apex trigger source',
    );

    if (!classes && !triggers) {
      for (const rule of Object.values(RULES)) {
        outcomes.push(
          inconclusive('apexlint', rule, 'Apex source could not be read; this needs the Author Apex permission.'),
        );
      }
      const summary = summarise(RULES, outcomes);
      return {
        metrics: { 'Components read': { value: '—' } },
        findings: summary.findings,
        coverage: summary.coverage,
        warnings,
        examined: 1,
      };
    }

    if (classes?.truncated || triggers?.truncated) {
      truncated = {
        reason: `Source was read for the first ${MAX_BODIES} classes and ${MAX_BODIES} triggers.`,
        examined: (classes?.records.length ?? 0) + (triggers?.records.length ?? 0),
        total: (classes?.totalSize ?? 0) + (triggers?.totalSize ?? 0),
      };
    }

    checkCancelled(ctx);
    yield { phase: 'Analysing source', fraction: 0.75 };

    const soqlLoops: FindingItem[] = [];
    const noSharing: FindingItem[] = [];
    const emptyCatches: FindingItem[] = [];
    const ids: FindingItem[] = [];
    const unbounded: FindingItem[] = [];
    let linesRead = 0;
    // Bodies the API returned as "(hidden)" (managed or protected) or empty.
    // They are not code and are never inspected, so they must not count as
    // read: one hidden class and no triggers used to grade a clean A.
    let hidden = 0;
    let readable = 0;

    const inspect = (row: ApexBody, kind: 'class' | 'trigger') => {
      const source = row.Body ?? '';
      // A hidden or packaged body comes back as this sentinel rather than code.
      if (!source || source.trim() === '(hidden)') {
        hidden += 1;
        return;
      }
      readable += 1;
      linesRead += source.split('\n').length;
      const stripped = stripCommentsAndStrings(source);
      const link = setupUrl(
        ctx.lightningHost,
        kind === 'class' ? `ApexClasses/page?address=%2F${row.Id}` : `ApexTriggers/page?address=%2F${row.Id}`,
      );

      const loops = loopsWithQueries(stripped);
      if (loops.length > 0) {
        soqlLoops.push({
          id: row.Id,
          name: row.Name,
          label: kind,
          setupUrl: link,
          evidence: { 'Loops affected': loops.length, 'First at line': loops[0] ?? null, Type: kind },
        });
      }

      // Triggers have no sharing declaration to make; the rule is class-only.
      if (kind === 'class' && !declaresSharing(stripped)) {
        noSharing.push({
          id: row.Id,
          name: row.Name,
          setupUrl: link,
          evidence: { 'API version': row.ApiVersion ?? null, Declaration: 'none' },
        });
      }

      const catches = emptyCatchLines(stripped);
      if (catches.length > 0) {
        emptyCatches.push({
          id: row.Id,
          name: row.Name,
          label: kind,
          setupUrl: link,
          evidence: { 'Empty catch blocks': catches.length, 'First at line': catches[0] ?? null },
        });
      }

      const literals = hardcodedIds(source);
      if (literals.length > 0) {
        ids.push({
          id: row.Id,
          name: row.Name,
          label: kind,
          setupUrl: link,
          evidence: {
            'Id-shaped literals': literals.length,
            Examples: literals.slice(0, 3).join(', '),
          },
        });
      }

      const loose = unboundedQueries(stripped);
      if (loose > 0) {
        unbounded.push({
          id: row.Id,
          name: row.Name,
          label: kind,
          setupUrl: link,
          evidence: { 'Queries with no LIMIT or WHERE': loose },
        });
      }
    };

    for (const row of classes?.records ?? []) inspect(row, 'class');
    for (const row of triggers?.records ?? []) inspect(row, 'trigger');

    const push = (rule: RuleSpec, items: FindingItem[]) =>
      outcomes.push(
        finding(
          'apexlint',
          rule,
          capped(items, MAX_ITEMS, (dropped) => warnings.push(`${dropped} further ${rule.id} matches are not listed.`)),
        ),
      );

    push(RULES.soqlInLoop, soqlLoops);
    push(RULES.noSharing, noSharing);
    push(RULES.emptyCatch, emptyCatches);
    push(RULES.hardcodedId, ids);
    push(RULES.unboundedQuery, unbounded);

    // One family read and one not: what was found stands, but a rule that
    // found nothing has only half its evidence, and half is not a clean bill.
    if (!classes || !triggers) {
      const missing = !classes ? 'Apex classes' : 'Apex triggers';
      warnings.push(`${missing} could not be read; findings below cover the other family only.`);
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        if (outcome && !isFinding(outcome)) {
          const rule = Object.values(RULES).find((r) => r.id === outcome.cleanRuleId);
          // The sharing rule is class-only, so missing triggers do not weaken it.
          if (rule && !(rule === RULES.noSharing && classes)) {
            outcomes[i] = inconclusive('apexlint', rule, `${missing} could not be read, so this rule saw only part of the org's source.`);
          }
        }
      }
    }

    // Any hidden body withholds the clean verdicts: a rule that found nothing
    // in the readable code has no verdict on the code it never saw, and a
    // finding that vanished because its body became unreadable is not a fix.
    // Findings stand; only "nothing found" is downgraded. Hidden bodies are
    // rare with managed packages excluded, so this bites mainly when they are
    // included, where it is the honest answer.
    if (hidden > 0) {
      const reason =
        readable === 0
          ? `All ${hidden} Apex ${hidden === 1 ? 'body' : 'bodies'} came back hidden (managed or protected source), so no code was inspected.`
          : `${hidden} of ${hidden + readable} Apex bodies came back hidden (managed or protected source); a clean verdict would cover code the scan never saw.`;
      for (let i = 0; i < outcomes.length; i++) {
        const outcome = outcomes[i];
        if (outcome && !isFinding(outcome)) {
          const rule = Object.values(RULES).find((r) => r.id === outcome.cleanRuleId);
          if (rule) outcomes[i] = inconclusive('apexlint', rule, reason);
        }
      }
      if (readable > 0) {
        warnings.push(
          `${hidden} of ${hidden + readable} Apex bodies came back hidden (managed or protected source) and ${hidden === 1 ? 'was' : 'were'} not inspected; the findings cover the ${readable} readable ${readable === 1 ? 'one' : 'ones'}, and rules that found nothing are held as inconclusive.`,
        );
      }
    }

    warnings.push(
      'These checks read the source as text rather than parsing Apex, and are biased towards under-reporting. Each finding is a place worth a developer’s eye, not a verdict — Salesforce Code Analyzer in a pipeline is the tool for a definitive answer.',
    );

    const summary = summarise(RULES, outcomes);
    // What was actually inspected, not what the query returned.
    const examined = readable;

    return {
      metrics: {
        'Components read': { value: examined, sub: hidden > 0 ? `${hidden} hidden, not inspected` : undefined },
        'Lines analysed': { value: linesRead.toLocaleString() },
        'Query or DML in a loop': { value: soqlLoops.length },
        'No sharing declared': { value: noSharing.length },
        'Silently swallowed errors': { value: emptyCatches.length },
      },
      findings: summary.findings,
      coverage: summary.coverage,
      warnings,
      examined: Math.max(1, examined),
      truncated,
    };
  },
};
