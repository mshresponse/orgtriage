/**
 * Run every analyzer against a live org from the command line, and write the
 * remediation plan the skills consume.
 *
 * This exists so the findings are reachable without a browser: from CI, from a
 * terminal, and from an agent that has been asked to fix something. It runs
 * `ANALYZERS` imported from the extension's own scan runner rather than a list
 * maintained here, so the CLI cannot fall behind the panel by omission. A test
 * covers the failure that import cannot prevent: an analyzer declared in the
 * `AnalyzerId` union but never registered, which would typecheck, ship, and
 * simply never run.
 *
 * Read-only, like everything else: the analyzers only issue GETs, never
 * execute a report, and this adds nothing of its own.
 *
 *   npm run scan -- --org <alias> [--out <dir>] [--only apex,flows] [--budget 300]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ANALYZERS } from '@/background/scanRunner';
import { toScanResult, type AnalyzerContext } from '@/analyzers/framework';
import { buildPlan, planToJson, type PlanOrg } from '@/shared/plan';
import type { AnalyzerId, ScanResult } from '@/shared/types';
import { createCliClient, resolveOrg } from './sfClient';

interface Args {
  org: string;
  out: string;
  only: AnalyzerId[] | null;
  budget: number;
  apiVersion?: string;
  quiet: boolean;
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const org = get('--org') ?? process.env.SF_ORG;
  if (!org) {
    throw new Error(
      'An org is required: --org <alias>, or set SF_ORG. `sf org list` shows what is authorised.',
    );
  }

  const only = get('--only');
  const ids = only ? (only.split(',').map((s) => s.trim()) as AnalyzerId[]) : null;
  for (const id of ids ?? []) {
    if (!(id in ANALYZERS)) {
      throw new Error(`Unknown analyzer "${id}". Available: ${Object.keys(ANALYZERS).join(', ')}`);
    }
  }

  return {
    org,
    out: resolve(get('--out') ?? process.env.OUT_DIR ?? './orgtriage-out'),
    only: ids,
    budget: Number(get('--budget') ?? 300),
    apiVersion: get('--api-version'),
    quiet: argv.includes('--quiet'),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const log = (line: string) => {
    // Progress goes to stderr so stdout stays a clean summary an agent or a
    // pipeline can parse without stripping chatter out of it.
    if (!args.quiet) process.stderr.write(`${line}\n`);
  };

  log(`Resolving org "${args.org}"…`);
  const org = resolveOrg(args.org, args.apiVersion);
  log(`  ${org.username} · ${org.orgId} · API v${org.apiVersion}`);

  mkdirSync(resolve(args.out, 'scan'), { recursive: true });

  const client = createCliClient({ org });
  const ctx: AnalyzerContext = {
    client: client as never,
    orgId: org.orgId,
    lightningHost: org.lightningHost,
    includeManaged: false,
    orgNamespace: null,
    detailBudget: args.budget,
    signal: new AbortController().signal,
  };

  const results: ScanResult[] = [];
  const failures: Array<{ id: string; error: string }> = [];

  for (const [id, analyzer] of Object.entries(ANALYZERS)) {
    if (args.only && !args.only.includes(id as AnalyzerId)) continue;

    const started = Date.now();
    const before = client.apiCalls;
    log(`\n=== ${id} ===`);

    try {
      const generator = analyzer.run(ctx);
      let output;
      for (;;) {
        const next = await generator.next();
        if (next.done) {
          output = next.value;
          break;
        }
        log(`  · ${next.value.phase}`);
      }

      const result = toScanResult(id as AnalyzerId, ctx, output, started, before);
      results.push(result);
      writeFileSync(resolve(args.out, 'scan', `${id}.json`), JSON.stringify(result, null, 1));

      const score = result.score;
      const coverage = ((score.ruleCoverage ?? 1) * 100).toFixed(0);
      log(
        `  score=${score.score} grade=${score.grade} examined=${score.examined} ` +
          `coverage=${coverage}% apiCalls=${client.apiCalls - before}`,
      );
      for (const warning of output.warnings ?? []) log(`  ! ${warning}`);
    } catch (error) {
      // One analyzer failing must not cost the others. The plan reports what
      // ran; a missing area is visible as absent rather than as clean.
      const message = (error as Error)?.message ?? String(error);
      failures.push({ id, error: message });
      log(`  FAILED: ${message}`);
    }
  }

  if (results.length === 0) {
    throw new Error('No analyzer completed, so there is nothing to plan from.');
  }

  const planOrg: PlanOrg = {
    orgId: org.orgId,
    orgName: org.alias,
    organizationType: 'Unknown',
    isSandbox: /sandbox|--/i.test(org.instanceUrl),
    instanceName: org.instanceUrl,
    apiVersion: org.apiVersion,
    lightningHost: org.lightningHost,
    userName: org.username,
  };

  const plan = buildPlan(planOrg, results);
  writeFileSync(resolve(args.out, 'plan.json'), planToJson(plan));

  // stdout: the compact answer. Everything else is on stderr or on disk.
  const summary = {
    org: { id: org.orgId, alias: org.alias, user: org.username, apiVersion: org.apiVersion },
    generatedAt: new Date().toISOString(),
    apiCalls: client.apiCalls,
    areas: results.map((r) => ({
      id: r.analyzer,
      score: r.score.score,
      grade: r.score.grade,
      findings: r.findings.length,
      coverage: r.score.ruleCoverage ?? null,
    })),
    stories: plan.stories.length,
    storiesBySeverity: plan.stories.reduce<Record<string, number>>((acc, story) => {
      acc[story.priority] = (acc[story.priority] ?? 0) + 1;
      return acc;
    }, {}),
    notEvaluated: plan.review.length,
    failedAnalyzers: failures,
    files: {
      plan: resolve(args.out, 'plan.json'),
      scans: resolve(args.out, 'scan'),
    },
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);

  log(`\nPlan written to ${resolve(args.out, 'plan.json')} — ${plan.stories.length} stories.`);
  if (failures.length > 0) {
    log(`${failures.length} analyzer(s) failed; those areas are absent from the plan, not clean.`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error)?.message ?? String(error)}\n`);
  process.exit(1);
});
