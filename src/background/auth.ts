/**
 * Session handling. This module is the extension's entire credential surface.
 *
 * Design rule: the session id never leaves this file. Nothing here returns it,
 * logs it, persists it, or puts it in an error. Callers get {@link signedFetch},
 * which attaches the Authorization header internally. That makes "credentials
 * stay in the service worker" a property of the module boundary rather than a
 * promise in a README.
 *
 * How the session is obtained — all of this is why it must live in the worker:
 *
 *  - `chrome.cookies` is not available to content scripts, only to the worker.
 *  - The Lightning host and the API host are different registrable domains and
 *    therefore carry *different* `sid` cookies. Calling the API on the Lightning
 *    host also triggers a redirect, and browsers strip `Authorization` across a
 *    cross-origin redirect. So the host is normalised before any call.
 *  - The `sid` value is `<15-char OrgId>!<opaque>`, which is how a session on
 *    one cookie domain is correlated to the same org's session on another. This
 *    is also what makes multiple simultaneously-logged-in orgs work.
 *
 * Sources:
 *   https://help.salesforce.com/s/articleView?id=xcloud.platform_cookies.htm&type=5
 *   https://developer.chrome.com/docs/extensions/reference/api/cookies
 */

/** Cookie domains swept for an org's API-capable session, in priority order. */
const SWEEP_DOMAINS = [
  'salesforce.com',
  'cloudforce.com',
  'salesforce.mil',
  'cloudforce.mil',
  'sfcrmproducts.cn',
  'force.com',
] as const;

/**
 * Salesforce's own help org sets a `sid` on this host. It is never the customer
 * org and must be excluded from the sweep or it will be picked up first.
 */
const EXCLUDED_COOKIE_DOMAIN = 'help.salesforce.com';

export interface OrgHost {
  /**
   * API host currently in use, e.g. `acme.my.salesforce.com`. Starts as the
   * best candidate and is replaced by whichever candidate actually answers —
   * see {@link candidates}.
   */
  apiHost: string;
  /**
   * Every plausible API host, best first.
   *
   * A cookie's `domain` is not necessarily a reachable host: a session scoped
   * to a parent domain yields something like `.develop.my.salesforce.com`,
   * which looks valid and fails DNS. Rather than trusting the first match, the
   * client probes these in order and keeps the one that serves the API.
   */
  candidates: string[];
  /** 15-character org id parsed from the session cookie. */
  orgId15: string;
  /** Cookie store the session came from — carried through for Firefox. */
  cookieStoreId?: string;
}

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly hint?: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

// The normalizer lives in src/shared/hosts.ts so the plan page can match
// tabs on the same org with the same rules; re-exported for existing callers.
import { normalizeApiHost } from '@/shared/hosts';
export { normalizeApiHost };

/** Hosts this extension is willing to talk to, mirroring host_permissions. */
const ALLOWED_API_HOST =
  /\.(salesforce\.com|force\.com|salesforce-setup\.com|cloudforce\.com|visualforce\.com|salesforce\.mil|force\.mil|cloudforce\.mil|visualforce\.mil|crmforce\.mil|sfcrmapps\.cn|sfcrmproducts\.cn)$/i;

export function isAllowedApiHost(host: string): boolean {
  return ALLOWED_API_HOST.test(host) && !host.includes('/') && !host.includes('..');
}

function getCookie(details: chrome.cookies.CookieDetails): Promise<chrome.cookies.Cookie | null> {
  return chrome.cookies.get(details).catch(() => null);
}

/**
 * Resolve the API host and org id for a Salesforce tab.
 *
 * `tabUrl` must come from the browser (`sender.tab.url`), never from a message
 * payload — otherwise a compromised panel could point queries at another org.
 */
export async function resolveOrgHost(tabUrl: string, cookieStoreId?: string): Promise<OrgHost> {
  let parsed: URL;
  try {
    parsed = new URL(tabUrl);
  } catch {
    throw new AuthError('BAD_HOST', 'This tab is not a Salesforce page.');
  }
  if (parsed.protocol !== 'https:' || !isAllowedApiHost(parsed.hostname)) {
    throw new AuthError('BAD_HOST', 'This tab is not a Salesforce page.');
  }

  const details: chrome.cookies.CookieDetails = { url: parsed.origin, name: 'sid' };
  if (cookieStoreId) details.storeId = cookieStoreId;

  const pageCookie = await getCookie(details);
  if (!pageCookie?.value) {
    throw new AuthError(
      'NO_SESSION',
      'No active Salesforce session was found for this tab.',
      'Log in to the org in this tab, then reopen OrgTriage.',
    );
  }

  const orgId15 = pageCookie.value.split('!')[0] ?? '';
  if (orgId15.length < 15) {
    throw new AuthError('NO_SESSION', 'The Salesforce session cookie was not in the expected form.');
  }

  const candidates: string[] = [];
  const add = (host: string): void => {
    const normalized = normalizeApiHost(host.replace(/^\./, ''));
    if (isAllowedApiHost(normalized) && !candidates.includes(normalized)) {
      candidates.push(normalized);
    }
  };

  // The tab's own host, normalised, goes first. It is the one host we know the
  // user is actually talking to, so it is the safest default even though the
  // cookie sweep below may find a better-scoped session.
  add(parsed.hostname);

  // Sweep the registrable domains for the same org's API-capable session. The
  // session on a Visualforce host is documented as lacking API access, so hosts
  // under *.salesforce.com are collected too.
  for (const domain of SWEEP_DOMAINS) {
    const query: chrome.cookies.GetAllDetails = { name: 'sid', domain, secure: true };
    if (cookieStoreId) query.storeId = cookieStoreId;

    const cookies = await chrome.cookies.getAll(query).catch(() => []);
    for (const cookie of cookies) {
      if (!cookie.value.startsWith(`${orgId15}!`)) continue;
      if (cookie.domain === EXCLUDED_COOKIE_DOMAIN) continue;
      add(cookie.domain);
    }
  }

  if (candidates.length === 0) {
    throw new AuthError('BAD_HOST', 'Could not determine the org’s API host from this tab.');
  }
  return { apiHost: candidates[0]!, candidates, orgId15, cookieStoreId };
}

