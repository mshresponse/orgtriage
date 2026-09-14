# Security model

The design goal: an admin installs OrgTriage, and the worst case if the extension
is compromised is still bounded by what their own Salesforce session can already
do — with no new secret created, stored, or transmitted anywhere.

## Trust boundaries

```
┌─ Lightning page (untrusted) ──────────────────────────────────────────┐
│  Page JS  ✗ nothing of the extension runs here: no content script,    │
│           ✗ no iframe, no injected CSS — the page cannot see the panel │
└───────────────────────────────────────────────────────────────────────┘

┌─ Side panel — chrome-extension:// origin, browser chrome ─────────────┐
│  Holds no session id; never imports auth.ts (see below)               │
│  Knows which tab it is beside; the worker reads that tab's URL itself │
│  Talks to the worker over chrome.runtime only                         │
└───────────────────────┬───────────────────────────────────────────────┘
                        │ chrome.runtime messages (results, never tokens)
              ┌─────────▼──────────────────────────────────────┐
              │  Service worker — the only trusted component   │
              │  · reads the `sid` cookie                      │
              │  · attaches Authorization internally           │
              │  · is the only code that calls Salesforce      │
              └────────────────────────────────────────────────┘
```

## The credential boundary is structural

`src/background/auth.ts` is the extension's entire credential surface. It has no
export that returns a session id. Callers get `signedFetch(host, path, init)`,
which attaches `Authorization: Bearer …` inside the module. There is no code
path by which a session id can reach a message, a log, or storage, because no
function hands one out.

Reinforcing that:

- Sessions live in a module-scoped `Map` with a five-minute TTL. Not
  `chrome.storage.local`, and not `chrome.storage.session` — the latter is
  readable by content scripts if `setAccessLevel` is ever called, so it is
  avoided entirely. Losing the cache on worker restart costs one cookie read.
- `src/shared/types.ts` deliberately contains no type that can hold a token. If
  a credential cannot be named in a transferable shape, it cannot be
  accidentally transferred.
- `redact()` strips session-shaped strings (`00D…!…`) from anything that might be
  surfaced. Session ids always contain `!`.
- `signedFetch` sets `credentials: 'omit'` — the header is the only auth, and no
  ambient cookies ride along.
- `signedFetch` sets `redirect: 'manual'` and rejects absolute URLs. A caller
  can never redirect a credentialed request to another origin. `'manual'`
  rather than `'error'` because Salesforce redirects an API call when the
  session is not valid for that host, and surfacing that as an opaque response
  lets the client say so — `'error'` reported it identically to the network
  being down.
- `chrome.cookies.onChanged` clears every cached session when a `sid` is
  removed, so signing out of Salesforce ends OrgTriage's access immediately.

## The panel cannot choose the org

`sessionFor()` derives the org from `sender.tab.url` — a value the browser
supplies — and never from the message body. A compromised panel cannot aim
queries at a different org the user happens to be logged into. The resolved host
is then checked against an allowlist that mirrors `host_permissions`.

One exception, deliberately narrow: the remediation plan page (`report.html`)
opens in its own tab, where there is no Salesforce tab to derive an org from,
so it names the org id in its `report.data` request. The worker answers that
request from the local cache only — rule verdicts and component names — and
makes no API call to serve it. Naming an org id there cannot aim a query at an
org, because nothing is queried.

## OrgTriage never executes a report

Reports are analysed from their `describe` and never executed, because an org's
500 synchronous report runs per hour are shared with its real integrations and
subscriptions. There is no exception, and there is no code path that could
become one: nothing in the worker calls `/analytics/reports/{id}` without
`/describe`, and a test asserts it.

Until 0.8.4 there was an exception — a button that ran the standard "API Usage
Last 7 Days" report, chosen by name from the org's `Report` inventory, with the
message carrying no id so the panel could not choose a different one. An
external review found the flaw in that design: the name lookup accepted any
report whose name began "API Usage", so a report *created* with that name by
anyone who can create reports would have been executed with full detail rows.
Measurement then found something worse — standard reports are not `Report`
records, so the lookup could never have found the report it was written for.
The only thing it could ever have run was the dangerous case. The path is
removed rather than gated; per-user API counts are reached through the Classic
report and the `ApiTotalUsage` event log, both linked from the Ops tab.

## Nothing in the extension can reach a non-Salesforce host

`content_security_policy.extension_pages` restricts `connect-src` to `'self'`
plus the Salesforce host patterns that appear in `host_permissions`, and adds
`frame-src 'none'`, `base-uri 'none'`, `form-action 'none'`, `object-src 'self'`,
and `style-src 'self' 'unsafe-inline'`.

`'unsafe-inline'` is scoped to **styles only**, and only because lit renders
`style="…"` attribute bindings — progress meters, table column widths — which a
bare `style-src 'self'` blocks (Chrome logs "Applying inline style violates
the following Content Security Policy directive" for every one; the first live
run produced dozens). Inline styles cannot execute script, `script-src` stays
`'self'` with no inline or eval, and Manifest V3 forbids relaxing it. Nothing
org-controlled is ever interpolated into a style value.

**This policy covers the service worker as well as the panel.** Chrome's
documentation is explicit: "The 'extension pages' policy applies to page and
worker contexts in the extension." There is therefore no way to express "the
worker may make network requests but the panel may not" in the manifest — one
policy governs both.

