/**
 * Verify that every Salesforce documentation link the product cites resolves
 * to a real article.
 *
 *   node tools/check-docs.mjs             → check every link, update docs/doc-links.json
 *   node tools/check-docs.mjs --dry       → check, report, do not write the snapshot
 *
 * Why a browser and not fetch(): help.salesforce.com and developer.salesforce.com
 * are single-page apps. A missing article answers HTTP 200 with an empty shell
 * and renders "Article could not be found" from JavaScript, so a status-code
 * check passes everything. Each link is loaded in headless Chromium, the page is
 * given time to render, and the result is judged on what a reader would see.
 *
 * The heading of every article that resolves is written to docs/doc-links.json.
 * That snapshot is the second half of the check: an id that Salesforce quietly
 * retargets to a different article still "resolves", and only a changed heading
 * reveals it. Run this before a release, and whenever a rule gains a link.
 *
 * Network: this reaches Salesforce's public documentation hosts and nothing
 * else. It is not part of `npm test`, because tests must not need the network.
 *
 * Known limit, measured 2026‑09‑09: help.salesforce.com serves a headless
 * browser its fallback home page and never the article, so those links are
 * reported UNVERIFIED and must be checked in a real browser; the snapshot
 * entries a real browser wrote for them are preserved. developer.salesforce.com
 * renders fully and is judged here.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { chromium } from 'playwright';

const SOURCES = [
  'src/analyzers/access.ts', 'src/analyzers/apex.ts', 'src/analyzers/apexlint.ts',
  'src/analyzers/fields.ts', 'src/analyzers/flows.ts', 'src/analyzers/flowscan.ts',
  'src/analyzers/layouts.ts', 'src/analyzers/limits.ts', 'src/analyzers/ops.ts',
  'src/analyzers/reports.ts', 'src/analyzers/security.ts', 'src/analyzers/framework.ts',
  'src/shared/playbook.ts',
];
const SNAPSHOT = 'docs/doc-links.json';
/**
 * Salesforce's own index of every page in the atlas-era guides (Apex, REST,
 * Tooling, Metadata API, Object Reference, …): one `- [Title](url)` line per
 * page, ~39,000 lines. Not committed — it is Salesforce's, and one command
 * refreshes it (docs/sources/README.md). When present, an atlas link is judged
 * by membership: listed means live, absent means retired. No browser, no
 * rendering, no bot-blocking, and a title to suggest for anything missing.
 */
const PRODUCT_INDEX = 'docs/sources/llms-product-docs.txt';

function loadIndex() {
  if (!existsSync(PRODUCT_INDEX)) return null;
  const byUrl = new Map();
  const guides = new Set();
  for (const line of readFileSync(PRODUCT_INDEX, 'utf8').split('\n')) {
    const m = /^- \[(.+?)\]\((https?:\/\/[^)]+)\)/.exec(line);
    if (!m) continue;
    byUrl.set(m[2].trim(), m[1].trim());
    const g = guideOf(m[2]);
    if (g) guides.add(g);
  }
  return { byUrl, guides };
}

/** The guide segment of an atlas URL: `atlas.en-us.apexcode.meta` → `apexcode`. */
function guideOf(url) {
  return /\/docs\/atlas\.en-us\.([^.]+)\.meta\//.exec(url)?.[1] ?? null;
}

/**
 * Compare headings by article title only. The browser records
 * "ApexClass | Tooling API"; the index records "ApexClass". Same article.
 */
function sameHeading(a, b) {
  const first = (t) => (t ?? '').split('|')[0].trim().toLowerCase();
  return first(a) === first(b);
}

/** Closest index titles to a retired page's name, for the "did you mean" line. */
function suggestFromIndex(index, url) {
  const page = url.split('/').pop().replace(/\.htm.*$/, '');
  const words = page.split(/[_-]+/).filter((w) => w.length > 2 && !/^(api|sforce|objects|meta|guide|dev)$/.test(w));
  const scored = [];
  for (const [u, title] of index.byUrl) {
    const hay = (u.split('/').pop() + ' ' + title).toLowerCase();
    const hits = words.filter((w) => hay.includes(w.toLowerCase())).length;
    if (hits > 0) scored.push({ hits, title, u });
  }
  return scored.sort((a, b) => b.hits - a.hits).slice(0, 4);
}
const DRY = process.argv.includes('--dry');
/** `--only <substring>`: check just the links containing it; the snapshot keeps the rest. */
const ONLY = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null; })();
/** `--debug`: print the headings and the og:title each page exposes, to see what the article heading actually is. */
const DEBUG = process.argv.includes('--debug');

