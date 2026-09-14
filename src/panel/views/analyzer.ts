/**
 * Per-analyzer view: score, metrics, and the findings list.
 *
 * A custom element rather than a render function because the filter/search
 * state is local to the tab and has no business in the global store.
 * Decorators are avoided in favour of `static properties` so the build does not
 * depend on decorator transform settings.
 */

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { store, ANALYZERS } from '../state';
import {
  badge,
  empty,
  errorAlert,
  formatDate,
  formatNumber,
  formatRelative,
  gradeTone,
  icons,
  metric,
  neutralBadge,
  skeletonRows,
  SEVERITY_ORDER,
} from '../ui';
import { proportionBar, scoreDial } from '../charts';
import { summariseDiff, type AreaDiff, type RuleChange } from '@/shared/diff';
import { navigateTab, openInNewTab } from '../tab';
import { openPlan } from '../planLink';
import { setupLinkFor } from '@/shared/setupLinks';
import { PLAYBOOK } from '@/shared/playbook';
import { docLabel, estimateHours, formatHours } from '@/shared/plan';
import type { AnalyzerId, Finding, Severity } from '@/shared/types';

export function renderAnalyzer(analyzer: AnalyzerId): TemplateResult {
  return html`<orgtriage-analyzer .analyzer=${analyzer}></orgtriage-analyzer>`;
}

export class OrgTriageAnalyzer extends LitElement {
  static override properties = {
    analyzer: { type: String },
    query: { state: true },
    severityFilter: { state: true },
  };

  declare analyzer: AnalyzerId;
  declare query: string;
  declare severityFilter: Severity | 'all';

  private unsubscribe?: () => void;

  constructor() {
    super();
    this.analyzer = 'apex';
    this.query = '';
    this.severityFilter = 'all';
  }

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

  /**
   * A deep link asks for one finding to be scrolled into view. It is only
   * possible once that finding has rendered, which may be a render or two
   * after the request when cached results are still loading, so the request
   * stays pending until the element exists.
   */
  protected override updated(): void {
    const target = store.state.pendingScroll;
    if (!target || store.state.focusArea !== this.analyzer) return;
    const el = this.querySelector<HTMLElement>(`[data-finding="${CSS.escape(target)}"]`);
    if (!el) return;
    store.patch({ pendingScroll: null });
    el.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }

  protected override render(): TemplateResult {
    const slot = store.state.slots[this.analyzer];
    const meta = ANALYZERS.find((a) => a.id === this.analyzer)!;

    return html`
      ${this.renderToolbar()}
      ${slot.error ? errorAlert(slot.error, () => void store.scan(this.analyzer)) : nothing}
      ${(slot.loading || slot.reading) && !slot.result
        ? html`<div class="os-card">${skeletonRows(6)}</div>`
        : !slot.result
          ? empty(
              `No ${meta.label} snapshot yet.`,
              meta.blurb,
              html`<button
                class="os-button os-button--brand"
                type="button"
                @click=${() => void store.scan(this.analyzer)}
              >
                ${icons.refresh} Run scan
              </button>`,
            )
          : this.renderResult()}
    `;
  }

  /* ---------------------------------------------------------------------- */

