# OrgTriage skills

Two skills that make the findings reachable from an agent rather than only from
the sidebar: one produces a plan, one works through it.

| Skill | What it does | Writes anything? |
|---|---|---|
| `orgtriage-scan` | Runs the analyzers against a live org via the Salesforce CLI, writes `plan.json` | No — reads only |
| `orgtriage-remediate` | Takes one backlog item from that plan and fixes it in an SFDX project, on a branch, with a PR | Yes — to a git branch, never to a production org |

## Why these exist

The extension is read-only on purpose, so the plan it produces is work nobody
has done yet. Claude Code can do that work — in a repository, on a branch, under
review. The read-only guarantee is unaffected: the extension still never writes,
and the writes that do happen are ordinary source changes a person approves.

The other half of the reason is that the procedures already existed. Every rule
in `src/shared/playbook.ts` carries fix steps, a role, an effort model and an
acceptance criterion, each checked against Salesforce's documentation. A skill
is mostly a procedure, and this one was written before the skills were.

## Installing

Copy or symlink into wherever your agent looks for skills — for Claude Code,
`~/.claude/skills/` for personal use or `.claude/skills/` in a project:

```bash
ln -s "$PWD/skills/orgtriage-scan"      ~/.claude/skills/orgtriage-scan
ln -s "$PWD/skills/orgtriage-remediate" ~/.claude/skills/orgtriage-remediate
```

Symlink rather than copy while the plan format is still moving, so an update to
this repo reaches the skill without a second step.

## Requirements

- The [Salesforce CLI](https://developer.salesforce.com/tools/salesforcecli)
  (`sf`) on PATH, with the target org authorised (`sf org login web --alias x`).
  The CLI holds the credential; no access token passes through either skill.
- This repository, with `npm install` run, for `npm run scan`.
- For remediation: an SFDX project, and the org's metadata retrievable into it.

## Portability

The valuable part is the procedure, and it is plain markdown. Adapting these for
another agent means changing the frontmatter and the install path, not the
content. The guardrails in `orgtriage-remediate` — never deploy to production, one
item per branch, stop rather than guess on access and deletion items — should
travel unchanged whatever runs them.
