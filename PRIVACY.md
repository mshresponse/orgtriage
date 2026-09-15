# Privacy Policy — OrgTriage

**Effective date:** September 12, 2026 · Applies to the OrgTriage browser
extension, version 0.8.46 and later. Published by Everything Virtually LLC.

## The short version

OrgTriage runs entirely in your browser. We do not collect, transmit, store, sell,
or share any of your data. OrgTriage has
no servers, no analytics, no telemetry, no accounts, and no third-party
services.

## What OrgTriage reads, and where it goes

OrgTriage analyzes how your Salesforce org is configured. To do that it reads
metadata from your org — Apex classes and triggers (inventory, coverage, and
source), Flows and their definitions, workflow rules, validation rules, custom
field definitions, custom buttons and links (their URLs), reports and
dashboards (their definitions, never their results), page layouts, Lightning
pages, custom stylesheets, permission sets and their assignments, licence seat
counts, Salesforce's own Health Check results, release-update status, org
limits, scheduled jobs and job run history — and turns them into findings. All analysis happens in
your browser. Nothing is uploaded anywhere.

OrgTriage does not read your business records. It never runs a report, and it
queries no Account, Contact, Opportunity, Case, or custom business object
rows. It does read Apex source code, because two of its checks need it: the
code-quality lint (queries inside loops, missing sharing declarations, empty
catch blocks, hard-coded ids) and the field-reference scan, which looks for
field names inside Apex bodies, flow definitions and validation rules. That
source stays in your browser like everything else, and only findings about it —
a class name, a line number and, for the hard-coded-id check, the id that was
found — are kept in the local cache.

## Where people appear in the results

Some findings are only useful if they name a person, so four analyzers read a
limited amount of user information from your org. This is the complete list:

- **Ops — scheduled jobs** (`CronTrigger`: Id, the job's name and type, State,
  NextFireTime, PreviousFireTime, TimesTriggered, OwnerId, CronExpression).
  The owner is the user the job runs as.
- **Ops — user names and active status** (`User`: Id, Name, IsActive), to say
  who owns a scheduled job that has stopped, or who a stalled approval is
  waiting on. A nightly process silently failing because its owner was
  deactivated is one of the problems OrgTriage exists to catch, and it cannot be
  reported without the name.
- **Ops — pending approval requests** (`ProcessInstance` and its work items):
  the instance's id, status and submission date, the record id the approval is
  for, the approval process name, and for each work item its id, the assigned
  and original approver, and when it was created. The record id is kept so
  the finding can link to it; the record itself is never read.
- **Ops — failed and paused flow runs** (`FlowInterview`): the run's id, the
  flow's label, the element it stopped at, the pause label, its status, when
  it started, and who started it.
- **Ops — failed Apex jobs** (`AsyncApexJob`): the job's id, class and method
  name, type, status, error count, when it was created and completed, and its
  error message, which can contain whatever the failing code put there. The
  whole message is fetched; the first 120 characters are kept.
- **The connection — your own name** (`User`: Id, Name, one row for the user
  running the scan), so the plan's cover page can say who produced it.
- **Ops — login counts**, grouped by user, application, and login type over the
  last week — so you can see what is calling your API. This is an aggregate
  count only: no IP addresses, individual timestamps, or browser details.
- **Access — who holds powerful permissions** (`User`: Id, Name, Username,
  IsActive, UserType, LastLoginDate, CreatedDate, ProfileId, the profile's
  name and its licence id; `PermissionSetAssignment`: Id, AssigneeId,
  PermissionSetId, PermissionSetGroupId, and the assignee's Name, Username,
  IsActive, UserType and LastLoginDate). These are needed to say who holds
  Modify All Data, whether they still log in, and by which route. Usernames
  are read here because permission set assignments identify people by them;
  email addresses and passwords are never read. The "Run diagnostics" check
  on the Overview also reads one assignment row's Id, to count assignments
  before a scan.
- **Access — licence seat counts** (`UserLicense`: Id, name, label, total and
  used seats, status). These are the numbers on Setup > Company Information. They
  are joined to the users above to count seats held by people who no longer
  log in; the finding reports counts per licence type, not names.
- **Access — configuration, not people** (`Profile`: Id, Name, licence name;
  `PermissionSet`: Id, Name, Label, Type, namespace, whether it is
  profile-owned, ProfileId, profile name, IsCustom, and the permission flags
  such as Modify All Data; `PermissionSetGroupComponent`: group id and set
  id). These describe what a permission set or profile grants, not who holds
  it; they are listed here so the inventory is complete.
- **Limits — who owns the debug logs** (`ApexLog` grouped by `LogUserId` and
  `LogUser.Name`: user id, name, total bytes and number of logs per user;
  `TraceFlag`: Id, LogType, TracedEntityId, which is the user or class being
  traced, StartDate, ExpirationDate, and the debug level's label, Apex and
  database levels). Names are shown only once debug-log storage is high enough
  to be a problem, so the finding can say whose trace flag is filling it.
