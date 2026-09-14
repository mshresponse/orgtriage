/**
 * Shared render helpers. Plain functions returning Lit templates rather than
 * custom elements — at this size a component registry would be ceremony, and
 * light-DOM functions keep the SLDS-derived global stylesheet in charge.
 */

import { html, nothing, type TemplateResult } from 'lit';
import type { ErrorPayload } from '@/shared/messages';
import type { Severity } from '@/shared/types';
import type { AreaDiff } from '@/shared/diff';

export const SEVERITY_ORDER: Severity[] = ['critical', 'warning', 'info', 'success'];

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
  success: 'Healthy',
};

export function badge(severity: Severity, text = SEVERITY_LABEL[severity]): TemplateResult {
  return html`<span class="os-badge os-badge--${severity}">${text}</span>`;
}

export function neutralBadge(text: string): TemplateResult {
  return html`<span class="os-badge os-badge--neutral">${text}</span>`;
}

export function metric(
  label: string,
  value: string | number,
  sub?: string,
  meter?: { fraction: number; tone?: 'success' | 'warning' | 'critical' },
  link?: { label: string; url: string; open: (url: string) => void },
): TemplateResult {
  return html`
    <div class="os-metric">
      <span class="os-metric__label" title=${label}>${label}</span>
      <span class="os-metric__value">${value}</span>
      ${meter
        ? html`<div
            class="os-meter"
            role="img"
            aria-label="${label}: ${value}"
          >
            <div
              class="os-meter__fill ${meter.tone && meter.tone !== 'success'
                ? `os-meter__fill--${meter.tone}`
                : ''}"
              style=${`width:${Math.max(0, Math.min(1, meter.fraction)) * 100}%`}
            ></div>
          </div>`
        : nothing}
      ${sub ? html`<span class="os-metric__sub">${sub}</span>` : nothing}
      ${link
        ? html`<a
            class="os-metric__link"
            href=${link.url}
            title=${`Open ${link.label} in this Salesforce tab`}
            @click=${(e: Event) => {
              e.preventDefault();
              link.open(link.url);
            }}
            >${icons.pane}${link.label}</a
          >`
        : nothing}
    </div>
  `;
}

export function empty(title: string, body?: string, action?: TemplateResult): TemplateResult {
  return html`
    <div class="os-empty">
      <span class="os-empty__title">${title}</span>
      ${body ? html`<span>${body}</span>` : nothing}
      ${action ?? nothing}
    </div>
  `;
}

export function errorAlert(error: ErrorPayload, retry?: () => void): TemplateResult {
  return html`
    <div class="os-alert os-alert--critical" role="alert">
      <div class="os-stack" style="flex:1 1 auto;min-width:0">
        <strong>${error.message}</strong>
        ${error.hint ? html`<span>${error.hint}</span>` : nothing}
        <span class="os-metric__label">
          ${error.code}${error.status ? ` · HTTP ${error.status}` : ''}
        </span>
      </div>
      ${retry
        ? html`<button class="os-button" @click=${retry} type="button">Retry</button>`
        : nothing}
    </div>
  `;
}

export function skeletonRows(count: number): TemplateResult {
  return html`
    <div class="os-stack" style="padding:var(--os-space-md)">
      ${Array.from(
        { length: count },
        (_, i) =>
          html`<div
            class="os-skeleton"
            style=${`width:${90 - ((i * 13) % 45)}%`}
          ></div>`,
      )}
    </div>
  `;
}

/** Grade letter derived from a 0–100 score. Kept here so UI and worker agree. */
export function gradeTone(grade: string): Severity {
  if (grade === 'A') return 'success';
  if (grade === 'B') return 'info';
  if (grade === 'C') return 'warning';
  return 'critical';
}

export function formatDate(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = typeof value === 'number' ? new Date(value) : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: '2-digit' });
}

