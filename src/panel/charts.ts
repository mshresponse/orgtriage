/**
 * Inline SVG chart primitives.
 *
 * No chart library: the panel ships with no network access to a CDN, every
 * kilobyte lands in the extension bundle, and the four shapes this UI needs are
 * a few dozen lines of geometry each. They are plain functions returning Lit
 * templates, like everything else in `ui.ts`.
 *
 * Three rules hold across all of them, and they are the reason the charts are
 * readable rather than decorative:
 *
 *   1. Colour is never the only key. Every series carries a direct label or a
 *      legend entry with its value, which is also what licenses the three light
 *      palette slots that sit below 3:1 on white (see tools/palette-check.mjs).
 *   2. Every chart is a labelled image to assistive technology — `role="img"`
 *      plus an `aria-label` that states the same numbers a sighted reader gets.
 *      A screen-reader user should never be told "chart".
 *   3. Colours come from CSS custom properties, never from literals here, so a
 *      theme switch repaints the charts with the page.
 */

import { html, svg, nothing, type TemplateResult } from 'lit';
import type { Severity } from '@/shared/types';

/** A slice of a proportion bar or donut. `value` is a raw count, not a share. */
export interface Segment {
  label: string;
  value: number;
  /** A CSS colour — normally `var(--os-status-*)` or `var(--os-chart-N)`. */
  color: string;
}

const TAU = Math.PI * 2;

/**
 * Score dial — an arc from 0 to `score` out of 100, with the number in the
 * middle and "out of 100" beneath it.
 *
 * The caption is not decoration. Without it the ring reads as a progress
 * indicator of something unspecified — the first question a reader asked of it
 * was "percentage… no, not percentage?", which is a chart failing at its one
 * job. An arc that needs explaining is an arc that needs a label.
 *
 * Drawn as a stroked circle with `stroke-dasharray` rather than an arc path:
 * one length to animate, no large-arc-flag arithmetic, and the round line cap
 * lands correctly at both ends. Rotated -90° so zero sits at twelve o'clock.
 */
export function scoreDial(
  score: number | null,
  tone: Severity,
  options: { size?: number; label?: string; caption?: boolean } = {},
): TemplateResult {
  const size = options.size ?? 104;
  const stroke = Math.max(6, Math.round(size * 0.085));
  const r = (size - stroke) / 2;
  const circumference = TAU * r;
  const fraction = score === null ? 0 : Math.max(0, Math.min(100, score)) / 100;
  const aria =
    score === null
      ? `${options.label ?? 'Score'}: not graded`
      : `${options.label ?? 'Score'}: ${score} out of 100`;

  return html`
    <svg
      class="os-dial"
      viewBox="0 0 ${size} ${size}"
      width=${size}
      height=${size}
      role="img"
      aria-label=${aria}
    >
      <circle
        cx=${size / 2}
        cy=${size / 2}
        r=${r}
        fill="none"
        stroke="var(--os-chart-track)"
        stroke-width=${stroke}
      />
      ${score === null
        ? nothing
        : svg`<circle
            cx=${size / 2}
            cy=${size / 2}
            r=${r}
            fill="none"
            stroke="var(--os-status-${tone})"
            stroke-width=${stroke}
            stroke-linecap="round"
            stroke-dasharray="${circumference * fraction} ${circumference}"
            transform="rotate(-90 ${size / 2} ${size / 2})"
          />`}
      <text
        class="os-dial__value"
        x=${size / 2}
        y=${size / 2 - (options.caption === false ? 0 : size * 0.06)}
        text-anchor="middle"
        dominant-baseline="central"
      >
        ${score === null ? '—' : score}
      </text>
      ${options.caption === false
        ? nothing
        : svg`<text
            class="os-dial__caption"
            x=${size / 2}
            y=${size / 2 + size * 0.17}
            text-anchor="middle"
            dominant-baseline="central"
          >out of 100</text>`}
    </svg>
  `;
}

/**
 * Proportion bar — one row, segments sized by share, with a legend beneath.
 *
 * Used for severity mixes and for "how much of this area could be checked".
 * Segments below ~1.5% of the width are given a floor so a single critical
 * finding among nine hundred is still a visible mark rather than a hairline
 * that anti-aliases away.
 */
