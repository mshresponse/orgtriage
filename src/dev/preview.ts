/**
 * Dev preview harness.
 *
 * Renders the real panel against fixture data with the `chrome.*` APIs stubbed,
 * so the layout, density, and contrast can be checked at the widths a side
 * panel is dragged to, without a Salesforce org. Not part of any shipped
 * bundle — the extension build has no entry point that reaches this file.
 */

import { scans, orgContext, previousDigests } from './fixtures';
import { diffAgainst } from '@/shared/diff';
import type { Request, Response } from '@/shared/messages';
import { DEFAULT_PANEL_PREFS, type AnalyzerId } from '@/shared/types';

/** Widths a side panel is commonly dragged to; Chrome's minimum is about 320px. */
const WIDTHS: { px: number; label: string }[] = [
  { px: 320, label: '320px' },
  { px: 400, label: '400px' },
  { px: 520, label: '520px' },
  { px: 720, label: '720px' },
];

/* -------------------------------------------------------------------------- */
/* chrome.* stubs                                                             */
/* -------------------------------------------------------------------------- */

export function installChromeStub(): void {
  // Backed by localStorage rather than a plain object: the panel persists the
  // open tab and the expanded findings so they survive the page reload that a
  // Lightning navigation causes, and an in-memory stub cannot exercise that.
  const PREVIEW_STORAGE = 'orgtriage.preview.storage';
  const load = (): Record<string, unknown> => {
    try {
      return { ...JSON.parse(localStorage.getItem(PREVIEW_STORAGE) ?? '{}') };
    } catch {
      return {};
    }
  };
  const store: Record<string, unknown> = { panelPrefs: { ...DEFAULT_PANEL_PREFS }, ...load() };
  const persist = () => {
    try {
      localStorage.setItem(PREVIEW_STORAGE, JSON.stringify(store));
    } catch {
      /* preview only */
    }
  };
  // `?fail=1` exercises the not-connected state and the diagnostics table —
  // the paths that only appear when something has gone wrong.
  const simulateFailure = new URLSearchParams(location.search).has('fail');

  const respond = (request: Request): Response => {
    switch (request.type) {
      case 'org.context':
        if (simulateFailure) {
          return {
            ok: false,
            error: {
              code: 'NO_REACHABLE_HOST',
              message:
                "None of this org's API hosts answered: acme.my.salesforce.com (Could not reach " +
                'https://acme.my.salesforce.com/services/data/ — Failed to fetch.)',
              hint: 'Check that you are signed in to the org in this tab and that no proxy or network policy blocks it.',
            },
          } as Response;
        }
        return { ok: true, data: orgContext } as Response;
      case 'diag.selfTest':
        return {
          ok: true,
          data: {
            checks: [
              { name: 'Salesforce tab', ok: true, detail: 'acme.lightning.force.com' },
              { name: 'Session cookie', ok: true, detail: 'Org 00Dau0000012ABC' },
              {
                name: 'Candidate API hosts',
                ok: true,
                detail: 'acme.my.salesforce.com, acme.develop.my.salesforce.com',
              },
              {
                name: 'Reachable API host',
                ok: false,
                detail:
                  "None of this org's API hosts answered: acme.my.salesforce.com (Failed to fetch)",
              },
            ],
          },
        } as Response;
      case 'meta.build':
        return {
          ok: true,
          data: { build: __ORGTRIAGE_BUILD__, analyzers: ['apex', 'flows', 'reports', 'layouts', 'ops'] },
        } as Response;
      case 'prefs.get':
        return { ok: true, data: store.panelPrefs } as Response;
      case 'prefs.set':
        // The real worker merges the patch and returns the result; a stub that
        // ignored the patch made every preference look broken in the preview.
        store.panelPrefs = { ...(store.panelPrefs as object), ...request.patch };
        persist();
        return { ok: true, data: store.panelPrefs } as Response;
      case 'scan.cached':
        return {
          ok: true,
          data: {
            result: scans[request.analyzer],
            staleness:
              request.analyzer === 'reports'
                ? {
                    state: 'stale',
                    cachedAt: scans.reports.completedAt,
                    reason: 'Setup changes were recorded after this snapshot.',
                  }
                : { state: 'fresh', cachedAt: scans[request.analyzer].completedAt },
            diff: previousDigests[request.analyzer]
              ? diffAgainst(previousDigests[request.analyzer]!, scans[request.analyzer])
              : undefined,
          },
        } as Response;
      case 'scan.run':
        return { ok: true, data: { status: 'done', result: scans[request.analyzer] } } as Response;
      case 'report.data':
        return {
          ok: true,
          data: {
            results: Object.values(scans).filter((s) => s.orgId === request.orgId),
            entries: [],
            diffs: Object.entries(previousDigests).map(([id, digest]) =>
              diffAgainst(digest, scans[id as AnalyzerId]),
            ),
          },
        } as Response;
      case 'budget.get':
        return {
          ok: true,
          data: { max: 100_000, remaining: 78_412, usedByOrgTriage: 215, observedAt: Date.now() },
        } as Response;
      case 'cache.status':
        return {
          ok: true,
          data: {
            entries: Object.values(scans).map((s) => ({
              analyzer: s.analyzer,
              orgId: s.orgId,
              completedAt: s.completedAt,
              apiVersion: s.apiVersion,
              bytes: JSON.stringify(s).length,
            })),
            totalBytes: Object.values(scans).reduce((n, s) => n + JSON.stringify(s).length, 0),
            quotaBytes: null,
          },
        } as Response;
      case 'cache.clear':
        return { ok: true, data: { cleared: 4 } } as Response;
      default:
        return {
          ok: false,
          error: { code: 'PREVIEW', message: `No preview stub for ${request.type}.` },
        } as Response;
    }
  };

  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      id: 'preview',
      // Extension pages live at the Vite root; `?preview` tells the report
      // page to install this stub rather than talk to a worker.
      getURL: (path: string) =>
        `/${path.replace(/^\//, '')}${path.endsWith('.html') ? '?preview' : ''}`,
      sendMessage: async (request: Request) => respond(request),
      connect: () => ({
        onMessage: { addListener: () => {} },
        onDisconnect: { addListener: () => {} },
        postMessage: () => {},
        disconnect: () => {},
      }),
      onMessage: { addListener: () => {} },
      openOptionsPage: () => window.open('/options.html?preview', '_blank'),
    },
    // The panel binds to the active tab and follows it; the preview has one
    // pretend Salesforce tab and nothing ever switches.
    tabs: {
      query: async () => [{ id: 1, url: 'https://acme.my.salesforce.com/lightning/page/home' }],
      get: async () => ({ id: 1, url: 'https://acme.my.salesforce.com/lightning/page/home' }),
      update: async () => undefined,
      create: async () => ({ id: 2 }),
      getCurrent: async () => undefined,
      onActivated: { addListener: () => {} },
      onUpdated: { addListener: () => {} },
    },
    storage: {
      local: {
        get: async (key: string | string[]) => {
          const keys = Array.isArray(key) ? key : [key];
          return Object.fromEntries(keys.map((k) => [k, store[k]]));
        },
        set: async (patch: Record<string, unknown>) => {
          Object.assign(store, patch);
          persist();
        },
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Frame (inner) vs harness (outer)                                           */
/* -------------------------------------------------------------------------- */

const isFrame = new URLSearchParams(location.search).has('frame');
// The report page imports this module for the stub alone and mounts itself.
const isReport = location.pathname.endsWith('/report.html');

if (isReport) {
  installChromeStub();
} else if (isFrame) {
  installChromeStub();
  void import('../panel/main');
} else {
  document.title = 'OrgTriage — panel preview';
  renderHarness();
}

function renderHarness(): void {
  const style = document.createElement('style');
  style.textContent = `
    :root { color-scheme: dark; }
    body {
      margin: 0;
      /* A definite height, not min-height: the iframe below uses height:100%,
         which only resolves against a parent with a definite height. */
      height: 100vh;
      background:
        linear-gradient(180deg, #1a1c19 0%, #121411 100%);
      font-family: ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
      color: #e9ece7;
      display: flex;
      flex-direction: column;
    }
    .bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 14px;
      background: #101210;
      border-bottom: 1px solid #262a24;
      font-size: 12px;
      flex: none;
      flex-wrap: wrap;
    }
    .bar strong { letter-spacing: .02em; }
    .bar .hint { color: #8b918a; }
    .bar .spacer { flex: 1 1 auto; }
    button {
      font: inherit;
      font-size: 12px;
      background: transparent;
      color: #b3b9b0;
      border: 1px solid #363a35;
      border-radius: 3px;
      padding: 3px 10px;
      cursor: pointer;
    }
    button[aria-pressed='true'] {
      background: #587053;
      border-color: #587053;
      color: #f4f7f3;
      font-weight: 600;
    }
    .stage {
      flex: 1 1 auto;
      min-height: 0;
      display: flex;
      justify-content: flex-end;
      position: relative;
      background:
        repeating-linear-gradient(45deg, #1c1f1b 0 12px, #191c18 12px 24px);
    }
    .stage::before {
      content: 'Salesforce Lightning page (simulated)';
      position: absolute;
      top: 16px;
      left: 20px;
      color: #565c53;
      font-size: 13px;
      letter-spacing: .04em;
    }
    iframe {
      border: 0;
      height: 100%;
      background: #161815;
      box-shadow: 0 0 0 1px #000, -8px 0 28px rgb(0 0 0 / .5);
      transition: width 180ms cubic-bezier(.25,.1,.25,1);
    }
  `;
  document.head.appendChild(style);

  const bar = document.createElement('div');
  bar.className = 'bar';
  const stage = document.createElement('div');
  stage.className = 'stage';
  const frame = document.createElement('iframe');
  const fail = new URLSearchParams(location.search).has('fail') ? '&fail=1' : '';
  frame.src = `${location.pathname}?frame=1${fail}`;
  stage.appendChild(frame);

  let current = 400;
  const apply = (): void => {
    frame.style.width = `${current}px`;
    for (const button of bar.querySelectorAll('button[data-width]')) {
      button.setAttribute('aria-pressed', String(Number(button.getAttribute('data-width')) === current));
    }
  };

  const title = document.createElement('strong');
  title.textContent = 'OrgTriage preview';
  bar.appendChild(title);

  const hint = document.createElement('span');
  hint.className = 'hint';
  hint.textContent = 'Fixture data · panel width:';
  bar.appendChild(hint);

  for (const point of WIDTHS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.dataset.width = String(point.px);
    button.textContent = point.label;
    button.addEventListener('click', () => {
      current = point.px;
      apply();
    });
    bar.appendChild(button);
  }

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  bar.appendChild(spacer);

  const themeButton = document.createElement('button');
  themeButton.type = 'button';
  themeButton.textContent = 'Toggle theme';
  themeButton.addEventListener('click', () => {
    const doc = frame.contentDocument?.documentElement;
    if (!doc) return;
    doc.dataset.osTheme = doc.dataset.osTheme === 'light' ? 'dark' : 'light';
  });
  bar.appendChild(themeButton);

  document.body.append(bar, stage);
  apply();
}
