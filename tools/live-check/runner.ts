/**
 * Drive the real analyzers against a live org, outside the extension.
 *
 * Substitutes a `SalesforceClient`-shaped object that shells out to the
 * Salesforce CLI, so no access token is ever handled here. Everything below
 * `client` is the shipping code.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { apexAnalyzer } from '@/analyzers/apex';
import { flowsAnalyzer } from '@/analyzers/flows';
import { reportsAnalyzer } from '@/analyzers/reports';
import { layoutsAnalyzer } from '@/analyzers/layouts';
import { toScanResult, type AnalyzerContext } from '@/analyzers/framework';

const ORG = 'nzc';
const V = 'v67.0';
const OUT = process.env.OUT_DIR!;
mkdirSync(OUT, { recursive: true });

let apiCalls = 0;
const captured: Record<string, unknown> = {};

function rest(path: string, method = 'GET', body?: unknown): any {
  apiCalls++;
  const args = ['api', 'request', 'rest', path, '-o', ORG];
  if (method !== 'GET') args.push('-X', method, '-H', 'Content-Type:application/json', '-b', '-');
  const out = execFileSync('sf', args, {
    input: method === 'GET' ? undefined : JSON.stringify(body),
    maxBuffer: 256 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'ignore'],
  });
  return JSON.parse(out);
}

class Err extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly hint?: string) {
    super(message); this.name = 'SalesforceError';
  }
  get retryable() { return false; }
}

const client = {
  apiVersion: '67.0',
  get apiCalls() { return apiCalls; },
  budget: { max: null, remaining: null, usedByOrgTriage: 0, observedAt: null },
  async query(soql: string, opts: any = {}) {
    const seg = opts.tooling ? '/tooling' : '';
    let path = `/services/data/${V}${seg}/query/?q=${encodeURIComponent(soql)}`;
    const records: any[] = [];
    let totalSize = 0, truncated = false;
    for (;;) {
      const page = rest(path);
      if (Array.isArray(page)) throw new Err(page[0]?.errorCode ?? 'ERR', page[0]?.message ?? 'query failed', 400);
      totalSize = page.totalSize ?? records.length;
      records.push(...(page.records ?? []));
      if (opts.maxRecords && records.length >= opts.maxRecords) {
        truncated = !page.done || records.length > opts.maxRecords;
        records.length = opts.maxRecords; break;
      }
      if (page.done || !page.nextRecordsUrl) break;
      path = page.nextRecordsUrl;
    }
    return { records, totalSize, truncated };
  },
  async queryOne(soql: string, opts: any = {}) {
    const { records } = await (client as any).query(soql, { ...opts, maxRecords: 1 });
    return records[0] ?? null;
  },
  async get(resource: string, opts: any = {}) {
    const seg = opts.tooling ? '/tooling' : '';
    const body = rest(`/services/data/${V}${seg}${resource}`);
    // A Salesforce error is an array of {errorCode,message}; so is a legitimate
    // collection resource like /analytics/report-types. Distinguish by shape.
    if (Array.isArray(body) && body[0] && typeof body[0].errorCode === 'string') {
      throw new Err(body[0].errorCode, body[0].message ?? 'get failed', 404);
    }
    return body;
  },
  async composite(subrequests: any[], opts: any = {}) {
    const seg = opts.tooling ? '/tooling' : '';
    const size = Math.max(1, Math.min(opts.chunkSize ?? 25, 25));
    const responses = new Map<string, any>();
    let chunks = 0, failedChunks = 0; let error: Error | undefined;
    for (let i = 0; i < subrequests.length; i += size) {
      chunks++;
      try {
        const payload = rest(`/services/data/${V}${seg}/composite`, 'POST',
          { allOrNone: false, compositeRequest: subrequests.slice(i, i + size) });
        for (const sub of payload.compositeResponse ?? []) responses.set(sub.referenceId, sub);
      } catch (e: any) { failedChunks++; error ??= e; }
    }
    return { responses, chunks, failedChunks, error };
  },
  async retrieveMany(objectType: string, ids: string[], opts: any = {}) {
    const seg = opts.tooling ? '/tooling' : '';
    const subs = ids.map((id, i) => ({ method: 'GET', url: `/services/data/${V}${seg}/sobjects/${objectType}/${id}`, referenceId: `r${i}` }));
    const outcome = await (client as any).composite(subs, opts);
    const records = new Map<string, any>();
    outcome.responses.forEach((sub: any, ref: string) => {
      const id = ids[Number(ref.slice(1))];
      if (id && sub.httpStatusCode >= 200 && sub.httpStatusCode < 300) records.set(id, sub.body);
    });
    return { records, chunks: outcome.chunks, failedChunks: outcome.failedChunks, error: outcome.error };
  },
  async getLimits() { return (client as any).get('/limits/'); },
};

const ctx: AnalyzerContext = {
  client: client as any,
  orgId: '00Diw000000vCKbEAM',
  lightningHost: 'everythingvirtuallyllc.lightning.force.com',
  includeManaged: false,
  orgNamespace: null,
  detailBudget: 300,
  signal: new AbortController().signal,
};

const ANALYZERS = { apex: apexAnalyzer, flows: flowsAnalyzer, reports: reportsAnalyzer, layouts: layoutsAnalyzer };
const only = process.argv[2] as keyof typeof ANALYZERS | undefined;

for (const [id, analyzer] of Object.entries(ANALYZERS)) {
  if (only && id !== only) continue;
  const started = Date.now();
  apiCalls = 0;
  process.stderr.write(`\n=== ${id} ===\n`);
  try {
    const gen = analyzer.run(ctx);
    let out: any;
    for (;;) {
      const next = await gen.next();
      if (next.done) { out = next.value; break; }
      process.stderr.write(`  · ${next.value.phase}\n`);
    }
    const result = toScanResult(id as any, ctx, out, started);
    writeFileSync(`${OUT}/${id}.json`, JSON.stringify(result, null, 1));
    const s = result.score;
    process.stderr.write(`  score=${s.score} grade=${s.grade} examined=${s.examined} coverage=${((s.ruleCoverage ?? 1) * 100).toFixed(0)}% apiCalls=${result.apiCalls}\n`);
  } catch (e: any) {
    process.stderr.write(`  FAILED: ${e?.message ?? e}\n${e?.stack ?? ''}\n`);
  }
}
