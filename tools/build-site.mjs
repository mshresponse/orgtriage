/**
 * Render the site: the disclosure documents as standalone pages, and the home page.
 *
 *   node tools/build-site.mjs          → site/index.html, site/privacy.html, site/permissions.html
 *
 * PRIVACY.md and docs/PERMISSIONS.md are the source of truth: the store listing
 * points at these pages, and a page that drifted from the document the code is
 * held to would be the worst kind of drift. So the pages are generated, never
 * edited by hand — change the markdown, run this, upload the output.
 *
 * Self-contained on purpose: no external stylesheet, script, font or image, so
 * the page makes no request to anyone when it is read. That is the property the
 * documents describe, and the pages should have it too.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { marked } from 'marked';

const PAGES = [
  {
    source: 'PRIVACY.md',
    out: 'site/privacy.html',
    slug: 'privacy',
    description: 'What the OrgTriage browser extension reads, where it goes, and what it never does.',
  },
  {
    source: 'docs/TERMS.md',
    out: 'site/terms.html',
    slug: 'terms',
    description: 'OrgTriage is a diagnostic tool, not an adviser: findings are recommendations to be verified, and the software is provided as is.',
  },
  {
    source: 'docs/PERMISSIONS.md',
    out: 'site/permissions.html',
    slug: 'permissions',
    description: 'Every browser permission the OrgTriage extension asks for, what each one allows, and how to verify it yourself.',
  },
];

/** Rewrites for references that only make sense inside the repository. */
const REWRITES = [
  [/See `docs\/SECURITY\.md` for the full trust model\./g, 'The full trust model is in the security design document that ships with the source.'],
  [/`docs\/SECURITY\.md`/g, 'the security design document'],
  [/See also: Privacy Policy · Help Center/g, 'See also: [Privacy Policy](privacy.html)'],
  [/Companion "Browser permissions, explained" page drafted at\s+`docs\/PERMISSIONS\.md`/g, 'Browser permissions, explained'],
];

/**
 * The wordmark, inlined from the brand package with the ink lettering switched
 * to the text colour so one file serves both themes. The arrow stays mint.
 * Outlined lettering: no font is loaded, and the page still requests nothing.
 */