An earlier revision of this file claimed the panel was *structurally* incapable
of reaching the network, on the strength of `connect-src 'none'`. That was
wrong twice over: the directive also blocked the service worker's own API calls
(so nothing worked at all), and the property it described is not one MV3 can
provide this way. What the CSP actually guarantees is narrower and still worth
having: **no part of this extension can open a connection to any host other than
Salesforce.** There is no destination to exfiltrate to.

## The panel is an extension page, and that is a weaker boundary than it looks

The panel runs at the `chrome-extension://` origin. That is what keeps the
Lightning page out of it — but it also means the panel is an ordinary extension
page, and **extension pages share the extension's permissions**. `cookies` is
granted to the extension, not to the service worker; script running in the
panel could call `chrome.cookies.get` for a Salesforce host just as the worker
does. An earlier revision of this file said the panel "has no way to obtain" a
session id. That is not true as a statement about Chrome. It is true only as a
statement about *this code*:

- `auth.ts` exports no function that returns a session id, and the panel never
  imports it. The worker is the only module that reads the cookie.
- The panel's CSP is `script-src 'self'` — no eval, no inline script, no remote
  script — so the only code that can run in it is code shipped in the package.
- Nothing from the org is rendered as HTML. There is no `unsafeHTML`, no
  `innerHTML` with org data, no `srcdoc`. Lit renders every org-supplied string
  as text.

So the credential discipline is a property of the source and its CSP, not a
privilege boundary Chrome enforces. Defeating it needs script execution inside
the panel, which needs a bug in the bundled code or in Chrome — a high bar, and
an honest one, which is different from "impossible". The stronger design — a
sandboxed renderer with no extension APIs, talking to a small trusted bridge —
is on the roadmap and is not what ships today. Until then the panel is not
sandboxed, because a sandboxed frame cannot use `chrome.runtime`, which is the
only channel it has.

One more limit of the CSP guarantee, stated plainly: `connect-src` bounds
*hosts*, not tenants. A Salesforce-controlled domain can serve content that
someone else controls (an Experience Cloud site, another org), so "no
destination to exfiltrate to" means "no destination outside Salesforce's
domains". For the threat model this extension is built for — no server of its
own, nothing sent to its author — that is the guarantee that matters; for a
compromised panel it is a smaller comfort than the sentence suggests.

## The page cannot reach the panel

Since 0.8.18 the panel is Chrome's side panel, which is browser chrome rather
than part of any page. Nothing of the extension is injected into Lightning: no
content script, no iframe, no stylesheet. A page script has no handle on the
panel and no channel to it. The `postMessage` bridge, closed shadow root and
`web_accessible_resources` rules that protected the earlier in-page sidebar are
gone with it.

The panel names the tab it is beside in every request. The worker accepts that
id only from the extension's own pages, reads the tab's URL from the browser
(`chrome.tabs.get`), and derives the org from that — so the panel can point at
any tab the user has open, and at nothing else, and never at a URL of its own
choosing.

## Why the service worker, and not the panel

This is forced by the platform, and it happens to be the right security answer:

- Requests from the service worker under `host_permissions` bypass CORS, so
  OrgTriage needs **zero** org configuration; anything running in a page context
  would need the admin to add a CORS allowlist entry in Setup.
- Keeping every authenticated call in one place is what makes "the panel never
  holds a token" a property that can be checked by reading one file.

## Permissions

| Permission | Why | Install warning |
|---|---|---|
| `cookies` | Read the `sid` cookie in the worker | none |
| `storage` | Preferences and the local snapshot cache | none |
| `sidePanel` | Show the panel in Chrome's side panel beside the page | none |
| `host_permissions` (Salesforce hosts) | Required alongside `cookies`, and for the API calls | shown |

Not requested: `tabs` ("Read your browsing history"), `scripting`,
`declarativeNetRequest` ("Block content on any page"), `sidePanel`.
`chrome.tabs.sendMessage` and `chrome.tabs.query` work for our purposes under
host permissions alone.

## What is stored, and where

| Data | Location | Contents |
|---|---|---|
| Scan snapshots | IndexedDB (`orgtriage`), keyed by org id + area | Component API names, dates, counts, rule verdicts |
| Nothing | — | No source code. Apex `Body`, Flow `Metadata` and stylesheet `Source` are read in the worker, reduced to counts and rule verdicts, and never persisted. |
| Preferences | `chrome.storage.local` | Theme, density, scan budgets |
| Org context | `chrome.storage.session`, 30-minute TTL, cleared when the sid cookie is removed | Org id, name, instance, type, sandbox flag, API host, current user's id and name, whether Limits was readable. No credential. Kept so a new Salesforce tab does not spend four API calls rebuilding it after the worker restarts. |
| Panel focus | `chrome.storage.session`, 5-minute TTL, taken once | The analyzer and rule id a tab opened from the report should land on. Set only by the report page; answered only to a panel in the same org. |
| Session id | Worker memory only, 5-minute TTL | — |

Snapshots contain **no record data** — no field values, no rows from any object.
The analyzers query metadata catalogs, not business data, and the one place
record content could appear (Apex `Body`) is never fetched. Nothing is
transmitted anywhere except to the user's own Salesforce org.

## Notes on the session-cookie technique

Salesforce documents the `sid` cookie as "the Session ID used to authenticate
Lightning Platform Soap-API and Rest-API data connections for the current user",
but does not bless reading it from an extension. Orgs with API Access Control
enabled will block this path entirely. A Connected App / OAuth PKCE flow is the
supported alternative and is the natural next addition; the client is already
structured so that only `auth.ts` would change.

## Reporting

Security issues in this repository should be reported privately to the
maintainer before public disclosure.
