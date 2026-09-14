/**
 * `<orgtriage-app>` — the panel shell.
 *
 * Rendered into the light DOM (`createRenderRoot` returns `this`) so the global
 * SLDS-derived stylesheet applies. Shadow DOM would isolate this component from
 * the design system for no benefit: the panel already sits in its own origin
 * and its own document.
 */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { store, ANALYZERS, type TabId } from './state';
import { renderOverview } from './views/overview';
import { renderDiagnostics } from './views/diagnostics';
import { renderWork } from './views/work';
import { renderAreas } from './views/areas';
import { icons, formatBytes, formatRelative, errorAlert, empty } from './ui';
import { navigateTab } from './tab';

/**
 * Production, Sandbox or Developer Edition — the thing an admin checks before
 * acting on a finding. The edition itself (Enterprise, Unlimited…) is in the
 * badge's tooltip; scratch orgs report as sandboxes, which is right for this.
 */
function orgKind(org: { isSandbox: boolean; organizationType: string }): string {
  if (org.isSandbox) return 'Sandbox';
  if (/developer edition/i.test(org.organizationType)) return 'Developer Edition';
  return 'Production';
}

export class OrgTriageApp extends LitElement {
  private unsubscribe?: () => void;

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override connectedCallback(): void {
    super.connectedCallback();
    this.unsubscribe = store.subscribe(() => this.requestUpdate());
  }

  override disconnectedCallback(): void {
    super.disconnectedCallback();
    this.unsubscribe?.();
  }

  protected override render(): TemplateResult {
    return html`
      <div class="os-app">
        ${this.renderTabs()}
        <main class="os-main" id="os-main" role="main" tabindex="-1">
          ${this.renderBuildNotice()}${this.renderBody()}
        </main>
        ${this.renderStatusBar()}
      </div>
    `;
  }

  /* ---------------------------------------------------------------------- */

  /**
   * Three tabs, not one per area.
   *
   * The counters differ on purpose: Work shows how much there is to do, and
   * Areas how many areas have anything critical. A single number on ten tabs
   * told the reader nothing they could act on.
   */
  private renderTabs(): TemplateResult {
    const { tab, slots } = store.state;
    const results = ANALYZERS.map((a) => slots[a.id].result);
    const openWork = results.reduce(
      (n, r) =>
        n +
        (r?.findings.filter((f) => !f.inconclusive && f.severity !== 'success' && f.items.length > 0).length ?? 0),
      0,
    );
    const areasWithCritical = results.filter((r) => (r?.score.counts.critical ?? 0) > 0).length;
    const scanning = Object.values(slots).some((slot) => slot.loading);

    const tabs: { id: TabId; label: string; count: number }[] = [
      { id: 'overview', label: 'Overview', count: 0 },
      { id: 'work', label: 'Work', count: openWork },
      { id: 'areas', label: 'Areas', count: areasWithCritical },
    ];

    const { org, connecting } = store.state;
    // One row: the views on the left, the org centred in what is left, the
    // theme control on the right. Chrome's own side-panel bar carries the
    // name and mark, so no row of ours repeats them. The org name is the
    // first thing to give way when the panel is narrow.
    return html`
      <div class="os-tabs">
        <div class="os-tabs__list" role="tablist" aria-label="Views">
          ${tabs.map(
          (t) => html`
            <button
              type="button"
              role="tab"
              class="os-tab"
              aria-selected=${String(tab === t.id)}
              aria-controls="os-main"
              @click=${() => store.setTab(t.id)}
            >
              ${t.label}
              ${scanning && t.id !== 'overview'
                ? html`<span class="os-badge os-badge--neutral">…</span>`
                : t.count > 0
                  ? html`<span class="os-badge os-badge--critical">${t.count}</span>`
                  : nothing}
            </button>
            `,
          )}
        </div>
        <span class="os-tabs__org">
          ${connecting
            ? html`<span class="os-muted">Connecting…</span>`
            : org
              ? html`
                  <b class="os-tabs__org-name" title=${org.orgName}>${org.orgName}</b>
                  <span class="os-badge os-badge--neutral" title="${org.organizationType} · ${org.apiHost}">
                    ${orgKind(org)}
                  </span>
                  <span class="os-muted">v${org.apiVersion}</span>
                `
              : html`<span class="os-muted">Not connected</span>`}
        </span>
        <button
          type="button"
          class="os-button os-button--icon os-tabs__theme"
          title="Toggle theme"
          aria-label="Toggle theme"
          @click=${this.toggleTheme}
        >
          ${document.documentElement.dataset.osTheme === 'light' ? icons.moon : icons.sun}
        </button>
      </div>
    `;
  }


  private renderBuildNotice(): TemplateResult | typeof nothing {
    const { workerBuild } = store.state;
    if (workerBuild === null || workerBuild === __ORGTRIAGE_BUILD__) return nothing;
    return html`
      <div class="os-alert os-alert--warning" role="alert">
        <span>
          This sidebar is build <b>${__ORGTRIAGE_BUILD__}</b> but the background service is running
          <b>${workerBuild}</b>, so newer checks will fail. Open
          <code class="os-inline">chrome://extensions</code>, reload OrgTriage, then reload this
          Salesforce tab.
        </span>
      </div>
    `;
  }