/** Text a Salesforce documentation host renders when an id does not exist. */
const NOT_FOUND = [
  /article could not be found/i,
  /we can.t find (that|the) (page|article)/i,
  /page (you requested )?(was )?not found/i,
  /this page (doesn.t|does not) exist/i,
  /sorry.{0,40}(couldn.t|could not) find/i,
];

function collectLinks() {
  const links = new Map(); // url → [where…]
  for (const file of SOURCES) {
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(/https?:\/\/[^\s'"`)]+/g)) {
      const url = match[0].replace(/[.,;]+$/, '');
      if (!/salesforce\.com|lightningdesignsystem\.com|trailhead/.test(url)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      const where = links.get(url) ?? [];
      where.push(`${file}:${line}`);
      links.set(url, where);
    }
  }
  return links;
}

/**
 * Titles the documentation hosts show before an article has loaded, or when
 * none exists. A page whose title never leaves this set has no article.
 */
const GENERIC_TITLE = /^(salesforce help|salesforce help \| article|salesforce developers|salesforce|help|documentation|loading…?)$/i;

/**
 * The article heading from the page itself. Salesforce Help's document title
 * is the fixed string "Salesforce Help | Article", so the title proves nothing
 * there; the heading has to come from the DOM, and the first <h1> on the page
 * is the cookie banner's. Tries, in order: the Open Graph title, a heading
 * inside the article/main region, then any heading that is not site chrome.
 * Runs inside the page; shadow roots are searched.
 */
/** Every heading on the page, through shadow roots, with its tag and the ancestry that locates it. For --debug. */
const HEADINGS_SEEN = () => {
  const out = [];
  const roots = [document];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
  walk(document);
  const path = (el) => { const parts = []; let n = el; for (let i = 0; n && n.tagName && i < 5; i++) { parts.unshift(n.tagName.toLowerCase() + (n.className && typeof n.className === 'string' ? '.' + n.className.trim().split(/\s+/).slice(0, 2).join('.') : '')); n = n.parentElement ?? (n.getRootNode()?.host ?? null); } return parts.join(' > '); };
  // Site chrome: the OneTrust cookie dialog and the global navigation. Skipped by ancestry.
  const isChrome = (el) => { let n = el; for (let i = 0; n && i < 12; i++) { const c = typeof n.className === 'string' ? n.className : ''; const id = n.id ?? ''; if (/(^|\s)(ot-|onetrust)|c360-nav|hgf-|global-nav/i.test(c) || /onetrust|c360|hgf/i.test(id)) return true; n = n.parentElement ?? (n.getRootNode()?.host ?? null); } return false; };
  let skipped = 0;
  for (const root of roots) {
    for (const el of root.querySelectorAll('h1, h2, h3')) {
      if (isChrome(el)) { skipped += 1; continue; }
      const t = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
      if (t) out.push(`${el.tagName.toLowerCase()} “${t.slice(0, 70)}”  ${path(el)}`);
      if (out.length >= 30) break;
    }
  }
  out.unshift(`(${skipped} cookie-dialog / navigation headings skipped)`);
  return { og: document.querySelector('meta[property="og:title"]')?.getAttribute('content') ?? null, headings: out };
};

const ARTICLE_HEADING = () => {
  const chrome = /^(cookie consent manager|salesforce help|salesforce|help|skip to|search|menu|products|industries|customers|events|learning|support|company)$/i;
  const clean = (t) => (t ?? '').replace(/\s+/g, ' ').trim();
  const isChrome = (el) => { let n = el; for (let i = 0; n && i < 12; i++) { const c = typeof n.className === 'string' ? n.className : ''; const id = n.id ?? ''; if (/(^|\s)(ot-|onetrust)|c360-nav|hgf-|global-nav/i.test(c) || /onetrust|c360|hgf/i.test(id)) return true; n = n.parentElement ?? (n.getRootNode()?.host ?? null); } return false; };
  const og = document.querySelector('meta[property="og:title"]')?.getAttribute('content');
  if (og && !chrome.test(clean(og))) return { heading: clean(og), via: 'og:title' };
  const roots = [document];
  const walk = (root) => { for (const el of root.querySelectorAll('*')) if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); } };
  walk(document);
  for (const sel of ['article h1', 'main h1', '[role="main"] h1', '.article-head h1', 'h1.article-title', '[data-article-title]']) {
    for (const root of roots) {
      const el = root.querySelector(sel);
      const t = clean(el?.textContent);
      if (el && !isChrome(el) && t && !chrome.test(t)) return { heading: t, via: sel };
    }
  }
  // First h1 outside the site chrome; failing that, the first such h2.
  for (const tag of ['h1', 'h2']) {
    for (const root of roots) {
      for (const el of root.querySelectorAll(tag)) {
        if (isChrome(el)) continue;
        const t = clean(el.textContent);
        if (t && t.length > 3 && !chrome.test(t)) return { heading: t, via: tag };
      }
    }
  }
  return { heading: '', via: '' };
};

