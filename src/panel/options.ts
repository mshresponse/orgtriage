/**
 * Options page. Runs at the extension origin in its own tab.
 *
 * Deliberately small: everything here is a scan-cost or presentation choice.
 * There is nothing to configure about credentials because there are none to
 * configure — OrgTriage reads the session the browser already holds.
 */

import '@/styles/theme.css';
import '@/styles/components.css';

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { icons } from './ui';
import { DEFAULT_PANEL_PREFS, type PanelPrefs } from '@/shared/types';

interface Settings {
  includeManaged: boolean;
  detailBudget: number;
  apiVersionOverride: string;
}

const DEFAULT_SETTINGS: Settings = {
  includeManaged: false,
  detailBudget: 300,
  apiVersionOverride: '',
};

class OrgTriageOptions extends LitElement {
  static override properties = {
    settings: { state: true },
    prefs: { state: true },
    saved: { state: true },
  };

  declare settings: Settings;
  declare prefs: PanelPrefs;
  declare saved: boolean;

  constructor() {
    super();
    this.settings = { ...DEFAULT_SETTINGS };
    this.prefs = { ...DEFAULT_PANEL_PREFS };
    this.saved = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    const stored = await chrome.storage.local.get(['settings', 'panelPrefs']);
    this.settings = { ...DEFAULT_SETTINGS, ...(stored.settings as Partial<Settings>) };
    this.prefs = { ...DEFAULT_PANEL_PREFS, ...(stored.panelPrefs as Partial<PanelPrefs>) };
    document.documentElement.dataset.osTheme =
      this.prefs.theme === 'system'
        ? window.matchMedia('(prefers-color-scheme: light)').matches
          ? 'light'
          : 'dark'
        : this.prefs.theme;
  }

  private async patchSettings(patch: Partial<Settings>): Promise<void> {
    this.settings = { ...this.settings, ...patch };
    await chrome.storage.local.set({ settings: this.settings });
    this.flashSaved();
  }

  private async patchPrefs(patch: Partial<PanelPrefs>): Promise<void> {
    this.prefs = { ...this.prefs, ...patch };
    await chrome.storage.local.set({ panelPrefs: this.prefs });
    this.flashSaved();
  }

  private flashSaved(): void {
    this.saved = true;
    setTimeout(() => {
      this.saved = false;
    }, 1600);
  }