- **Reports — report and dashboard owners** (`Report`: Id, Name,
  DeveloperName, FolderName, Format, LastRunDate, LastViewedDate, Description,
  OwnerId; `Dashboard`: Id, Title, DeveloperName, FolderId, FolderName,
  RunningUserId, Type, Description, DashboardResultRefreshedDate; then `User`:
  Id, Name, IsActive for the running-user ids only). So a dashboard that runs
  as a fixed user can be flagged when that user has been deactivated, which is
  why it stops refreshing.

This is your own organization's employee information, and it stays on your
device exactly like everything else. It is never transmitted to us.

OrgTriage can never see more than your own Salesforce permissions allow —
field-level security, object permissions, and sharing rules are always enforced
by Salesforce itself. If your user cannot see something, neither can OrgTriage.

## Your Salesforce connection

OrgTriage reuses the Salesforce session from your existing browser login to call
the Salesforce API directly from your browser to your org. Your session token and
your org's data never pass through any OrgTriage system, because none exists.

The session token is handled only inside the extension's service worker. It is
held in memory for at most five minutes, is never written to disk, never logged,
never shown, and is discarded the moment you sign out of Salesforce. OrgTriage
never asks for your password and creates no credential of its own.

## What stays on your device

Scan results are cached in your browser's local storage so reopening the panel
does not re-run a scan. Each scan uses part of your org's rolling 24-hour API allowance;
caching avoids those extra calls. Your panel preferences are stored the same way.

The cache holds analysis output: component names and labels, Salesforce record
ids, dates, counts, rule verdicts, and — for the people-related findings above
— user names, usernames, and the approval and job details listed. Note that
your component API names and the names of your users are your organization's
confidential information; they remain on your device, and should be treated
like anything else cached locally on a shared or managed machine.

You can clear it at any time with **Clear local snapshots** in the panel
overview, and removing the extension deletes everything.

## Exporting

The remediation plan page can export a plan as CSV or Markdown, or print it.
These files are generated in your browser and saved only where you choose. They
are not uploaded, and no copy is kept.

## Browser permissions, explained

OrgTriage requests the minimum its features need: **cookies** (reuse your own
Salesforce session for API calls, limited to Salesforce domains), **storage**
(keep your cached scans and preferences on your device) and **sidePanel** (open
as a side panel beside the Salesforce tab). Those are the only three permissions. Host access is limited
to the Salesforce domains listed in the extension's manifest, including sandbox,
Government Cloud, and China instances.

OrgTriage deliberately does **not** request `tabs` (it cannot see your browsing
history), `scripting`, `declarativeNetRequest`, `activeTab`, or `downloads`. It
does not run on, read, or affect any website that is not Salesforce.

## What we don't do

No analytics or usage tracking. No crash reporting. No advertising or ad
identifiers. No selling or sharing of data (there is none to sell). No remote
code: everything the extension runs ships inside the extension package reviewed
by the Chrome Web Store. The extension's Content Security Policy restricts it to
Salesforce hosts, so there is no other destination it could reach.

## Children's privacy

OrgTriage is a business tool for Salesforce administrators, not directed at
children, and — consistent with everything above — collects no data from anyone
of any age.

## Changes to this policy

If a future feature ever changes this picture, we will update this policy before
that feature ships and clearly label any mode in which data leaves your machine.
The core promise will not change: OrgTriage's analysis runs locally.

**Revision history.** September 15, 2026: the contact address is now
support@orgtriage.com; nothing about what is read changed. September 14, 2026
(versions 0.8.61 to 0.8.63): the inventory names every field read from
permission set assignments, scheduled jobs, reports, dashboards, trace flags,
approvals, flow interviews and Apex jobs, and the licence record id; the
profile and permission-set reads are listed as configuration; support for
reverse-proxied hostnames was removed. September 12, 2026 (version 0.8.46 and later): the list of
people-related reads now names all four analyzers that make them, the job error
text is described as fetched whole and truncated in the finding, and the
extension's one read of your own user name is listed. The Apex exception-
recipient check no longer reads email addresses; it reads record ids only.
September 9, 2026: first published, for version 0.8.5.

## Terms of use

This policy covers what OrgTriage reads and where it goes. The extension's warranty disclaimer and guidance on using findings are in the
[terms of use](terms.html): OrgTriage is a diagnostic tool, not an adviser, it
is provided as is, and every finding is a recommendation for an experienced
administrator or developer to verify.

## Contact

Questions: support@orgtriage.com · Everything Virtually LLC.

---

© 2026 OrgTriage · Everything Virtually LLC