/** Strip the host's suffix from a document title: "Manage Deleted Fields | Salesforce Help" → the article. */
function articleTitle(raw) {
  return raw.replace(/\s*[|–-]\s*(Salesforce Help|Salesforce Developers|Salesforce)\s*$/i, '').trim();
}

/**
 * Visible text including shadow roots. developer.salesforce.com renders
 * articles inside web components, and `body.innerText` sees none of it — the
 * first run of this tool called every one of those pages an empty shell.
 */
const VISIBLE_TEXT = () => {
  const parts = [];
  const skip = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        for (const child of el.shadowRoot.children) {
          if (!skip.has(child.tagName)) parts.push(child.innerText ?? '');
        }
        walk(el.shadowRoot);
      }
    }
  };
  parts.push(document.body?.innerText ?? '');
  walk(document);
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 40000);
};

/** The article heading from the top document or any frame; frames are tried in order. */
async function headingInAnyFrame(page) {
  for (const frame of page.frames()) {
    try {
      const found = await frame.evaluate(ARTICLE_HEADING);
      if (found.heading) return { ...found, via: `${found.via}${frame === page.mainFrame() ? '' : ' in frame ' + (frame.url().slice(0, 60))}` };
    } catch {
      /* a frame that navigated away mid-evaluation */
    }
  }
  return { heading: '', via: '' };
}

async function inspect(page, url) {
  const started = Date.now();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    // Both hosts are single-page apps that set the document title once the
    // article arrives, and the old `atlas` URLs redirect client-side first.
    // Poll the title for up to 25 s rather than trusting a fixed wait.
    let title = '';
    let domHeading = { heading: '', via: '' };
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(1_000);
      title = articleTitle(await page.title());
      if (title && !GENERIC_TITLE.test(title)) break;
      // Salesforce Help never changes the title; wait for the article itself,
      // in the top document or in any frame it embeds.
      domHeading = await headingInAnyFrame(page);
      if (domHeading.heading) break;
    }
    const text = await page.evaluate(VISIBLE_TEXT);
    const finalUrl = page.url();
    if (DEBUG) {
      const seen = await page.evaluate(HEADINGS_SEEN);
      console.log(`         debug og:title = ${seen.og === null ? '(none)' : `“${seen.og}”`}`);
      for (const h of seen.headings) console.log(`         debug ${h}`);
      console.log(`         debug frames: ${page.frames().map((f) => f.url().slice(0, 90) || '(about:blank)').join(' | ')}`);
      console.log(`         debug visible text: ${text.length} chars — “${text.slice(0, 240)}”`);
      const shot = 'check-docs-debug.png';
      await page.screenshot({ path: shot, fullPage: false });
      console.log(`         debug screenshot: ${shot}`);
    }
    const notFound = NOT_FOUND.some((p) => p.test(text)) || /not found/i.test(title);

    // Where the title says nothing (Salesforce Help), read the heading from the page.
    let heading = title;
    let via = 'title';
    if (!title || GENERIC_TITLE.test(title)) {
      const found = domHeading.heading ? domHeading : await headingInAnyFrame(page);
      heading = found.heading;
      via = found.via;
    }
    // A developer-docs title with no page part — "Apex Developer Guide" alone —
    // is the guide's landing page: the docs site sends a retired page there.
    const landedOnGuide = /developer\.salesforce\.com\/docs\/atlas/.test(url) && heading && !heading.includes('|');
    const noArticle = !heading;
    // Salesforce Help serves an automated browser its fallback home page
    // ("Agentforce is temporarily unavailable … visit Help topics below") and
    // never the article. Measured 2026‑09‑09. Those links cannot be judged
    // here either way; they are reported as unverified and left to a real
    // browser session — see docs/reviews/2026-09-09-doc-links.md.
    const helpFallback = /help\.salesforce\.com/.test(url) && (noArticle || /temporarily unavailable/i.test(text.slice(0, 400)));
    if (helpFallback && !notFound) {
      return { ok: null, heading: '', via, finalUrl, ms: Date.now() - started, reason: 'Salesforce Help does not render articles for a headless browser; verify in a real browser' };
    }
    const ok = !notFound && !noArticle && !landedOnGuide;
    return {
      ok,
      heading: ok ? heading : '',
      via,
      finalUrl,
      ms: Date.now() - started,
      reason: notFound
        ? 'not-found page'
        : landedOnGuide
          ? `redirected to the guide's landing page (“${heading}”) — the article id is retired`
          : noArticle
            ? `no article heading after 25 s (title: “${title || '—'}”, ${text.length} chars of text)`
            : '',
    };
  } catch (error) {
    return { ok: false, heading: '', finalUrl: url, ms: Date.now() - started, reason: String(error.message).slice(0, 80) };
  }
}

