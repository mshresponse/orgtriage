/**
 * Opens the remediation plan for the connected org in a new tab.
 *
 * The report is an extension page, so it cannot ask the worker "which org is
 * this tab on" the way the sidebar does. The sidebar therefore hands it the
 * org's *display* facts in the URL fragment — id, name, edition, host — none of
 * which is a credential, and the report reads the cached snapshots for that id
 * from the worker. No API call is made to render it.
 */

import type { OrgContext } from '@/shared/types';

export function planUrl(org: OrgContext): string {
  const params = new URLSearchParams({
    orgId: org.orgId,
    name: org.orgName,
    type: org.organizationType,
    sandbox: String(org.isSandbox),
    instance: org.instanceName,
    api: org.apiVersion,
    host: org.lightningHost,
    user: org.userName,
  });
  return `${chrome.runtime.getURL('report.html')}#${params.toString()}`;
}

export function openPlan(org: OrgContext): void {
  // A new tab the user is taken to. The panel is not wanted beside the plan:
  // the report page switches it off for its own tab as it loads, and the
  // worker does the same for every tab that is not Salesforce.
  void chrome.tabs.create({ url: planUrl(org), active: true });
}
