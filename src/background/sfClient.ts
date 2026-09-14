/**
 * Salesforce API client for the service worker.
 *
 * What this layer is responsible for, beyond "call fetch":
 *
 *  - **Budget honesty.** Every REST response carries `Sforce-Limit-Info`, which
 *    is free and real-time. The client parses it on every call so the UI can
 *    show what the org has left without spending a `/limits/` request to find
 *    out. Each scan reports what it consumed.
 *  - **Throttle handling.** Salesforce signals throttling with HTTP 403 and
 *    `errorCode: REQUEST_LIMIT_EXCEEDED` — never 429, and with no `Retry-After`.
 *    403 also means `INSUFFICIENT_ACCESS`, so the body must be parsed to tell a
 *    permission problem from a rate problem.
 *  - **Batching.** `/composite` bundles 25 subrequests (max 5 of them queries)
 *    and counts as *one* API call. Several unavoidable N+1 patterns — flow
 *    metadata, FlexiPage metadata, report describes — collapse 25× through it.
 *    `/composite/batch` is deliberately never used: there, each subrequest
 *    counts separately, so it buys latency but no budget.
 *  - **Worker lifetime.** MV3 gives a `fetch()` 30 seconds to produce a
 *    response, so requests are aborted at 25s with a clear error rather than
 *    being killed anonymously with the worker.
 */

import { AuthError, invalidateSession, redact, signedFetch, type OrgHost } from './auth';
import type { ApiBudget } from '@/shared/types';

/** Version used when discovery fails. One release behind the current platform
 *  release, which is what an org that has not yet been upgraded will serve. */
export const FALLBACK_API_VERSION = '66.0';

/** Oldest version worth attempting. 21.0–30.0 are retired and return 410. */
export const MIN_API_VERSION = 41;

/** In-flight request ceiling. Developer Edition and trial orgs allow only 5
 *  concurrent long-running requests (production allows 25), and a scan tuned
 *  for production trips limits immediately in the DE org used to demo it. */
const MAX_CONCURRENCY = 4;

const REQUEST_TIMEOUT_MS = 25_000;

export interface SfError {
  message: string;
  errorCode: string;
  fields?: string[];
}

export class SalesforceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'SalesforceError';
  }

  /** True when retrying could plausibly succeed. */
  get retryable(): boolean {
    return this.status >= 500 || this.status === 0 || this.code === 'REQUEST_LIMIT_EXCEEDED';
  }
}

interface QueryResponse<T> {
  totalSize: number;
  done: boolean;
  nextRecordsUrl?: string;
  records: T[];
}

export interface CompositeSubrequest {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  url: string;
  referenceId: string;
  body?: unknown;
}

export interface CompositeSubresponse<T = unknown> {
  body: T;
  httpStatusCode: number;
  referenceId: string;
}

/**
 * What a multi-chunk composite actually achieved.
 *
 * A composite of 300 subrequests is 12 API calls, and one of them timing out
 * used to discard the other eleven. Callers get the successful subresponses
 * plus an honest count of what was lost, which is what lets an analyzer say
 * "inconclusive" instead of silently reporting a clean bill of health.
 */
export interface CompositeOutcome<T = unknown> {
  responses: Map<string, CompositeSubresponse<T>>;
  /** Chunks attempted. */
  chunks: number;
  /** Chunks that threw. `chunks - failedChunks` is what the results cover. */
  failedChunks: number;
  /** First failure, for the message an inconclusive finding carries. */
  error?: Error;
}

/**
 * Simple counting semaphore — keeps concurrent fetches under the org's ceiling.
 *
 * Two properties matter here and both were once wrong:
 *
 *  - A woken waiter **re-checks** the limit rather than assuming a slot is free.
 *    `tighten()` can lower the ceiling below `active` while waiters are parked,
 *    and a waiter that trusted the wake-up would push concurrency back over the
 *    limit that had just been lowered to protect the org.
 *  - Nothing ever holds a slot across a sleep. The retry loop in `request()`
 *    releases before backing off and re-acquires afterwards; a retry issued
 *    while holding its parent's slot deadlocks as soon as `tighten()` drops the
 *    ceiling to the number of requests already waiting on their own retries.
 */
class Semaphore {
  private active = 0;
  private queue: (() => void)[] = [];

  constructor(private limit: number) {}

  async acquire(): Promise<() => void> {
    while (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.wake();
    };
  }

  /** Narrow the ceiling after a throttle; never widens on its own. */
  tighten(): void {
    this.limit = Math.max(1, this.limit - 1);
  }

