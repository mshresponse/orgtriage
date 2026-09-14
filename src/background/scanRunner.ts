/**
 * Scan execution.
 *
 * An MV3 service worker is terminated after five minutes on a single event and
 * after thirty seconds of idle. A full metadata sweep of a large org exceeds
 * both. So a scan is not one long call: it is a job that the panel advances
 * with repeated `scan.run` messages. Each message does up to
 * {@link SLICE_BUDGET_MS} of work and returns, which keeps every event well
 * inside the ceiling and gives the next one a fresh budget.
 *
 * The generator holding a job's position lives in worker memory. If the worker
 * is torn down anyway, the job is simply gone and the next `scan.run` starts
 * over — no partial result is ever written to the cache, so a scan is either
 * complete or absent, never silently half-done.
 */

import type { AnalyzerId, OrgWatermark, ScanProgress, ScanResult } from '@/shared/types';
import type { Analyzer, AnalyzerContext, AnalyzerOutput, Phase } from '@/analyzers/framework';
import { toScanResult } from '@/analyzers/framework';
import { apexAnalyzer } from '@/analyzers/apex';
import { flowsAnalyzer } from '@/analyzers/flows';
import { reportsAnalyzer } from '@/analyzers/reports';
import { layoutsAnalyzer } from '@/analyzers/layouts';
import { opsAnalyzer } from '@/analyzers/ops';
import { accessAnalyzer } from '@/analyzers/access';
import { limitsAnalyzer } from '@/analyzers/limits';
import { securityAnalyzer } from '@/analyzers/security';
import { fieldsAnalyzer } from '@/analyzers/fields';
import { apexLintAnalyzer } from '@/analyzers/apexlint';
import type { SalesforceClient } from './sfClient';

/** Wall-clock a single `scan.run` message may spend before yielding. */
const SLICE_BUDGET_MS = 45_000;

export const ANALYZERS: Record<AnalyzerId, Analyzer> = {
  apex: apexAnalyzer,
  flows: flowsAnalyzer,
  reports: reportsAnalyzer,
  layouts: layoutsAnalyzer,
  ops: opsAnalyzer,
  access: accessAnalyzer,
  limits: limitsAnalyzer,
  security: securityAnalyzer,
  fields: fieldsAnalyzer,
  apexlint: apexLintAnalyzer,
};

export type StepOutcome =
  | { status: 'running'; progress: ScanProgress }
  | { status: 'done'; result: ScanResult };

class ScanJob {
  private readonly generator: AsyncGenerator<Phase, AnalyzerOutput, void>;
  private readonly controller = new AbortController();
  private readonly startedAt = Date.now();
  /** The shared client's counter when this job began; see `toScanResult`. */
  private readonly apiCallsAtStart: number;
  private lastPhase: Phase = { phase: 'Starting', fraction: 0 };
  /** Guards against two `scan.run` messages advancing the same generator at once. */
  private stepping: Promise<StepOutcome> | null = null;

  constructor(
    readonly analyzer: Analyzer,
    private readonly ctx: AnalyzerContext,
  ) {
    this.apiCallsAtStart = ctx.client.apiCalls;
    this.generator = analyzer.run({ ...ctx, signal: this.controller.signal });
  }

  get progress(): ScanProgress {
    return {
      analyzer: this.analyzer.id,
      phase: this.lastPhase.phase,
      fraction: this.lastPhase.fraction,
      apiCalls: Math.max(0, this.ctx.client.apiCalls - this.apiCallsAtStart),
    };
  }

  isCancelled(): boolean {
    return this.controller.signal.aborted;
  }

  cancel(): void {
    this.controller.abort();
  }

  /**
   * Advance the scan for up to one slice.
   *
   * Two panels for the same org can each send `scan.run`; an async generator
   * being advanced from two callers throws. The second caller waits for the
   * slice already in flight and receives its outcome.
   */
  step(): Promise<StepOutcome> {
    if (this.stepping) return this.stepping;
    this.stepping = this.stepOnce().finally(() => {
      this.stepping = null;
    });
    return this.stepping;
  }

  private async stepOnce(): Promise<StepOutcome> {
    const deadline = Date.now() + SLICE_BUDGET_MS;

    do {
      const next = await this.generator.next();
      if (next.done) {
        return {
          status: 'done',
          result: toScanResult(
            this.analyzer.id,
            this.ctx,
            next.value,
            this.startedAt,
            this.apiCallsAtStart,
          ),
        };
      }
      this.lastPhase = next.value;
    } while (Date.now() < deadline);

    return { status: 'running', progress: this.progress };
  }
}

const jobs = new Map<string, ScanJob>();

function jobKey(orgId: string, analyzer: AnalyzerId): string {
  return `${orgId}:${analyzer}`;
}

/**
 * Start or advance a scan. Returns once the slice budget is spent, so callers
 * must keep calling until `status` is `done`.
 */
export async function advanceScan(
  analyzerId: AnalyzerId,
  ctx: AnalyzerContext,
  restart: boolean,
): Promise<StepOutcome> {
  const key = jobKey(ctx.orgId, analyzerId);

  if (restart && jobs.has(key)) {
    jobs.get(key)!.cancel();
    jobs.delete(key);
  }

  let job = jobs.get(key);
  if (!job) {
    const analyzer = ANALYZERS[analyzerId];
    if (!analyzer) throw new Error(`Unknown analyzer: ${analyzerId}`);
    job = new ScanJob(analyzer, ctx);
    jobs.set(key, job);
  }

  try {
    const outcome = await job.step();
    // A cancel that landed while the last slice was running: the generator may
    // have finished anyway, but the user asked for it not to count, and the
    // panel has already stopped listening. Nothing is written.
    if (job.isCancelled()) throw new DOMException('Scan cancelled', 'AbortError');
    // A finished job stays registered until `commitScan` releases it, so a
    // cancel that lands while the caller is still probing the watermark and
    // writing the snapshot has something to cancel.
    return outcome;
  } catch (err) {
    jobs.delete(key);
    throw err;
  }
}

/**
 * Release a finished job and say whether its result may be written. False
 * means a cancel (or a restart) arrived after the last slice returned and
 * before the caller committed, and the result must be discarded.
 */
export function commitScan(orgId: string, analyzer: AnalyzerId): boolean {
  const key = jobKey(orgId, analyzer);
  const job = jobs.get(key);
  jobs.delete(key);
  return job !== undefined && !job.isCancelled();
}

export function cancelScan(orgId: string, analyzer: AnalyzerId): boolean {
  const key = jobKey(orgId, analyzer);
  const job = jobs.get(key);
  if (!job) return false;
  job.cancel();
  jobs.delete(key);
  return true;
}

export function activeScan(orgId: string, analyzer: AnalyzerId): ScanProgress | null {
  return jobs.get(jobKey(orgId, analyzer))?.progress ?? null;
}

/**
 * Cheap probe for "has the org changed since this snapshot was taken".
 *
 * Only the Setup Audit Trail watermark is used. It is one row, it is org-wide,
 * and it moves whenever an admin changes anything in Setup. Note its retention
 * is 180 days, and a user without access simply gets no watermark — in which
 * case the cache falls back to judging staleness by age alone rather than
 * pretending to know.
 */
export async function probeWatermark(client: SalesforceClient): Promise<OrgWatermark | null> {
  try {
    const row = await client.queryOne<{ CreatedDate: string }>(
      'SELECT CreatedDate FROM SetupAuditTrail ORDER BY CreatedDate DESC',
    );
    if (!row?.CreatedDate) return null;
    return { lastSetupChangeAt: row.CreatedDate };
  } catch {
    return null;
  }
}
