#!/usr/bin/env node
/**
 * Chart-palette gate for the six categorical slots in src/styles/theme.css.
 *
 * The contrast gate (tools/contrast-check.mjs) answers "can this text be read".
 * This one answers a different question the contrast gate cannot: "can two
 * chart series be told apart" — including by a reader with a colour-vision
 * deficiency, who sees no difference at all between hues a designer picked as
 * obviously distinct.
 *
 * Four computed checks per theme, none of them a matter of taste:
 *
 *   Lightness band  Every slot inside the OKLCH L band for its ground, so no
 *                   series disappears into the card and none glares.
 *   Chroma floor    OKLCH C >= 0.10. Below that a hue reads as grey and stops
 *                   being an identity.
 *   CVD separation  OKLab ΔE (×100) between *adjacent* slots under simulated
 *                   protan and deutan vision (Machado, Oliveira & Fernandes
 *                   2009, severity 1.0). Adjacent is the right pairlist because
 *                   the charts here are stacked bars and proportion bars, where
 *                   neighbouring slots physically touch.
 *   Normal vision   The same worst-adjacent ΔE unsimulated. Dichromat safety is
 *                   not a licence to make neighbours dull for everyone else.
 *
 * Contrast against the card surface is reported, not enforced: a slot below
 * 3:1 is allowed under the relief rule *because* every chart in this UI ships
 * a direct label or a legend carrying the value. If a chart is ever added that
 * relies on colour alone, that exemption stops applying.
 *
 * Slot ORDER is the safety mechanism, not decoration — reordering changes which
 * pairs are adjacent. Re-run this after any change to the slots.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/styles/theme.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

const BAND = { light: [0.43, 0.77], dark: [0.48, 0.67] };
const CHROMA_FLOOR = 0.1;
const CVD_TARGET = 8.0;
const CVD_FLOOR = 6.0;
const NORMAL_FLOOR = 15.0;
const CONTRAST_MIN = 3.0;
const SLOTS = 7;
/**
 * The severity ramp, in the order a proportion bar draws it.
 *
 * These were never gated, and that is exactly how they broke: `--os-status-*`
 * was tuned for *text* contrast against a background, then reused as bar
 * segments sitting edge to edge, where a completely different property matters.
 * On the light theme critical and warning came out ΔE 0.7 apart under deutan
 * vision — indistinguishable. Adjacency is now checked here so the two roles
 * cannot silently become one again.
 */
const SEVERITY = ['--os-sev-critical', '--os-sev-warning', '--os-sev-info', '--os-sev-success'];

/* Machado, Oliveira & Fernandes (2009), severity 1.0, in linear RGB. The
   thresholds above are calibrated to this simulation; swapping in another
   model (Viénot, Brettel) moves borderline pairs and invalidates them. */
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
};

function block(selector) {
  const re = new RegExp(`${selector}\\s*\\{([^{}]*)\\}`);
  const m = re.exec(css);
  if (!m) throw new Error(`no block matched ${selector}`);
  const vars = new Map();
  const decl = /(--[\w-]+)\s*:\s*([^;]+);/g;
  let d;
  while ((d = decl.exec(m[1])) !== null) vars.set(d[1], d[2].trim());
  return vars;
}

const base = block(':root');
const themes = {
  dark: { vars: new Map([...base, ...block(":root,\\s*\\[data-os-theme='dark'\\]")]), surface: null },
  light: { vars: new Map([...base, ...block("\\[data-os-theme='light'\\]")]), surface: null },
};

function resolveVar(name, vars, depth = 0) {
  if (depth > 12) throw new Error(`var() cycle at ${name}`);
  const raw = vars.get(name);
  if (raw === undefined) throw new Error(`undefined token ${name}`);
  const ref = raw.match(/^var\(\s*(--[\w-]+)\s*\)$/);
  return ref ? resolveVar(ref[1], vars, depth + 1) : raw;
}