export function proportionBar(
  segments: Segment[],
  options: { legend?: boolean; height?: number; label?: string } = {},
): TemplateResult {
  const shown = segments.filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  const height = options.height ?? 8;
  const aria =
    total === 0
      ? `${options.label ?? 'Breakdown'}: nothing to show`
      : `${options.label ?? 'Breakdown'}: ${shown
          .map((s) => `${s.label} ${s.value}`)
          .join(', ')}`;

  const MIN_SHARE = 0.015;
  const floored = shown.map((s) => Math.max(s.value / total, MIN_SHARE));
  const scale = floored.reduce((a, b) => a + b, 0);

  return html`
    <div class="os-propbar" role="img" aria-label=${aria}>
      <div class="os-propbar__track" style=${`height:${height}px`}>
        ${total === 0
          ? html`<div class="os-propbar__empty"></div>`
          : shown.map(
              (s, i) =>
                html`<div
                  class="os-propbar__seg"
                  style=${`width:${((floored[i] ?? 0) / scale) * 100}%;background:${s.color}`}
                  title="${s.label}: ${s.value.toLocaleString()}"
                ></div>`,
            )}
      </div>
      ${options.legend === false
        ? nothing
        : html`<ul class="os-legend">
            ${shown.map(
              (s) => html`<li class="os-legend__item">
                <span class="os-legend__swatch" style=${`background:${s.color}`}></span>
                <span class="os-legend__label">${s.label}</span>
                <span class="os-legend__value">${s.value.toLocaleString()}</span>
              </li>`,
            )}
          </ul>`}
    </div>
  `;
}

/**
 * Sparkline column chart — the last N values of one measure.
 *
 * Bars rather than a line: the series here are short (a handful of scans) and
 * discrete, and a line between two scans a week apart implies a continuity that
 * does not exist. The most recent column is emphasised.
 */
export function sparkColumns(
  values: number[],
  options: { label?: string; tone?: Severity; height?: number } = {},
): TemplateResult {
  if (values.length === 0) return html`<span class="os-muted">—</span>`;
  const height = options.height ?? 28;
  const max = Math.max(1, ...values);
  const tone = options.tone ?? 'info';

  return html`
    <div
      class="os-spark"
      style=${`height:${height}px`}
      role="img"
      aria-label="${options.label ?? 'Recent values'}: ${values.join(', ')}"
    >
      ${values.map(
        (v, i) =>
          html`<span
            class="os-spark__col ${i === values.length - 1 ? 'os-spark__col--now' : ''}"
            style=${`height:${Math.max(6, (v / max) * 100)}%;background:var(--os-status-${tone})`}
            title=${String(v)}
          ></span>`,
      )}
    </div>
  `;
}

/**
 * Horizontal ranked bars — "which areas carry the most weight".
 *
 * Rows are pre-sorted by the caller; this only draws them. The value sits at
 * the end of each bar rather than inside it, so a short bar's number is not
 * clipped and does not need a contrast exception.
 */
export function rankedBars(
  rows: { label: string; value: number; color: string; onClick?: () => void }[],
  options: { label?: string; suffix?: string } = {},
): TemplateResult {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return html`
    <ul
      class="os-ranked"
      role="img"
      aria-label="${options.label ?? 'Ranked'}: ${rows
        .map((r) => `${r.label} ${r.value}`)
        .join(', ')}"
    >
      ${rows.map(
        (r) => html`<li class="os-ranked__row">
          ${r.onClick
            ? html`<button class="os-ranked__label os-ranked__label--link" type="button" @click=${r.onClick}>
                ${r.label}
              </button>`
            : html`<span class="os-ranked__label">${r.label}</span>`}
          <span class="os-ranked__track">
            <span
              class="os-ranked__fill"
              style=${`width:${(r.value / max) * 100}%;background:${r.color}`}
            ></span>
          </span>
          <span class="os-ranked__value">${r.value.toLocaleString()}${options.suffix ?? ''}</span>
        </li>`,
      )}
    </ul>
  `;
}
