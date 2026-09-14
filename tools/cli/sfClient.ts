/**
 * A `SalesforceClient` that shells out to the Salesforce CLI.
 *
 * The extension's client holds a session cookie. This one holds nothing: every
 * request goes through `sf api request rest`, so the CLI owns the credential
 * and no access token is ever read, stored, or passed through this process.
 * That is the whole reason a CLI path exists — it lets the analyzers run in CI,
 * in a terminal, and under an agent without ever handing any of them a token.
 *
 * Everything above this file is the shipping analyzer code, unmodified. If a
 * rule behaves differently here than in the panel, the difference is in this
 * file and nowhere else.
 */

import { lightningHostFor as apiLightningHostFor } from '../../src/shared/hosts';
import { execFileSync } from 'node:child_process';

export interface OrgIdentity {
  alias: string;
  orgId: string;
  username: string;
  instanceUrl: string;
  lightningHost: string;
  apiVersion: string;
}

/** A Salesforce error payload: `[{ errorCode, message }]`. */
class CliSalesforceError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'SalesforceError';
  }

  /** Nothing is retried here: the CLI already retries transport failures. */
  get retryable(): boolean {
    return false;
  }
}

/**
 * Strip the CLI's own chatter from a stream so the real error survives.
 *
 * `sf api request rest` is a beta command, so every invocation writes a beta
 * notice to stderr, and an out-of-date CLI adds an update notice on top. When a
 * request failed, reporting stderr verbatim buried the cause under two warnings
 * that had nothing to do with it — which is exactly what the first full run
 * against a live org produced, twice, with no way to tell what had gone wrong.
 */
function withoutCliNoise(stream: string | undefined): string {
  return (stream ?? '')
    .split('\n')
    .filter((line) => {
      const text = line.replace(/^[›\s]+/, '').trim();
      if (!text) return false;
      if (/^Warning:/i.test(text)) return false;
      if (/update available from/i.test(text)) return false;
      if (/currently in beta/i.test(text)) return false;
      return true;
    })
    .join(' ')
    .trim();
}

/** Keys under which the CLI, or Salesforce, would hand back a credential. */
const CREDENTIAL_PATTERN = /"(accessToken|access_token|refreshToken|refresh_token|sfdxAuthUrl)"\s*:/;

/**
 * Refuse to hold a credential.
 *
 * Every CLI command's output passes through here before anything reads it.
 * `sf org display --json` includes the org's access token, and the first
 * version of this client captured it, parsed it, and kept only the fields it
 * wanted — which is still importing the token into this process and hoping.
 * The commands used now do not return one; this makes that a checked fact
 * rather than a belief, so a future command that does will fail loudly instead
 * of quietly widening the credential surface.
 */
export function assertNoCredential(output: string, command: string): void {
  if (CREDENTIAL_PATTERN.test(output)) {
    throw new Error(
      `Refusing to read the output of \`${command}\`: it carries a credential, and this process must never hold one.`,
    );
  }
}

