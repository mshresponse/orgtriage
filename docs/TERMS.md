# Terms of Use — OrgTriage

**Effective date:** September 11, 2026 · Applies to the OrgTriage browser
extension, the orgtriage.com website, and the remediation plans the extension
produces. Published by Everything Virtually LLC.

## The short version

OrgTriage is a diagnostic tool, not an adviser. It reads your org's
configuration and tells you what it found, with a suggested fix for each
finding. **Every finding and every step is a recommendation.** Have someone who
knows your org check it, test it outside production, and deploy it the way you
deploy everything else. The software is provided as is, with no warranty.

## What OrgTriage does

It reads configuration metadata and Apex source through the Salesforce API,
applies a set of rules to what it reads, and produces findings with a score, a
priority, remediation steps, acceptance criteria and an estimate. It is
read-only: it does not change your org, execute reports, or read business
records. The full list of what it reads is in the
[privacy policy](privacy.html).

## What OrgTriage is not

- **Not an audit, a certification, or a security assessment.** A high score is
  not a statement that your org is secure, compliant, or correctly configured.
- **Not complete.** A rule can only judge what the API returns. Areas that could
  not be checked are marked as unchecked, not given a clean score, and managed-package
  components are excluded by default.
- **Not legal, financial, or professional advice**, and not a substitute for
  someone who knows your org and your business.

## Verify before you act

Findings come from rules. Most cite the Salesforce documentation behind them;
some cite the open-source linter the rule came from; a few are our own
judgement and say so in the finding. Thresholds that are our recommendation
rather than a documented Salesforce limit are labelled as such.

**An experienced Salesforce administrator or developer should review any change
before it is made.** Test in a sandbox, use your normal release process, and
keep whatever backups your policies require. Estimates are planning figures,
not quotes; the work may take more or less time in your org.

## No warranty

OrgTriage is provided **"as is" and "as available", without warranty of any
kind**, express or implied, including but not limited to warranties of
merchantability, fitness for a particular purpose, non-infringement, accuracy,
or completeness. We do not warrant that the software will be uninterrupted or
error-free, that findings are accurate or exhaustive, or that acting on them
will produce any particular result.

## Limitation of liability

To the maximum extent permitted by law, Everything Virtually LLC and its
members are not liable for any indirect, incidental, special, consequential or
punitive damages, or for any loss of data, revenue, profits, or business,
arising out of or relating to your use of OrgTriage — including any change you
make to a Salesforce org in response to a finding. To the maximum extent
permitted by law, our total liability for all claims relating to OrgTriage will
not exceed the greater of the amount you paid us for it (which, for the free
extension, is nothing) or ten US dollars.

Some jurisdictions do not allow the exclusion of certain warranties or the
limitation of certain damages, so parts of the two sections above may not apply
to you.

## Your responsibilities

You are responsible for the changes you make to your Salesforce org, for
complying with your own organisation's policies and your agreement with
Salesforce, and for having the rights to use the extension against the org you
scan. Use the extension only in orgs you are authorised to administer.

## Third-party software and trademarks

OrgTriage includes open-source components under their own licences; they are
listed in the NOTICE file that ships with the extension.

Salesforce and the Salesforce marks are trademarks of Salesforce, Inc.
**OrgTriage is not affiliated with, endorsed by, or sponsored by Salesforce,
Inc.**, and is not an AppExchange product. Any other product named in our
documentation is named to describe a fact about it, not to claim any
association with it.

OrgTriage is a trademark of Everything Virtually LLC.

## Changes

These terms may change as the product does. The effective date above says when
this version was published; material changes will be noted on this page.

## Contact

Questions: [support@orgtriage.com](mailto:support@orgtriage.com?subject=OrgTriage%20terms) · Everything Virtually LLC.

---

© 2026 OrgTriage · Everything Virtually LLC
