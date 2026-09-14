---
name: orgtriage-scan
description: Scan a Salesforce org for technical debt, security and operational risk, and produce a ranked remediation plan. Use when asked to audit, assess, health-check or review a Salesforce org, to find technical debt, or to produce a backlog of fixes. Also use to refresh a plan before remediation work.
---

# Scan a Salesforce org

Runs OrgTriage's analyzers against a live org through the Salesforce CLI and
writes a remediation plan. Read-only: it issues GETs and nothing else, and the
CLI holds the credential — no access token passes through this skill.

## Before running

1. **The org must be authorised already.** `sf org list` shows what is. If the
   target is not there, ask the user to run `sf org login web --alias <name>`
   rather than doing it for them: it opens a browser and they choose the org.
2. **Never guess the org.** If more than one alias could be meant, ask. Scanning
   the wrong org wastes their API allowance and produces a plan for someone
   else's problems.
3. **Ask before scanning production** if the alias suggests one. A full scan is
   a few hundred read API calls, which is ordinarily nothing, but it is their
   allowance to spend.

## Run it

From the OrgTriage repository:

```bash
npm run scan -- --org <alias> --out ./orgtriage-out
```

Options that matter:

- `--only apex,flows` — one or more of `apex, flows, reports, layouts, ops,
  access, limits, security, fields, apexlint`. Use when the user asked about one
  area; a full scan is otherwise the right default because the ranking is
  cross-area.
- `--budget 300` — how many components get per-item metadata fetched. Lower it
  for a very large org that is taking too long; the plan says when a budget was
  reached, so a truncated scan is visible rather than silent.
- `--quiet` — suppress progress on stderr.

Takes a few minutes on a real org. Most of that is Salesforce responding, not
the analysis.

## What you get

- `orgtriage-out/plan.json` — the plan. This is the artifact to work from.
- `orgtriage-out/scan/<area>.json` — raw findings per analyzer, if you need the
  evidence behind a story.
- **stdout** — a compact JSON summary: score and grade per area, story counts by
  priority, API calls spent, and any analyzer that failed.

## Reading the plan

`plan.json` has `stories[]`, each of which is a unit of work:

| Field | What it is |
|---|---|
| `key` | `OT-001`, stable within one plan — how the user will refer to it |
| `title`, `rationale` | What is wrong, and why it matters |
| `steps[]` | Ordered fix steps with real Setup paths |
| `acceptance[]` | What "done" means. This is the definition of done, not a suggestion |
| `items[]` | The affected components, with evidence and Setup links |
| `priority`, `severity`, `kind`, `role` | P1–P3; `bug`/`debt`/`hygiene`; `admin`/`developer` |
| `effortHours`, `effortSize`, `points` | Planning estimate |
| `unscripted` | `true` means no playbook entry — `steps` is a single fallback sentence |

Also present: `epics[]`, `areas[]` (score per area), and **`review[]`** — checks
that could not be evaluated.

## Reporting back

Lead with what the user asked about. If they asked an open question, give the
grade per area, the P1 count, and name the two or three stories you would start
with — not a list of everything.

Two things to always carry through, because they are the point of the tool:

- **`review[]` is not a pass.** A check that could not run — usually a missing
  permission — is reported as not evaluated. Say so explicitly rather than
  letting silence read as health. If it is a permission, name it: most often
  View Setup and Configuration, which the Security area needs.
- **A failed analyzer means that area is absent, not clean.** The summary lists
  `failedAnalyzers`. Do not describe an org as healthy in an area that did not
  run.

Do not restate every story. Point at `plan.json` and offer to start on one.

## Fixing what it finds

That is `orgtriage-remediate`. It takes a story key from this plan and does the
work in an SFDX project. Offer it once there is a plan; do not start editing
metadata from inside this skill.
