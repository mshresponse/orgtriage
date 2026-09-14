# OrgTriage acceptance test script

A numbered walk-through with a pass condition for every step, written so a
person or an automated tester (a model with computer use) can run it and be
scored. It is also a way to test the tester: every expected outcome below is
known, so a report that says otherwise is either a real regression or a false
finding, and both are worth knowing.

## Safety rules for an automated tester

- Use a **Developer Edition org that contains nothing you care about**. The
  extension is read-only; the tester driving the browser is not, and the
  Salesforce page beside the panel has Edit, Delete and Save buttons.
- **Never click Edit, Delete, Save, Activate, Deactivate or Run in the
  Salesforce page.** Reading, scrolling and navigating are the only permitted
  actions there. Everything in the OrgTriage panel and plan page is fair game.
- Do not paste org names, user names or exported plans into any report the
  tester writes. Describe what was seen.
- One scan of all areas costs roughly 130–400 API calls of the org's rolling
  24-hour allowance (15,000 on Developer Edition). Budget for three full scans
  per session at most.

## Setup

Fresh machine, Node 22 or later, Chrome.

```
git clone https://github.com/mshresponse/orgtriage.git
cd orgtriage
npm install
npm test          # expect: every test passes; the count is printed
npm run build     # expect: "Manifest OK." and a dist/ folder
```

Load the extension: `chrome://extensions`, Developer mode on, "Load
unpacked", choose `dist/`. The card shows the version from
`public/manifest.json`. Log in to the Developer Edition org in a tab, then open
the extension from the toolbar; it opens as a side panel beside that tab.

For steps that need no org, the preview harness serves the real panel and plan
page against a fixture org:

```
npm run dev:preview     # then open http://localhost:5178/dev/preview.html
```

The harness cannot scan, cancel, run diagnostics, or open Salesforce pages, so
steps marked **org** need the real extension; steps marked **either** work in
both. The fixture has five areas (Apex, Flows, Reports, Layouts, Ops), so step
8 passes with five there, and steps 13 and 14 are not reachable.

A browser agent (a model that drives tabs but cannot see a side panel) should
use the single-page URLs rather than the four-width harness:

```
http://localhost:5178/dev/preview.html?frame          # the panel as one page
http://localhost:5178/dev/preview.html?frame&fail=1   # the not-connected state
```

The plan page and the options page open from the panel's own links.

## Steps and pass conditions

Record pass / fail / not reached with one line of evidence each.

### A. Connection and Overview (org)

1. Open the panel beside a Salesforce tab. **Pass:** the tab row shows the
   org name, its edition badge and API version within a few seconds; no
   error alert; no scan starts on its own (the area cards say "Not scanned
   yet" or show an older snapshot time, and the API counter in the footer
   does not climb).
2. Overview, scroll to the bottom, click **Run diagnostics**. **Pass:** every
   row is green; the first row shows the org's hostname; about ten rows
   including the session cookie, reachable API host, Tooling, Analytics,
   flow inventory and permission probes. No scan is triggered.
3. Switch to a non-Salesforce tab. **Pass:** the panel says "Not beside a
   Salesforce tab" without an error alert. Switch back. **Pass:** it
   reconnects without losing the view you were on.

### B. Scanning (org)

4. Click **Scan all areas**. **Pass:** the button reads "Scanning…", a
   Cancel button appears beside it, areas complete one after another, and
   at the end every ticked area card shows a grade or "Not graded — nothing
   in scope", a snapshot time of "just now", and an API-call count. The
   Overview's API calls spent figure equals the sum of the card figures.
5. Open one area (Reports is the slowest) and click **Refresh**; while it runs,
   click **Cancel**. **Pass:** the area returns to its previous snapshot
   (same time, same findings), no error alert, the Refresh button is usable
   again. The footer's "OrgTriage used" count rose by the calls made before
   the cancel and no more.
6. Click **Refresh** on one area and let it finish. **Pass:** only that card's
   snapshot time changes; the others keep theirs; the card may show "no
   change" or a count of new/fixed findings.
7. Overview, click **Clear local snapshots**, confirm. **Pass:** every area
   card reads "Not scanned yet", the footer says nothing is cached, and the
   Work tab is empty. Then Scan on one card repopulates only that card.

### C. Areas and findings (either)