function sf(args: string[], input?: string): string {
  const command = `sf ${args.slice(0, 3).join(' ')}`;
  try {
    const out = execFileSync('sf', args, {
      input,
      maxBuffer: 256 * 1024 * 1024,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assertNoCredential(out, command);
    return out;
  } catch (error) {
    const err = error as { stderr?: string; stdout?: string; message?: string; code?: string };
    if (err.code === 'ENOENT') {
      throw new Error(
        'The Salesforce CLI (`sf`) is not on PATH. Install it from ' +
          'https://developer.salesforce.com/tools/salesforcecli and run `sf org login web`.',
      );
    }
    if (err.message?.startsWith('Refusing to read')) throw error;
    // Salesforce's own error body comes back on stdout as JSON even when the
    // CLI exits non-zero, so it is the more informative of the two streams.
    // A failed command's output is redacted the same way before it is quoted.
    const detail =
      withoutCliNoise(err.stdout) || withoutCliNoise(err.stderr) || err.message || 'unknown error';
    const safe = CREDENTIAL_PATTERN.test(detail) ? 'output withheld: it contains a credential' : detail;
    throw new Error(`${command} failed: ${safe.slice(0, 400)}`);
  }
}

/**
 * Resolve who we are about to scan.
 *
 * Two REST reads through the CLI rather than `sf org display --json`. The
 * latter answers in one call — and its JSON carries the access token, which
 * this process must never hold (see `assertNoCredential`). The versions list
 * is unauthenticated and costs no API call; the identity endpoint is what the
 * extension's worker uses for the same question.
 */
export function resolveOrg(alias: string, apiVersionOverride?: string): OrgIdentity {
  const run = (path: string): unknown => {
    const out = sf(['api', 'request', 'rest', path, '--target-org', alias]);
    return out.trim() ? JSON.parse(out) : {};
  };

  // Newest API version the org serves. `/services/data` lists every version.
  const versions = run('/services/data') as Array<{ version?: string }>;
  const newest = Array.isArray(versions)
    ? versions.map((v) => v.version).filter((v): v is string => typeof v === 'string').sort((a, b) => Number(b) - Number(a))[0]
    : undefined;

  // Who and where. `userinfo` names the org, the user and the org's own URL;
  // it never includes a token.
  const identity = run('/services/oauth2/userinfo') as {
    organization_id?: string;
    preferred_username?: string;
    urls?: { custom_domain?: string; rest?: string };
  };
  const instanceUrl =
    identity.urls?.custom_domain ??
    (identity.urls?.rest ? new URL(identity.urls.rest).origin : undefined);
  if (!identity.organization_id || !instanceUrl) {
    throw new Error(
      `Could not resolve org "${alias}". Check \`sf org list\` — the alias must be authorised already.`,
    );
  }

  return {
    alias,
    orgId: identity.organization_id,
    username: identity.preferred_username ?? 'unknown',
    instanceUrl,
    lightningHost: lightningHostFor(instanceUrl),
    apiVersion: apiVersionOverride ?? newest ?? '67.0',
  };
}

/**
 * Derive the Lightning host from the instance URL.
 *
 * Only used to build Setup deep links in findings, so a wrong guess produces a
 * link that does not resolve rather than a wrong result. My Domain orgs — which
 * is all of them since Winter '24 — serve Lightning on `<domain>.lightning.force.com`.
 */
export function lightningHostFor(instanceUrl: string): string {
  const host = instanceUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
  // The same derivation the extension's worker uses, so Government Cloud and
  // regional orgs get the same Lightning host from the CLI. An instance-style
  // host (na123.salesforce.com) has no Lightning equivalent worth guessing at
  // and comes back unchanged, which keeps links pointing somewhere real.
  return apiLightningHostFor(host);
}

export interface CliClientOptions {
  org: OrgIdentity;
  /** Called with each REST path, for progress reporting. */
  onRequest?: (path: string) => void;
}

/**
 * Build a client the analyzers accept. Typed loosely on purpose: it is
 * structurally compatible with `SalesforceClient`, and the analyzers only ever
 * touch the methods below.
 */
export function createCliClient(options: CliClientOptions) {
  const { org, onRequest } = options;
  const version = `v${org.apiVersion.replace(/^v/, '')}`;
  let apiCalls = 0;

  function rest(path: string, method = 'GET', body?: unknown): unknown {
    apiCalls += 1;
    onRequest?.(path);
    const args = ['api', 'request', 'rest', path, '--target-org', org.alias];
    if (method !== 'GET') {
      args.push('--method', method, '--header', 'Content-Type:application/json', '--body', '-');
    }
    const out = sf(args, method === 'GET' ? undefined : JSON.stringify(body));
    return JSON.parse(out);
  }

  /** Salesforce returns errors as an array of `{errorCode, message}`. */
  function throwIfError(payload: unknown, fallbackStatus: number): void {
    if (
      Array.isArray(payload) &&
      payload[0] &&
      typeof (payload[0] as { errorCode?: unknown }).errorCode === 'string'
    ) {
      const first = payload[0] as { errorCode: string; message?: string };
      throw new CliSalesforceError(first.errorCode, first.message ?? 'request failed', fallbackStatus);
    }
  }

  const client = {
    apiVersion: org.apiVersion.replace(/^v/, ''),
    get apiCalls() {
      return apiCalls;
    },
    budget: { max: null, remaining: null, usedByOrgTriage: 0, observedAt: null },

    async query(soql: string, opts: Record<string, any> = {}) {
      const seg = opts.tooling ? '/tooling' : '';
      let path = `/services/data/${version}${seg}/query/?q=${encodeURIComponent(soql)}`;
      const records: unknown[] = [];
      let totalSize = 0;
      let truncated = false;

      for (;;) {
        const page = rest(path) as {
          totalSize?: number;
          records?: unknown[];
          done?: boolean;
          nextRecordsUrl?: string;
        };
        throwIfError(page, 400);
        totalSize = page.totalSize ?? records.length;
        records.push(...(page.records ?? []));

        if (opts.maxRecords && records.length >= opts.maxRecords) {
          truncated = !page.done || records.length > opts.maxRecords;
          records.length = opts.maxRecords;
          break;
        }
        if (page.done || !page.nextRecordsUrl) break;
        path = page.nextRecordsUrl;
      }
      return { records, totalSize, truncated };
    },

    async queryOne(soql: string, opts: Record<string, any> = {}) {
      const { records } = await client.query(soql, { ...opts, maxRecords: 1 });
      return records[0] ?? null;
    },

    async get(resource: string, opts: Record<string, any> = {}) {
      const seg = opts.tooling ? '/tooling' : '';
      const body = rest(`/services/data/${version}${seg}${resource}`);
      // A legitimate collection resource (/analytics/report-types) is also an
      // array, so shape alone cannot distinguish one — the errorCode key can.
      throwIfError(body, 404);
      return body;
    },

    async composite(subrequests: any[], opts: Record<string, any> = {}) {
      const seg = opts.tooling ? '/tooling' : '';
      const size = Math.max(1, Math.min(opts.chunkSize ?? 25, 25));
      const responses = new Map<string, any>();
      let chunks = 0;
      let failedChunks = 0;
      let error: Error | undefined;

      for (let i = 0; i < subrequests.length; i += size) {
        chunks += 1;
        try {
          const payload = rest(`/services/data/${version}${seg}/composite`, 'POST', {
            allOrNone: false,
            compositeRequest: subrequests.slice(i, i + size),
          }) as { compositeResponse?: Array<{ referenceId: string }> };
          for (const sub of payload.compositeResponse ?? []) responses.set(sub.referenceId, sub);
        } catch (e) {
          // One bad chunk must not lose the others: the caller reports partial
          // coverage rather than treating the whole rule as clean.
          failedChunks += 1;
          error ??= e as Error;
        }
      }
      return { responses, chunks, failedChunks, error };
    },

    async retrieveMany(objectType: string, ids: string[], opts: Record<string, any> = {}) {
      const seg = opts.tooling ? '/tooling' : '';
      const subs = ids.map((id, i) => ({
        method: 'GET',
        url: `/services/data/${version}${seg}/sobjects/${objectType}/${id}`,
        referenceId: `r${i}`,
      }));
      const outcome = await client.composite(subs, opts);
      const records = new Map<string, unknown>();
      outcome.responses.forEach((sub: any, ref: string) => {
        const id = ids[Number(ref.slice(1))];
        if (id && sub.httpStatusCode >= 200 && sub.httpStatusCode < 300) records.set(id, sub.body);
      });
      return { records, chunks: outcome.chunks, failedChunks: outcome.failedChunks, error: outcome.error };
    },

    async getLimits() {
      return client.get('/limits/');
    },
  };

  return client;
}
