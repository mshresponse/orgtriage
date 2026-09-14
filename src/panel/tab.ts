/**
 * Which Salesforce tab the side panel is showing beside.
 *
 * Chrome's side panel belongs to the window, not to a page, so the panel has
 * to follow the active tab itself: it binds to the active tab at start, again
 * whenever the user switches tabs, and again when the bound tab navigates to
 * a different origin. Every worker request carries the bound tab id and the
 * worker reads that tab's URL from the browser, so the panel never says which
 * org it wants — only which of the user's tabs it is looking at.
 */

import { setDefaultTabId } from '@/shared/messages';

let boundTabId: number | null = null;
let boundOrigin: string | null = null;

function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Bind to the window's active tab. Returns true when the org may have changed. */
export async function bindActiveTab(): Promise<boolean> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const nextId = tab?.id ?? null;
  // A tab the plan just opened has only a pending URL until navigation
  // commits; without it the panel called a loading Salesforce tab "not a
  // Salesforce tab" for the first second.
  const nextOrigin = originOf(tab?.url || tab?.pendingUrl);
  const changed = nextId !== boundTabId || nextOrigin !== boundOrigin;
  boundTabId = nextId;
  boundOrigin = nextOrigin;
  setDefaultTabId(boundTabId);
  return changed;
}

export function boundTab(): number | null {
  return boundTabId;
}

/**
 * Follow the user between tabs and across navigations. `onChange` fires only
 * when the tab or its origin changed: Lightning rewrites the URL on almost
 * every click, and reconnecting on each of those blanked the panel.
 */
export function followActiveTab(onChange: () => void, onNavigate?: () => void): void {
  chrome.tabs.onActivated.addListener(() => {
    void bindActiveTab().then((changed) => {
      if (changed) onChange();
    });
  });
  chrome.tabs.onUpdated.addListener((tabId, info) => {
    if (tabId !== boundTabId || !info.url) return;
    // Any navigation of the bound tab: the plan page steers this tab to a
    // component and leaves a finding for the panel to land on.
    onNavigate?.();
    const next = originOf(info.url);
    if (next === boundOrigin) return;
    boundOrigin = next;
    onChange();
  });
}

/**
 * Resolve once the bound tab has finished loading, or after `maxWaitMs`.
 *
 * Connecting while Salesforce is still bootstrapping a freshly opened tab
 * made the first API call compete with the page and time out; the user then
 * pressed Retry and it worked. Waiting for the tab to settle costs nothing
 * on a tab that is already loaded.
 */
export async function whenBoundTabSettled(maxWaitMs = 8_000): Promise<void> {
  const id = boundTabId;
  if (id === null) return;
  try {
    const tab = await chrome.tabs.get(id);
    if (tab.status !== 'loading') return;
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, maxWaitMs);
    function listener(tabId: number, info: chrome.tabs.TabChangeInfo): void {
      if (tabId === id && info.status === 'complete') done();
    }
    function done(): void {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

/** Navigate the bound tab. The panel stays; that is the point of the side panel. */
export function navigateTab(url: string): void {
  if (boundTabId === null) return;
  void chrome.tabs.update(boundTabId, { url });
}

/**
 * Open a URL in a new tab with the panel beside it.
 *
 * A side panel belongs to the tab it was opened in, so a new tab starts
 * without one; the panel does not follow on its own. The remediation plan
 * page already does this dance, and it must happen here too or the arrow
 * that promises "the panel follows" leaves the user on a bare Salesforce tab.
 */
export function openInNewTab(url: string): void {
  void chrome.tabs.create({ url, active: true }).then(async (tab) => {
    if (tab.id === undefined) return;
    try {
      await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'panel.html', enabled: true });
      await chrome.sidePanel.open({ tabId: tab.id });
    } catch {
      /* the browser declined (no user gesture left, or already open): the tab is there either way */
    }
  });
}