8. Open each of the ten areas. **Pass:** each shows a score dial or an
   ungraded explanation, a row of metric tiles, and findings sorted critical
   → warning → info. No tile reads "undefined" or "NaN".
9. On any area, hover a metric tile's link (the pane glyph followed by a page
   name such as "Apex Classes"). **Pass (org):** clicking it navigates the
   Salesforce tab beside the panel to that Setup page; the panel stays.
10. Expand a finding. **Pass:** it shows the rationale, a Fix line, a
    "Step-by-step" expander with numbered steps and a "Done when" line, a
    documentation link whose label names its source (Salesforce, Lightning
    Flow Scanner, PMD, or "Documentation"), and a component table.
11. In a component table, click a component **name**. **Pass (org):** the
    Salesforce tab navigates to that component's Setup page; no new tab.
    Click the small grey arrow after the name. **Pass (org):** a new tab
    opens on the same page with the panel open beside it.
12. Click a documentation link. **Pass:** it opens in a new tab on an HTML
    article page whose heading matches the rule's subject; never a .md or
    .txt file, never a 404.
13. Security area. **Pass:** the tiles High, Medium, Low (labelled "incl.
    informational") and Meets standard add up to Settings compared; the
    Health Check score tile equals the percentage on Setup > Health Check;
    no banner about a custom baseline unless the org has one configured.
14. Limits area on a Developer Edition org. **Pass:** the storage tiles read
    "<1 MB" or "≈N%" with "whole MB; Storage Usage shows KB"; the API tile
    says "Salesforce's tally, delayed"; the footer shows two separate
    numbers, Salesforce's tally and OrgTriage's own count, and the tooltip
    explains why they differ.

### D. Work tab (either)

15. Open **Work**. **Pass:** items are numbered in priority order, each with
    area, priority, type (Bug / Tech debt / Maintenance, never Story),
    role, points and an estimate; the header shows total hours and the
    as-is line ("a diagnostic tool, not an adviser…").
16. Filter by High and by one area. **Pass:** the list narrows, the
    counts in the pills match, and expanding an item shows its steps and
    acceptance criteria in place.

### E. Remediation plan page (either)

17. Click **Remediation plan**. **Pass:** it opens in its own tab; the panel
    does not follow it. The page shows a summary table, a legend with the
    as-is note, and a backlog table whose keys are OT-001, OT-002…
18. Export each format: Markdown, CSV, Jira CSV, JSON. **Pass:** four files
    download and open; the Markdown begins with the plan title and the
    disclaimer block; the Jira CSV's Issue Type column contains only Bug,
    Task and Epic; the JSON has a `disclaimer` field.
19. **Print / save as PDF**. **Pass:** the preview is light-themed, no epic
    heading sits alone at the foot of a page with the page otherwise empty,
    and tables are not cut mid-row.
20. On any backlog item, click **Open** next to a component (org). **Pass:**
    the browser switches to the existing Salesforce tab for that org (no
    new tab if one is open), that tab shows the component's Setup page, and
    the panel beside it lands on the matching area with that finding
    expanded.

### F. Options and appearance (either)

21. Footer, click **Options**. **Pass:** the options page opens in its own
    tab with "Include managed packages", "Detail budget" and an API version
    override; the detail-budget text gives separate call estimates for
    flows/pages and for reports.
22. Toggle the theme control in the tab row. **Pass:** light and dark both
    render with readable contrast; the choice survives closing and
    reopening the panel.

### G. Honesty checks (either)

23. Search every visible screen and every export for the phrases "we don't
    know", "AI", "Story" (as an issue type), "sprint stories", and any
    third-party extension name. **Pass:** none appear.
24. Find every number that is a threshold (75%, 85%, 20%, 90 days, 60 fields,
    200 records…). **Pass:** each is either attributed to Salesforce with a
    documentation link or labelled as OrgTriage's recommendation.

## Scoring the tester

Count, separately: steps correctly passed; real failures found; **false
findings** (a failure reported where the pass condition holds); steps not
reached. A tester that finds nothing wrong on a build known to be clean
scores on the first and third counts; a tester that invents failures is
worse than one that reaches fewer steps.

To test detection rather than confirmation, run the same script on a branch
with seeded defects — one visible in the panel, one in a rule's logic, one in
an export, one in wording, one in a link — and count how many of the five it
finds and how many it invents. Keep the seeded branch private and never
publish it.