  /** One release frees one slot, so it wakes one waiter. The waiter re-checks
   *  the ceiling on resume; if a fresh acquirer took the slot first it parks
   *  again, and that acquirer's own release wakes it. */
  private wake(): void {
    if (this.active < this.limit) this.queue.shift()?.();
  }
}

export class SalesforceClient {
  readonly host: OrgHost;
  private version: string = FALLBACK_API_VERSION;
  private semaphore = new Semaphore(MAX_CONCURRENCY);

  /** API calls this client has made, as Salesforce counts them. */
  apiCalls = 0;
  /**
   * Calls made against this org earlier today by previous worker lifetimes.
   * Chrome discards the worker after about thirty seconds idle, and a count
   * that restarted at zero each time read as if the panel had spent nothing.
   * The owner of the client loads this from storage and persists the total
   * through {@link onCall}.
   */
  apiCallsBefore = 0;
  onCall: ((totalToday: number) => void) | null = null;
  /** Latest values parsed from `Sforce-Limit-Info`. */
  budget: ApiBudget = { max: null, remaining: null, usedByOrgTriage: 0, observedAt: null };
  /** Called with each fresh header reading, so the worker can remember it across restarts. */
  onBudget?: (budget: ApiBudget) => void;
  /** Set once the org has told us we are out of budget; stops further scanning. */
  budgetExhausted = false;

  constructor(host: OrgHost) {
    this.host = host;
  }

  get apiVersion(): string {
    return this.version;
  }

  /** `v67.0`-style path prefix. */
  private get base(): string {
    return `/services/data/v${this.version}`;
  }

  /* ---------------------------------------------------------------------- */
  /* Version discovery                                                       */
  /* ---------------------------------------------------------------------- */

  /**
   * Settle on a reachable API host and learn which versions it serves.
   *
   * `GET /services/data/` needs no authentication and costs no API call, which
   * makes it the ideal probe: it proves the host resolves and answers before
   * anything expensive or credentialed is attempted. Candidates are tried in
   * order because a host derived from a cookie's `domain` can look perfectly
   * valid and still not exist — a session scoped to a parent domain yields
   * something like `.develop.my.salesforce.com`, which fails DNS.
   *
   * Reading the org's own version list also beats pinning a constant: a pinned
   * version newer than the org's release 404s, and one too old eventually hits
   * the retirement cliff (410 GONE).
   */
  async resolveHost(): Promise<void> {
    const candidates = this.host.candidates.length > 0 ? this.host.candidates : [this.host.apiHost];
    const failures: string[] = [];

    for (const candidate of candidates) {
      this.host.apiHost = candidate;
      try {
        const response = await this.request('GET', '/services/data/', undefined, {
          countsAsCall: false,
        });
        const versions = (await response.json()) as { version: string; label: string }[];
        const newest = versions
          .map((v) => Number.parseFloat(v.version))
          .filter((n) => Number.isFinite(n) && n >= MIN_API_VERSION)
          .sort((a, b) => b - a)[0];
        if (newest) this.version = newest.toFixed(1);
        return;
      } catch (err) {
        failures.push(`${candidate} (${err instanceof Error ? err.message : 'failed'})`);
      }
    }

    this.host.apiHost = candidates[0]!;
    throw new SalesforceError(
      'NO_REACHABLE_HOST',
      `None of this org's API hosts answered: ${failures.join('; ')}`,
      0,
      'Check that you are signed in to the org in this tab and that no proxy or network policy blocks it.',
    );
  }

  /** @deprecated Use {@link resolveHost}, which also picks the host. */
  async discoverApiVersion(): Promise<string> {
    await this.resolveHost();
    return this.version;
  }

  /** Override the negotiated version (options screen). */
  setApiVersion(version: string): void {
    const parsed = Number.parseFloat(version);
    if (Number.isFinite(parsed) && parsed >= MIN_API_VERSION) this.version = parsed.toFixed(1);
  }

  /* ---------------------------------------------------------------------- */
  /* Core request                                                            */
  /* ---------------------------------------------------------------------- */

