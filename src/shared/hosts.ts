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

/** True for a Lightning UI host of any family: commercial, sandbox, regional, Government Cloud. */
export function isLightningHost(host: string): boolean {
  return /\.lightning\.(?:[^.]+\.)?force\.(?:com|mil)$/.test(host);
}

/**
 * The Lightning host for an API host: `acme.my.salesforce.com` →
 * `acme.lightning.force.com`, `acme.my.salesforce.mil` →
 * `acme.lightning.force.mil`, `acme.my.eu1.salesforce.com` →
 * `acme.lightning.eu1.force.com`. A host that fits no pattern comes back as is.
 */
export function lightningHostFor(apiHost: string): string {
  return apiHost
    .replace(/\.my\.salesforce\.(com|mil)$/, '.lightning.force.$1')
    .replace(/\.my\.([^.]+)\.salesforce\.com$/, '.lightning.$1.force.com');
}

/**
 * Every host a tab on this org may be open at, from whichever host the caller
 * has: the host itself, the API host, the Lightning host derived from it, and
 * the enhanced-domains Setup host where one exists. Commercial, sandbox,
 * regional and Government Cloud hosts all go through the same two functions
 * in both directions, so the list is right whichever host the worker held.
 */
export function orgHosts(host: string): string[] {
  const api = normalizeApiHost(host);
  const lightning = lightningHostFor(api);
  const setup = api.replace(/\.my\.salesforce\.com$/, '.my.salesforce-setup.com');
  return [...new Set([host, api, lightning, setup])];
}
