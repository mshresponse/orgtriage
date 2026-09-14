# OrgTriage

**Turn Salesforce org findings into a prioritized backlog.**

Assess org health, rank issues by impact, and create actionable Jira work items.

A Chrome extension that gives Salesforce admins a real org-health read-out
beside Lightning — Apex, Flows, Reports & Dashboards, and Layouts/SLDS — in
Chrome's side panel, which stays open while you click through the org. Every
finding becomes a backlog item with steps, acceptance criteria and an
estimate. The Jira export creates Bugs (behaviour that is wrong) and Tasks
(maintenance, cleanup and configuration work); it never creates Stories,
because a finding is a fix to something that exists, not a new capability.

OrgTriage is a diagnostic tool, not an adviser, and it is provided as is
without warranty. Every finding is a recommendation: have an experienced
Salesforce administrator or developer verify it, test the change outside
production, and deploy it the way you deploy everything else. The full terms
are in [`docs/TERMS.md`](docs/TERMS.md).

Every Salesforce API fact this tool relies on is recorded in a facts ledger
compiled from the Salesforce Developer Portal, Salesforce Help, the Chrome
extension documentation, and measurements against real orgs; the source
comments cite it as `docs/FACTS.md`. It is kept with the private working notes
because it names the orgs it was measured on. Where the docs do not answer a
question, the code says so rather than guessing — the ledger has an explicit
"OPEN QUESTIONS / DO NOT GUESS" section, and every rule that carries a number
either cites its Salesforce source or says the number is OrgTriage's own.

---

## What it does

### The panel

Three views, because ten areas do not fit a tab strip in a 360px column — and
because a tab per analyzer asks the reader to know which analyzer owns their
problem before they can look at it:

| View | What it answers |
|---|---|
| **Overview** | How is the org doing, and what will a scan cost |
| **Work** | What should I do, worst first — every open finding across every area, ranked exactly the way the remediation plan numbers its backlog items, expandable in place to its fix steps and acceptance criteria, filterable by priority, area and who does the work |
| **Areas** | What was checked — the card grid, drilling into one area's findings behind a back link |

The panel is Chrome's own side panel (since 0.8.18). The browser places it
beside the page, narrows the page to make room, remembers the width you drag it
to, and keeps it open across every navigation in the tab — Setup pages, which
Salesforce serves from a separate domain, included. Clicking a component in a
finding opens it in the Salesforce tab with the finding still on screen.

- The toolbar icon or `Alt+Shift+O` opens it; Chrome's own control closes it.
- It follows the active tab, and reconnects only when the tab's origin changes.
- On tabs that are not Salesforce it is switched off rather than shown empty.

Nothing is injected into the Salesforce page: there is no content script, no
iframe in the page, and no CSS applied to Lightning.

### The ten analyzers

Each produces a 0–100 score, headline metrics, and findings with evidence,
rationale, remediation, and a link to the documentation behind the
rule.

**Apex** — org-wide and per-class coverage against the 75% deployment gate,
components with no coverage, triggers at 0%, multiple active triggers on one
object, stale API versions, `IsValid = false` components needing recompile, no
Apex exception-email recipients, stale or failing test runs.

**Flows** — two layers. Per-flow static analysis comes from [Lightning Flow
Scanner](https://github.com/Flow-Scanner/lightning-flow-scanner) (MIT, pinned):
SOQL, DML and actions inside loops, missing fault paths, no entry criteria,
system mode without sharing, suspected credentials, recursive after-save
updates, updates that belong before save, unchecked Get Records results,
repeatable screen-flow operations, all-fields retrievals, unreachable elements,
unused variables and excessive complexity. Twenty-one rules, each re-severitied
and re-explained here — OrgTriage takes the detection and writes its own advice.

On top sit the checks a per-flow scanner structurally cannot make, because they
compare flows to each other or read the inventory rather than the metadata:
trigger-order collisions on the same object, Process Builder / workflow-era
automation, workflow rules still in place (active flag read per rule up to a
budget), never-activated flows, version clutter, stale API versions, legacy
Cloud Flow Designer flows, a key-prefix-validated heuristic for hard-coded
record IDs, and managed-package flows reported as unexamined rather than clean.

**Reports & Dashboards** — unfiltered full-object scans, abandoned reports,
hidden report types, private/unfiled folders, structurally duplicated reports,
dashboard components pointing at deleted reports, stale dashboards, and fixed
running users. Eleven performance rules compare each report's describe with
Salesforce's "Improve Report Performance" guidance (operators, date range,
cross filters, columns, formulas, buckets, groupings), a twelfth checks the
custom fields a report filters on against `FieldDefinition.IsIndexed`, and a
dashboard rule multiplies components by filter values to find dashboards that
re-run hundreds of reports per refresh. **This analyzer never executes a
report** — see below.

