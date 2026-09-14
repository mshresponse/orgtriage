/**
 * Salesforce hostname arithmetic shared by the service worker (which needs
 * the API host for a tab) and the plan page (which needs every host a tab on
 * the same org might be open at). No chrome.* calls here.
 */

/**
 * Convert any Salesforce UI host into the API host.
 *
 * All three substitutions matter:
 *   1. `*.lightning.force.com` → `*.my.salesforce.com` (the common case).
 *   2. `*.lightning.<region>.force.com` → `*.my.<region>.salesforce.com`,
 *      which is what makes government and regional instances work.
 *   3. `*.my.salesforce-setup.com` → `*.my.salesforce.com`. Enhanced domains
 *      serve Setup from its own registrable domain, and that is where admins
 *      spend most of their time — so it is the tab host far more often than
 *      not. Whether the setup domain answers `/services/data/` with an
 *      API-capable session is undocumented; rewriting to the documented API
 *      host means we never find out the hard way.
 *
 * Sandbox hosts fall out of (1) and (3) correctly:
 * `acme--dev.sandbox.lightning.force.com` → `acme--dev.sandbox.my.salesforce.com`.
 */
export function normalizeApiHost(host: string): string {
  return host
    .replace(/\.lightning\.force\./, '.my.salesforce.')
    .replace(/\.lightning\.([^.]+)\.force\.com$/, '.my.$1.salesforce.com')
    .replace(/\.my\.salesforce-setup\.com$/, '.my.salesforce.com');
}

/**
 * Every host a tab on this org may be open at: the Lightning host itself, the
 * API host it normalizes to, and the enhanced-domains Setup host where that
 * exists. Commercial, sandbox, regional and Government Cloud hosts all go
 * through the same normalizer, so the list is right wherever the worker is.
 */
export function orgHosts(lightningHost: string): string[] {
  const api = normalizeApiHost(lightningHost);
  const setup = api.replace(/\.my\.salesforce\.com$/, '.my.salesforce-setup.com');
  return [...new Set([lightningHost, api, setup])];
}