/* -------------------------------------------------------------------------- */
/* The credential boundary                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Short-lived in-memory session cache. Not `chrome.storage` — not even
 * `storage.session`, which is readable by the panel if `setAccessLevel` is ever
 * called. Losing this cache on worker restart costs one cookie read.
 */
const sessionCache = new Map<string, { value: string; fetchedAt: number }>();
const SESSION_TTL_MS = 5 * 60 * 1000;

function cacheKey(apiHost: string, storeId?: string): string {
  return `${storeId ?? 'default'}::${apiHost}`;
}

async function getSessionId(apiHost: string, cookieStoreId?: string): Promise<string> {
  const key = cacheKey(apiHost, cookieStoreId);
  const cached = sessionCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < SESSION_TTL_MS) return cached.value;

  const details: chrome.cookies.CookieDetails = { url: `https://${apiHost}`, name: 'sid' };
  if (cookieStoreId) details.storeId = cookieStoreId;

  const cookie = await getCookie(details);
  if (!cookie?.value) {
    sessionCache.delete(key);
    throw new AuthError(
      'NO_SESSION',
      'Your Salesforce session has ended.',
      'Refresh the Salesforce tab to sign in again.',
    );
  }
  const fetchedAt = Date.now();
  sessionCache.set(key, { value: cookie.value, fetchedAt });
  // Evict on the clock, not only on the next read: "held in memory for at
  // most five minutes" has to hold for an entry nobody asks for again. If the
  // worker is shut down first, the map goes with it.
  setTimeout(() => {
    if (sessionCache.get(key)?.fetchedAt === fetchedAt) sessionCache.delete(key);
  }, SESSION_TTL_MS);
  return cookie.value;
}

/** Drop a cached session — called on 401 so the next attempt re-reads the cookie. */
export function invalidateSession(apiHost: string, cookieStoreId?: string): void {
  sessionCache.delete(cacheKey(apiHost, cookieStoreId));
}

export function clearAllSessions(): void {
  sessionCache.clear();
}

/**
 * Perform an authorized request against an org.
 *
 * The Authorization header is attached here and nowhere else. `path` must be a
 * root-relative path; passing an absolute URL is rejected so a caller can never
 * redirect a credentialed request to another origin.
 *
 * `redirect: 'manual'` is deliberate. Browsers strip `Authorization` across a
 * cross-origin redirect, so a followed redirect would surface as a baffling
 * 401. `'manual'` returns an opaque-redirect response instead of throwing,
 * which lets the caller say "the org redirected this request" rather than
 * reporting a generic network failure.
 */
export async function signedFetch(
  host: OrgHost,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!/^\//.test(path)) {
    throw new AuthError('BAD_REQUEST', 'Internal error: API path must be root-relative.');
  }
  if (!isAllowedApiHost(host.apiHost)) {
    throw new AuthError('BAD_HOST', 'Refusing to call a non-Salesforce host.');
  }

  const sessionId = await getSessionId(host.apiHost, host.cookieStoreId);
  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${sessionId}`);
  headers.set('Accept', 'application/json');
  // Identifies this client in the org's API usage logs, so admins can see
  // exactly what OrgTriage consumed.
  headers.set('Sforce-Call-Options', 'client=OrgTriage');
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=UTF-8');
  }

  return fetch(`https://${host.apiHost}${path}`, {
    ...init,
    headers,
    credentials: 'omit', // the header is the only auth; never send ambient cookies
    redirect: 'manual',
  });
}

/**
 * Strip anything session-shaped out of a string before it is logged or shown.
 * Session ids always contain `!`, and their first segment is the org id.
 */
export function redact(text: string): string {
  return text.replace(/\b00D[A-Za-z0-9]{12,15}![^\s"'&]+/g, '00D…!<redacted>');
}
