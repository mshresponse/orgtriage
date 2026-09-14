/**
 * Areas — what was checked, and how each area is doing.
 *
 * Two states in one view. With no area focused it is the grid of cards, which
 * is where scanning is controlled and where the per-area API cost is stated
 * before it is spent. With one focused it is that area's findings, reached by
 * a back link rather than by a tab, because ten tabs do not fit a 360px column
 * and an area is a place you visit rather than somewhere you live.
 */

import { html, type TemplateResult } from 'lit';
import { store, ANALYZERS } from '../state';
import { icons } from '../ui';
import { renderAnalyzer } from './analyzer';
import { renderAreaGrid } from './overview';

export function renderAreas(): TemplateResult {
  const focus = store.state.focusArea;
  if (!focus) {
    return html`
      <div class="os-stack">
        <p class="os-metric__sub" style="margin:0">
          Every area OrgTriage can check, what each costs to scan, and whether it is included when you scan
          everything. Open one to read its findings.
        </p>
        ${renderAreaGrid()}
      </div>
    `;
  }

  const area = ANALYZERS.find((a) => a.id === focus);
  return html`
    <div class="os-breadcrumb">
      <button class="os-button os-button--subtle" type="button" @click=${() => store.openArea(null)}>
        <span class="os-breadcrumb__back">${icons.chevron}</span> All areas
      </button>
      <span class="os-breadcrumb__here">${area?.label ?? focus}</span>
    </div>
    ${renderAnalyzer(focus)}
  `;
}