**Layouts & SLDS** — field-heavy layouts, oversized sections, layouts near the
100 related-list limit, Lightning page regions past the documented 100
components-per-region limit (applying Salesforce's non-obvious counting rules),
Report Chart components that run a report on every page view, pages with no
recorded usage, and a lint of the org's custom Aura and LWC stylesheets against
the CSS rules the official SLDS linter enforces (its HTML-only checks are out of
reach from CSS, so this is a stylesheet pass, not full conformance).

It also answers the question Lightning App Builder's **Analyze** panel answers,
across every page at once instead of one at a time. Page speed tracks what a
page assembles *before* it is usable, not what it contains — everything but the
first tab of a Tabs component, and every closed accordion section, loads only
when opened. So pages are measured on their **eagerly loaded** component count,
and a page that defers almost nothing is flagged separately as the cheapest win
available. Alongside the estimate, the **measured** page time from the Lightning
Usage app is read where the org exposes it: the object is described at scan time
and the duration field discovered rather than assumed, because that schema
differs by release — where it is absent the check reports itself unevaluated
instead of silently passing.

**Limits & storage** — the ceilings an org walks into rather than the metadata
it accumulates. Data and file storage headroom, the daily API allowance already
spent when the scan ran, every other org limit with under 20% left, and which
objects the data storage actually went into. Also the **debug log ceiling**,
which has no entry in `/limits` and is measured from `ApexLog`: past 1,000 MB
accumulated, *nobody in the org can add or edit a trace flag* until someone
deletes logs, so the first symptom is a developer who cannot turn on logging
during a production incident. The trace flags still switched on — the usual
cause — are listed alongside it. Two endpoints answer the whole
area, which makes it the cheapest scan here — about two API calls whatever the
size of the org. Per-object storage figures apply Salesforce's published record
rates (2 KB for most records, with the documented exceptions) and are labelled
an estimate wherever they appear; Email Messages are billed at their actual size
and so are counted but never estimated.

**Security settings** — Salesforce's own Health Check, read rather than
reimplemented. The tiles count settings that sit off the baseline, so they read
lower than the group headers on the Health Check page, which count compliant
settings too; the Low risk tile folds in Salesforce's Informational group. The
baseline is whatever Health Check is configured with: Salesforce's standard, or a
custom one, which the area names. Salesforce's standard moves with
each release, so a copy here would silently drift; `SecurityHealthCheck` and
`SecurityHealthCheckRisks` are queryable Tooling objects needing only View Setup
and Configuration. What this adds over the Setup page: the risks become backlog items
with owners and estimates, they are compared against the previous scan, and they
sit beside everything else wrong with the org.

**Field usage** — custom fields referenced by no Apex class, active flow or
validation rule. Page layouts, Lightning pages and report columns are *not*
read — fetching them costs hundreds of calls in a large org — and every finding
says so, so a field used only on a layout is a candidate to check, not a
verdict. This is a narrower question than Optimizer asked: Optimizer sampled
how many records have a field populated, which needs record data, and this
extension reads none. A field written only by an integration will appear here
and may be in daily use, so the remediation begins with "confirm before
deleting".

**Apex code quality** — source-level checks over the Apex actually deployed in
the org, which is often not what is in the repository: queries and DML inside
loops, undeclared sharing, swallowed exceptions, hard-coded ids, unbounded
queries. Comments and string literals are stripped before anything is matched,
loop bodies are found by brace matching rather than a line window, and every
check is labelled a heuristic biased towards under-reporting. Salesforce Code
Analyzer in a pipeline is the tool for a definitive answer.

**Access** — who holds the permissions that ignore the sharing model. Modify
All Data sprawl past a handful of active holders, privileged accounts dormant
for ninety days, Password Never Expires, View All Data without Modify All,
Author Apex in production, Customize Application, Manage Users, deactivated
users still holding permission set assignments, unassigned permission sets,
custom profiles with no active users, and licence seats held by users who have
not logged in for ninety days or never logged in at all (counted per licence
type from `UserLicense`, never by name). All three grant routes are joined:
profiles (through `User.ProfileId`, not through assignment rows), permission
sets, and permission set groups expanded through `PermissionSetGroupComponent`.
Muting permission sets are not modelled and the analyzer says so rather than
over-reporting.

**Ops** — the run-time problems that only surface on scattered Setup pages:
batch, queueable and future jobs failing in the last week (AsyncApexJob),
scheduled jobs in ERROR or BLOCKED, scheduled jobs owned by a deactivated user
(the usual way a nightly process silently stops), hours of the day with five or
more jobs stacked, failed and long-paused flow interviews grouped by flow,
approval requests pending for a month or assigned to a deactivated approver,
release updates with steps outstanding before their enforcement date, custom
buttons and links whose URL names a Salesforce host or a record id, and who is
using the API from what (Login History by user and application).
Unhandled Apex exception counts are deliberately absent: Salesforce exposes them
only by email or through the paid Event Monitoring add-on.

The Ops tab also points at **API usage by user**, which OrgTriage does not
compute: it has two sources in Salesforce, and the tab links to both. The
Classic *API Usage Last 7 Days* report (Administrative Reports folder;
Salesforce notes it misses some Bulk API calls) and the `ApiTotalUsage` event
log — one line per request with the user and client, free in Developer,
Enterprise, Unlimited and Performance editions with one day of retention once
*Generate Event Log Files* is on. Earlier versions had a button that tried to
run the Classic report; it never could — standard reports are not `Report`
records, so the lookup found nothing — and the only thing it could have run was
a custom report someone had named "API Usage…". It is gone, and with it the
last exception to "never executes a report".

### The remediation plan

Findings are only useful once they are on a backlog. **Remediation plan** (on
the Overview tab, or **Plan** on any analyzer) opens a printable document built
from the cached snapshots, with no further API calls:

- **Grouped into epics**, one per area and named for the workstream rather than
  the analyzer, so the plan imports as a hierarchy rather than a flat list.
- **One story per finding**, keyed `OT-001`… in priority order, each with the
  rationale, numbered fix steps for that rule (Setup paths included), acceptance
  criteria, a role (admin or developer), a T-shirt size and a planning estimate
  in hours, and the affected components with their evidence.
- **An executive summary** — scores per area, how much of each area could
  actually be checked, story and estimate totals — and a **backlog table** that
  fits on one page.
- **A "Progress since the previous scan" section.** Each area is compared with
  the snapshot it replaced: score movement, what was fixed, what is new. Omitted
  entirely when there is nothing to compare against — a "Progress" heading
  reading "no data" lands as "no progress". A check that could not be evaluated
  this time is never reported as resolved.
- **A "Not evaluated" appendix.** Checks that could not run, partial scans, and
  work that needs a person (joined reports, managed-package flows) are listed
  there and never counted as clean.
- **Filters** that the exports honour, so what downloads is what is on screen:
  priority pills, a keyword filter over titles, rules and component names, and a
  per-area filter driven from the breakdown matrix.
- **Four export formats:**
  - **CSV for Jira**, with every epic ahead of its own children — Jira's importer
    creates rows in file order and resolves `Epic Link` against epics that
    already exist, so the order is the contract. It carries both hierarchy
    mechanisms, `Issue ID`/`Parent` and `Epic Name`/`Epic Link`, because which
    one a site accepts depends on its project type. `Project key` is left empty
    for the import wizard to fill. Team-managed projects cannot always expose
    `Parent`; the page says so rather than letting the import fail quietly.
  - **CSV for any other tracker** — flat, one row per story, plain column names.
  - **Markdown** for Confluence or a wiki, and **JSON** of the whole plan for
    anyone driving a tracker's API instead of its importer.
  - **Print / save as PDF**, which always renders light whatever theme the page
    is being read in.

The step-by-step guide is also available inside each finding in the panel.
Estimates are planning figures for an experienced admin or developer, with
per-component cost tapering after fifty. They are given in hours, person-days
and sprints, and story points are derived from the hours rather than estimated
separately so the two can never disagree. Every conversion constant is stated on
the page, because those are the assumptions a client will argue with.

### What the other tools do, and what is left over

Worth being accurate about this, because the gap is narrower than it looks.
Salesforce Inspector Reloaded ships a Flow Scanner, a Dependencies Explorer,
field-population percentages, a debug-log viewer and an org-limits page — but it
works a flow, or an object, at a time. Org Check (Salesforce Labs, free, the
tool Salesforce Help names in place of the Optimizer it retired in 2026) has around a
hundred rules across the org. Both embed the same flow engine this does.

So the flow rules here are not a differentiator, and pretending otherwise would
be silly. These are:

- **A plan, not a list.** Every finding carries fix steps, a role, an effort
  estimate and an acceptance criterion, ranked into a backlog and exportable as
  Jira-shaped CSV. No free tool does this, and it is the part a client pays for.
- **Reports and dashboards.** Org Check's only report rule is "no description".
  Unfiltered full-object scans, non-selective operators, cross filters, wide
  date ranges, runtime formulas, missing row limits, bucket fields, unindexed
  filter fields and dashboard filter load have no equivalent in a free tool.
- **SLDS 2 migration readiness.** The custom Aura/LWC stylesheets in the org are
  linted against the rules the official `@salesforce-ux/slds-linter` enforces:
  `--slds-c-*` component hooks (SLDS 1 only, dead under Cosmos), private
  `--slds-s-*` / `--_slds-*` variables, deprecated `--lwc-*` design tokens,
  retired `--` BEM syntax, `.slds-*` overrides, hard-coded colours, and hooks
  with no fallback. Nothing in Setup surfaces this.
- **Report scan-risk without running anything.** Full-table-scan reports are
  identified from `describe` metadata — no filters, no cross filters, no row
  limit, no boolean logic, no hierarchy filter, and no effective date range.
- **Cross-referenced dashboard integrity.** Dashboard components are joined
  against the report inventory to find components pointing at deleted reports.
- **Honest scoring.** A rule that could not be evaluated is reported as *not
  evaluated*, never as a pass.

---

## Install (unpacked)

```bash
npm install && npm run build
```

Then open `chrome://extensions`, enable Developer mode, choose **Load unpacked**,
and select the `dist/` folder. Open any Lightning page and click the toolbar
icon, or press `Alt+Shift+O`.

## Preview the UI without an org

```bash
npm run dev:preview
```

Open the printed URL at `/dev/preview.html`. It renders the real panel against
fixture data with the `chrome.*` APIs stubbed, at the widths a side panel is
usually dragged to, in both themes. Nothing under `src/dev/` is part of any
shipped bundle.

## Commands

```bash
npm run build           # the extension into dist/
npm run typecheck       # tsc --noEmit
npm test                # regression tests over payloads captured from a live org
npm run check:contrast  # WCAG 2.2 AA gate over the theme (52 pairings)
npm run check:palette   # chart palette: lightness, chroma, CVD separation
npm run zip             # build and package for the Web Store
node tools/make-icons.mjs   # regenerate the icons from their procedural source

# Layout check (needs Playwright and a Chromium, and the preview running)
node tools/panel-scroll-check.mjs   # the panel scrolls its findings list at every width
```

---

## Design

**Azure and Charcoal.** A single chromatic accent family (Salesforce blue) over
a charcoal neutral ramp, with a status ramp retuned into the same family so a
warning rail and a warning bar segment are the same colour. The overview leads
with a score dial, KPI tiles and a card per area rather than a table: a table
gave an A and an F the same visual weight.

The layout is tuned for scanning hundreds of metadata rows: 13px base, 28px
table rows (SLDS uses 32px), monospace API names, tabular figures, sticky table
headers, and a 3px severity rail on each finding so severity survives being read
in a 360px-wide column.

Colour is never the only signal — every severity rail is paired with a text
badge. `npm run check:contrast` parses `src/styles/theme.css`, resolves the
`var()` chains, and asserts all 52 foreground/background pairings clear WCAG 2.2
AA (4.5:1 for text, 3:1 for UI boundaries) in **both** themes. It exits non-zero
on regression.

Charts get a second, separate gate. `npm run check:palette` validates the seven
categorical slots by computation rather than taste: OKLCH lightness band, chroma
floor, and OKLab ΔE between *adjacent* slots under simulated protan and deutan
vision (Machado, Oliveira & Fernandes 2009). Slot **order** is the safety
mechanism, because adjacent slots are the ones a stacked bar puts side by side —
reordering them changes what the check measures. Three light-mode slots sit below
3:1 on white, which is permitted only because every chart here carries a direct
label or a legend with the value.

### On SLDS

The theme is expressed as SLDS **2** global styling hooks (`--slds-g-*`), and
only names that appear in the published global-hooks reference. Three things are
deliberately absent, all for the same reason the analyzer flags them in your org:

- `--slds-c-*` component hooks are SLDS 1 only and do not work under SLDS 2 /
  Cosmos, GA in Winter '26.
- `--slds-s-*` and `--_slds-*` are private and their use is prohibited.
- `--lwc-*` design tokens are unsupported in SLDS 2.

---

## Security

The full model is in [`docs/SECURITY.md`](docs/SECURITY.md). In short:

- **No credentials, anywhere.** OrgTriage never asks for a password and stores no
  secret. It uses the Salesforce session your browser already holds.
- **The session id is used only inside the service worker, and only to
  authenticate requests to your own Salesforce org.** It is not modelled in any
  message type, so it cannot reach the panel or the report page; it is never
  written to `chrome.storage` (not even `storage.session`), and never logged. `auth.ts` exposes `signedFetch`, not the token — the
  boundary is structural, not a convention.
- **Nothing can connect to a non-Salesforce host.** The extension CSP restricts
  `connect-src` to the Salesforce host patterns, so there is no destination to
  exfiltrate to. (This policy covers the service worker too — it is not possible
  in MV3 to give the panel a stricter network policy than the worker.)
- **The panel cannot choose which org to query.** It names the tab it is
  beside, and the worker reads that tab's URL from the browser, never from the
  message body — so it can only ask about a tab the user actually has open.
- **The page cannot reach the panel.** The side panel is browser chrome, not
  part of the page: nothing is injected into Lightning and no page script can
  see the panel at all.
- **Three permissions:** `cookies`, `storage` and `sidePanel`. None produces an
  install-time warning. No `tabs`, no `scripting`, no `declarativeNetRequest`.

---

## Cost and honesty

Every scan spends the org's daily API allowance, so the tool is explicit about it:

- **Nothing refreshes automatically.** Ever. A scan happens because someone
  pressed a button. Cached snapshots are shown with their age, and the status bar
  says when the org has changed underneath them.
- **The cost is stated before it is spent.** Each area card carries what a scan
  of it costs — the derived estimate until it has been run once, the measured
  figure afterwards — and the Scan-all button totals them. Any area can be
  unticked so the sweep leaves it alone and it is run deliberately on its own;
  nothing is excluded by default, because a partial picture that looks complete
  is worse than an expensive one. For scale: scanning all six areas is roughly
  120 API calls against a daily allowance of 15,000 (Developer Edition) to
  100,000+ (production).
- **Diagnostics before a scan.** "Run diagnostics" on the Overview probes the
  connection and the permissions each analyzer depends on — including whether
  `PermissionSetGroupComponent` is queryable and whether an API Usage report
  exists — with about ten single-row queries. No scan, and no report is run.
- **The API budget is live.** It comes from the `Sforce-Limit-Info` header
  present on every response — free and real-time — rather than from `/limits/`,
  which costs a call and is five minutes stale.
- **N+1 patterns are batched.** Flow metadata, FlexiPage metadata, report
  describes, and layout describes are inherently one-record-at-a-time; they go
  through `/composite` at 25 subrequests per API call.
- **Savings are measured, not asserted.** A page-load saving is quoted only
  where it can be derived from the org's own data: measured page times from the
  Lightning Usage app are fitted against eagerly loaded component counts, and the
  slope is that org's cost per component. Every number travels with its sample
  size and the share of variation explained. Below eight paired pages, or below a
  usable fit, nothing is shown — a missing estimate is a fine outcome and a
  confident wrong one is not. Report *timings* are never quoted, because they
  cannot be known without executing the reports; the one report-side saving that
  is stated is arithmetic rather than estimation — each dashboard filter value
  removed is exactly `components` fewer report runs per refresh.
- **Truncation is always reported.** If a scan hits its detail budget, the UI
  says how many components were not inspected. Silent truncation in an org-health
  report reads as "nothing more to see", which is the worst thing it could do.
- **Reports are never executed.** The org's 500 synchronous report runs per
  hour are shared with its real integrations and schedules, so everything is
  read from `describe`. There is no exception — the one that existed until
  0.8.4 is described under the Ops analyzer above.

---

## Known limitations

- `MetadataComponentDependency` (the Dependency API) is not used yet. It is
  still Beta, caps at 2,000 rows with no pagination escape, and excludes reports
  entirely — truncation there produces false "unused" verdicts, which is the
  most dangerous error an audit can make.
- Hard-coded-ID detection in flows is a text heuristic. Salesforce publishes no
  API for it, and the finding says so.
- Org-wide report *view* counts are not available; `LastRunDate` is the only
  org-wide signal Salesforce exposes, and the UI states this.
- Thresholds that Salesforce does not publish — layout field counts, flow version
  counts, class size — are labelled as OrgTriage recommendations wherever shown.
