---
name: orgtriage-remediate
description: Fix a finding from an OrgTriage remediation plan in a Salesforce SFDX project — bulkify a flow, add fault paths, tune a report, raise API versions — on a branch, with the story's acceptance criteria as the PR checklist. Use when asked to fix, remediate, or work through OrgTriage findings, technical debt stories, or a story key like OS-014.
---

# Fix an OrgTriage backlog item

Takes one backlog item (an entry in the `stories` array of `plan.json`) and does the work in a local SFDX project:
change the metadata, run the tests, open a PR whose checklist is the story's
acceptance criteria.

You need a plan. If there isn't one, run `orgtriage-scan` first.

## The rules that do not bend

**Never deploy to production.** Not with `sf project deploy start`, not as a
"quick fix", not because the user seems to want speed. Changes land on a git
branch and go through review. If they ask for a direct production deploy, say
no and offer the branch.

**One item per branch.** `orgtriage/OT-014-flows-dml-in-loop`. Stories get
reviewed, rejected and reverted individually; a branch carrying three of them
cannot be.

**Deploy to a sandbox only when asked, and only to test.** Verifying a fix
against a scratch org or sandbox is good practice. Do it when the user asks or
approves, name the target org first, and never let it substitute for review.

**Do not invent the fix.** The item's `steps[]` are researched and sourced. Follow
them. If they don't fit what you find in the code, that is worth raising — say
what doesn't match rather than improvising something plausible.

## Stop and ask instead of proceeding

Some items are not yours to action, and the plan carries the signals.

| Signal | Why to stop |
|---|---|
| `analyzer` is `access` or `security` | Permission and security-setting changes decide what named people can see. They need a human who knows the org's policy. Explain the finding; do not change a permission set. |
| The fix **deletes** metadata — unused fields, unassigned permission sets, unused profiles, obsolete flow versions | "Nothing references it" is not "nobody needs it". An integration or a report can depend on something no metadata mentions. Deletions need a person to confirm. |
| `unscripted: true` | No playbook entry, so `steps` is one fallback sentence. Don't guess a procedure. |
| The fix is org **state**, not source — trace flags, scheduled jobs, storage, debug logs, dashboard refresh schedules | There is nothing in the repo to change. Give the user the Setup path from the story and let them do it. |
| The item affects more than ~20 components | Ask how they want it staged. A 200-file PR does not get reviewed, it gets approved. |

`role` and `kind` help you judge: `role: admin` often means the work happens in
Setup rather than in source, and `kind: hygiene` rarely justifies a large diff.

## Doing the work

1. **Find the item.** Read `plan.json`, locate it by `key`. Read `steps`,
   `acceptance`, and `items[]` — `items` names the exact components, so you do
   not have to search for what is affected.

2. **Check the story still applies.** The plan is a snapshot. If the metadata no
   longer matches what the finding describes, say so and stop; it may already be
   fixed.

3. **Get the metadata.** If the components aren't in the project:
   ```bash
   sf project retrieve start --metadata Flow:My_Flow --target-org <alias>
   ```
   Retrieve only what the story names. A broad retrieve buries the diff.

4. **Branch, then change.** Follow `steps[]` in order. Keep the diff to what the
   story is about — an unrelated tidy-up in the same commit makes the review
   harder and the revert impossible.

5. **Test.** Run the tests that cover what you touched:
   ```bash
   sf apex run test --tests <ClassName> --target-org <sandbox> --wait 10
   ```
   For a flow or a layout there may be no test. Say that plainly in the PR
   rather than implying coverage that doesn't exist.

6. **Open a draft PR.** Body carries:
   - the story key, title, and `rationale` — so a reviewer knows why without opening the plan;
   - **`acceptance[]` as a task list**, unticked except where you verified it;
   - what you changed and what you deliberately did not;
   - anything you could not verify.

   Draft, not ready-for-review, unless the user says otherwise.

7. **Report back** with the branch, the PR, and anything a human still has to
   do — the acceptance criteria you could not tick yourself.

## Confirming it worked

The real check is the rule no longer firing. After the change is deployed,
re-run the scan for that area:

```bash
npm run scan -- --org <alias> --only flows --out ./orgtriage-out
```

The story should be gone from `plan.json`. If it isn't, the fix was incomplete —
which is the point of checking rather than assuming.

Do not re-scan against an org the change hasn't reached yet; you will conclude
the fix failed when it simply hasn't been deployed.

## The common ones

**`flows.lfs.dml-in-loop` / `soql-in-loop`** — the most frequent and the most
mechanical. Move the Get before the loop; collect records into a collection
variable inside the loop; one Create/Update after it. `items[].evidence.Elements`
names the offending element, so go straight there.

**`flows.lfs.missing-fault-path`** — add fault connectors routed somewhere a
person sees. Include `{!$Flow.FaultMessage}`.

**`apex.old-api-version` / `flows.old-api-version`** — raise the version and run
the tests. Do a few at a time: behaviour changes between versions, and a
20-class bump that breaks something is hard to bisect.

**`reports.perf.*`** — report metadata is source, so filters and column changes
are ordinary edits. Do not "reorder" filters for performance: the optimizer is
cost-based and the order in the builder has no effect. Add a selective indexed
filter instead, which is what the steps say.
