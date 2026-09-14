#!/usr/bin/env node
/**
 * Manifest invariants, checked against the built `dist/`.
 *
 * This exists because of a real bug: the CSP declared `connect-src 'none'`,
 * which in MV3 applies to the *service worker* as well as extension pages, so
 * every Salesforce API call the extension made was blocked by its own manifest.
 * Nothing caught it — the build was clean, the types were clean, and the only
 * symptom was a generic "Failed to fetch" at runtime against a live org.
 *
 * Run as part of `npm run build`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.json'), 'utf8'));

const failures = [];
const fail = (message) => failures.push(message);
const checks = [];
const pass = (message) => checks.push(message);

/* --- CSP ------------------------------------------------------------------ */
const csp = manifest.content_security_policy?.extension_pages ?? '';
const directives = Object.fromEntries(
  csp
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, ...values] = part.split(/\s+/);
      return [name, values];
    }),
);

const connectSrc = directives['connect-src'];
if (connectSrc) {
  if (connectSrc.includes("'none'")) {
    fail(
      "connect-src is 'none'. In MV3 the extension_pages policy also governs the " +
        'service worker, so this blocks every Salesforce API call the extension makes.',
    );
  } else if (!connectSrc.some((source) => source.includes('salesforce.com'))) {
    fail(`connect-src does not permit any salesforce.com host: ${connectSrc.join(' ')}`);
  } else if (connectSrc.includes('*') || connectSrc.includes('https:')) {
    fail(`connect-src is unrestricted (${connectSrc.join(' ')}); list Salesforce hosts explicitly.`);
  } else {
    pass(`connect-src limited to ${connectSrc.length} explicit sources`);
  }
} else {
  fail('connect-src is not declared; the default would allow any host.');
}

if (!directives['script-src']?.includes("'self'")) fail("script-src must include 'self'.");
if (directives['script-src']?.some((s) => s.includes('unsafe'))) {
  fail('script-src contains an unsafe- source; MV3 rejects this at load time.');
}

/* --- Every referenced file exists ---------------------------------------- */
const referenced = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
  manifest.options_ui?.page,
  // Opened by name from the sidebar (`chrome.runtime.getURL('report.html')`)
  // rather than declared in the manifest, so the manifest cannot catch its
  // absence — this can.
  'report.html',
  // The MIT and BSD licences of the code compiled into background.js require
  // their notices to travel with the binary. Nothing references NOTICE, so
  // nothing else would notice it going missing.
  'NOTICE',
  ...(manifest.web_accessible_resources ?? []).flatMap((entry) =>
    (entry.resources ?? []).filter((resource) => !resource.includes('*')),
  ),
].filter(Boolean);

for (const file of new Set(referenced)) {
  if (existsSync(resolve(dist, file))) pass(`${file} present`);
  else fail(`manifest references ${file}, which is not in dist/`);
}

/* --- Permissions stay minimal -------------------------------------------- */
const WARNING_PERMISSIONS = ['tabs', 'declarativeNetRequest', 'webRequest', '<all_urls>'];
for (const permission of manifest.permissions ?? []) {
  if (WARNING_PERMISSIONS.includes(permission)) {
    fail(`permission "${permission}" triggers an install-time warning; it was deliberately avoided.`);
  }
}
pass(`permissions: ${(manifest.permissions ?? []).join(', ') || 'none'}`);

/* --- Report --------------------------------------------------------------- */
console.log(`\nManifest checks — ${manifest.name} v${manifest.version}\n`);
for (const message of checks) console.log(`  pass  ${message}`);
for (const message of failures) console.error(`  FAIL  ${message}`);

if (failures.length > 0) {
  console.error(`\n${failures.length} manifest problem(s).\n`);
  process.exit(1);
}
console.log('\nManifest OK.\n');