export function formatRelative(epochMs: number | undefined, now = Date.now()): string {
  if (!epochMs) return 'never';
  const diff = Math.max(0, now - epochMs);
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatNumber(value: number): string {
  return value.toLocaleString();
}

/** Icons, inlined so the panel needs no network and no icon font. */
export const icons = {
  /**
   * The OrgTriage mark: three ranked rows with an arrow on the leading row —
   * the "Priority Path" identity in brand/01-logos/mark-primary.svg, geometry
   * copied from that file. The rows take the current text colour so the mark
   * sits in either theme; the arrow is brand mint and never changes with scan
   * status — see brand/10-brand/BRAND-GUIDE.md.
   */
  mark: html`<svg viewBox="0 0 128 160" aria-hidden="true">
    <rect x="12" y="32" width="74" height="24" rx="7" fill="currentColor" />
    <rect x="12" y="76" width="68" height="22" rx="7" fill="currentColor" />
    <rect x="12" y="116" width="44" height="22" rx="7" fill="currentColor" />
    <path d="M82 16L118 44L82 72Z" fill="#42E2B8" />
  </svg>`,
  refresh: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <path d="M13.5 8a5.5 5.5 0 1 1-1.7-4" stroke-width="1.4" stroke-linecap="round" />
    <path d="M13.5 2v3.2h-3.2" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`,
  close: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <path d="m4 4 8 8M12 4l-8 8" stroke-width="1.5" stroke-linecap="round" />
  </svg>`,
  chevron: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <path d="m6 3.5 5 4.5-5 4.5" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`,
  /** Opens in the Salesforce tab beside the panel: a window with its left pane and an arrow into it. */
  pane: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <rect x="2" y="3" width="12" height="10" rx="1.5" stroke-width="1.3" />
    <path d="M6.5 3v10" stroke-width="1.3" />
    <path d="M12 8H8.5M10 6.5 8.5 8l1.5 1.5" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
  </svg>`,
  external: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <path d="M9 3h4v4" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
    <path d="M13 3 7.5 8.5" stroke-width="1.3" stroke-linecap="round" />
    <path
      d="M11.5 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5.5a1 1 0 0 1 1-1h2.5"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>`,
  sun: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <circle cx="8" cy="8" r="3" stroke-width="1.3" />
    <path
      d="M8 1v1.5M8 13.5V15M15 8h-1.5M2.5 8H1M12.9 3.1l-1 1M4.1 11.9l-1 1M12.9 12.9l-1-1M4.1 4.1l-1-1"
      stroke-width="1.3"
      stroke-linecap="round"
    />
  </svg>`,
  document: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <path
      d="M4 2h5l3 3v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Z"
      stroke-width="1.3"
      stroke-linejoin="round"
    />
    <path d="M9 2v3h3M5.5 8h5M5.5 10.5h5" stroke-width="1.3" stroke-linecap="round" />
  </svg>`,
  moon: html`<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor">
    <path
      d="M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"
      stroke-width="1.3"
      stroke-linejoin="round"
    />
  </svg>`,
};

/**
 * A score movement chip: "+7 since 27 Aug".
 *
 * Direction is stated with an arrow and a sign as well as a colour, because a
 * green pill and a red pill are the same pill to a reader with a colour-vision
 * deficiency — and because on a score, "up" is good while on a finding count
 * "up" is bad, which no colour convention can carry on its own.
 */
export function deltaChip(diff: AreaDiff | null): TemplateResult | typeof nothing {
  if (!diff) return nothing;
  if (diff.scoreDelta === null || diff.scoreDelta === 0) {
    return html`<span class="os-delta os-delta--flat" title=${sinceLabel(diff)}>no change</span>`;
  }
  const better = diff.scoreDelta > 0;
  return html`<span
    class="os-delta ${better ? 'os-delta--up' : 'os-delta--down'}"
    title="${sinceLabel(diff)}"
    >${better ? '▲' : '▼'} ${better ? '+' : ''}${diff.scoreDelta}</span
  >`;
}

export function sinceLabel(diff: AreaDiff): string {
  return `Compared with the snapshot taken ${formatDate(diff.since)}`;
}