  private renderToolbar(): TemplateResult {
    const slot = store.state.slots[this.analyzer];
    const stale = slot.staleness.state === 'stale';

    return html`
      <div class="os-toolbar">
        <button
          class="os-button ${stale || !slot.result ? 'os-button--brand' : ''}"
          type="button"
          ?disabled=${slot.loading}
          @click=${() => void store.scan(this.analyzer)}
          title="Queries the org and replaces the local snapshot. Costs API calls."
        >
          ${icons.refresh} ${slot.loading ? 'Scanning…' : slot.result ? 'Refresh' : 'Run scan'}
        </button>
        ${slot.loading
          ? html`<button
              class="os-button"
              type="button"
              @click=${() => void store.cancelScan(this.analyzer)}
              title="Stops this scan. The area keeps its previous snapshot; API calls already made are not refunded."
            >
              Cancel
            </button>`
          : nothing}

        ${slot.result
          ? html`
              <span class="os-metric__sub">
                ${stale
                  ? html`<span class="os-badge os-badge--warning">Stale</span>
                      ${slot.staleness.reason ?? ''}`
                  : html`Snapshot ${formatRelative(slot.result.completedAt)} ·
                      ${slot.result.apiCalls} API calls`}
              </span>
            `
          : nothing}

        <span class="os-header__spacer"></span>

        ${slot.result
          ? html`
              <button
                class="os-button os-button--subtle"
                type="button"
                title="Printable plan with steps, acceptance criteria and estimates for every finding"
                @click=${() => store.state.org && openPlan(store.state.org)}
              >
                ${icons.document} Plan
              </button>
              <input
                class="os-input os-input--search"
                type="search"
                placeholder="Filter findings and components…"
                aria-label="Filter findings"
                .value=${this.query}
                @input=${(e: Event) => {
                  this.query = (e.target as HTMLInputElement).value;
                }}
              />
              <select
                class="os-select"
                aria-label="Severity filter"
                .value=${this.severityFilter}
                @change=${(e: Event) => {
                  this.severityFilter = (e.target as HTMLSelectElement).value as Severity | 'all';
                }}
              >
                <option value="all">All severities</option>
                <option value="critical">Critical</option>
                <option value="warning">Warning</option>
                <option value="info">Info</option>
              </select>
            `
          : nothing}
      </div>

      ${slot.loading && slot.progress
        ? html`
            <div class="os-stack">
              <span class="os-metric__sub">
                ${slot.progress.phase} · ${slot.progress.apiCalls} API calls
              </span>
              <div class="os-meter">
                <div
                  class="os-meter__fill"
                  style=${`width:${(slot.progress.fraction ?? 0.05) * 100}%`}
                ></div>
              </div>
            </div>
          `
        : nothing}
    `;
  }

  /**
   * API usage by user — two pointers, no report run.
   *
   * This card used to execute the org's "API Usage Last 7 Days" report. It
   * never could: that is a standard report, standard reports are not `Report`
   * records, and the name lookup returned nothing in every org it was tried
   * in — while the only thing it *could* have executed was a custom report
   * somebody had named "API Usage…". Report execution is gone from the
   * extension altogether. Per-user counts have two sources, both linked here.
   */
  private renderApiUsage(): TemplateResult {
    const org = store.state.org;
    const classicReports = org ? `https://${org.apiHost}/00O/o` : null;
    return html`
      <div class="os-card">
        <div class="os-card__header">
          <h2 class="os-card__title">API usage by user</h2>
          <span class="os-metric__sub">OrgTriage never runs a report; this one is read in Salesforce</span>
        </div>
        <div class="os-card__body os-stack">
          <p class="os-metric__sub">
            <strong>API Usage Last 7 Days</strong> — Salesforce Classic only, in the
            <em>Administrative Reports</em> folder (Reports tab → All Folders). Enterprise, Performance
            and Unlimited editions, and Developer Edition orgs that ship the folder. Needs <em>View Setup
            and Configuration</em>. Salesforce notes it does not count every call — some Bulk API requests
            are missing — so treat it as a per-user picture, not an audit.
          </p>
          <p class="os-metric__sub">
            <strong>ApiTotalUsage event log</strong> — one line per API request, with the user, client and
            resource, available at no cost in Developer, Enterprise, Unlimited and Performance editions
            with one day of retention. Setup → <em>Event Monitoring Settings</em> → <em>Generate Event
            Log Files</em>, then <em>Event Log File Browser</em>. This is the complete source.
          </p>
          ${classicReports
            ? html`<div class="os-toolbar" style="padding:0;border:0">
                <a
                  class="os-button"
                  href=${classicReports}
                  @click=${(e: Event) => {
                    e.preventDefault();
                    navigateTab(classicReports);
                  }}
                  title="Opens in this Salesforce tab"
                  >${icons.pane} Open the Classic Reports tab</a
                >
              </div>`
            : nothing}
        </div>
      </div>
    `;
  }

