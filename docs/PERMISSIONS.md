# Browser permissions, explained

For the OrgTriage Chrome extension · Last reviewed September 10, 2026 (version
0.8.13) · Published by Everything Virtually LLC.

If you need to approve this extension, start here. Chrome summarizes permissions
in the install dialog. This page explains what each permission does, why
OrgTriage needs it, what it does not allow, and how to verify those limits.

The authoritative source is the extension's `manifest.json`, which ships inside
the package and can be read on your own machine. Everything on this page can be
checked against it.

## The complete list

OrgTriage requests **three permissions**. That is the entire list — there are no
optional permissions requested later, and none requested at runtime.

| Permission | What OrgTriage uses it for | What it does not allow |
|---|---|---|
| `cookies` | Reuse the Salesforce session you are already logged in with, so the extension can call the Salesforce API as you. OrgTriage reads one cookie, named `sid`, on your Salesforce host. | Cannot read cookies for any other site — the host patterns below are enforced by Chrome, not by us. The session token is used in the API call and is never transmitted anywhere else, because the extension only calls Salesforce. It is held in memory for at most five minutes, never written to disk, and discarded when you sign out. |
| `storage` | Keep your cached scan results and panel preferences on your device so they survive a browser restart. | Local to your machine. Not synced to us, not backed up by us. Removing the extension removes them. Note that OrgTriage does not request `unlimitedStorage`. |
| `sidePanel` | Show the panel in Chrome's side panel, beside the Salesforce page, so it stays open while you move through the org. | Does not grant access to the page. The side panel is part of Chrome: it cannot read the page, and the page cannot see it. It is switched off on tabs that are not Salesforce. |

These are the only three permissions. None of them produces an install-time warning in
Chrome, and a read-only diagnostic does not need more.

## Host access

OrgTriage requests fourteen host patterns to cover Salesforce domains across
commercial, Government Cloud, China and proxied deployments.

- **Commercial Salesforce** — `salesforce.com`, `force.com`,
  `salesforce-setup.com`, `cloudforce.com`, `visualforce.com`,
  `builder.salesforce-experience.com`. A single org spans several of these:
  Lightning and the REST API live on `salesforce.com`, Setup has its own domain
  under enhanced domains, and Experience Cloud and Visualforce pages live on
  `force.com`.
- **Government Cloud** — `salesforce.mil`, `force.mil`, `cloudforce.mil`,
  `visualforce.mil`, `crmforce.mil`. Salesforce serves GovCloud customers from
  `.mil` domains entirely. Without these, OrgTriage does not work at all for a
  public-sector org.
- **China** — `sfcrmapps.cn`, `sfcrmproducts.cn`, the Alibaba Cloud instances.
- **Proxied** — `force.com.mcas.ms`, the suffix Microsoft Defender for Cloud
  Apps appends when your organization routes Salesforce through it. If your
  security team uses MCAS, your Salesforce hostname is not the one Salesforce
  gave you, and an extension that does not account for it silently fails.

Chrome enforces this host-access boundary. On any other site the extension has no host access at
all: it cannot read the page, cannot read cookies, and cannot make requests.
There is no wildcard host access and no access to your other tabs.

Nothing in this list is optional to the product, and nothing in it broadens
access to a non-Salesforce site. If your org is on commercial Salesforce, the
`.mil` and `.cn` entries are inert for you.

## Nothing is injected into the Salesforce page

OrgTriage declares no content script. Nothing runs inside your Salesforce pages,
no iframe is added to them, and no CSS is applied to Lightning. The panel is
Chrome's side panel: a separate document at the extension's own origin, placed
beside the page by the browser. It cannot read your Salesforce page — it does
not scrape records, watch what you type, or report what you looked at — and the
page cannot see it.

What the panel does read is which tab it is beside. Every request it makes to
the extension's service worker names that tab, and the worker reads the tab's
URL from the browser to find the org. It can only ever ask about a tab you have
open, and only on the Salesforce hosts listed above; on any other site the tab's
URL is not even visible to the extension.

The panel runs at the extension's own origin. Chrome grants an
extension's permissions to every page of the extension, not to the service
worker alone. What keeps the session token inside the worker is the code —
the panel never imports the module that reads the cookie, its Content Security
Policy allows no script that did not ship in the package, and nothing from your
org is ever rendered as HTML. You can verify these safeguards in the code.
Chrome does not enforce a separate permission boundary between the panel and
the worker. See `docs/SECURITY.md` for the full trust model.

## About the analyzers that read your users

Four analyzers read a limited amount of information about people in your org.
The list below explains which fields they read and why, so you can review
whether that access is appropriate for your org.

Here is exactly what is read, and why:

- **Ops — `User`: Id, Name, IsActive.** So a finding can say *"the nightly
  billing job is owned by Dana Reyes, whose account was deactivated in March"*
  instead of *"a job is owned by an inactive user id."* A scheduled process that
  silently stopped because its owner left the company is one of the specific
  problems OrgTriage exists to catch, and it cannot be reported usefully without
  the name.
- **Ops — `ProcessInstance` and its work items:** the target record's id, the
  process name, submission date, and the assigned and original approver ids. So
  a month-old stalled approval can name who it is waiting on and link to the
  record. The record is never opened.
- **Ops — `FlowInterview`:** label, current element, pause label, status, and
  `CreatedById`. So failed and long-paused flow runs can be grouped.
- **Ops — `AsyncApexJob`:** class, method, type, status, and `ExtendedStatus`,
  the error text the failing code produced. The whole field is fetched; the
  first 120 characters are kept in the finding.