  private renderBody(): TemplateResult {
    const { org, orgError, connecting, tab } = store.state;

    if (connecting) return empty('Connecting to your org…');

    // Beside a tab that is not Salesforce — the remediation plan, a new tab,
    // anything else — the panel has nothing to connect to. That is not an
    // error to retry, and it should not look like one.
    if (!org && orgError?.code === 'NO_TAB') {
      return empty(
        'Not beside a Salesforce tab',
        'Switch to a Salesforce tab and the panel follows it. Article links and the remediation plan open in their own tabs on purpose.',
      );
    }

    if (!org) {
      return html`
        <div class="os-stack">
          ${orgError
            ? errorAlert(orgError, () => void store.connect())
            : empty('Not connected to a Salesforce org.')}

          ${renderDiagnostics({
            blurb: 'Checks each step of the connection and reports where it stops',
          })}

          <div class="os-card">
            <div class="os-card__header"><h2 class="os-card__title">What OrgTriage needs</h2></div>
            <div class="os-card__body os-stack">
              <p style="margin:0">
                OrgTriage reads your existing Salesforce session from the browser — it never asks for
                a password, and it stores no credentials. Open a Lightning tab in the org you want
                to inspect, then retry.
              </p>
              <p style="margin:0" class="os-metric__sub">
                If you are logged in and this persists, your user may lack the
                <code class="os-inline">View Setup and Configuration</code> permission, which the
                metadata queries require.
              </p>
            </div>
          </div>
        </div>
      `;
    }

    if (tab === 'overview') return renderOverview();
    if (tab === 'work') return renderWork();
    return renderAreas();
  }

  private renderStatusBar(): TemplateResult {
    const { budget, cacheEntries, cacheBytes, cacheKnown, slots, org } = store.state;
    // Where Salesforce shows the same figure: the System Overview page in
    // Setup, "API Requests, Last 24 Hours" — the place its own API-limits
    // article says to look. Navigates the tab beside the panel, like every
    // other Salesforce link here, so the two stay side by side.
    const systemOverview = org ? `https://${org.lightningHost}/lightning/setup/SystemOverview/home` : null;
    const newest = cacheEntries.reduce((max, e) => Math.max(max, e.completedAt), 0);
    const anyStale = Object.values(slots).some((s) => s.staleness.state === 'stale');
    const scanning = Object.values(slots).some((s) => s.loading);
    const reading = !cacheKnown || Object.values(slots).some((s) => s.reading);

    const dotClass = scanning || reading
      ? 'os-statusbar__dot'
      : anyStale
        ? 'os-statusbar__dot os-statusbar__dot--stale'
        : cacheEntries.length === 0
          ? 'os-statusbar__dot os-statusbar__dot--offline'
          : 'os-statusbar__dot';

    return html`
      <footer class="os-statusbar" role="status">
        <span class="os-statusbar__item">
          <span class=${dotClass}></span>
          ${scanning
            ? 'Scanning…'
            : reading
              ? 'Reading snapshots…'
              : cacheEntries.length === 0
                ? 'No local snapshot'
                : anyStale
                  ? `Snapshot ${formatRelative(newest)} · org has changed`
                  : `Snapshot ${formatRelative(newest)}`}
        </span>

        <span class="os-statusbar__item" title="Local cache size">
          ${cacheKnown ? `${cacheEntries.length} cached · ${formatBytes(cacheBytes)}` : '…'}
        </span>

        <button
          type="button"
          class="os-statusbar__item os-statusbar__link"
          title="Scan settings: managed packages, API version, budgets"
          @click=${() => void chrome.runtime.openOptionsPage()}
        >
          Options
        </button>

        <span class="os-statusbar__spacer"></span>

        ${budget
          ? html`<span
              class="os-statusbar__item"
              title=${budget.observedAt
                ? `Salesforce's own tally of this org's rolling 24-hour API allowance, read from the last response at ${new Date(budget.observedAt).toLocaleTimeString()}. Salesforce tabulates usage with a delay — its documentation says the figures are accurate within five minutes — so right after a scan this reads higher than it will settle to. OrgTriage's count is exact: every request it has made to this org today.`
                : 'No call has been made to this org yet, so Salesforce has not reported the allowance'}
            >
              ${systemOverview
                ? html`<button
                    type="button"
                    class="os-statusbar__link"
                    title="Open Setup > System Overview in the Salesforce tab, where this figure is shown as API Requests, Last 24 Hours"
                    @click=${() => navigateTab(systemOverview)}
                  >Salesforce tally</button>`
                : 'Salesforce tally'}
              <span class="os-muted">(delayed)</span>
              ${budget.remaining !== null && budget.max !== null
                ? `${budget.remaining.toLocaleString()} / ${budget.max.toLocaleString()} left`
                : 'unknown'}
              <!-- Two different kinds of number. Salesforce's is a delayed
                   tabulation (measured: seconds after a 179-call scan its own
                   header still showed 70 consumed); ours counts requests as
                   they are made. Labelling the first as Salesforce's tally
                   stops the pair reading as a contradiction. -->
              ${budget.observedAt && Date.now() - budget.observedAt > 60_000
                ? html`<span class="os-muted"
                    >(at ${new Date(budget.observedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })})</span
                  >`
                : nothing}
              ${budget.usedByOrgTriage > 0 ? html`· OrgTriage used ${budget.usedByOrgTriage} today` : nothing}
            </span>`
          : nothing}
      </footer>
    `;
  }

  private toggleTheme = (): void => {
    const next = document.documentElement.dataset.osTheme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.osTheme = next;
    void store.prefsSet({ theme: next });
    this.requestUpdate();
  };
}

customElements.define('orgtriage-app', OrgTriageApp);

declare global {
  interface HTMLElementTagNameMap {
    'orgtriage-app': OrgTriageApp;
  }
}