  private renderResult(): TemplateResult {
    const result = store.state.slots[this.analyzer].result!;
    const findings = this.filtered(result.findings);

    return html`
      <div class="os-hero">
        <div class="os-hero__dial">
          ${scoreDial(
            result.score.score,
            result.score.grade ? gradeTone(result.score.grade) : 'info',
            { label: `${ANALYZERS.find((a) => a.id === this.analyzer)!.label} score` },
          )}
        </div>
        <div class="os-hero__body">
          <div class="os-hero__headline">
            <h2 class="os-hero__title">
              ${ANALYZERS.find((a) => a.id === this.analyzer)!.label}
            </h2>
            ${result.score.grade
              ? badge(gradeTone(result.score.grade), `Grade ${result.score.grade}`)
              : nothing}
          </div>
          <p class="os-hero__sub">
            ${formatNumber(result.score.examined)} components examined
            ${result.score.ungradedReason
              ? html`<br /><span style="color:var(--os-status-warning)"
                    >${result.score.ungradedReason}</span
                  >`
              : nothing}
          </p>
          ${proportionBar(
            [
              {
                label: 'Critical',
                value: result.score.counts.critical,
                color: 'var(--os-sev-critical)',
              },
              {
                label: 'Warning',
                value: result.score.counts.warning,
                color: 'var(--os-sev-warning)',
              },
              { label: 'Info', value: result.score.counts.info, color: 'var(--os-sev-info)' },
              {
                label: 'Checks passed',
                value: result.score.counts.success,
                color: 'var(--os-sev-success)',
              },
            ],
            { label: 'Findings by severity', height: 10 },
          )}
        </div>
      </div>

      <div class="os-metrics">
          ${Object.entries(result.metrics).map(([label, m]) =>
            metric(
              label,
              m.value,
              m.sub,
              typeof m.meter === 'number'
                ? {
                    fraction: m.meter,
                    tone: m.meter > 0.85 ? 'critical' : m.meter > 0.6 ? 'warning' : 'success',
                  }
                : undefined,
              (() => {
                const org = store.state.org;
                const link = org ? setupLinkFor(this.analyzer, label, org.lightningHost) : null;
                return link ? { ...link, open: navigateTab } : undefined;
              })(),
            ),
          )}
      </div>

      ${renderDiff(store.state.slots[this.analyzer].diff)}
      ${this.analyzer === 'ops' ? this.renderApiUsage() : nothing}

      ${result.truncated
        ? html`<div class="os-alert os-alert--warning" role="alert">
            <span>
              Partial results: ${result.truncated.reason} Examined
              ${formatNumber(result.truncated.examined)} of
              ${result.truncated.total === null ? 'an unknown number of' : formatNumber(result.truncated.total)}
              components.
            </span>
          </div>`
        : nothing}
      ${result.warnings.length > 0
        ? html`<div class="os-alert os-alert--info">
            <div class="os-stack">
              ${result.warnings.map((w) => html`<span>${w}</span>`)}
            </div>
          </div>`
        : nothing}

      <div class="os-card">
        <div class="os-card__header">
          <h2 class="os-card__title">Findings</h2>
          ${SEVERITY_ORDER.filter((s) => s !== 'success').map((s) =>
            result.score.counts[s] > 0 ? badge(s, `${result.score.counts[s]} ${s}`) : nothing,
          )}
          <span class="os-header__spacer"></span>
          <span class="os-metric__sub">${findings.length} shown</span>
        </div>
        <div class="os-card__body--flush">
          ${findings.length === 0
            ? empty(
                result.findings.length === 0
                  ? 'No issues found in this area.'
                  : 'No findings match the current filter.',
              )
            : findings.map((f) => this.renderFinding(f))}
        </div>
      </div>
    `;
  }

