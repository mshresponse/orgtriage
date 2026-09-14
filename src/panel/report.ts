/**
 * The remediation plan — a printable document built from the cached snapshots.
 *
 * Runs in its own tab at the extension origin. Everything on the page comes
 * from `report.data`, which reads the local cache and makes no API call, so
 * the document can be printed, saved as PDF, or exported to a tracker without
 * touching the org again.
 *
 * Structure follows how a backlog is written rather than how a scanner thinks:
 * one story per finding with a key, a priority, an estimate, the steps that fix
 * it, and what "done" means — followed by an explicit list of what could not be
 * checked, so the plan never implies that silence is health.
 */

import '@/styles/theme.css';
import '@/styles/report.css';

import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { send } from '@/shared/messages';
import { docLabel } from '@/shared/plan';
import type { AnalyzerId, FindingItem, ScanResult } from '@/shared/types';
import type { AreaDiff, RuleChange } from '@/shared/diff';
import { icons } from './ui';
import {
  AREA_LABEL,
  AREA_ORDER,
  buildPlan,
  DAYS_PER_SPRINT,
  EFFORT_LABEL,
  EPIC_NAME,
  formatDays,
  formatHours,
  HOURS_PER_PERSON_DAY,
  planToGenericCsv,
  planToJiraCsv,
  planToJson,
  planToMarkdown,
  PRIORITY_LABEL, PRIORITY_NAME,
  type Plan,
  type PlanOrg,
  type Priority,
  type ReviewItem,
  type Story,
} from '@/shared/plan';

const PREPARED_BY_KEY = 'reportPreparedBy';
/** 'system' resolves against the OS setting, as the panel does. */
function resolveTheme(preference: 'light' | 'dark' | 'system'): 'light' | 'dark' {
  if (preference !== 'system') return preference;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
const COMPACT_ITEMS = 25;

interface View {
  includeInfo: boolean;
  compact: boolean;
  /** Acceptance criteria are the longest block on a story; some readers want the list without them. */
  showAcceptance: boolean;
  preparedBy: string;
  /** `null` means every priority. */
  priority: Priority | null;
  /** Free-text filter over title, component names and rule id. */
  query: string;
  /** Restrict the backlog to one area, set by clicking a row in the matrix. */
  area: AnalyzerId | null;
  theme: 'light' | 'dark';
}

function orgFromHash(): PlanOrg | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  const orgId = params.get('orgId');
  if (!orgId) return null;
  return {
    orgId,
    orgName: params.get('name') || 'Salesforce org',
    organizationType: params.get('type') || '',
    isSandbox: params.get('sandbox') === 'true',
    instanceName: params.get('instance') || '',
    apiVersion: params.get('api') || '',
    lightningHost: params.get('host') || '',
    userName: params.get('user') || '',
  };
}

