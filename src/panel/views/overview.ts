/**
 * Overview — the composite org health picture, the per-area cards, the
 * cross-area "fix first" queue, and the cache/refresh controls.
 *
 * The layout is a hero + card grid rather than a table. A table was the honest
 * first cut — this tool is about scanning many rows — but the overview is the
 * one screen that is read at a glance rather than scanned, and six numbers in a
 * row of `<td>`s gave every area the same visual weight whether it was an A or
 * an F. The cards carry a dial, a severity bar and the snapshot age, so the
 * area in trouble is the one that looks like trouble.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { store, ANALYZERS } from '../state';
import {
  badge,
  deltaChip,
  formatBytes,
  formatNumber,
  formatRelative,
  gradeTone,
  icons,
  metric,
  SEVERITY_LABEL,
} from '../ui';
import { proportionBar, rankedBars, scoreDial, type Segment } from '../charts';
import { renderDiagnostics } from './diagnostics';
import { openPlan } from '../planLink';
import type { AnalyzerId, Finding, ScanResult, Severity } from '@/shared/types';

/**
 * Composite score: the mean of whatever domains have been scanned *and could be
 * graded*. An ungraded domain contributes nothing rather than a default, so a
 * composite is never propped up by an area that was never examined.
 */
function composite(results: ScanResult[]): { score: number; grade: string; of: number } | null {
  const graded = results.filter((r) => r.score.score !== null);
  if (graded.length === 0) return null;
  const score = Math.round(
    graded.reduce((sum, r) => sum + (r.score.score ?? 0), 0) / graded.length,
  );
  return { score, grade: gradeFor(score), of: graded.length };
}

export function gradeFor(score: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2, success: 3 };

/**
 * Areas are no longer colour-coded, and that is deliberate.
 *
 * With seven areas each could carry a slot from the validated categorical
 * palette. At ten it cannot: the palette validates eight, and the data-viz
 * method is explicit that past the validated count you stop assigning distinct
 * hues rather than inventing more — ten hues cannot be told apart under
 * simulated protan vision whatever order they are put in.
 *
 * So colour here means severity and nothing else, which is also the more useful
 * meaning: a reader scanning the grid wants to know what is on fire, not which
 * analyzer produced it. Area identity is carried by its name.
 */
const AREA_ACCENT = 'var(--os-chart-1)';

/**
 * The same ordering the remediation plan uses to number its stories: severity,
 * then the rule's own weight, then how many components it touches. Keeping the
 * two in step matters — a consultant reading "fix first" here and then opening
 * the plan should find the same work at the top of both.
 */
function rankFindings(results: ScanResult[]): { finding: Finding; area: AnalyzerId }[] {
  const ranked = results.flatMap((r) =>
    r.findings
      .filter((f) => !f.inconclusive && f.severity !== 'success' && f.items.length > 0)
      .map((f) => ({ finding: f, area: r.analyzer })),
  );
  ranked.sort(
    (a, b) =>
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
      b.finding.weight - a.finding.weight ||
      b.finding.items.length - a.finding.items.length ||
      a.finding.title.localeCompare(b.finding.title),
  );
  return ranked;
}