const WORDMARK = readFileSync('brand/08-website/wordmark-light.svg', 'utf8')
  .replace(/^<\?xml[^>]*>\s*/, '')
  .replace(/<svg /, '<svg class="wordmark" ')
  .replace(/fill="#122B39"/g, 'fill="currentColor"')
  .replace(/<svg\b[^>]*>/, (root) => root.replace(/ (?:width|height)="[^"]*"/g, ''));

/**
 * Where the Chrome Web Store listing will live. Null until the listing is
 * approved: the page then shows the store as pending rather than linking to a
 * URL that does not resolve. The brand copy's own rule — publish availability
 * wording when the surface is live.
 */
const STORE_URL = null;

/** Public project links. Set either to null to omit its links from every page. */
const REPO_URL = 'https://github.com/mshresponse/orgtriage';
const ISSUES_URL = REPO_URL ? `${REPO_URL}/issues/new/choose` : null;

const CSS = `
/* Brand tokens from brand/10-brand/colors.json: Paper ground, Ink text, Slate muted, Line rules, Forest links (4.84:1 on Paper). */
:root { color-scheme: light dark; --bg:#F5F7F3; --fg:#122B39; --muted:#506873; --rule:#D8E1DB; --accent:#087B63; --code:#e9eee9; }
@media (prefers-color-scheme: dark) { :root { --bg:#122B39; --fg:#F5F7F3; --muted:#b3c2c9; --rule:#2a4250; --accent:#42E2B8; --code:#1b3846; } }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.6 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
header, main, footer { max-width: 60rem; margin: 0 auto; padding: 0 1.25rem; }
header { padding-top: 2rem; display:flex; justify-content:space-between; align-items:center; gap:1.5rem; flex-wrap:wrap; padding-bottom:1.5rem; border-bottom:1px solid var(--rule); }
header .brand { font-weight:700; letter-spacing:.01em; text-decoration:none; color:var(--fg); font-size:1.05rem; display:inline-flex; align-items:center; gap:.45rem; }
header .brand .wordmark { width:180px; height:auto; display:block; }
header nav { display:flex; align-items:center; gap:1.5rem; }
header nav a { color:var(--muted); text-decoration:none; padding:.3rem 0; }
header nav a[aria-current] { color:var(--fg); border-bottom:2px solid var(--accent); }
main { padding: 2rem 1.25rem 4rem; }
/* The documents are read, not scanned: they keep a reading measure. */
html:not(.home) main { max-width:44rem; }
a:focus-visible { outline:2px solid var(--accent); outline-offset:5px; }
@media (max-width:520px) { header { gap:1rem; padding-top:1.25rem; } header .brand .wordmark { width:150px; } header nav { gap:1rem; font-size:.9rem; } }
h1 { font-size:2rem; line-height:1.2; margin:1rem 0 .5rem; }
h2 { font-size:1.35rem; margin:2.2rem 0 .6rem; padding-top:1.2rem; border-top:1px solid var(--rule); }
h3 { font-size:1.1rem; margin:1.6rem 0 .4rem; }
p, li { max-width: 68ch; }
a { color:var(--accent); }
code { font: .9em ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; background:var(--code); padding:.1em .35em; border-radius:4px; }
pre { background:var(--code); padding:1rem; overflow-x:auto; border-radius:6px; }
pre code { background:none; padding:0; }
table { border-collapse:collapse; width:100%; margin:1rem 0; display:block; overflow-x:auto; }
th, td { text-align:left; vertical-align:top; padding:.6rem .7rem; border-bottom:1px solid var(--rule); }
th { font-weight:600; }
blockquote { margin:1rem 0; padding:.2rem 1rem; border-left:3px solid var(--rule); color:var(--muted); }
hr { border:0; border-top:1px solid var(--rule); margin:2rem 0; }
footer { color:var(--muted); font-size:.9rem; padding:1.5rem 1.25rem 3rem; border-top:1px solid var(--rule); }
footer a { color:var(--muted); }
`;

/** Extra styling for the home page only; the document pages keep the reading layout. */
const HOME_CSS = `
.home main { max-width: 60rem; }
.hero { padding: 2.5rem 0 2rem; }
.hero .eyebrow { color:var(--accent); font-weight:650; font-size:.9rem; letter-spacing:.04em; margin:0 0 1.1rem; }
.hero h1 { font-size: clamp(2.15rem, 4.5vw, 3.6rem); letter-spacing:-.035em; margin:0 0 1.25rem; max-width:26ch; text-wrap:balance; }
.hero .sub { font-size: 1.15rem; color: var(--muted); max-width: 62ch; margin: 0 0 1.5rem; }
.journey { display:flex; flex-wrap:wrap; gap:.5rem 1rem; align-items:center; margin: 0 0 1.4rem; font-weight:600; letter-spacing:.02em; }
.journey span { color: var(--accent); }
.journey .arrow { color: var(--muted); font-weight:400; }
.cta { display:flex; flex-wrap:wrap; gap:.75rem; align-items:center; margin: 0 0 .6rem; }
.button { display:inline-block; padding:.7rem 1.1rem; border-radius:8px; font-weight:600; text-decoration:none; }
.button--brand { background:#122B39; color:#F5F7F3; }
@media (prefers-color-scheme: dark) { .button--brand { background:#42E2B8; color:#122B39; } }
.button--pending { border:1px solid var(--rule); color:var(--muted); cursor:default; }
.note { color: var(--muted); font-size:.95rem; }
.surfaces { display:grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap:1rem; margin: 1rem 0; }
.surface { border:1px solid var(--rule); border-radius:10px; padding:1rem 1.1rem; }
.surface h3 { margin:0 0 .35rem; font-size:1.05rem; }
.surface .status { display:inline-block; font-size:.78rem; font-weight:600; letter-spacing:.04em; text-transform:uppercase; padding:.15rem .5rem; border-radius:999px; border:1px solid var(--rule); color:var(--muted); margin-bottom:.5rem; }
.surface .status--live { color:var(--accent); border-color:var(--accent); }
.surface p { margin:.3rem 0; font-size:.97rem; }
.areas { display:grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap:.6rem 1.5rem; padding:0; list-style:none; margin: 1rem 0; }
.areas li { padding:.5rem 0; border-bottom:1px solid var(--rule); }
.areas b { display:block; }
.areas span { color: var(--muted); font-size:.95rem; }
.shots { display:grid; grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr)); gap:1.2rem; margin: 1rem 0; }
.shots figure { margin:0; }
.shots img { width:100%; height:auto; border:1px solid var(--rule); border-radius:8px; display:block; background:#fff; }
.shots figcaption { color: var(--muted); font-size:.9rem; margin-top:.4rem; }
.facts { padding-left: 1.2rem; }
.facts li { margin: .35rem 0; }
`;

/** Ten areas, one honest line each — what the analyzer reads, not what it promises. */
const AREAS = [
  ['Apex', 'Org-wide and per-class test coverage against the 75% deployment gate, triggers without coverage, stale API versions, failing and stale test runs.'],
  ['Apex code quality', 'Source-level patterns in your own classes: empty catch blocks, hard-coded ids, unbounded queries, oversized classes.'],
  ['Flows', 'DML and queries inside loops, missing fault paths, run-order collisions, old API versions, version clutter, never-activated flows, Process Builder and workflow rules still in place.'],
  ['Reports & dashboards', 'Reports with no filters, unindexed filters, long-text filters that silently truncate, dashboards that never refresh or point at reports the scan cannot find.'],
  ['Layouts & SLDS', 'Field-heavy layouts against Salesforce\'s own recommendation, Lightning page component counts, and stylesheet checks for retired SLDS patterns.'],
  ['Field usage', 'Custom fields nothing references, fields with no description, validation rules carrying ids that will not survive a deployment.'],
  ['Access & permissions', 'Dormant admins, Modify All Data holders, passwords set never to expire, unassigned permission sets, idle licences.'],
  ['Security settings', 'Your Health Check score and the settings that sit below Salesforce\'s baseline, read from the same API the Setup page uses.'],
  ['Operations', 'Scheduled jobs in error, orphaned jobs, paused flow interviews, stuck approvals, release updates due, hard-coded URLs in buttons.'],
  ['Limits & storage', 'Data and file storage, the rolling 24-hour API allowance, debug-log volume, and every org limit with little headroom left.'],
];

/** Captures from the built-in sample org, rendered by tools/capture-site.mjs. */
const SHOTS = [
  ['images/panel-overview.png', 'The Overview: org health across ten areas, what to fix first, and what a scan costs in API calls.'],
  ['images/panel-work.png', 'The Work tab: every open finding in the same priority order as the plan.'],
  ['images/panel-area.png', 'An area in detail: findings with affected components, steps, and the documentation behind the rule.'],
  ['images/report.png', 'The remediation plan: backlog items with steps, acceptance criteria and estimates, exported to Markdown, CSV or Jira.'],
];

function shell({ slug, title, description, body, home = false, note }) {
  const nav = [['index', 'Home'], ['privacy', 'Privacy'], ['permissions', 'Permissions'], ['terms', 'Terms']]
    .map(([s, label]) => `<a href="${s === 'index' ? '/' : `${s}.html`}"${s === slug ? ' aria-current="page"' : ''}>${label}</a>`)
    .join('');
  return `<!doctype html>
<html lang="en"${home ? ' class="home"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}${home ? '' : ' — OrgTriage'}</title>
<meta name="description" content="${escape(description)}">
<meta name="robots" content="index,follow">
<link rel="canonical" href="https://orgtriage.com/${slug === 'index' ? '' : `${slug}.html`}">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml" sizes="any">
<link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
<link rel="manifest" href="/site.webmanifest">
<meta name="theme-color" content="#122B39">
<meta name="application-name" content="OrgTriage">
<meta property="og:type" content="website">
<meta property="og:site_name" content="OrgTriage">
<meta property="og:title" content="${escape(title)}${home ? '' : ' — OrgTriage'}">
<meta property="og:description" content="${escape(description)}">
<meta property="og:url" content="https://orgtriage.com/${slug === 'index' ? '' : `${slug}.html`}">
<meta property="og:image" content="https://orgtriage.com/og-image.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="OrgTriage — Assess, Prioritize, Act. Turn Salesforce org findings into a prioritized backlog.">
<meta name="twitter:card" content="summary_large_image">
<style>${CSS}${home ? HOME_CSS : ''}</style>
</head>
<body>
<header>
  <a class="brand" href="/" aria-label="OrgTriage home">${WORDMARK}</a>
  <nav aria-label="Site">${nav}</nav>
</header>
<main>
${body}
</main>
<footer>
  <p>OrgTriage is published by Everything Virtually LLC.
    <a href="mailto:mike@everythingvirtually.com?subject=OrgTriage">Contact</a>${
      ISSUES_URL ? ` · <a href="${ISSUES_URL}">Report a bug or request a feature</a>` : ''
    }${
      REPO_URL ? ` · <a href="${REPO_URL}">Source on GitHub</a>` : ''
    } · <a href="privacy.html">Privacy</a> · <a href="permissions.html">Permissions</a> · <a href="terms.html">Terms</a></p>
  <p>OrgTriage is provided as is, without warranty. Findings are recommendations: have an experienced Salesforce administrator or developer verify any change, and test it outside production. Not affiliated with Salesforce, Inc.</p>
  <p>${note}</p>
</footer>
</body>
</html>
`;
}

function render({ source, out, slug, description }) {
  let md = readFileSync(source, 'utf8');
  for (const [pattern, replacement] of REWRITES) md = md.replace(pattern, replacement);

  // The first heading becomes the page title; the rest renders as the body.
  const match = /^# (.+)\n/.exec(md);
  const title = match ? match[1].replace(/ — OrgTriage$/, '') : slug;
  const body = marked.parse(match ? md.slice(match[0].length) : md, { gfm: true });

  const html = shell({
    slug,
    title,
    description,
    body: `<h1>${escape(title)}</h1>\n${body}`,
    note: 'This page loads no external scripts, fonts, images or stylesheets.',
  });
  mkdirSync('site', { recursive: true });
  writeFileSync(out, html);
  console.log(`${out}  ←  ${source}  (${(html.length / 1024).toFixed(0)} KB)`);
}

function renderHome() {
  const store = STORE_URL
    ? `<a class="button button--brand" href="${STORE_URL}">Add to Chrome</a>`
    : `<span class="button button--pending" title="The listing is being submitted; this becomes the install button when it is live.">Chrome Web Store — listing pending</span>`;

  const body = `
<section class="hero">
  <p class="eyebrow">Salesforce org-health assessment</p>
  <h1>Turn Salesforce org findings into a prioritized backlog.</h1>
  <p class="sub">Assess org health, rank issues by impact, and create Jira work items with steps to follow.</p>
  <p class="journey"><span>Assess</span><span class="arrow">&rarr;</span><span>Prioritize</span><span class="arrow">&rarr;</span><span>Act</span></p>
  <div class="cta">${store}<a href="privacy.html">How your data is handled</a></div>
  <p class="note">Free, read-only assessments in Chrome&rsquo;s side panel. No Salesforce package installation required. Analysis runs locally, with no OrgTriage server or telemetry.</p>
</section>

<h2>Choose how you work</h2>
<div class="surfaces">
  <div class="surface">
    <span class="status status--live">Browser extension</span>
    <h3>OrgTriage for Chrome</h3>
    <p>Assess ten areas of org health from Chrome&rsquo;s side panel. Review prioritized findings and export a remediation plan with effort estimates.</p>
    <p class="note">${STORE_URL ? 'Available on the Chrome Web Store.' : 'Chrome Web Store listing pending.'}</p>
  </div>
  <div class="surface">
    <span class="status">Coming soon</span>
    <h3>Claude Code skills</h3>
    <p>Two skills for Claude Code: one assesses an org through the Salesforce CLI and builds the same prioritized backlog; the other takes one item and does the work in a Salesforce project, on a branch, with a pull request for review. The extension itself uses no AI.</p>
    <p class="note">Published with the source repository.</p>
  </div>
  <div class="surface">
    <span class="status">Planned</span>
    <h3>In-org app</h3>
    <p>Review findings and coordinate remediation with your team inside Salesforce, with findings saved over time instead of kept in one admin&rsquo;s browser.</p>
    <p class="note">Release timing to be announced.</p>
  </div>
</div>

<h2>What it checks</h2>
<p>Ten areas, each scored on its own and combined into one org-health grade. Rules cite the documentation behind them where it exists &mdash; Salesforce&rsquo;s, or the open-source linter the rule came from &mdash; and say plainly when a threshold is our recommendation rather than a Salesforce limit.</p>
<ul class="areas">
${AREAS.map(([name, line]) => `  <li><b>${escape(name)}</b><span>${escape(line)}</span></li>`).join('\n')}
</ul>

<h2>From finding to backlog</h2>
<p>Each finding becomes a backlog item with a priority, affected components, steps to fix it, acceptance criteria and an estimate in hours and points. Export the plan to Markdown, CSV for your tracker, or a Jira import that creates Bugs for incorrect behaviour and Tasks for maintenance and cleanup.</p>

<h2>Understand the scan</h2>
<ul class="facts">
  <li><b>Read-only.</b> It reads configuration, metadata and Apex source. It never writes to your org, never executes a report, and never reads business records &mdash; no accounts, contacts, leads or custom data.</li>
  <li><b>Your session, in your browser.</b> API calls go from the extension&rsquo;s service worker straight to your own Salesforce org. The session id is used only to authenticate those calls and is sent nowhere else.</li>
  <li><b>No backend, no telemetry.</b> There is no OrgTriage server. Scan results live in your browser&rsquo;s local storage and nowhere else, and you choose when to export a plan.</li>
  <li><b>API usage.</b> Every area shows how many API calls it used, and the footer shows what OrgTriage has used against your org&rsquo;s rolling 24-hour allowance. Nothing scans on its own.</li>
  <li><b>Scan coverage.</b> An area that could not be checked is marked as unchecked, not given a clean score. Managed-package components are excluded by default, and the scan shows how many it excluded.</li>
</ul>
<p>Read the <a href="privacy.html">privacy policy</a>, including the limited user information the access and operations checks read, and the <a href="permissions.html">permissions explainer</a>. Both describe what the code does.</p>

<h2>Use it with judgement</h2>
<p>OrgTriage is a diagnostic tool, not an adviser, and it is provided as is. Every finding is a recommendation. A high score is not a statement that your org is secure or correctly configured, and an area that could not be checked is marked as unchecked, not given a clean score.</p>
<p>Have an experienced Salesforce administrator or developer review any change before it is made, test it outside production, and deploy it the way you deploy everything else. The <a href="terms.html">terms of use</a> explain this in detail.</p>

<h2>Help improve OrgTriage</h2>
<p>Email <a href="mailto:mike@everythingvirtually.com?subject=OrgTriage">mike@everythingvirtually.com</a>${
    ISSUES_URL ? ` · <a href="${ISSUES_URL}">Report a bug or request a feature</a>` : ''
  }${
    REPO_URL ? ` · <a href="${REPO_URL}">Source on GitHub</a>` : ''
  }. If a rule gets something wrong in your org, tell us what it reported and what you expected.</p>

<h2>Open source</h2>
<p>OrgTriage is open source under Apache 2.0. Issues and pull requests are welcome. Do not include org names, user names, record data, session details or an exported plan in a bug report. Findings name your users and components; describe them instead, and remove identifying details from screenshots.</p>

<h2>See OrgTriage in action</h2>
<p class="note">Screenshots use Northwind Trading, the built-in sample org &mdash; sample data, not a customer org.</p>
<div class="shots">
${SHOTS.map(([src, caption]) => `  <figure><img src="${src}" alt="${escape(caption)}" loading="lazy"><figcaption>${escape(caption)}</figcaption></figure>`).join('\n')}
</div>
`;

  const html = shell({
    slug: 'index',
    title: 'OrgTriage — Salesforce findings to a prioritized backlog',
    description: 'Assess org health, rank issues by impact, and create Jira work items with steps to follow. A free, read-only Chrome extension for Salesforce admins.',
    body,
    home: true,
    note: 'This page loads screenshots from this site, with no external scripts, fonts or trackers.',
  });
  mkdirSync('site', { recursive: true });
  writeFileSync('site/index.html', html);
  console.log(`site/index.html  ←  tools/build-site.mjs  (${(html.length / 1024).toFixed(0)} KB)`);
}

function escape(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

for (const page of PAGES) render(page);
renderHome();