function download(name: string, type: string, content: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function fileStem(plan: Plan): string {
  const org = plan.org.orgName.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'org';
  return `orgtriage-plan-${org}-${new Date(plan.generatedAt).toISOString().slice(0, 10)}`;
}

/**
 * Recompute the totals for a filtered subset.
 *
 * Not a partial update of the originals: a filtered plan whose header still
 * showed the unfiltered estimate would misreport the scope of the work, which
 * is the one number a client reads off this page.
 */
function totalsFor(plan: Plan, stories: Story[]): Plan['totals'] {
  const hours = Math.round(stories.reduce((n, s) => n + s.effortHours, 0) * 4) / 4;
  const totals: Plan['totals'] = {
    stories: stories.length,
    components: stories.reduce((n, s) => n + s.items.length, 0),
    hours,
    personDays: Math.round((hours / HOURS_PER_PERSON_DAY) * 10) / 10,
    sprints: Math.round((hours / HOURS_PER_PERSON_DAY / DAYS_PER_SPRINT) * 10) / 10,
    points: stories.reduce((n, s) => n + s.points, 0),
    byPriority: { P1: 0, P2: 0, P3: 0 },
    byKind: { bug: 0, debt: 0, hygiene: 0 },
    critical: 0,
    warning: 0,
    info: 0,
  };
  for (const story of stories) {
    totals.byPriority[story.priority] += 1;
    totals.byKind[story.kind] += 1;
    if (story.severity === 'critical') totals.critical += 1;
    else if (story.severity === 'warning') totals.warning += 1;
    else totals.info += 1;
  }
  return totals;
}

type Tone = 'success' | 'info' | 'warning' | 'critical';

export function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function gradeTone(grade: string): Tone {
  if (grade === 'A') return 'success';
  if (grade === 'B') return 'info';
  if (grade === 'C') return 'warning';
  return 'critical';
}

/**
 * The score ring on the cover.
 *
 * Inline SVG with a dasharray rather than a chart library: this page is printed
 * as often as it is read, and a canvas-drawn chart is a blank rectangle in a
 * PDF. The number is beside the ring, not inside it, so the ring can be small
 * enough not to dominate the tile.
 */
function dial(score: number, grade: string): TemplateResult {
  const size = 44;
  const stroke = 5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return html`
    <svg class="rp-dial" viewBox="0 0 ${size} ${size}" width=${size} height=${size} role="img" aria-label="Org health ${score} out of 100">
      <circle cx=${size / 2} cy=${size / 2} r=${r} fill="none" stroke="var(--os-chart-track)" stroke-width=${stroke} />
      <circle
        cx=${size / 2}
        cy=${size / 2}
        r=${r}
        fill="none"
        stroke="var(--os-status-${gradeTone(grade)})"
        stroke-width=${stroke}
        stroke-linecap="round"
        stroke-dasharray="${(c * Math.max(0, Math.min(100, score))) / 100} ${c}"
        transform="rotate(-90 ${size / 2} ${size / 2})"
      />
    </svg>
  `;
}

/**
 * The priority mix as one bar.
 *
 * Every segment is also written out in the legend beneath with its count, which
 * is what lets the bar use three colours at all — on the light ground two of
 * them sit below the 3:1 contrast the palette gate would otherwise demand.
 */
function priorityBar(byPriority: Record<Priority, number>): TemplateResult {
  const total = byPriority.P1 + byPriority.P2 + byPriority.P3;
  if (total === 0) return html`<div class="rp-prio"></div>`;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return html`
    <div class="rp-prio" role="img" aria-label="${byPriority.P1} P1, ${byPriority.P2} P2, ${byPriority.P3} P3">
      <span class="rp-prio__seg rp-prio__seg--p1" style=${`width:${pct(byPriority.P1)}`}></span>
      <span class="rp-prio__seg rp-prio__seg--p2" style=${`width:${pct(byPriority.P2)}`}></span>
      <span class="rp-prio__seg rp-prio__seg--p3" style=${`width:${pct(byPriority.P3)}`}></span>
    </div>
  `;
}

function formatDate(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

class OrgTriageReport extends LitElement {
  static override properties = {
    plan: { state: true },
    error: { state: true },
    view: { state: true },
    copied: { state: true },
    exportOpen: { state: true },
  };

  declare plan: Plan | null;
  declare error: string | null;
  declare view: View;
  declare copied: boolean;
  declare exportOpen: boolean;

  private org: PlanOrg | null = null;
  private results: ScanResult[] = [];
  /** What moved since the previous snapshot, per area. Empty on a first scan. */
  private diffs: AreaDiff[] = [];

  constructor() {
    super();
    this.plan = null;
    this.error = null;
    this.view = {
      includeInfo: true,
      compact: false,
      showAcceptance: true,
      preparedBy: '',
      priority: null,
      query: '',
      area: null,
      theme: 'light',
    };
    this.copied = false;
    this.exportOpen = false;
  }

  protected override createRenderRoot(): HTMLElement {
    return this;
  }

  override async connectedCallback(): Promise<void> {
    super.connectedCallback();
    // The side panel has no use beside the plan. Switch it off for this tab;
    // the worker's per-tab rule does the same, this just does not wait for it.
    void chrome.tabs
      .getCurrent()
      .then((tab) => (tab?.id === undefined ? undefined : chrome.sidePanel.setOptions({ tabId: tab.id, enabled: false })))
      .catch(() => {
        /* not running as a tab (preview harness), or no side panel API */
      });
    try {
      // The theme is the panel's: one preference, so the plan opens in the
      // theme the panel is showing. An earlier version kept its own key here,
      // and the report went dark on its own after one click on its toggle.
      const stored = await chrome.storage.local.get([PREPARED_BY_KEY, 'panelPrefs']);
      const preparedBy = stored[PREPARED_BY_KEY];
      const prefs = stored.panelPrefs as { theme?: 'light' | 'dark' | 'system' } | undefined;
      if (typeof preparedBy === 'string') this.view = { ...this.view, preparedBy };
      this.applyTheme(resolveTheme(prefs?.theme ?? 'system'), { persist: false });
    } catch {
      /* preference only */
    }
    await this.load();
  }

  private async load(): Promise<void> {
    this.org = orgFromHash();
    if (!this.org) {
      this.error = 'This page needs to be opened from the OrgTriage sidebar, which tells it which org to report on.';
      return;
    }
    const res = await send({ type: 'report.data', orgId: this.org.orgId });
    if (!res.ok) {
      this.error = res.error.message;
      return;
    }
    this.results = res.data.results;
    this.diffs = res.data.diffs ?? [];
    if (this.results.length === 0) {
      this.error = `No snapshots are cached for ${this.org.orgName}. Run a scan in the sidebar first, then open the plan again.`;
      return;
    }
    this.plan = buildPlan(this.org, this.results);
    document.title = `Remediation plan — ${this.org.orgName}`;
  }

  /**
   * The plan with the current view filters applied.
   *
   * Exports read this, not the raw plan, so what downloads is exactly what is
   * on screen. A CSV that quietly contained the rows a filter had hidden would
   * be the worst kind of surprise in a document someone hands to a client.
   *
   * Epics are recomputed against the surviving stories: an epic whose every
   * story was filtered out must not reach the Jira import as an empty parent.
   */
  private get visible(): Plan | null {
    if (!this.plan) return null;
    const { includeInfo, priority, query, area } = this.view;
    const needle = query.trim().toLowerCase();

    let stories = this.plan.stories;
    if (!includeInfo) stories = stories.filter((s) => s.severity !== 'info');
    if (priority) stories = stories.filter((s) => s.priority === priority);
    if (area) stories = stories.filter((s) => s.analyzer === area);
    if (needle) {
      stories = stories.filter(
        (s) =>
          s.title.toLowerCase().includes(needle) ||
          s.key.toLowerCase().includes(needle) ||
          s.ruleId.toLowerCase().includes(needle) ||
          s.area.toLowerCase().includes(needle) ||
          s.items.some((i) => i.name.toLowerCase().includes(needle)),
      );
    }
    if (stories === this.plan.stories) return this.plan;

    const keptKeys = new Set(stories.map((s) => s.key));
    const epics = this.plan.epics
      .map((e) => ({ ...e, storyKeys: e.storyKeys.filter((k) => keptKeys.has(k)) }))
      .filter((e) => e.storyKeys.length > 0);

    return { ...this.plan, stories, epics, totals: totalsFor(this.plan, stories) };
  }

  /** True when anything is hiding rows, so the page can say so. */
  private get filtered(): boolean {
    const { includeInfo, priority, query, area } = this.view;
    return !includeInfo || priority !== null || area !== null || query.trim() !== '';
  }

  private applyTheme(theme: 'light' | 'dark', opts: { persist?: boolean } = {}): void {
    this.view = { ...this.view, theme };
    document.documentElement.setAttribute('data-os-theme', theme);
    if (opts.persist === false) return;
    // Written into the panel's preferences, so the toggle here and the one in
    // the panel move the same switch.
    void chrome.storage.local
      .get('panelPrefs')
      .then((stored) =>
        chrome.storage.local.set({ panelPrefs: { ...((stored.panelPrefs as object | undefined) ?? {}), theme } }),
      )
      .catch(() => {
        /* preference only */
      });
  }

  /* ---------------------------------------------------------------------- */

  protected override render(): TemplateResult {
    if (this.error) {
      return html`<div class="rp-page"><div class="rp-empty"><strong>Cannot build the plan.</strong><span>${this.error}</span></div></div>`;
    }
    const plan = this.visible;
    if (!plan) return html`<div class="rp-page"><div class="rp-empty">Building the plan…</div></div>`;

    return html`
      ${this.renderToolbar(plan)}
      <div class="rp-page">
        ${this.renderCover(plan)} ${this.renderSummary(plan)} ${this.renderProgress()}
        ${this.renderLegend()}
        ${this.renderBacklog(plan)}
        <section class="rp-section">
          <div class="rp-section__head">
            <h2>Backlog items</h2>
            ${this.filtered
              ? html`<button class="rp-linkbutton rp-noprint" type="button" @click=${() => this.clearFilters()}>
                  Clear all filters
                </button>`
              : nothing}
          </div>
          ${this.renderFilters()}
          ${plan.stories.length === 0
            ? html`<p class="rp-muted">No items match the current filters.</p>`
            : plan.epics.map((epic) => this.renderEpic(epic, plan))}
        </section>
        ${this.renderReview(plan)} ${this.renderMethod(plan)}
      </div>
    `;
  }

  private renderToolbar(plan: Plan): TemplateResult {
    return html`
      <div class="rp-toolbar rp-noprint" role="toolbar" aria-label="Report actions">
        <span class="rp-toolbar__mark">${icons.mark} OrgTriage</span>
        <button class="rp-button rp-button--brand" type="button" @click=${() => window.print()}>
          Print / save as PDF
        </button>

        <div class="rp-menu">
          <button
            class="rp-button"
            type="button"
            aria-expanded=${this.exportOpen}
            @click=${() => {
              this.exportOpen = !this.exportOpen;
            }}
          >
            Export ▾
          </button>
          ${this.exportOpen
            ? html`<div class="rp-menu__list" role="menu">
                ${this.exportItem(
                  'CSV for Jira',
                  'Epics first, then their work items as Bugs and Tasks, with both Parent and Epic Link so either project type can map it.',
                  () => download(`${fileStem(plan)}-jira.csv`, 'text/csv;charset=utf-8', planToJiraCsv(plan)),
                )}
                ${this.exportItem(
                  'CSV — any tracker',
                  'One flat row per backlog item with plain column names, for Azure DevOps, Linear, Asana or a spreadsheet.',
                  () => download(`${fileStem(plan)}.csv`, 'text/csv;charset=utf-8', planToGenericCsv(plan)),
                )}
                ${this.exportItem(
                  'Markdown',
                  'For Confluence, a wiki, or a pull request description.',
                  () => download(`${fileStem(plan)}.md`, 'text/markdown;charset=utf-8', planToMarkdown(plan)),
                )}
                ${this.exportItem(
                  'JSON',
                  'The whole plan, for driving a tracker’s API rather than its importer.',
                  () => download(`${fileStem(plan)}.json`, 'application/json', planToJson(plan)),
                )}
                ${this.exportItem(
                  this.copied ? 'Copied to clipboard' : 'Copy Markdown',
                  'Paste straight into a ticket or a document.',
                  () => void this.copyMarkdown(plan),
                )}
              </div>`
            : nothing}
        </div>

        <span class="rp-toolbar__spacer"></span>

        <label class="rp-check">
          <input
            type="checkbox"
            .checked=${this.view.includeInfo}
            @change=${(e: Event) => this.setView({ includeInfo: (e.target as HTMLInputElement).checked })}
          />
          Include low priority (info / tech debt)
        </label>
        <label class="rp-check">
          <input
            type="checkbox"
            .checked=${this.view.showAcceptance}
            @change=${(e: Event) => this.setView({ showAcceptance: (e.target as HTMLInputElement).checked })}
          />
          Acceptance criteria
        </label>
        <label class="rp-check">
          <input
            type="checkbox"
            .checked=${this.view.compact}
            @change=${(e: Event) => this.setView({ compact: (e.target as HTMLInputElement).checked })}
          />
          Compact component lists
        </label>
        <label class="rp-check">
          Prepared by
          <input
            class="rp-input"
            type="text"
            placeholder="your name or company"
            .value=${this.view.preparedBy}
            @change=${(e: Event) => this.setPreparedBy((e.target as HTMLInputElement).value)}
          />
        </label>
        <button
          class="rp-button rp-button--icon"
          type="button"
          title=${this.view.theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}
          aria-label="Toggle theme"
          @click=${() => this.applyTheme(this.view.theme === 'dark' ? 'light' : 'dark')}
        >
          ${this.view.theme === 'dark' ? '☀' : '☾'}
        </button>
      </div>
    `;
  }

  private exportItem(label: string, hint: string, run: () => void): TemplateResult {
    return html`
      <button
        class="rp-menu__item"
        type="button"
        role="menuitem"
        @click=${() => {
          run();
          this.exportOpen = false;
        }}
      >
        <span class="rp-menu__label">${label}</span>
        <span class="rp-menu__hint">${hint}</span>
      </button>
    `;
  }

  private renderCover(plan: Plan): TemplateResult {
    const { org } = plan;
    return html`
      <header class="rp-cover">
        <div class="rp-cover__eyebrow">OrgTriage · Salesforce org health</div>
        <h1>Remediation plan</h1>
        <div class="rp-cover__org">${org.orgName}</div>
        <dl class="rp-facts">
          <div><dt>Edition</dt><dd>${org.organizationType || '—'}${org.isSandbox ? ' · sandbox' : ''}</dd></div>
          <div><dt>Instance</dt><dd>${org.instanceName || '—'}</dd></div>
          <div><dt>Org id</dt><dd><code>${org.orgId}</code></dd></div>
          <div><dt>API version</dt><dd>${org.apiVersion ? `v${org.apiVersion}` : '—'}</dd></div>
          <div><dt>Generated</dt><dd>${formatDate(plan.generatedAt)}</dd></div>
          <div><dt>Scanned as</dt><dd>${org.userName || '—'}</dd></div>
          ${this.view.preparedBy ? html`<div><dt>Prepared by</dt><dd>${this.view.preparedBy}</dd></div>` : nothing}
        </dl>
      </header>
    `;
  }

  private renderSummary(plan: Plan): TemplateResult {
    const graded = plan.areas.filter((a) => a.score !== null);
    const composite = graded.length
      ? Math.round(graded.reduce((n, a) => n + (a.score ?? 0), 0) / graded.length)
      : null;
    const t = plan.totals;
    const grade = composite === null ? null : gradeFor(composite);
    const baseline = this.compositeDelta();

    return html`
      <section class="rp-section">
        <h2 class="rp-sr-only">Executive summary</h2>
        <div class="rp-tiles">
          <div class="rp-tile">
            <div class="rp-tile__head">
              <span class="rp-tile__label">Overall org health</span>
              ${grade ? html`<span class="rp-grade rp-grade--${grade}">Grade ${grade}</span>` : nothing}
            </div>
            <div class="rp-tile__figure">
              <span class="rp-tile__value">${composite === null ? '—' : composite}</span>
              <span class="rp-tile__unit">/ 100</span>
              ${composite === null ? nothing : dial(composite, grade!)}
            </div>
            <div class="rp-tile__foot">
              <span>Mean of ${graded.length} graded ${graded.length === 1 ? 'area' : 'areas'}</span>
              ${baseline === null
                ? nothing
                : html`<span class="rp-delta rp-delta--${baseline >= 0 ? 'up' : 'down'}"
                    >${baseline >= 0 ? '▲ +' : '▼ '}${baseline} pts vs previous</span
                  >`}
            </div>
          </div>

          <div class="rp-tile">
            <div class="rp-tile__head">
              <span class="rp-tile__label">Backlog items</span>
              ${t.byPriority.P1 > 0
                ? html`<span class="rp-badge rp-badge--critical">${t.byPriority.P1} high</span>`
                : nothing}
            </div>
            <div class="rp-tile__figure">
              <span class="rp-tile__value">${t.stories}</span>
              <span class="rp-tile__unit">${t.points} pts</span>
            </div>
            ${priorityBar(t.byPriority)}
            <div class="rp-tile__foot rp-tile__foot--legend">
              <span class="rp-keylegend rp-keylegend--p1">${t.byPriority.P1} High</span>
              <span class="rp-keylegend rp-keylegend--p2">${t.byPriority.P2} Medium</span>
              <span class="rp-keylegend rp-keylegend--p3">${t.byPriority.P3} Low</span>
            </div>
          </div>

          <div class="rp-tile">
            <div class="rp-tile__head">
              <span class="rp-tile__label">Components affected</span>
            </div>
            <div class="rp-tile__figure">
              <span class="rp-tile__value">${t.components.toLocaleString()}</span>
              <span class="rp-tile__unit">metadata assets</span>
            </div>
            <div class="rp-tile__foot rp-tile__foot--legend">
              <span class="rp-keylegend rp-keylegend--bug">${t.byKind.bug} Bug</span>
              <span class="rp-keylegend rp-keylegend--debt">${t.byKind.debt} Tech debt</span>
              <span class="rp-keylegend rp-keylegend--hygiene">${t.byKind.hygiene} Maintenance</span>
            </div>
          </div>

          <div class="rp-tile">
            <div class="rp-tile__head">
              <span class="rp-tile__label">Effort estimate</span>
            </div>
            <div class="rp-tile__figure">
              <span class="rp-tile__value">${t.personDays}</span>
              <span class="rp-tile__unit">person-days</span>
            </div>
            <div class="rp-tile__foot">
              <span>${t.hours.toLocaleString()} gross hours</span>
              <span>~${t.sprints} ${t.sprints === 1 ? 'sprint' : 'sprints'}</span>
            </div>
          </div>
        </div>
      </section>

      <section class="rp-section">
        <div class="rp-section__head">
          <h2>Audit area breakdown</h2>
          <span class="rp-muted">${plan.areas.length} of ${AREA_ORDER.length} areas analysed</span>
        </div>
        <table class="rp-table rp-table--areas">
          <thead>
            <tr>
              <th>Audit domain</th>
              <th>Health score</th>
              <th class="rp-num">High</th>
              <th class="rp-num">Medium</th>
              <th class="rp-num">Low</th>
              <th class="rp-num">Examined</th>
              <th class="rp-num">Checks</th>
              <th class="rp-num">Items</th>
              <th class="rp-num">Estimate</th>
              <th class="rp-noprint">Scope</th>
            </tr>
          </thead>
          <tbody>
            ${plan.areas.map((a) => {
              const stories = this.plan?.stories.filter((st) => st.analyzer === a.analyzer).length ?? 0;
              return html`<tr>
                <td>
                  <span class="rp-dot rp-dot--${a.grade ? gradeTone(a.grade) : 'neutral'}"></span>
                  ${a.area}
                </td>
                <td>
                  ${a.score === null
                    ? html`<span class="rp-muted">not graded</span>`
                    : html`<span class="rp-scorecell">
                        <span class="rp-grade rp-grade--${a.grade}">${a.score} / 100 (${a.grade})</span>
                        <span class="rp-scorebar"
                          ><span
                            class="rp-scorebar__fill rp-scorebar__fill--${gradeTone(a.grade!)}"
                            style=${`width:${a.score}%`}
                          ></span
                        ></span>
                      </span>`}
                </td>
                <td class="rp-num">
                  ${a.counts.critical > 0
                    ? html`<span class="rp-count rp-count--critical">${a.counts.critical}</span>`
                    : html`<span class="rp-muted">0</span>`}
                </td>
                <td class="rp-num">
                  ${a.counts.warning > 0
                    ? html`<span class="rp-count rp-count--warning">${a.counts.warning}</span>`
                    : html`<span class="rp-muted">0</span>`}
                </td>
                <td class="rp-num">${a.counts.info || html`<span class="rp-muted">0</span>`}</td>
                <td class="rp-num">${a.examined.toLocaleString()}</td>
                <td class="rp-num">${Math.round(a.ruleCoverage * 100)}% evaluated</td>
                <td class="rp-num">${stories}</td>
                <td class="rp-num">${stories === 0 ? html`<span class="rp-muted">—</span>` : formatDays(a.hours) + ' d'}</td>
                <td class="rp-noprint">
                  ${stories === 0
                    ? a.score === null
                      ? // No stories because nothing was graded is not a pass.
                        // Two ways to get here: nothing in scope to examine, or
                        // too little of the area could be checked for a grade.
                        html`<span class="rp-muted"
                          >${a.examined === 0 ? 'Nothing in scope' : 'Not graded'}</span
                        >`
                      : html`<span class="rp-pass">✓ Pass</span>`
                    : html`<button
                        class="rp-linkbutton"
                        type="button"
                        @click=${() =>
                          this.setView({ area: this.view.area === a.analyzer ? null : a.analyzer })}
                      >
                        ${this.view.area === a.analyzer ? 'Clear filter' : `Filter ${stories} items`}
                      </button>`}
                </td>
              </tr>`;
            })}
            ${plan.unscanned.map(
              (id) => html`<tr class="rp-muted">
                <td><span class="rp-dot rp-dot--neutral"></span>${AREA_LABEL[id]}</td>
                <td>not scanned</td>
                <td colspan="8">Run this area in the sidebar and regenerate the plan to include it.</td>
              </tr>`,
            )}
          </tbody>
        </table>
        <p class="rp-note">
          "Checks" is the share of each area's rules that reached a verdict. A score is held back in
          proportion to what could not be checked, and everything that could not be checked is listed
          under <a href="#rp-review">Not evaluated</a> — never counted as a pass.
        </p>
      </section>
    `;
  }

  /** Mean score movement across the areas that have a previous snapshot. */
  private compositeDelta(): number | null {
    const moved = this.diffs.filter((d) => d.scoreDelta !== null);
    if (moved.length === 0) return null;
    return Math.round(moved.reduce((n, d) => n + (d.scoreDelta ?? 0), 0) / moved.length);
  }

  /**
   * "Progress since the previous scan" — the section that turns a one-off audit
   * into a status report, and the one a client asks for at the second meeting.
   *
   * Omitted entirely when there is no previous snapshot to compare against.
   * A section headed "Progress" that says "no data" is worse than no section:
   * it reads as "no progress".
   */
  private renderProgress(): TemplateResult | typeof nothing {
    const moved = this.diffs.filter((d) => !d.unchanged);
    if (moved.length === 0) return nothing;

    return html`
      <section class="rp-section">
        <h2>Progress since the previous scan</h2>
        <p class="rp-muted">
          Each area is compared with the snapshot it replaced. Areas scanned only once are not
          listed.
          ${(() => {
            const platform = moved.find((d) => d.platformMoved)?.platformMoved;
            return platform
              ? ` Salesforce moved this org from API v${platform.from} to v${platform.to} between the scans, so findings about old API versions grow for that reason alone.`
              : '';
          })()}
        </p>
        <table class="rp-table">
          <thead>
            <tr>
              <th scope="col">Area</th>
              <th scope="col">Previous scan</th>
              <th scope="col" class="rp-num">Score</th>
              <th scope="col" class="rp-num">Fixed</th>
              <th scope="col" class="rp-num">New</th>
            </tr>
          </thead>
          <tbody>
            ${moved.map((diff) => {
              const fixed =
                diff.resolved.reduce((n: number, r: RuleChange) => n + Math.abs(r.delta), 0) +
                diff.changed
                  .filter((c: RuleChange) => c.delta < 0)
                  .reduce((n: number, c: RuleChange) => n + Math.abs(c.delta), 0);
              const added =
                diff.appeared.reduce((n: number, r: RuleChange) => n + r.count, 0) +
                diff.changed
                  .filter((c: RuleChange) => c.delta > 0)
                  .reduce((n: number, c: RuleChange) => n + c.delta, 0);
              return html`<tr>
                <td>${AREA_LABEL[diff.analyzer]}</td>
                <td>${formatDate(diff.since)}</td>
                <td class="rp-num">
                  ${diff.scoreDelta === null
                    ? '—'
                    : diff.scoreDelta === 0
                      ? 'no change'
                      : `${diff.scoreDelta > 0 ? '+' : ''}${diff.scoreDelta}`}
                </td>
                <td class="rp-num">${fixed || '—'}</td>
                <td class="rp-num">${added || '—'}</td>
              </tr>`;
            })}
          </tbody>
        </table>
        ${moved
          .filter((d) => d.resolved.length > 0)
          .map(
            (diff) => html`<p class="rp-muted">
              <strong>${AREA_LABEL[diff.analyzer]}:</strong> resolved since the previous scan —
              ${diff.resolved.map((r: RuleChange) => r.title).join('; ')}.
            </p>`,
          )}
      </section>
    `;
  }

  private renderLegend(): TemplateResult {
    return html`
      <section class="rp-section rp-legend">
        <h2>How to read the backlog items</h2>
        <div class="rp-legend__grid">
          <div>
            <h3>Priority</h3>
            <p><b>High</b> — fix now: users, deployments or data visibility are affected today.</p>
            <p><b>Medium</b> — next sprint: nothing is broken yet, but risk or cost grows while it waits.</p>
            <p><b>Low</b> — backlog: clutter and recommendations; schedule when convenient.</p>
          </div>
          <div>
            <h3>Type</h3>
            <p><b>Bug</b> — something is wrong now; exported to Jira as a Bug.</p>
            <p><b>Tech debt</b> — a shortcut to pay down; exported as a Task with the tech-debt label.</p>
            <p><b>Maintenance</b> — tidy-up, often a morning with a spreadsheet; exported as a Task with the maintenance label.</p>
            <p class="rp-muted">
              Nothing is exported as a Story: every item here fixes something that exists rather than adding a
              capability. The issue type cannot yet be changed per item before export.
            </p>
          </div>
          <div>
            <h3>Estimate</h3>
            ${(['XS', 'S', 'M', 'L', 'XL'] as const).map((s) => html`<p><b>${s}</b> — ${EFFORT_LABEL[s].split(' · ')[1]}.</p>`)}
            <p class="rp-muted">
              Planning figures for an experienced admin or developer, including sandbox testing and a normal
              release. Per-component cost tapers after fifty, as the fix becomes routine.
            </p>
          </div>
        </div>
        <p class="rp-legend__note">OrgTriage is a diagnostic tool, not an adviser. Every item below is a recommendation: have an experienced Salesforce administrator or developer verify it, test the change outside production, and deploy it through your normal release process. Provided as is, without warranty.</p>
      </section>
    `;
  }

  private renderBacklog(plan: Plan): TemplateResult {
    return html`
      <section class="rp-section">
        <h2>Backlog</h2>
        <table class="rp-table rp-table--backlog">
          <thead>
            <tr>
              <th>Key</th>
              <th>Item</th>
              <th>Epic</th>
              <th>Priority</th>
              <th>Type</th>
              <th>Role</th>
              <th class="rp-num">Components</th>
              <th class="rp-num">Points</th>
              <th class="rp-num">Estimate</th>
            </tr>
          </thead>
          <tbody>
            ${plan.stories.map(
              (s) => html`<tr>
                <td><a class="rp-key" href="#${s.key}">${s.key}</a></td>
                <td>${s.title}</td>
                <td>${EPIC_NAME[s.analyzer]}</td>
                <td><span class="rp-badge rp-badge--${s.severity}">${PRIORITY_NAME[s.priority]}</span></td>
                <td>${s.kindLabel}</td>
                <td>${s.role}</td>
                <td class="rp-num">${s.items.length.toLocaleString()}</td>
                <td class="rp-num">${s.points}</td>
                <td class="rp-num">${formatHours(s.effortHours)}</td>
              </tr>`,
            )}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="6">${plan.stories.length} backlog items across ${plan.epics.length} epics</td>
              <td class="rp-num">${plan.stories.reduce((n, s) => n + s.items.length, 0).toLocaleString()}</td>
              <td class="rp-num">${plan.totals.points}</td>
              <td class="rp-num">${formatHours(plan.totals.hours)}</td>
            </tr>
          </tfoot>
        </table>
      </section>
    `;
  }

  /**
   * Priority pills and a text filter.
   *
   * The counts on the pills come from the *unfiltered* plan on purpose: a pill
   * reading "P1 (0)" because the P2 filter is active would be a lie about the
   * org. They say how many exist, and the active one says which are shown.
   */
  private renderFilters(): TemplateResult {
    const all = this.plan?.stories ?? [];
    const count = (p: Priority) => all.filter((st) => st.priority === p).length;
    const pill = (value: Priority | null, label: string, n: number) => html`
      <button
        class="rp-pill ${this.view.priority === value ? 'rp-pill--on' : ''}"
        type="button"
        aria-pressed=${this.view.priority === value}
        @click=${() => this.setView({ priority: value })}
      >
        ${label} <span class="rp-pill__count">${n}</span>
      </button>
    `;

    return html`
      <div class="rp-filters rp-noprint">
        <input
          class="rp-input rp-input--search"
          type="search"
          placeholder="Filter by keyword, component name, or rule id…"
          .value=${this.view.query}
          @input=${(e: Event) => this.setView({ query: (e.target as HTMLInputElement).value })}
        />
        <span class="rp-filters__spacer"></span>
        <span class="rp-filters__label">Priority</span>
        ${pill(null, 'All', all.length)} ${pill('P1', 'High', count('P1'))}
        ${pill('P2', 'Medium', count('P2'))} ${pill('P3', 'Low', count('P3'))}
        ${this.view.area
          ? html`<button class="rp-pill rp-pill--on" type="button" @click=${() => this.setView({ area: null })}>
              ${AREA_LABEL[this.view.area]} ✕
            </button>`
          : nothing}
      </div>
    `;
  }

  private clearFilters(): void {
    this.setView({ includeInfo: true, priority: null, query: '', area: null });
  }

  private renderEpic(epic: Plan['epics'][number], plan: Plan): TemplateResult {
    const stories = plan.stories.filter((st) => st.epicKey === epic.key);
    if (stories.length === 0) return html``;
    return html`
      <section class="rp-epic">
        <header class="rp-epic__head">
          <span class="rp-epic__name">${epic.name}</span>
          <span class="rp-muted">
            ${stories.length} ${stories.length === 1 ? 'item' : 'items'} ·
            ${stories.reduce((n, st) => n + st.points, 0)} points ·
            ${formatDays(stories.reduce((n, st) => n + st.effortHours, 0))} days
          </span>
        </header>
        ${stories.map((st) => this.renderStory(st))}
      </section>
    `;
  }

  private renderStory(story: Story): TemplateResult {
    return html`
      <article class="rp-story" id=${story.key}>
        <header class="rp-story__head">
          <span class="rp-key">${story.key}</span>
          <span class="rp-badge rp-badge--${story.severity}">${PRIORITY_LABEL[story.priority]}</span>
          <span class="rp-badge rp-badge--epic">${EPIC_NAME[story.analyzer]}</span>
          <span class="rp-story__points">
            ${story.points} ${story.points === 1 ? 'point' : 'points'}
            (${formatDays(story.effortHours)} ${Number(formatDays(story.effortHours)) === 1 ? 'day' : 'days'})
          </span>
        </header>
        <h3 class="rp-story__title">${story.title}</h3>
        <p class="rp-story__why">${story.rationale}</p>
        <div class="rp-story__meta">
          <span class="rp-badge rp-badge--neutral">${story.kindLabel}</span>
          <span class="rp-badge rp-badge--neutral">${story.area}</span>
          <span class="rp-badge rp-badge--neutral">${story.role}</span>
          <span class="rp-badge rp-badge--neutral">${EFFORT_LABEL[story.effortSize]} · ${formatHours(story.effortHours)}</span>
        </div>

        <h4>Steps</h4>
        ${story.unscripted
          ? html`<p class="rp-note">No step-by-step guide exists for this rule yet; the remediation summary is shown instead.</p>`
          : nothing}
        <ol class="rp-steps">
          ${story.steps.map((s) => html`<li>${s}</li>`)}
        </ol>

        ${this.view.showAcceptance
          ? html`<div class="rp-accept">
              <h4 class="rp-accept__head">Acceptance criteria (definition of done)</h4>
              <ul class="rp-acceptance">
                ${story.acceptance.map((a) => html`<li>${a}</li>`)}
              </ul>
            </div>`
          : nothing}

        <h4>Affected components <span class="rp-muted">(${story.items.length.toLocaleString()})</span></h4>
        ${this.renderItems(story.items, story.analyzer, story.ruleId)}

        <footer class="rp-story__foot">
          <span>Rule <code>${story.ruleId}</code></span>
          ${story.docUrl
            ? html`<a href=${story.docUrl} target="_blank" rel="noreferrer noopener">${docLabel(story.docUrl)}</a>`
            : nothing}
        </footer>
      </article>
    `;
  }

  /**
   * "Open" opens the component's Setup page in a new Salesforce tab. The
   * sidebar in that tab lands on this story's finding rather than on the
   * Overview, so the steps are beside the thing they describe: the finding is
   * handed to the worker before the tab opens, and the new panel takes it as
   * it connects.
   */
  private async rememberFocus(analyzer: AnalyzerId, findingId: string): Promise<void> {
    if (!this.org) return;
    await send({ type: 'focus.set', orgId: this.org.orgId, analyzer, findingId });
  }

  /**
   * Open a component's Setup page in the Salesforce tab the user already has
   * for this org, with the side panel landing on the finding. A tab is
   * created only when no tab of this org is open: a new tab means a fresh
   * panel, which re-reads the snapshots and spends a connection, and the
   * owner would rather stay in one tab. `sidePanel.open` needs a user
   * gesture, which the click is; the anchor's own navigation is suppressed
   * so the tab is chosen here and its id is known.
   */
  private openBeside(event: Event, url: string, analyzer: AnalyzerId, findingId: string): void {
    event.preventDefault();
    void (async () => {
      // Stored before the tab moves, so the panel cannot ask before it exists.
      await this.rememberFocus(analyzer, findingId);
      let tab = await this.existingOrgTab();
      if (tab?.id !== undefined) {
        tab = await chrome.tabs.update(tab.id, { url, active: true });
        if (tab?.windowId !== undefined) {
          try {
            await chrome.windows.update(tab.windowId, { focused: true });
          } catch {
            /* a window that cannot be focused is still the right tab */
          }
        }
      } else {
        tab = await chrome.tabs.create({ url, active: true });
      }
      if (tab?.id === undefined) return;
      try {
        // The worker enables the panel for Salesforce tabs as they appear, but
        // this must not race it: say so here, then open.
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: 'panel.html', enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
      } catch {
        /* already open, or the browser declined: the tab is there either way */
      }
      // A panel already open on that tab may see no URL change (same page), so
      // tell every panel a focus is waiting; only the one on this org takes it.
      try {
        await send({ type: 'focus.nudge' });
      } catch {
        /* the panel will still take it on its next navigation or connect */
      }
    })();
  }

  /**
   * The most recently used open tab on this org, or null. Lightning, Setup
   * and the API host are three hostnames for one org, all sharing the org's
   * My Domain label, so all three are matched.
   */
  private async existingOrgTab(): Promise<chrome.tabs.Tab | null> {
    const host = this.org?.lightningHost;
    if (!host) return null;
    // Production: label.lightning.force.com; sandbox: label.sandbox.lightning.force.com.
    // The Setup and API hosts carry the same label and the same sandbox marker.
    // Other families (Gov, China, proxies) fall back to the literal host.
    const m = /^(.+?)(\.sandbox)?\.lightning\.force\.com$/.exec(host);
    const patterns = m
      ? [
          `https://${m[1]}${m[2] ?? ''}.lightning.force.com/*`,
          `https://${m[1]}${m[2] ?? ''}.my.salesforce-setup.com/*`,
          `https://${m[1]}${m[2] ?? ''}.my.salesforce.com/*`,
        ]
      : [`https://${host}/*`];
    try {
      const tabs = await chrome.tabs.query({ url: patterns });
      const current = await chrome.windows.getCurrent();
      const ranked = tabs
        .filter((t) => t.id !== undefined)
        .sort(
          (a, b) =>
            Number(b.windowId === current.id) - Number(a.windowId === current.id) ||
            (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0),
        );
      return ranked[0] ?? null;
    } catch {
      return null;
    }
  }

  private renderItems(items: FindingItem[], analyzer: AnalyzerId, findingId: string): TemplateResult {
    const shown = this.view.compact ? items.slice(0, COMPACT_ITEMS) : items;
    const columns: string[] = [];
    for (const item of shown) {
      for (const key of Object.keys(item.evidence ?? {})) if (!columns.includes(key)) columns.push(key);
    }
    return html`
      <table class="rp-table rp-table--items" data-analyzer=${analyzer}>
        <thead>
          <tr>
            <th>Component</th>
            ${columns.map((c) => html`<th>${c}</th>`)}
            <th class="rp-noprint"></th>
          </tr>
        </thead>
        <tbody>
          ${shown.map(
            (item) => html`<tr>
              <td>
                <code class="rp-api">${item.name}</code>
                ${item.label && item.label !== item.name ? html`<span class="rp-muted"> · ${item.label}</span>` : nothing}
              </td>
              ${columns.map((c) => {
                const v = item.evidence?.[c];
                return html`<td class=${typeof v === 'number' ? 'rp-num' : ''}>
                  ${v === null || v === undefined || v === '' ? html`<span class="rp-muted">—</span>` : typeof v === 'number' ? v.toLocaleString() : String(v)}
                </td>`;
              })}
              <td class="rp-noprint">
                ${item.setupUrl
                  ? html`<a
                      href=${item.setupUrl}
                      target="_blank"
                      rel="noreferrer noopener"
                      title="Opens in your Salesforce tab for this org, with the panel on this finding; a new tab only if none is open"
                      @click=${(e: Event) => this.openBeside(e, item.setupUrl!, analyzer, findingId)}
                      >${icons.pane} Open</a
                    >`
                  : nothing}
              </td>
            </tr>`,
          )}
        </tbody>
      </table>
      ${shown.length < items.length
        ? html`<p class="rp-note">Showing ${shown.length} of ${items.length.toLocaleString()}; turn off "Compact component lists" or use the CSV export for the full list.</p>`
        : nothing}
    `;
  }

  private renderReview(plan: Plan): TemplateResult {
    if (plan.review.length === 0) return html``;
    const groups = new Map<ReviewItem['kind'], ReviewItem[]>();
    for (const r of plan.review) groups.set(r.kind, [...(groups.get(r.kind) ?? []), r]);
    const heading: Record<ReviewItem['kind'], string> = {
      inconclusive: 'Checks that could not run',
      manual: 'Work that needs a person',
      warning: 'Analyzer notes',
      partial: 'Partial scans',
    };
    return html`
      <section class="rp-section" id="rp-review">
        <h2>Not evaluated</h2>
        <p class="rp-note">
          Nothing here is counted in the backlog items above. A check that could not run is not a clean check, and
          the score for its area is held back accordingly; these are the first things to clear on a follow-up
          pass, usually by scanning as a user with wider access.
        </p>
        ${(['inconclusive', 'partial', 'manual', 'warning'] as const).map((kind) => {
          const rows = groups.get(kind);
          if (!rows) return nothing;
          return html`
            <h3>${heading[kind]}</h3>
            <ul class="rp-review">
              ${rows.map(
                (r) => html`<li>
                  <b>${r.area} · ${r.title}</b> — ${r.detail}
                  ${r.items.length > 0
                    ? html`<ul>
                        ${r.items.slice(0, this.view.compact ? COMPACT_ITEMS : r.items.length).map(
                          (i) => html`<li><code class="rp-api">${i.name}</code>${i.label && i.label !== i.name ? html` · ${i.label}` : nothing}</li>`,
                        )}
                        ${this.view.compact && r.items.length > COMPACT_ITEMS ? html`<li class="rp-muted">… and ${r.items.length - COMPACT_ITEMS} more</li>` : nothing}
                      </ul>`
                    : nothing}
                </li>`,
              )}
            </ul>
          `;
        })}
      </section>
    `;
  }

  private renderMethod(plan: Plan): TemplateResult {
    return html`
      <section class="rp-section rp-method">
        <h2>Method</h2>
        <p>
          OrgTriage reads metadata through the Salesforce REST, Tooling and Analytics APIs using the scanning
          user's own session and permissions. It reads no business records: the snapshots behind this plan
          contain component names, dates, counts, rule verdicts, and the people-related fields the privacy policy
          lists (the names of job owners, permission holders, debug-log owners and dashboard running users, and
          the error text of failed jobs). Nothing was sent anywhere other than the org
          itself.
        </p>
        <p>
          Each area's score deducts for every rule that fired, weighted by severity and by how widespread the
          problem is, and is capped by the share of rules that could actually be evaluated. Report and
          dashboard "abandonment" is based on the org-wide last-run date, because Salesforce exposes report
          views per user only.
        </p>
        <table class="rp-table rp-table--method">
          <thead>
            <tr><th>Area</th><th>Snapshot</th><th class="rp-num">API calls</th><th>API</th></tr>
          </thead>
          <tbody>
            ${plan.areas.map(
              (a) => html`<tr>
                <td>${a.area}</td>
                <td>${formatDate(a.completedAt)}</td>
                <td class="rp-num">${a.apiCalls.toLocaleString()}</td>
                <td>v${this.results.find((r) => r.analyzer === a.analyzer)?.apiVersion ?? plan.org.apiVersion}</td>
              </tr>`,
            )}
          </tbody>
        </table>
        <p class="rp-muted">
          Generated by OrgTriage. Estimates are planning figures, not a quotation.
        </p>
      </section>
    `;
  }

  /* ---------------------------------------------------------------------- */

  private setView(patch: Partial<View>): void {
    this.view = { ...this.view, ...patch };
  }

  private setPreparedBy(value: string): void {
    this.setView({ preparedBy: value.trim() });
    try {
      void chrome.storage.local.set({ [PREPARED_BY_KEY]: value.trim() });
    } catch {
      /* preference only */
    }
  }

  private async copyMarkdown(plan: Plan): Promise<void> {
    try {
      await navigator.clipboard.writeText(planToMarkdown(plan));
      this.copied = true;
      setTimeout(() => {
        this.copied = false;
      }, 1600);
    } catch {
      download(`${fileStem(plan)}.md`, 'text/markdown;charset=utf-8', planToMarkdown(plan));
    }
  }
}

customElements.define('orgtriage-report', OrgTriageReport);

async function main(): Promise<void> {
  // The dev preview serves this page with fixture data and a chrome.* stub.
  if (import.meta.env.DEV && new URLSearchParams(location.search).has('preview')) {
    await import('../dev/preview');
  }
  document.getElementById('root')?.appendChild(document.createElement('orgtriage-report'));
}

void main();