const links = collectLinks();
const previous = existsSync(SNAPSHOT) ? JSON.parse(readFileSync(SNAPSHOT, 'utf8')) : {};
const index = loadIndex();
console.log(`${links.size} distinct documentation links across ${SOURCES.length} files`);
console.log(index ? `Salesforce product-docs index loaded: ${index.byUrl.size} pages across ${index.guides.size} guides (${PRODUCT_INDEX})\n` : `No product-docs index at ${PRODUCT_INDEX}; atlas links will be loaded in the browser instead\n`);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const results = { ...previous };
let failures = 0;
let changed = 0;
let checked = 0;
let unverified = 0;

for (const [url, where] of links) {
  if (ONLY && !url.includes(ONLY)) continue;
  checked += 1;
  let r;
  if (index && guideOf(url) && index.guides.has(guideOf(url))) {
    // Judged by Salesforce's index, not by rendering — but only for guides the
    // index covers. "Absent" means retired only where "present" was possible;
    // the Reports & Dashboards REST API guide, for one, is not indexed at all.
    const title = index.byUrl.get(url.replace(/[?#].*$/, ''));
    r = title
      ? { ok: true, heading: title, via: 'product-docs index', finalUrl: url, ms: 0, reason: '' }
      : { ok: false, heading: '', via: 'product-docs index', finalUrl: url, ms: 0, reason: 'not in Salesforce\'s product-docs index — the page id is retired' };
    if (!r.ok) {
      const near = suggestFromIndex(index, url);
      if (near.length) r.reason += '\n         did you mean: ' + near.map((n) => `“${n.title}” ${n.u}`).join('\n                       ');
    }
  } else {
    r = await inspect(page, url);
  }
  const prior = previous[url];
  if (r.ok === null) {
    // Keep whatever a real browser recorded for this link; do not overwrite it.
    unverified += 1;
    console.log(`UNVERIF. ${url}\n         ${r.reason}${prior?.ok ? `  (snapshot: “${prior.heading}”)` : ''}`);
    if (prior) results[url] = prior;
    continue;
  }
  const retargeted = r.ok && prior?.heading && !sameHeading(prior.heading, r.heading);
  if (!r.ok) failures += 1;
  if (retargeted) changed += 1;
  const mark = !r.ok ? 'FAIL' : retargeted ? 'CHANGED' : 'ok';
  console.log(`${mark.padEnd(8)} ${url}`);
  if (!r.ok) console.log(`         ${r.reason}  ←  ${where.join(', ')}`);
  else if (retargeted) console.log(`         heading was “${prior.heading}”, now “${r.heading}”  ←  ${where.join(', ')}`);
  else console.log(`         “${r.heading}”  [${r.via}]${r.finalUrl !== url ? `  → ${r.finalUrl}` : ''}  (${(r.ms / 1000).toFixed(0)} s)`);
  results[url] = { ok: r.ok, heading: r.heading, finalUrl: r.finalUrl, where, checkedAt: new Date().toISOString().slice(0, 10) };
}
await browser.close();

console.log(`\n${checked - failures - unverified} of ${checked} checked links resolve, ${failures} do not, ${unverified} cannot be verified headless (Salesforce Help), ${changed} changed heading since the last snapshot.`);
if (!DRY) {
  writeFileSync(SNAPSHOT, JSON.stringify(results, null, 2) + '\n');
  console.log(`Snapshot written to ${SNAPSHOT}.`);
}
process.exit(failures > 0 ? 1 : 0);