  protected override render(): TemplateResult {
    return html`
      <div class="os-app" style="max-width:760px;margin:0 auto">
        <header class="os-header">
          <span class="os-header__mark">
            <span class="os-header__logo">${icons.mark}</span>
            OrgTriage options
          </span>
          <span class="os-header__spacer"></span>
          ${this.saved ? html`<span class="os-badge os-badge--success">Saved</span>` : nothing}
        </header>

        <main class="os-main">
          <div class="os-card">
            <div class="os-card__header"><h2 class="os-card__title">Scanning</h2></div>
            <div class="os-card__body os-stack" style="gap:var(--os-space-lg)">
              ${this.field(
                'Include managed-package components',
                'Off by default. Managed code and flows cannot be changed by an admin, and including them ' +
                  'makes every "old API version" and "no coverage" list mostly noise.',
                html`<label class="os-row">
                  <input
                    type="checkbox"
                    .checked=${this.settings.includeManaged}
                    @change=${(e: Event) =>
                      void this.patchSettings({
                        includeManaged: (e.target as HTMLInputElement).checked,
                      })}
                  />
                  <span>Include managed packages</span>
                </label>`,
              )}
              ${this.field(
                'Detail budget',
                'Flow structure and Lightning page components are fetched 25 per API call; report filters ' +
                  'cost one call per report, because Salesforce describes reports one at a time. Every call ' +
                  'counts against the org’s rolling 24-hour allowance. This caps how many components each ' +
                  'area inspects in depth; changing it starts a fresh comparison baseline, since a smaller ' +
                  'budget examines fewer components.',
                html`<div class="os-row">
                  <input
                    class="os-input"
                    type="number"
                    min="25"
                    max="2000"
                    step="25"
                    style="width:110px"
                    .value=${String(this.settings.detailBudget)}
                    @change=${(e: Event) =>
                      void this.patchSettings({
                        detailBudget: clampNumber(
                          Number((e.target as HTMLInputElement).value),
                          25,
                          2000,
                          DEFAULT_SETTINGS.detailBudget,
                        ),
                      })}
                  />
                  <span class="os-metric__sub">
                    components per area · flows and pages about ${Math.ceil(this.settings.detailBudget / 25)} calls
                    each, reports up to ${this.settings.detailBudget}
                  </span>
                </div>`,
              )}
              ${this.field(
                'API version',
                'Left blank, OrgTriage asks the org which versions it serves and uses the newest. Override only ' +
                  'if you need to pin a specific version.',
                html`<div class="os-row">
                  <input
                    class="os-input"
                    type="text"
                    placeholder="negotiate with the org"
                    style="width:150px"
                    .value=${this.settings.apiVersionOverride}
                    @change=${(e: Event) =>
                      void this.patchSettings({
                        apiVersionOverride: normalizeVersion((e.target as HTMLInputElement).value),
                      })}
                  />
                  <span class="os-metric__sub">e.g. <code class="os-inline">66.0</code></span>
                </div>`,
              )}
            </div>
          </div>

          <div class="os-card">
            <div class="os-card__header"><h2 class="os-card__title">Panel</h2></div>
            <div class="os-card__body os-stack" style="gap:var(--os-space-lg)">
              ${this.field(
                'Theme',
                'Sage and Charcoal in either polarity.',
                html`<select
                  class="os-select"
                  .value=${this.prefs.theme}
                  @change=${(e: Event) => {
                    const theme = (e.target as HTMLSelectElement).value as PanelPrefs['theme'];
                    void this.patchPrefs({ theme });
                    document.documentElement.dataset.osTheme =
                      theme === 'system'
                        ? window.matchMedia('(prefers-color-scheme: light)').matches
                          ? 'light'
                          : 'dark'
                        : theme;
                  }}
                >
                  <option value="system">Match system</option>
                  <option value="dark">Dark</option>
                  <option value="light">Light</option>
                </select>`,
              )}
            </div>
          </div>

          <div class="os-card">
            <div class="os-card__header"><h2 class="os-card__title">Data and privacy</h2></div>
            <div class="os-card__body os-stack">
              <p style="margin:0">
                OrgTriage uses the Salesforce session your browser already holds. It never asks for a password,
                never stores a credential, and sends nothing to any server other than your own Salesforce org.
              </p>
              <p style="margin:0" class="os-metric__sub">
                Snapshots are stored locally in this browser profile (IndexedDB) and contain metadata names,
                dates, and rule verdicts — never record data. Clear them any time from the sidebar’s Overview
                tab. Nothing refreshes on its own: every query happens because you asked for one.
              </p>
            </div>
          </div>
        </main>
      </div>
    `;
  }

  private field(label: string, help: string, control: TemplateResult): TemplateResult {
    return html`
      <div class="os-stack">
        <strong>${label}</strong>
        <span class="os-metric__sub" style="max-width:62ch">${help}</span>
        ${control}
      </div>
    `;
  }
}

function clampNumber(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

/** Accepts `66`, `66.0`, or `v66.0`; anything else clears the override. */
function normalizeVersion(input: string): string {
  const trimmed = input.trim().replace(/^v/i, '');
  if (trimmed === '') return '';
  const parsed = Number.parseFloat(trimmed);
  return Number.isFinite(parsed) && parsed >= 41 ? parsed.toFixed(1) : '';
}

customElements.define('orgtriage-options', OrgTriageOptions);
document.getElementById('root')?.appendChild(document.createElement('orgtriage-options'));
