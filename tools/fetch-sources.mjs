/**
 * Save the Markdown form of every cited developer.salesforce.com/docs/platform
 * page under docs/sources/, and say what changed since the last fetch.
 *
 *   npm run fetch:sources
 *
 * Only new-format pages (/docs/<area>/<guide>/guide/…) serve Markdown (the same path with .md);
 * atlas pages redirect .md to .htm and are covered by the product-docs index
 * instead. Nothing fetched here is shown to a user or committed — see
 * docs/sources/README.md.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCES = [
  'src/analyzers/access.ts', 'src/analyzers/apex.ts', 'src/analyzers/apexlint.ts',
  'src/analyzers/fields.ts', 'src/analyzers/flows.ts', 'src/analyzers/flowscan.ts',
  'src/analyzers/layouts.ts', 'src/analyzers/limits.ts', 'src/analyzers/ops.ts',
  'src/analyzers/reports.ts', 'src/analyzers/security.ts', 'src/analyzers/framework.ts',
  'src/shared/playbook.ts',
];

const urls = new Set();
for (const file of SOURCES) {
  for (const m of readFileSync(file, 'utf8').matchAll(/https:\/\/developer\.salesforce\.com\/docs\/[a-z-]+\/[a-z0-9-]+\/guide\/[^\s'"`)]+\.html/g)) urls.add(m[0]);
}
console.log(`${urls.size} cited new-format pages offer Markdown (developer.salesforce.com/docs/…/guide/…)\n`);

const today = new Date().toISOString().slice(0, 10);
let changed = 0;
for (const url of urls) {
  const mdUrl = url.replace(/\.html$/, '.md');
  const out = join('docs/sources', new URL(url).host, new URL(url).pathname.replace(/\.html$/, '.md'));
  try {
    const res = await fetch(mdUrl, { redirect: 'follow' });
    const body = await res.text();
    if (!res.ok || /<!doctype html|<html/i.test(body.slice(0, 200))) {
      console.log(`SKIP     ${url}\n         no Markdown served (${res.status})`);
      continue;
    }
    const previous = existsSync(out) ? readFileSync(out, 'utf8').split('\n').slice(1).join('\n') : null;
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, `<!-- source: ${url} · fetched ${today} -->\n${body}`);
    const status = previous === null ? 'new' : previous === body ? 'unchanged' : 'CHANGED';
    if (status === 'CHANGED') changed += 1;
    console.log(`${status.padEnd(9)}${url}\n         → ${out} (${(body.length / 1024).toFixed(0)} KB)`);
  } catch (error) {
    console.log(`FAIL     ${url}\n         ${String(error.message).slice(0, 100)}`);
  }
}
console.log(`\n${changed} page(s) changed since the last fetch.`);
