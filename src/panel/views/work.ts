/**
 * Work — every open finding in the org, in the order it should be dealt with.
 *
 * This is the view the tool exists for. The area tabs answer "what did the
 * Reports analyzer find"; this answers "what should I do on Monday", which is
 * the question an admin or a consultant actually has. It is the same ordering
 * the remediation plan uses to number its stories, so the top of this list and
 * the top of the printed plan are the same work.
 *
 * Findings are collapsed by default and carry their fix steps inline, so the
 * whole path from "what is wrong" to "what do I type into Setup" happens here
 * without opening anything else.
 */

import { html, nothing, type TemplateResult } from 'lit';
import { store, ANALYZERS } from '../state';
import { badge, empty, formatNumber, icons, skeletonRows } from '../ui';
import { openPlan } from '../planLink';
import { proportionBar, type Segment } from '../charts';
import { PLAYBOOK } from '@/shared/playbook';
import { docLabel, estimateHours, formatHours, PRIORITY_FOR, PRIORITY_LABEL, PRIORITY_NAME, type Priority } from '@/shared/plan';
import type { AnalyzerId, Finding, ScanResult, Severity } from '@/shared/types';

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2, success: 3 };

export interface WorkItem {
  finding: Finding;
  area: AnalyzerId;
  areaLabel: string;
  priority: Priority;
  hours: number;
}

/**
 * Rank every open finding across every area.
 *
 * Severity, then the rule's own weight, then how many components it touches —
 * identical to `buildPlan`'s comparator, deliberately. If this list and the
 * printed plan disagreed about what matters most, one of them would be wrong
 * and the reader would have no way to know which.
 */
export function rankWork(results: ScanResult[]): WorkItem[] {
  const items: WorkItem[] = [];
  for (const result of results) {
    const areaLabel = ANALYZERS.find((a) => a.id === result.analyzer)?.label ?? result.analyzer;
    for (const finding of result.findings) {
      if (finding.inconclusive || finding.severity === 'success' || finding.items.length === 0) continue;
      items.push({
        finding,
        area: result.analyzer,
        areaLabel,
        priority: PRIORITY_FOR[finding.severity],
        hours: estimateHours(PLAYBOOK[finding.id], finding.items.length),
      });
    }
  }
  items.sort(
    (a, b) =>
      SEVERITY_RANK[a.finding.severity] - SEVERITY_RANK[b.finding.severity] ||
      b.finding.weight - a.finding.weight ||
      b.finding.items.length - a.finding.items.length ||
      a.finding.title.localeCompare(b.finding.title),
  );
  return items;
}

