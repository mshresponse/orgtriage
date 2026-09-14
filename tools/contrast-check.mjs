#!/usr/bin/env node
/**
 * WCAG 2.2 contrast gate for the Sage & Charcoal theme.
 *
 * Parses src/styles/theme.css, resolves the var() chains for each theme block,
 * and asserts every declared foreground/background pairing clears its target
 * ratio. Run via `npm run check:contrast`. Exits non-zero on failure so the
 * theme cannot regress silently.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(resolve(here, '../src/styles/theme.css'), 'utf8');

/** Strip comments, then drop whole at-rule blocks (brace-balanced).
 *  `@media (prefers-contrast: more)` deliberately raises contrast, so measuring
 *  it instead of the default theme would hide regressions in the default. */
function stripAtRules(source) {
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '');
  let out = '';
  for (let i = 0; i < noComments.length; i++) {
    if (noComments[i] !== '@') {
      out += noComments[i];
      continue;
    }
    const open = noComments.indexOf('{', i);
    if (open === -1) break;
    let depth = 0;
    let j = open;
    for (; j < noComments.length; j++) {
      if (noComments[j] === '{') depth++;
      else if (noComments[j] === '}' && --depth === 0) break;
    }
    i = j; // skip the entire at-rule
  }
  return out;
}

const css = stripAtRules(raw);

/** Collect `--name: value;` declarations from every block whose selector matches. */
function collect(selectorPattern) {
  const vars = new Map();
  const blockRe = /([^{}]+)\{([^{}]*)\}/g;
  let m;
  while ((m = blockRe.exec(css)) !== null) {
    const selector = m[1].trim();
    if (!selectorPattern.test(selector)) continue;
    const declRe = /(--[\w-]+)\s*:\s*([^;]+);/g;
    let d;
    while ((d = declRe.exec(m[2])) !== null) vars.set(d[1], d[2].trim());
  }
  if (vars.size === 0) throw new Error(`no theme block matched ${selectorPattern}`);
  return vars;
}

const base = collect(/^:root$/);
const darkVars = new Map([...base, ...collect(/^:root,\s*\[data-os-theme='dark'\]$/)]);
const lightVars = new Map([...base, ...collect(/^\[data-os-theme='light'\]$/)]);

/** Resolve a token through nested var() references to a literal colour. */
function resolveVar(name, vars, depth = 0) {
  if (depth > 12) throw new Error(`var() cycle at ${name}`);
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`undefined token ${name}`);
  const ref = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return ref ? resolveVar(ref[1], vars, depth + 1) : raw;
}

function parseColor(value) {
  const hex = value.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (hex) {
    const h = hex[1].length === 3 ? hex[1].replace(/./g, (c) => c + c) : hex[1];
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  }
  const rgb = value.trim().match(/^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)/i);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`cannot parse colour: ${value}`);
}

/** WCAG relative luminance (sRGB). */
function luminance([r, g, b]) {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
}

function contrast(fg, bg) {
  const a = luminance(parseColor(fg));
  const b = luminance(parseColor(bg));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Every pairing the UI actually renders.
 * `min` follows WCAG 2.2: 4.5 for body text, 3.0 for large text (>=18.66px bold
 * / 24px) and for non-text UI boundaries (1.4.11).
 */
const PAIRS = [
  // Body text on each surface
  ['--os-text-primary', '--os-bg-canvas', 4.5, 'body text on canvas'],
  ['--os-text-primary', '--os-bg-surface', 4.5, 'body text on surface'],
  ['--os-text-primary', '--os-bg-surface-raised', 4.5, 'body text on raised surface'],
  ['--os-text-primary', '--os-bg-hover', 4.5, 'body text on hovered row'],
  ['--os-text-primary', '--os-bg-selected', 4.5, 'body text on selected row'],
  ['--os-text-secondary', '--os-bg-canvas', 4.5, 'secondary text on canvas'],
  ['--os-text-secondary', '--os-bg-surface', 4.5, 'secondary text on surface'],
  ['--os-text-tertiary', '--os-bg-canvas', 4.5, 'tertiary text on canvas'],
  ['--os-text-tertiary', '--os-bg-surface', 4.5, 'tertiary text on surface'],
  ['--os-text-accent', '--os-bg-canvas', 4.5, 'link on canvas'],
  ['--os-text-accent', '--os-bg-surface', 4.5, 'link on surface'],
  ['--os-text-accent', '--os-bg-surface-raised', 4.5, 'link on raised surface'],

  // Accent / inverse surfaces
  ['--os-text-on-accent', '--os-bg-accent', 4.5, 'button label on brand fill'],
  ['--os-text-on-accent', '--os-bg-accent-hover', 4.5, 'button label on brand hover'],

  // Status text on canvas, surface, and its own tinted chip background
  ['--os-status-success', '--os-bg-surface', 4.5, 'success text on surface'],
  ['--os-status-warning', '--os-bg-surface', 4.5, 'warning text on surface'],
  ['--os-status-critical', '--os-bg-surface', 4.5, 'critical text on surface'],
  ['--os-status-info', '--os-bg-surface', 4.5, 'info text on surface'],
  ['--os-status-success', '--os-status-success-bg', 4.5, 'success chip'],
  ['--os-status-warning', '--os-status-warning-bg', 4.5, 'warning chip'],
  ['--os-status-critical', '--os-status-critical-bg', 4.5, 'critical chip'],
  ['--os-status-info', '--os-status-info-bg', 4.5, 'info chip'],

  // Non-text UI: 1.4.11 requires 3:1 for meaningful boundaries and focus.
  ['--os-border-strong', '--os-bg-surface', 3.0, 'input border on surface'],
  ['--os-focus-ring', '--os-bg-canvas', 3.0, 'focus ring on canvas'],
  ['--os-focus-ring', '--os-bg-surface', 3.0, 'focus ring on surface'],
  ['--os-border-accent', '--os-bg-surface', 3.0, 'active tab underline'],
];

let failures = 0;
let checked = 0;
const rows = [];

for (const [themeName, vars] of [
  ['dark', darkVars],
  ['light', lightVars],
]) {
  for (const [fgToken, bgToken, min, label] of PAIRS) {
    let ratio;
    try {
      ratio = contrast(resolveVar(fgToken, vars), resolveVar(bgToken, vars));
    } catch (err) {
      rows.push({ themeName, label, ratio: NaN, min, note: err.message });
      failures++;
      continue;
    }
    checked++;
    const pass = ratio >= min;
    if (!pass) failures++;
    rows.push({ themeName, label, ratio, min, pass });
  }
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`\nOrgTriage contrast gate — ${checked} pairings\n`);
for (const r of rows) {
  const mark = r.note ? 'ERR ' : r.pass ? 'pass' : 'FAIL';
  const ratio = Number.isNaN(r.ratio) ? '  -  ' : r.ratio.toFixed(2).padStart(5);
  console.log(
    `  ${mark}  ${pad(r.themeName, 6)} ${ratio}:1 (min ${r.min.toFixed(1)})  ${r.label}${
      r.note ? `  — ${r.note}` : ''
    }`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} contrast failure(s). Adjust src/styles/theme.css.\n`);
  process.exit(1);
}
console.log(`\nAll ${checked} pairings meet WCAG 2.2 AA.\n`);