- **The connection — `User`: Id and Name of the user running the scan**, one
  row, so the plan's cover page can say who produced it.
- **Ops — `LoginHistory`: user, application, and login type, as counts over the
  last seven days.** So you can see what is calling your API and from where.
  This is an aggregate `COUNT()` query. OrgTriage does not read IP addresses,
  individual login timestamps, session details, or browser fingerprints.
- **Access — `User`: Id, Name, Username, IsActive, UserType, LastLoginDate,
  CreatedDate, ProfileId, profile name and the profile's licence id;
  `PermissionSetAssignment` with the assignee's Name, Username, IsActive,
  UserType and LastLoginDate.** So the extension can say who holds Modify All
  Data and the other permissions that bypass sharing, whether they have logged
  in recently, and whether they hold it by profile, permission set, or group.
  Usernames are read because that is how assignments identify people.
- **Access — `UserLicense`: Name, MasterLabel, TotalLicenses, UsedLicenses,
  Status.** The seat totals from Setup > Company Information, joined to the
  users above to count seats held by users who no longer log in. The finding
  is per licence type and carries counts only.
- **Limits — `ApexLog` grouped by `LogUserId` and `LogUser.Name`:** user id,
  name, bytes and log count per user. So when debug-log storage is high, the
  finding can say whose trace flag is producing it. Nobody is named while the
  storage is below the warning level.
- **Reports — `Dashboard.RunningUserId`, then `User`: Id, Name, IsActive for
  those ids only.** So a dashboard that runs as a fixed user can be flagged
  when that user has been deactivated, which stops it refreshing.

The limits on that access:

- **It is your own org's data, and it stays on your device.** It is cached
  locally alongside every other finding and is never transmitted, because there
  is no OrgTriage server to transmit it to.
- **Salesforce enforces the limit, not us.** OrgTriage runs these queries as you.
  Field-level security, object permissions, and sharing rules apply exactly as
  they do when you run a report. If your user cannot see it, neither can
  OrgTriage.
- **No email addresses or passwords are read.** The User fields queried are the
  ones listed above and no others; usernames appear only in the Access findings.
  The Apex area checks whether any Apex Exception Email recipient exists by
  reading record ids alone, never the addresses.
- **You can delete it.** *Clear local snapshots* in the panel overview removes
  every cached scan, and uninstalling the extension removes the database.

## What OrgTriage deliberately does not request

The following permissions do not appear in the manifest:

| Not requested | Which means |
|---|---|
| `<all_urls>` or broad host access | No access to any site other than Salesforce. |
| `tabs` | Cannot read your browsing history. The panel can see which tab it is beside only when that tab is on a Salesforce host; every other tab's URL is hidden from it. |
| `scripting` | Nothing is injected into any page, at install or at runtime. There is no content script at all. |
| `webRequest` / `declarativeNetRequest` | Cannot observe, intercept, modify, or block your network traffic. |
| `downloads` | Exports are ordinary blob links you click. The extension has no download management. |
| `nativeMessaging` | Cannot communicate with any program installed on your computer. |
| `management` | Cannot see or change your other extensions. |
| `history`, `bookmarks`, `identity`, `clipboardRead` | No browsing history, no bookmarks, no account linkage, no clipboard reading. |
| `unlimitedStorage` | Operates within Chrome's ordinary local storage quota. |

OrgTriage does set a custom `content_security_policy`, and it is worth saying why,
since a custom CSP is usually a way of *relaxing* one. This one tightens it:
`connect-src` is restricted to an explicit list of Salesforce hosts, so no part
of the extension can open a connection to any other destination — including one
belonging to us. It also sets `frame-src 'none'`, `base-uri 'none'`,
`form-action 'none'`, and keeps `script-src 'self'` with no `unsafe-eval`. The
one relaxation is `style-src 'unsafe-inline'`, which permits inline **CSS
attribute values** — progress meters and table column widths rendered by the
`lit` library. Inline styles cannot execute script, and no value from your org is
ever interpolated into one.

## How to verify all of this yourself

You can verify these claims yourself:

1. **Read the manifest.** Go to `chrome://extensions`, enable Developer mode,
   and open the extension's `manifest.json` from its directory on disk. Compare
   it to the lists above. The permission and host entries are the ones Chrome
   enforces.
2. **Watch the network.** Open DevTools on the side panel, go to the Network
   panel, and run a scan. The only requests you will see are to your own
   Salesforce org. There is no OrgTriage domain in the list, because there is no
   OrgTriage server.
3. **Watch it from the org's side.** Every request OrgTriage makes is tagged
   `Sforce-Call-Options: client=OrgTriage`. Your org's API usage logs will show
   what it called and how much API allowance it used.
4. **Read the code.** The extension ships as unobfuscated JavaScript. The cookie
   read and the single `fetch()` call site are each in one searchable location, both
   in `background/auth.ts`.
5. **Check the store listing.** The Chrome Web Store shows the permissions and
   data-usage disclosures for the published version independently of anything we
   say here.

## If this ever changes

If a future feature ever changes the picture on this page, we will update this
page and the privacy policy before that feature ships, and clearly label any
mode in which data leaves your machine. The core promise will not change:
OrgTriage's analysis runs locally.

## Questions

For questions about permissions or security, email
**mike@everythingvirtually.com**.

See also: Privacy Policy · Help Center

---

© 2026 OrgTriage · Everything Virtually LLC
