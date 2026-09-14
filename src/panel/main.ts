/**
 * Panel entry point.
 *
 * Runs at the extension origin in Chrome's side panel. Every query goes
 * through the service worker, which is the only place a session id ever
 * exists — `auth.ts` exposes no function that hands one out, so a request made
 * from here would simply be unauthenticated. The manifest CSP additionally
 * bounds *every* extension context, worker included, to Salesforce hosts, so
 * there is no third party to exfiltrate to. See docs/SECURITY.md.
 */

import '@/styles/theme.css';
import '@/styles/components.css';
import './app';

import { store } from './state';
import { bindActiveTab, followActiveTab } from './tab';

function applyTheme(preference: 'dark' | 'light' | 'system'): void {
  const resolved =
    preference === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : preference;
  document.documentElement.dataset.osTheme = resolved;
}

async function main(): Promise<void> {
  await bindActiveTab();
  // A different tab or a different origin means a possibly different org.
  // `reconnect()` keeps the current view mounted while it re-resolves; a full
  // `connect()` would blank the panel on every tab switch.
  followActiveTab(
    () => void store.reconnect(),
    () => void store.takeFocus(),
  );
  // The plan page says so explicitly after it has stored a focus and steered
  // the tab; a same-URL navigation produces no URL change to react to.
  chrome.runtime.onMessage.addListener((message: { type?: string } | undefined) => {
    if (message?.type === 'focus.nudge') void store.takeFocus();
  });

  await Promise.all([store.prefsLoad(), store.viewLoad(), store.checkBuild()]);
  applyTheme(store.state.prefs.theme);
  window
    .matchMedia('(prefers-color-scheme: light)')
    .addEventListener('change', () => {
      if (store.state.prefs.theme === 'system') applyTheme('system');
    });

  const root = document.getElementById('root');
  if (root) root.appendChild(document.createElement('orgtriage-app'));

  await store.connect();
}

void main();