  /**
   * One request, with retries.
   *
   * The retry loop lives **here**, outside the semaphore, and not inside the
   * error handler. `handleErrorResponse` used to call `this.request()`
   * recursively while the parent still held its slot; combined with
   * `tighten()`, four concurrent throttled requests would drop the ceiling to
   * one and then wait forever on slots their own parents were holding. Now the
   * slot is acquired per attempt, released before the backoff sleep, and
   * re-acquired for the next attempt.
   */
  private async request(
    method: string,
    path: string,
    body?: unknown,
    opts: { countsAsCall?: boolean } = {},
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      if (this.budgetExhausted) {
        throw new SalesforceError(
          'BUDGET_EXHAUSTED',
          'Stopped: this org has no daily API requests left.',
          403,
          'Wait for the org\u2019s 24-hour API window to roll over, then refresh.',
        );
      }

      const outcome = await this.attempt(method, path, body, opts, attempt);
      if (outcome.response) return outcome.response;

      // Sleep with no slot held. This is the whole point of the restructure.
      if (outcome.delayMs > 0) await delay(outcome.delayMs);
    }
  }

  /** A single attempt, holding exactly one semaphore slot for its duration. */
  private async attempt(
    method: string,
    path: string,
    body: unknown,
    opts: { countsAsCall?: boolean },
    attempt: number,
  ): Promise<{ response: Response | null; delayMs: number }> {
    const release = await this.semaphore.acquire();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await signedFetch(this.host, path, {
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      if (opts.countsAsCall !== false) {
        this.apiCalls++;
        this.onCall?.(this.apiCallsBefore + this.apiCalls);
      }
      this.readLimitHeader(response);

      // `redirect: 'manual'` surfaces a redirect as an opaque response rather
      // than throwing. Salesforce redirects an API call when the session is not
      // valid for this host, which is a very different problem from the network
      // being down — and the two used to be reported identically.
      if (response.type === 'opaqueredirect') {
        throw new SalesforceError(
          'REDIRECTED',
          `${this.host.apiHost} redirected the request instead of answering it.`,
          0,
          'The session is probably not valid for this host. Reload the Salesforce tab and try again.',
        );
      }

      if (response.ok) return { response, delayMs: 0 };
      // Throws unless a retry is warranted, in which case it returns the backoff.
      return { response: null, delayMs: await this.handleErrorResponse(response, attempt) };
    } catch (err) {
      if (err instanceof SalesforceError || err instanceof AuthError) throw err;
      if (controller.signal.aborted) {
        throw new SalesforceError(
          'TIMEOUT',
          `${this.host.apiHost} did not respond within 25 seconds.`,
          0,
          'The org may be under load. Try a narrower scan or retry shortly.',
        );
      }
      // Name the host and the resource. A bare "could not reach Salesforce" is
      // undebuggable, and the host is exactly the thing most likely to be wrong.
      throw new SalesforceError(
        'NETWORK',
        `Could not reach https://${this.host.apiHost}${path.split('?')[0]} — ${
          err instanceof Error ? redact(err.message) : 'the request failed'
        }.`,
        0,
        'Check that you are signed in to this org and that no network policy blocks it.',
      );
    } finally {
      clearTimeout(timer);
      release();
    }
  }

  /**
   * Decide what a non-2xx response means. Returns the milliseconds to wait
   * before the caller retries; throws when the request is not retryable.
   */
  private async handleErrorResponse(response: Response, attempt: number): Promise<number> {
    const errors = await this.parseErrors(response);
    const first = errors[0];
    const code = first?.errorCode ?? `HTTP_${response.status}`;
    const message = first?.message ?? response.statusText;

    // A stale session: drop the cached cookie value and try once more.
    if (response.status === 401 && attempt === 0) {
      invalidateSession(this.host.apiHost, this.host.cookieStoreId);
      return 0;
    }

    if (response.status === 403 && code === 'REQUEST_LIMIT_EXCEEDED') {
      // One code, two very different causes. The usage header disambiguates:
      // close to the ceiling means the daily allocation is gone and retrying
      // just burns more; well under means too many concurrent long requests.
      const nearLimit =
        this.budget.max !== null &&
        this.budget.remaining !== null &&
        this.budget.remaining <= this.budget.max * 0.02;

      if (nearLimit) {
        this.budgetExhausted = true;
        throw new SalesforceError(
          'BUDGET_EXHAUSTED',
          'This org has used its daily API request allocation.',
          403,
          'OrgTriage stopped so it does not consume more. Cached snapshots are still available.',
        );
      }

      if (attempt < 3) {
        this.semaphore.tighten();
        return 1000 * 2 ** attempt;
      }

      throw new SalesforceError(
        'THROTTLED',
        'Salesforce is rate-limiting this org\u2019s API requests.',
        403,
        'Too many concurrent requests. Try again in a minute.',
      );
    }

    if (response.status === 403) {
      throw new SalesforceError(
        code,
        message || 'Salesforce refused this request.',
        403,
        'Your user may lack a permission this check needs.',
      );
    }

    if (response.status === 410) {
      throw new SalesforceError(
        'API_VERSION_RETIRED',
        `API version ${this.version} has been retired by Salesforce.`,
        410,
        'Update the API version in OrgTriage options.',
      );
    }

    if (response.status >= 500 && attempt < 2) return 700 * 2 ** attempt;

    throw new SalesforceError(code, redact(message || 'Salesforce returned an error.'), response.status);
  }

  private async parseErrors(response: Response): Promise<SfError[]> {
    try {
      const parsed = (await response.json()) as SfError[] | SfError;
      return Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      return [];
    }
  }

  /**
   * `Sforce-Limit-Info: api-usage=10018/100000; api-bursts=1/750`
   * Present on every REST response, so the budget stays current for free.
   */
  private readLimitHeader(response: Response): void {
    const header = response.headers.get('Sforce-Limit-Info');
    if (!header) return;
    const match = /api-usage=(\d+)\/(\d+)/.exec(header);
    if (!match) return;
    const used = Number(match[1]);
    const max = Number(match[2]);
    this.budget = {
      max,
      remaining: Math.max(0, max - used),
      usedByOrgTriage: this.apiCallsBefore + this.apiCalls,
      observedAt: Date.now(),
    };
    this.onBudget?.(this.budget);
  }

  /* ---------------------------------------------------------------------- */
  /* Queries                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Run SOQL and follow `nextRecordsUrl` to completion.
   *
   * Pagination is always by cursor. `LIMIT`/`OFFSET` are avoided because the
   * Tooling catalog objects (EntityDefinition, FieldDefinition, and 14 others)
   * *silently ignore* them — a pager built on OFFSET there looks like it works
   * while returning the wrong rows.
   */
  async query<T = Record<string, unknown>>(
    soql: string,
    opts: { tooling?: boolean; maxRecords?: number } = {},
  ): Promise<{ records: T[]; totalSize: number; truncated: boolean }> {
    const segment = opts.tooling ? '/tooling' : '';
    let path = `${this.base}${segment}/query/?q=${encodeURIComponent(soql)}`;
    const records: T[] = [];
    let totalSize = 0;
    let truncated = false;

    for (;;) {
      const response = await this.request('GET', path);
      const page = (await response.json()) as QueryResponse<T>;
      totalSize = page.totalSize ?? records.length;
      records.push(...page.records);

      if (opts.maxRecords && records.length >= opts.maxRecords) {
        // Truncated if there are more pages *or* if this page alone already
        // overshot the cap. A 2,000-row first page with `done: true` and
        // `maxRecords: 5` discards 1,995 rows and must say so.
        truncated = !page.done || records.length > opts.maxRecords;
        records.length = opts.maxRecords;
        break;
      }
      if (page.done) break;
      if (!page.nextRecordsUrl) {
        // `done: false` with nowhere to continue is a malformed page, and the
        // rows it did not deliver must not be mistaken for a complete result.
        truncated = true;
        break;
      }
      path = page.nextRecordsUrl;
    }

    return { records, totalSize, truncated };
  }

  /** Convenience for queries expected to return one row. */
  async queryOne<T = Record<string, unknown>>(
    soql: string,
    opts: { tooling?: boolean } = {},
  ): Promise<T | null> {
    const { records } = await this.query<T>(soql, { ...opts, maxRecords: 1 });
    return records[0] ?? null;
  }

  /** GET an arbitrary versioned resource, e.g. `/analytics/reports/{id}/describe`. */
  async get<T>(resource: string, opts: { tooling?: boolean } = {}): Promise<T> {
    const segment = opts.tooling ? '/tooling' : '';
    const response = await this.request('GET', `${this.base}${segment}${resource}`);
    return (await response.json()) as T;
  }

  /* ---------------------------------------------------------------------- */
  /* Composite                                                               */
  /* ---------------------------------------------------------------------- */

  /**
   * Send up to 25 subrequests as a single API call.
   *
   * Salesforce caps a composite at 25 subrequests, of which at most 5 may be
   * queries. Callers pass any number; this chunks accordingly. `allOrNone` is
   * false because an audit wants the 24 subrequests that worked, not a rollback
   * because one component was inaccessible.
   */
  async composite<T = unknown>(
    subrequests: CompositeSubrequest[],
    opts: { tooling?: boolean; chunkSize?: number } = {},
  ): Promise<CompositeOutcome<T>> {
    const responses = new Map<string, CompositeSubresponse<T>>();
    if (subrequests.length === 0) return { responses, chunks: 0, failedChunks: 0 };

    const segment = opts.tooling ? '/tooling' : '';
    const chunks = chunkComposite(subrequests, opts.chunkSize);
    let failedChunks = 0;
    let error: Error | undefined;

    for (const chunk of chunks) {
      try {
        const response = await this.request('POST', `${this.base}${segment}/composite`, {
          allOrNone: false,
          compositeRequest: chunk,
        });
        const payload = (await response.json()) as { compositeResponse: CompositeSubresponse<T>[] };
        for (const sub of payload.compositeResponse ?? []) {
          responses.set(sub.referenceId, sub);
        }
      } catch (err) {
        // A budget stop is org-wide: continuing would burn calls we were just
        // told we do not have. Everything else costs one chunk.
        if (err instanceof SalesforceError && err.code === 'BUDGET_EXHAUSTED') throw err;
        failedChunks++;
        if (!error) error = err instanceof Error ? err : new Error(String(err));
      }
    }
    return { responses, chunks: chunks.length, failedChunks, error };
  }

  /**
   * Fetch one record's full detail for many ids, batched through composite.
   * This is the shape every `Metadata`-bearing Tooling object forces on us:
   * `Metadata` and `FullName` may only be selected when the result is a single
   * record, so bulk retrieval is inherently one request per component.
   */
  async retrieveMany<T>(
    objectType: string,
    ids: string[],
    opts: { tooling?: boolean; chunkSize?: number } = {},
  ): Promise<{ records: Map<string, T>; chunks: number; failedChunks: number; error?: Error }> {
    const segment = opts.tooling ? '/tooling' : '';
    const subrequests: CompositeSubrequest[] = ids.map((id, index) => ({
      method: 'GET',
      url: `${this.base}${segment}/sobjects/${objectType}/${id}`,
      referenceId: `r${index}`,
    }));

    const outcome = await this.composite<T>(subrequests, opts);
    const records = new Map<string, T>();
    outcome.responses.forEach((sub, ref) => {
      const index = Number(ref.slice(1));
      const id = ids[index];
      // 403/404 subresponses are normal here (managed package, deleted between
      // the list query and the fetch); skip them rather than failing the scan.
      if (id && sub.httpStatusCode >= 200 && sub.httpStatusCode < 300) records.set(id, sub.body);
    });
    return {
      records,
      chunks: outcome.chunks,
      failedChunks: outcome.failedChunks,
      error: outcome.error,
    };
  }

  /* ---------------------------------------------------------------------- */
  /* Limits                                                                  */
  /* ---------------------------------------------------------------------- */

  /**
   * The `/limits/` resource. Costs a call, needs "View Setup and Configuration",
   * and is only accurate within five minutes — so it is read once per session
   * for the detail view, while the live budget comes from the response header.
   */
  async getLimits(): Promise<Record<string, { Max: number; Remaining: number }>> {
    return this.get('/limits/');
  }
}