  private renderFinding(finding: Finding): TemplateResult {
    const items = this.filterItems(finding);
    return html`
      <details
        class="os-finding"
        data-finding=${finding.id}
        ?open=${store.isFindingOpen(this.analyzer, finding.id)}
        @toggle=${(e: Event) =>
          store.setFindingOpen(this.analyzer, finding.id, (e.target as HTMLDetailsElement).open)}
      >
        <summary class="os-finding__summary os-sev-rail os-sev-rail--${finding.severity}">
          <span class="os-finding__chevron">${icons.chevron}</span>
          <span class="os-finding__title" title=${finding.title}>${finding.title}</span>
          ${finding.inconclusive
            ? neutralBadge('Not evaluated')
            : html`<span class="os-finding__count">${formatNumber(finding.items.length)}</span>`}
          ${badge(finding.severity)}
        </summary>
        <div class="os-finding__body">
          ${finding.inconclusive
            ? html`<div class="os-alert os-alert--info">
                <span>This check could not run: ${finding.inconclusive.reason}</span>
              </div>`
            : nothing}
          <div class="os-finding__why">${finding.rationale}</div>
          <div class="os-finding__fix"><strong>Fix:</strong> ${finding.remediation}</div>
          ${this.renderSteps(finding)}
          ${finding.docUrl
            ? html`<a
                class="os-link"
                href=${finding.docUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                ${docLabel(finding.docUrl)} ${icons.external}
              </a>`
            : nothing}
          ${items.length > 0 ? this.renderItemTable(finding, items) : nothing}
        </div>
      </details>
    `;
  }

  /**
   * The playbook's step-by-step guide, collapsed by default so the finding
   * list stays scannable. The estimate shown is the same one the remediation
   * plan uses, so the sidebar and the printed backlog never disagree.
   */
  private renderSteps(finding: Finding): TemplateResult | typeof nothing {
    const playbook = PLAYBOOK[finding.id];
    if (!playbook || finding.inconclusive || finding.items.length === 0) return nothing;
    const hours = estimateHours(playbook, finding.items.length);
    return html`
      <details
        class="os-finding__steps"
        ?open=${store.isFindingOpen(this.analyzer, `${finding.id}#steps`)}
        @toggle=${(e: Event) =>
          store.setFindingOpen(
            this.analyzer,
            `${finding.id}#steps`,
            (e.target as HTMLDetailsElement).open,
          )}
      >
        <summary>
          Step-by-step (${playbook.steps.length}) · ${playbook.role} · about ${formatHours(hours)}
        </summary>
        <ol>
          ${playbook.steps.map((step) => html`<li>${step}</li>`)}
        </ol>
        <div class="os-finding__done"><strong>Done when:</strong> ${playbook.acceptance}</div>
      </details>
    `;
  }

  private renderItemTable(finding: Finding, items: Finding['items']): TemplateResult {
    // Union of every evidence key present, so a rule can attach whatever
    // columns make its case without the view knowing them in advance.
    const columns: string[] = [];
    for (const item of items) {
      for (const key of Object.keys(item.evidence ?? {})) {
        if (!columns.includes(key)) columns.push(key);
      }
    }
    // Header and cells are right-aligned together for the columns that read as
    // numbers. Testing `typeof value === 'number'` alone put "API version" and
    // "Size" right and "Coverage" (a `0%` string) left in the same table; a
    // strict all-values test then let one "no data" row drag the whole column
    // back to the left. A majority decides instead.
    const numeric = new Set(columns.filter((c) => isNumericColumn(items.map((i) => i.evidence?.[c]))));

    return html`
      <div class="os-table-wrap" style="max-height:320px">
        <table class="os-table">
          <thead>
            <tr>
              <th scope="col">Component</th>
              ${columns.map((c) => html`<th scope="col" class=${numeric.has(c) ? 'os-num' : ''}>${c}</th>`)}
            </tr>
          </thead>
          <tbody>
            ${items.map(
              (item) => html`
                <tr>
                  <td title=${item.setupUrl ? `${item.label ?? item.name} — the name opens in this Salesforce tab; the arrow opens a new tab, which the panel follows` : (item.label ?? item.name)}>
                    ${item.setupUrl
                      ? html`<a
                            class="os-api-name os-item__link"
                            href=${item.setupUrl}
                            @click=${(e: Event) => {
                              e.preventDefault();
                              navigateTab(item.setupUrl!);
                            }}
                            >${item.name}</a
                          ><button
                            class="os-button os-button--icon os-item__go"
                            type="button"
                            title="Open in a new tab (the panel follows the new tab)"
                            aria-label="Open ${item.name} in a new tab"
                            @click=${() => openInNewTab(item.setupUrl!)}
                          >
                            ${icons.external}
                          </button>`
                      : html`<span class="os-api-name">${item.name}</span>`}
                    ${item.label && item.label !== item.name
                      ? html`<span class="os-muted"> · ${item.label}</span>`
                      : nothing}
                  </td>
                  ${columns.map((c) => {
                    const value = item.evidence?.[c];
                    return html`<td
                      class=${numeric.has(c) ? 'os-num' : ''}
                      title=${value === null || value === undefined ? '' : String(value)}
                    >
                      ${value === null || value === undefined
                        ? html`<span class="os-muted">—</span>`
                        : typeof value === 'number'
                          ? formatNumber(value)
                          : String(value)}
                    </td>`;
                  })}
                </tr>
              `,
            )}
          </tbody>
        </table>
      </div>
      ${items.length < finding.items.length
        ? html`<span class="os-metric__sub">
            Showing ${formatNumber(items.length)} of ${formatNumber(finding.items.length)} matching
            the filter.
          </span>`
        : nothing}
    `;
  }

  /* ---------------------------------------------------------------------- */

  private filtered(findings: Finding[]): Finding[] {
    const query = this.query.trim().toLowerCase();
    return findings
      .filter((f) => this.severityFilter === 'all' || f.severity === this.severityFilter)
      .filter((f) => {
        if (!query) return true;
        if (f.title.toLowerCase().includes(query)) return true;
        return f.items.some((i) => i.name.toLowerCase().includes(query) ||
          (i.label ?? '').toLowerCase().includes(query));
      })
      .sort(
        (a, b) =>
          SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
          b.items.length - a.items.length,
      );
  }

  private filterItems(finding: Finding): Finding['items'] {
    const query = this.query.trim().toLowerCase();
    const matchesTitle = query && finding.title.toLowerCase().includes(query);
    if (!query || matchesTitle) return finding.items;
    return finding.items.filter(
      (i) =>
        i.name.toLowerCase().includes(query) || (i.label ?? '').toLowerCase().includes(query),
    );
  }
}

customElements.define('orgtriage-analyzer', OrgTriageAnalyzer);

declare global {
  interface HTMLElementTagNameMap {
    'orgtriage-analyzer': OrgTriageAnalyzer;
  }
}

/**
 * Values an analyzer writes where a number would go when it has none.
 * They stand in for a missing number, so they abstain from the alignment
 * vote rather than arguing the column is text.
 */
const NUMERIC_PLACEHOLDERS = new Set(['no data', 'not coverable', 'not measured', 'unknown', 'none', 'n/a', '—']);

/**
 * Does this evidence value read as a number?
 *
 * True for numbers and for strings that are a number with an optional unit —
 * `0%`, `1,292`, `3.1 d`, `58.0`. Empty values and placeholders are `null`:
 * they stand where a number would and should not vote either way.
 */
export function isNumericLike(value: unknown): boolean | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && NUMERIC_PLACEHOLDERS.has(value.trim().toLowerCase())) return null;
  if (typeof value === 'number') return true;
  if (typeof value !== 'string') return false;
  return /^-?\d[\d,]*(\.\d+)?\s*(%|h|d|wk|min|KB|MB|GB|pts?|points?)?$/.test(value.trim());
}

/**
 * Is this whole column right-aligned?
 *
 * By majority of the values that have an opinion, so a stray "no data" among
 * ninety-nine percentages does not left-align the column — and a column of
 * component names with one numeric-looking entry stays left.
 */
export function isNumericColumn(values: unknown[]): boolean {
  let numeric = 0;
  let other = 0;
  for (const value of values) {
    const verdict = isNumericLike(value);
    if (verdict === null) continue;
    if (verdict) numeric += 1;
    else other += 1;
  }
  return numeric > other;
}

/**
 * "Since the previous scan" — the two lists that answer *is this getting
 * better?*
 *
 * Deliberately not a table of every rule: the unchanged rules are the majority
 * and listing them would bury the handful that moved. A rule that fired in both
 * scans with the same components produces no row at all.
 */
function renderDiff(diff: AreaDiff | null): TemplateResult | typeof nothing {
  if (!diff) return nothing;

  const improved = [...diff.resolved, ...diff.changed.filter((c) => c.delta < 0)];
  const worsened = [...diff.appeared, ...diff.changed.filter((c) => c.delta > 0)];
  if (diff.unchanged && improved.length === 0 && worsened.length === 0) {
    return html`<p class="os-metric__sub" style="margin:0">
      Nothing changed in this area since the scan on ${formatDate(diff.since)}.
    </p>`;
  }

  return html`
    <div class="os-card">
      <div class="os-card__header">
        <h2 class="os-card__title">Since ${formatDate(diff.since)}</h2>
        <span class="os-metric__sub">${summariseDiff(diff)}</span>
        ${diff.scoreDelta !== null && diff.scoreDelta !== 0
          ? html`<span
              class="os-delta ${diff.scoreDelta > 0 ? 'os-delta--up' : 'os-delta--down'}"
              >${diff.scoreDelta > 0 ? '▲ +' : '▼ '}${diff.scoreDelta} score</span
            >`
          : nothing}
      </div>
      ${diff.platformMoved
        ? html`<p class="os-metric__sub" style="margin:0; padding: 0 var(--os-space-md)">
            Salesforce moved this org from API v${diff.platformMoved.from} to v${diff.platformMoved.to}
            between these scans. Findings about old API versions grow for that reason alone.
          </p>`
        : nothing}
      <div class="os-card__body os-changes">
        ${improved.length > 0
          ? html`<section class="os-changes__group">
              <h3 class="os-changes__heading os-changes__heading--good">Fixed</h3>
              <ul class="os-changes__list">
                ${improved.map((c) => changeRow(c, 'cleared'))}
              </ul>
            </section>`
          : nothing}
        ${worsened.length > 0
          ? html`<section class="os-changes__group">
              <h3 class="os-changes__heading os-changes__heading--bad">New</h3>
              <ul class="os-changes__list">
                ${worsened.map((c) => changeRow(c, 'appeared'))}
              </ul>
            </section>`
          : nothing}
      </div>
    </div>
  `;
}

function changeRow(change: RuleChange, side: 'appeared' | 'cleared'): TemplateResult {
  const names = side === 'appeared' ? change.appeared : change.cleared;
  const magnitude = Math.abs(change.delta) || names.length;
  return html`
    <li class="os-changes__item">
      <span class="os-changes__count">${side === 'appeared' ? '+' : '−'}${magnitude}</span>
      <span class="os-changes__title">${change.title}</span>
      ${names.length > 0
        ? html`<span class="os-changes__names">
            ${names.slice(0, 6).map((n) => html`<code class="os-inline">${n}</code>`)}
            ${names.length > 6 ? html`<span class="os-muted">+${names.length - 6} more</span>` : nothing}
          </span>`
        : change.namesIncomplete
          ? html`<span class="os-muted os-changes__names"
              >Too many components to name individually — the count is exact, the list is not
              kept.</span
            >`
          : nothing}
    </li>
  `;
}