const s2lin = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const lin = (h) => {
  const v = h.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(v)) throw new Error(`not a 6-digit hex: ${h}`);
  return [0, 2, 4].map((i) => s2lin(parseInt(v.slice(i, i + 2), 16) / 255));
};
const relLum = ([r, g, b]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const contrast = (a, b) => {
  const [hi, lo] = [relLum(lin(a)), relLum(lin(b))].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function oklab([r, g, b]) {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
const oklch = (h) => {
  const [L, a, b] = oklab(lin(h));
  return [L, Math.hypot(a, b)];
};
const simulate = (h, kind) => {
  const [r, g, b] = lin(h);
  const M = MACHADO[kind];
  return M.map((row) => Math.max(0, Math.min(1, row[0] * r + row[1] * g + row[2] * b)));
};
const deltaE = (h1, h2, kind) => {
  const a = oklab(kind ? simulate(h1, kind) : lin(h1));
  const b = oklab(kind ? simulate(h2, kind) : lin(h2));
  return 100 * Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
};

let failures = 0;
const line = (mark, text) => console.log(`  ${mark}  ${text}`);

function gate(name, vars, label, slots, surface) {
  const [lo, hi] = BAND[name];
  console.log(`${name} — ${label}: ${slots.length} on ${surface}`);

  const offband = slots.filter((c) => oklch(c)[0] < lo || oklch(c)[0] > hi);
  if (offband.length) failures++;
  line(offband.length ? 'FAIL' : 'pass', `lightness band  ${offband.length ? offband.join(', ') : `all inside L ${lo}–${hi}`}`);

  const grey = slots.filter((c) => oklch(c)[1] < CHROMA_FLOOR);
  if (grey.length) failures++;
  line(grey.length ? 'FAIL' : 'pass', `chroma floor    ${grey.length ? grey.join(', ') : `all >= ${CHROMA_FLOOR}`}`);

  const adjacent = Array.from({ length: slots.length - 1 }, (_, i) => [slots[i], slots[i + 1]]);
  let worst = null;
  for (const kind of ['protan', 'deutan']) {
    for (const [a, b] of adjacent) {
      const d = deltaE(a, b, kind);
      if (worst === null || d < worst.d) worst = { d, kind, a, b };
    }
  }
  if (worst.d < CVD_FLOOR) failures++;
  line(
    worst.d < CVD_FLOOR ? 'FAIL' : worst.d < CVD_TARGET ? 'warn' : 'pass',
    `CVD separation  worst adjacent ${worst.a}↔${worst.b} ΔE ${worst.d.toFixed(1)} (${worst.kind}), target ${CVD_TARGET}`,
  );

  let nworst = null;
  for (const [a, b] of adjacent) {
    const d = deltaE(a, b);
    if (nworst === null || d < nworst.d) nworst = { d, a, b };
  }
  if (nworst.d < NORMAL_FLOOR) failures++;
  line(
    nworst.d < NORMAL_FLOOR ? 'FAIL' : 'pass',
    `normal vision   worst adjacent ${nworst.a}↔${nworst.b} ΔE ${nworst.d.toFixed(1)}, floor ${NORMAL_FLOOR}`,
  );

  const dim = slots.filter((c) => contrast(c, surface) < CONTRAST_MIN);
  line(
    dim.length ? 'note' : 'pass',
    `contrast        ${
      dim.length
        ? `${dim.map((c) => `${c} ${contrast(c, surface).toFixed(2)}:1`).join(', ')} — relief rule: these slots must carry a direct label`
        : `all >= ${CONTRAST_MIN}:1`
    }`,
  );
  console.log('');
}

console.log('\nOrgTriage chart-palette gate\n');
for (const [name, { vars }] of Object.entries(themes)) {
  gate(
    name,
    vars,
    'categorical slots',
    Array.from({ length: SLOTS }, (_, i) => resolveVar(`--os-chart-${i + 1}`, vars)),
    resolveVar('--os-bg-surface-raised', vars),
  );
  gate(
    name,
    vars,
    'severity bar segments',
    SEVERITY.map((token) => resolveVar(token, vars)),
    resolveVar('--os-bg-surface-raised', vars),
  );
}

if (failures > 0) {
  console.error(`${failures} palette failure(s). Adjust the --os-chart-* slots in src/styles/theme.css.\n`);
  process.exit(1);
}
console.log('Chart palette passes every computed gate in both themes.\n');