export function renderOverview(): TemplateResult {
  const { slots, org, cacheEntries, cacheBytes, budget, clearing } = store.state;
  const results = ANALYZERS.map((a) => slots[a.id].result).filter(
    (r): r is ScanResult => r !== null,
  );
  const overall = composite(results);
  const scanning = ANALYZERS.some((a) => slots[a.id].loading);
  const totals = results.reduce(
    (acc, r) => {
      acc.critical += r.score.counts.critical;
      acc.warning += r.score.counts.warning;
      acc.info += r.score.counts.info;
      acc.clean += r.score.counts.success;
      acc.examined += r.score.examined;
      acc.apiCalls += r.apiCalls;
      return acc;
    },
    { critical: 0, warning: 0, info: 0, clean: 0, examined: 0, apiCalls: 0 },
  );

  const severityMix: Segment[] = [
    { label: SEVERITY_LABEL.critical, value: totals.critical, color: 'var(--os-sev-critical)' },
    { label: SEVERITY_LABEL.warning, value: totals.warning, color: 'var(--os-sev-warning)' },
    { label: SEVERITY_LABEL.info, value: totals.info, color: 'var(--os-sev-info)' },
    { label: 'Checks passed', value: totals.clean, color: 'var(--os-sev-success)' },
  ];

  const queue = rankFindings(results).slice(0, 6);

  // What "Scan all areas" will actually do, and what it will cost, stated
  // before the button is pressed rather than reported after.
  const skipSet = new Set(store.state.prefs.skipInScanAll ?? []);
  const included = ANALYZERS.filter((a) => !skipSet.has(a.id));
  const skipped = ANALYZERS.filter((a) => skipSet.has(a.id));
  // An area that has been scanned knows what it actually cost, so the estimate
  // uses that and falls back to the derived range only for areas never run
  // here. Once every included area has a measurement the range collapses to a
  // single number, which is the point: the guess is a placeholder for a fact.
  const estimate = included.reduce<[number, number]>((sum, a) => {
    const measured = slots[a.id].result?.apiCalls;
    const [lo, hi] = measured !== undefined ? [measured, measured] : a.typicalCalls;
    return [sum[0] + lo, sum[1] + hi];
  }, [0, 0]);
  const estimateLabel = estimate[0] === estimate[1] ? `~${estimate[0]}` : `~${estimate[0]}–${estimate[1]}`;

  return html`
    <div class="os-hero">
      <div class="os-hero__dial">
        ${scoreDial(overall ? overall.score : null, overall ? gradeTone(overall.grade) : 'info', {
          label: 'Org health',
        })}
      </div>
      <div class="os-hero__body">
        <div class="os-hero__headline">
          <h2 class="os-hero__title">Org health</h2>
          <!-- No grade badge mid-scan. "Scan all areas" runs the analyzers one
               after another, so the mean is over however many have finished:
               it lurched F → D → C → B as each landed, and a letter grade on a
               partial mean reads as a verdict rather than a running total. -->
          ${overall && !scanning ? badge(gradeTone(overall.grade), `Grade ${overall.grade}`) : nothing}
        </div>
        <p class="os-hero__sub">
          ${scanning
            ? `Scanning… ${results.length} of ${ANALYZERS.length} areas so far (provisional)`
            : results.length === 0
              ? 'No areas scanned yet — nothing here refreshes on its own.'
              : `Mean of ${results.length} of ${ANALYZERS.length} areas, from cached snapshots.`}
        </p>
        ${results.length === 0
          ? nothing
          : proportionBar(severityMix, { label: 'Findings by severity', height: 10 })}
      </div>
    </div>

    <div class="os-kpis">
      ${kpi('Critical', formatNumber(totals.critical), 'critical', 'Findings that block or break something today')}
      ${kpi('Warnings', formatNumber(totals.warning), 'warning', 'Findings that will cost you later')}
      ${kpi('Components examined', formatNumber(totals.examined), 'info', 'Classes, flows, reports, pages and jobs actually read')}
      ${kpi('API calls spent', formatNumber(totals.apiCalls), 'success', 'From this org’s daily allowance, across all cached scans')}
    </div>

    <div class="os-toolbar">
      <button
        class="os-button os-button--brand"
        type="button"
        ?disabled=${scanning || included.length === 0 || !org}
        @click=${() => void store.scanAll()}
        title=${`Runs ${included.length} of ${ANALYZERS.length} areas in sequence and spends roughly ${estimateLabel} API calls. Areas you have unticked below are left alone.`}
      >
        ${icons.refresh}
        ${scanning
          ? 'Scanning…'
          : skipped.length === 0
            ? 'Scan all areas'
            : `Scan ${included.length} areas`}
      </button>
      ${scanning
        ? html`<button
            class="os-button"
            type="button"
            @click=${() => void store.cancelScanAll()}
            title="Stops the area in progress and starts no further areas. Areas already finished keep their new snapshots."
          >
            Cancel
          </button>`
        : nothing}
      <button
        class="os-button"
        type="button"
        ?disabled=${results.length === 0 || !org}
        title="Opens a printable plan built from the cached snapshots: one backlog item per finding with steps, acceptance criteria and an estimate, plus CSV and Markdown exports. No API calls."
        @click=${() => org && openPlan(org)}
      >
        ${icons.document} Remediation plan
      </button>
      <button
        class="os-button"
        type="button"
        ?disabled=${clearing || cacheEntries.length === 0 || scanning}
        title="Deletes this org's cached snapshots from this browser profile. Nothing is removed from Salesforce."
        @click=${() => void store.clearCache()}
      >
        ${clearing ? 'Clearing…' : 'Clear local snapshots'}
      </button>
      <span class="os-metric__sub">
        ${estimateLabel} API calls${skipped.length > 0
          ? `, skipping ${skipped.map((a) => a.label).join(', ')}`
          : ''}. Nothing refreshes automatically.
      </span>
    </div>

    ${queue.length === 0
      ? nothing
      : html`<div class="os-card">
          <div class="os-card__header">
            <h2 class="os-card__title">Fix these first</h2>
            <span class="os-metric__sub">
              Ranked the same way the remediation plan numbers its stories
            </span>
          </div>
          <p class="os-metric__sub os-card__note">
            OrgTriage is a diagnostic tool, not an adviser, provided as is. Every item is a recommendation: have an experienced Salesforce administrator or developer verify it and test it outside production.
          </p>
          <ul class="os-card__body os-queue">
            ${queue.map(
              ({ finding, area }, i) => html`<li class="os-queue__item">
                <span class="os-queue__rank">${i + 1}</span>
                <button
                  class="os-queue__title"
                  type="button"
                  title="Open the ${areaLabel(area)} tab"
                  @click=${() => store.openArea(area)}
                >
                  ${finding.title}
                </button>
                <span class="os-queue__meta">
                  ${badge(finding.severity)}
                  <span class="os-badge os-badge--neutral">${areaLabel(area)}</span>
                  <span class="os-muted"
                    >${formatNumber(finding.items.length)}
                    ${finding.items.length === 1 ? 'component' : 'components'}</span
                  >
                </span>
              </li>`,
            )}
          </ul>
        </div>`}

    ${renderAreaGrid()}

    ${results.length < 2
      ? nothing
      : html`<div class="os-card">
          <div class="os-card__header">
            <h2 class="os-card__title">Where the work is</h2>
            <span class="os-metric__sub">Open findings by area</span>
          </div>
          <div class="os-card__body">
            ${rankedBars(
              results
                .map((r) => ({
                  label: areaLabel(r.analyzer),
                  value: r.score.counts.critical + r.score.counts.warning + r.score.counts.info,
                  color: AREA_ACCENT,
                  onClick: () => store.openArea(r.analyzer),
                }))
                .sort((a, b) => b.value - a.value),
              { label: 'Open findings by area' },
            )}
          </div>
        </div>`}

    <div class="os-card">
      <div class="os-card__header">
        <h2 class="os-card__title">On-demand tools</h2>
        <span class="os-metric__sub">Nothing here runs as part of a scan</span>
      </div>
      <ul class="os-card__body os-tools">
        <li class="os-tools__item">
          <div class="os-stack" style="gap:2px">
            <strong>API usage by user</strong>
            <span class="os-metric__sub">
              Calls per user per day. Salesforce publishes this as a Classic administrative report
              and as the ApiTotalUsage event log; OrgTriage links you to both and runs neither.
            </span>
          </div>
          <button class="os-button os-button--subtle" type="button" @click=${() => store.openArea('ops')}>
            Open in Ops ${icons.chevron}
          </button>
        </li>
      </ul>
    </div>

    <div class="os-card">
      <div class="os-card__header">
        <h2 class="os-card__title">Local cache</h2>
      </div>
      <div class="os-card__body os-stack">
        <p style="margin:0" class="os-metric__sub">
          Snapshots are stored in this browser profile only, in IndexedDB, scoped to
          ${org ? html`<code class="os-inline">${org.orgId}</code>` : 'the connected org'}. They
          contain metadata names, dates, and rule verdicts — no record data and no credentials.
        </p>
        <div class="os-metrics">
          ${metric('Snapshots', formatNumber(cacheEntries.length))}
          ${metric('Size', formatBytes(cacheBytes))}
          ${metric(
            'API budget',
            budget?.remaining !== null && budget?.remaining !== undefined
              ? formatNumber(budget.remaining)
              : '—',
            budget?.max ? `of ${formatNumber(budget.max)}, rolling 24 hours · Salesforce's tally, delayed` : 'not reported',
            budget?.max && budget.remaining !== null
              ? { fraction: 1 - budget.remaining / budget.max }
              : undefined,
          )}
        </div>
      </div>
    </div>

    ${renderDiagnostics({
      blurb: 'Whether each permission-dependent check can run in this org, and what the connection costs',
    })}
  `;
}

/** The grid of area cards, shared with the Areas tab. */
export function renderAreaGrid(): TemplateResult {
  return html`<div class="os-areagrid">${ANALYZERS.map((a) => renderAreaCard(a))}</div>`;
}

function areaLabel(id: AnalyzerId): string {
  return ANALYZERS.find((a) => a.id === id)?.label ?? id;
}

/** A stat tile: the number first, the label under it, a tone rail down the side. */
function kpi(label: string, value: string, tone: Severity, hint: string): TemplateResult {
  return html`
    <div class="os-kpi os-kpi--${tone}" title=${hint}>
      <span class="os-kpi__value">${value}</span>
      <span class="os-kpi__label">${label}</span>
    </div>
  `;
}

function renderAreaCard(area: (typeof ANALYZERS)[number]): TemplateResult {
  const { id, label, blurb } = area;
  const slot = store.state.slots[id];
  const skipped = (store.state.prefs.skipInScanAll ?? []).includes(id);
  // Once an area has been scanned its real cost is known, and a measured number
  // beats an estimate every time.
  const cost = slot.result
    ? `${formatNumber(slot.result.apiCalls)} API calls last time`
    : `~${area.typicalCalls[0]}–${area.typicalCalls[1]} API calls · ${area.costNote}`;
  const result = slot.result;
  const stale = slot.staleness.state === 'stale';
  const grade = result?.score.grade ?? null;
  const mix: Segment[] = result
    ? [
        {
          label: SEVERITY_LABEL.critical,
          value: result.score.counts.critical,
          color: 'var(--os-sev-critical)',
        },
        {
          label: SEVERITY_LABEL.warning,
          value: result.score.counts.warning,
          color: 'var(--os-sev-warning)',
        },
        {
          label: SEVERITY_LABEL.info,
          value: result.score.counts.info,
          color: 'var(--os-sev-info)',
        },
        {
          label: 'Passed',
          value: result.score.counts.success,
          color: 'var(--os-sev-success)',
        },
      ]
    : [];

  return html`
    <article class="os-areacard" style=${`--os-areacard-hue:${AREA_ACCENT}`}>
      <header class="os-areacard__head">
        <button class="os-areacard__name" type="button" title=${blurb} @click=${() => store.openArea(id)}>
          ${label}
        </button>
        ${slot.loading
          ? html`<span class="os-badge os-badge--neutral">Scanning…</span>`
          : grade
            ? badge(gradeTone(grade), grade)
            : nothing}
      </header>

      <div class="os-areacard__body">
        <div class="os-areacard__dial">
          ${scoreDial(result?.score.score ?? null, grade ? gradeTone(grade) : 'info', {
            size: 72,
            label,
          })}
        </div>
        <div class="os-areacard__facts">
          ${result === null
            ? html`<span class="os-muted">${slot.reading ? 'Reading snapshot…' : 'Not scanned yet'}</span>`
            : result.score.score === null
              ? html`<span
                  class="os-muted"
                  title=${result.score.ungradedReason ?? 'Not enough was examined to grade this area.'}
                  >${result.score.examined === 0 && (result.score.ruleCoverage ?? 0) > 0
                    ? 'Not graded — nothing in scope'
                    : 'Not graded — too little could be examined'}</span
                >`
              : html`
                  <span class="os-areacard__count">
                    ${formatNumber(
                      result.score.counts.critical +
                        result.score.counts.warning +
                        result.score.counts.info,
                    )}
                    open ${result.score.counts.critical + result.score.counts.warning + result.score.counts.info === 1 ? 'finding' : 'findings'}
                  </span>
                  ${proportionBar(mix, { legend: false, height: 6, label: `${label} severity mix` })}
                  <span class="os-areacard__key">
                    ${mix
                      .filter((m) => m.value > 0)
                      .map(
                        (m) => html`<span class="os-areacard__keyitem"
                          ><span class="os-areacard__swatch" style=${`background:${m.color}`}></span>${m.value}
                          ${m.label.toLowerCase()}</span
                        >`,
                      )}
                  </span>
                  <span class="os-metric__sub">
                    ${formatNumber(result.score.examined)} examined${result.score.ruleCoverage !==
                      undefined && result.score.ruleCoverage < 0.999
                      ? ` · ${Math.round(result.score.ruleCoverage * 100)}% of checks ran`
                      : ''}
                  </span>
                `}
        </div>
      </div>

      <footer class="os-areacard__foot">
        <span class=${stale ? '' : 'os-muted'}>
          ${result ? formatRelative(result.completedAt) : 'never scanned'}
          ${stale ? badge('warning', 'stale') : nothing}
          ${deltaChip(slot.diff)}
        </span>
        <button
          class="os-button os-button--subtle"
          type="button"
          ?disabled=${slot.loading}
          @click=${() => void store.scan(id)}
        >
          ${result ? 'Refresh' : 'Scan'}
        </button>
      </footer>

      <label class="os-areacard__cost" title=${cost}>
        <input
          type="checkbox"
          .checked=${!skipped}
          @change=${(e: Event) =>
            void store.setScanAllIncludes(id, (e.target as HTMLInputElement).checked)}
        />
        <span>${skipped ? 'Excluded from “Scan all”' : 'In “Scan all”'}</span>
        <span class="os-areacard__costnum">${cost}</span>
      </label>
    </article>
  `;
}