export function renderWork(): TemplateResult {
  const { slots, org, workFilter } = store.state;
  const results = ANALYZERS.map((a) => slots[a.id].result).filter((r): r is ScanResult => r !== null);
  const all = rankWork(results);

  // Snapshots are still being read after a page load or tab switch: a skeleton,
  // not "nothing scanned", which was a lie for the few seconds it showed.
  if (results.length === 0 && ANALYZERS.some((a) => slots[a.id].reading)) {
    return html`<div class="os-card">${skeletonRows(6)}</div>`;
  }

  if (results.length === 0) {
    return empty(
      'Nothing scanned yet',
      'Run a scan from the Overview and the work will be listed here, worst first.',
      html`<button class="os-button os-button--brand" type="button" @click=${() => store.setTab('overview')}>
        Go to Overview
      </button>`,
    );
  }

  const shown = all.filter((item) => {
    if (workFilter.priority && item.priority !== workFilter.priority) return false;
    if (workFilter.area && item.area !== workFilter.area) return false;
    if (workFilter.role && (PLAYBOOK[item.finding.id]?.role ?? 'admin') !== workFilter.role) return false;
    return true;
  });

  const count = (p: Priority) => all.filter((i) => i.priority === p).length;
  const totalHours = shown.reduce((n, i) => n + i.hours, 0);
  const mix: Segment[] = [
    { label: PRIORITY_NAME.P1, value: count('P1'), color: 'var(--os-sev-critical)' },
    { label: PRIORITY_NAME.P2, value: count('P2'), color: 'var(--os-sev-warning)' },
    { label: PRIORITY_NAME.P3, value: count('P3'), color: 'var(--os-sev-info)' },
  ];

  const pill = (value: Priority | null, label: string, n: number) => html`
    <button
      class="os-pill ${workFilter.priority === value ? 'os-pill--on' : ''}"
      type="button"
      aria-pressed=${String(workFilter.priority === value)}
      @click=${() => store.setWorkFilter({ priority: value })}
    >
      ${label} <span class="os-pill__count">${n}</span>
    </button>
  `;

  return html`
    <div class="os-hero">
      <div class="os-hero__body">
        <div class="os-hero__headline">
          <h2 class="os-hero__title">${formatNumber(all.length)} things to fix</h2>
          ${all.length > 0
            ? html`<span class="os-metric__sub">
                ${formatHours(all.reduce((n, i) => n + i.hours, 0))} of work in total
              </span>`
            : nothing}
        </div>
        <p class="os-hero__sub">
          Ordered exactly the way the remediation plan numbers its backlog items: severity first, then how much the
          rule matters, then how many components it touches.
        </p>
        <p class="os-hero__sub">
          OrgTriage is a diagnostic tool, not an adviser, provided as is. Every item is a recommendation: have an experienced Salesforce administrator or developer verify it and test it outside production.
        </p>
        ${proportionBar(mix, { label: 'Work by priority', height: 10 })}
      </div>
    </div>

    <div class="os-toolbar">
      ${pill(null, 'All', all.length)} ${pill('P1', 'High', count('P1'))}
      ${pill('P2', 'Medium', count('P2'))} ${pill('P3', 'Low', count('P3'))}
      <select
        class="os-select"
        aria-label="Filter by area"
        .value=${workFilter.area ?? ''}
        @change=${(e: Event) =>
          store.setWorkFilter({ area: ((e.target as HTMLSelectElement).value || null) as AnalyzerId | null })}
      >
        <option value="">All areas</option>
        ${ANALYZERS.filter((a) => results.some((r) => r.analyzer === a.id)).map(
          (a) => html`<option value=${a.id}>${a.label}</option>`,
        )}
      </select>
      <select
        class="os-select"
        aria-label="Filter by who does the work"
        .value=${workFilter.role ?? ''}
        @change=${(e: Event) =>
          store.setWorkFilter({ role: (e.target as HTMLSelectElement).value || null })}
      >
        <option value="">Anyone</option>
        <option value="admin">Admin</option>
        <option value="developer">Developer</option>
        <option value="admin or developer">Either</option>
      </select>
      <button
        class="os-button"
        type="button"
        ?disabled=${!org}
        title="Opens the printable plan built from the cached snapshots. No API calls."
        @click=${() => org && openPlan(org)}
      >
        ${icons.document} Remediation plan
      </button>
      <span class="os-metric__sub">
        ${formatNumber(shown.length)} shown${shown.length !== all.length ? ` of ${formatNumber(all.length)}` : ''}
        · ${formatHours(totalHours)}
      </span>
    </div>

    ${shown.length === 0
      ? empty('Nothing matches these filters', 'Clear a filter to see the rest of the work.')
      : html`<ol class="os-worklist">
          ${shown.map((item, index) => renderWorkItem(item, index + 1))}
        </ol>`}
  `;
}

function renderWorkItem(item: WorkItem, position: number): TemplateResult {
  const { finding, area, areaLabel, hours } = item;
  const playbook = PLAYBOOK[finding.id];
  const open = store.isFindingOpen(area, finding.id);

  return html`
    <li class="os-work">
      <button
        class="os-work__head"
        type="button"
        aria-expanded=${String(open)}
        @click=${() => store.setFindingOpen(area, finding.id, !open)}
      >
        <span class="os-work__rank">${position}</span>
        <span class="os-work__title">${finding.title}</span>
        <span class="os-work__chevron ${open ? 'os-work__chevron--open' : ''}">${icons.chevron}</span>
      </button>
      <div class="os-work__meta">
        ${badge(finding.severity, PRIORITY_LABEL[item.priority])}
        <button class="os-work__area" type="button" @click=${() => store.openArea(area)}>${areaLabel}</button>
        <span class="os-muted">
          ${formatNumber(finding.items.length)}
          ${finding.items.length === 1 ? 'component' : 'components'}
        </span>
        <span class="os-muted">${formatHours(hours)}</span>
        ${playbook ? html`<span class="os-muted">${playbook.role}</span>` : nothing}
      </div>

      ${open
        ? html`<div class="os-work__body">
            <p class="os-work__why">${finding.rationale}</p>
            ${playbook
              ? html`
                  <h4 class="os-work__heading">Steps</h4>
                  <ol class="os-finding__steps">
                    ${playbook.steps.map((step) => html`<li>${step}</li>`)}
                  </ol>
                  <h4 class="os-work__heading">Done when</h4>
                  <p class="os-work__why">${playbook.acceptance}</p>
                `
              : html`<p class="os-work__why">${finding.remediation}</p>`}
            <div class="os-work__foot">
              <button class="os-button os-button--subtle" type="button" @click=${() => store.openArea(area)}>
                See the ${formatNumber(finding.items.length)} affected
                ${finding.items.length === 1 ? 'component' : 'components'} ${icons.chevron}
              </button>
              ${finding.docUrl
                ? html`<a href=${finding.docUrl} target="_blank" rel="noreferrer noopener"
                    >${docLabel(finding.docUrl)} ${icons.external}</a
                  >`
                : nothing}
            </div>
          </div>`
        : nothing}
    </li>
  `;
}