/**
 * Salesforce caps a composite at 25 subrequests. Callers may ask for less:
 * 25 full Flow records or 25 Analytics describes is a multi-megabyte response
 * against a fixed 25-second abort, and the orgs big enough to need the tool are
 * the ones most likely to lose the whole chunk to a timeout.
 */
export function chunkComposite(
  subrequests: CompositeSubrequest[],
  chunkSize?: number,
): CompositeSubrequest[][] {
  const MAX_SUBREQUESTS = 25;
  /** Salesforce allows at most five query subrequests in one composite. */
  const MAX_QUERY_SUBREQUESTS = 5;
  const size = Math.max(1, Math.min(chunkSize ?? MAX_SUBREQUESTS, MAX_SUBREQUESTS));
  const isQuery = (sub: CompositeSubrequest) => /\/query\/?\?/.test(sub.url);

  const chunks: CompositeSubrequest[][] = [];
  let current: CompositeSubrequest[] = [];
  let queries = 0;
  for (const sub of subrequests) {
    const q = isQuery(sub) ? 1 : 0;
    if (current.length >= size || queries + q > MAX_QUERY_SUBREQUESTS) {
      chunks.push(current);
      current = [];
      queries = 0;
    }
    current.push(sub);
    queries += q;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** SOQL string literal escaping. */
export function soqlString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
