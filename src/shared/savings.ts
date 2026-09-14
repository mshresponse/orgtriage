/**
 * Estimated time saved by a fix.
 *
 * The rule this module exists to enforce: **never state a saving from a
 * constant somebody made up.** "Removing a component saves 80ms" is the kind of
 * number that sounds authoritative, travels into a client deck, and is wrong by
 * an order of magnitude in half the orgs it is quoted in.
 *
 * What is defensible is a saving derived from the org's own measurements. A
 * Lightning page's measured time and its eagerly loaded component count are
 * both available per page, which makes a set of paired observations, which
 * makes a line. The slope of that line is this org's cost per component — not
 * an industry figure, not a guess, and it comes with the sample size and the
 * fit quality so a reader can judge it.
 *
 * When the org has too few pages, or the relationship is too weak to be worth
 * quoting, this returns nothing and the UI says nothing. A missing estimate is
 * a fine outcome; a confident wrong one is not.
 */

/** Fewer paired pages than this and a line through them means nothing. */
export const MIN_SAMPLE = 8;
/**
 * Below this share of variance explained, component count is not what is
 * driving page time in this org — the honest answer is then "we don't know".
 */
export const MIN_R2 = 0.3;
/** A negative or trivial slope means more components did not cost more time. */
export const MIN_SLOPE_MS = 5;

export interface Point {
  /** Eagerly loaded components. */
  x: number;
  /** Measured page time, in milliseconds. */
  y: number;
}

export interface Fit {
  /** Milliseconds per eagerly loaded component, in this org. */
  slopeMs: number;
  interceptMs: number;
  /** Coefficient of determination, 0–1. */
  r2: number;
  /** Pages the fit was computed from. */
  n: number;
}

/**
 * Ordinary least squares through the paired observations.
 *
 * Deliberately the simplest model that can be explained in one sentence to a
 * client: "in your org, each component a page loads up front costs about N
 * milliseconds". A better model exists — component type matters, and so does
 * the record's data — but none of that is measurable from here, and a more
 * complicated model built on the same two columns would only look more certain
 * without being more right.
 */
export function fitLinear(points: Point[]): Fit | null {
  const usable = points.filter(
    (p) => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x > 0 && p.y > 0,
  );
  if (usable.length < MIN_SAMPLE) return null;

  const n = usable.length;
  const meanX = usable.reduce((s, p) => s + p.x, 0) / n;
  const meanY = usable.reduce((s, p) => s + p.y, 0) / n;

  let sxy = 0;
  let sxx = 0;
  for (const p of usable) {
    sxy += (p.x - meanX) * (p.y - meanY);
    sxx += (p.x - meanX) ** 2;
  }
  // Every page has the same component count: there is no relationship to find.
  if (sxx === 0) return null;

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssRes = 0;
  let ssTot = 0;
  for (const p of usable) {
    const predicted = intercept + slope * p.x;
    ssRes += (p.y - predicted) ** 2;
    ssTot += (p.y - meanY) ** 2;
  }
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot;

  return { slopeMs: slope, interceptMs: intercept, r2, n };
}

/** True when a fit is strong enough to quote a saving from. */
export function isQuotable(fit: Fit | null): fit is Fit {
  return fit !== null && fit.n >= MIN_SAMPLE && fit.r2 >= MIN_R2 && fit.slopeMs >= MIN_SLOPE_MS;
}

/**
 * What deferring `components` off the initial load is worth, in this org.
 *
 * Returns null rather than zero when there is nothing defensible to say, so a
 * caller cannot accidentally render "0 ms saved" and have it read as a measured
 * result.
 */
export function savedMs(fit: Fit | null, components: number): number | null {
  if (!isQuotable(fit) || components <= 0) return null;
  return Math.round(fit.slopeMs * components);
}

/** "1.4 s" / "320 ms". */
export function formatMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`;
}

/**
 * The one-line provenance that must travel with any saving.
 *
 * Every place a saving is shown also shows this. A number without its sample
 * size and fit quality is an assertion; with them it is a measurement a reader
 * can argue with, which is the whole point.
 */
export function fitProvenance(fit: Fit): string {
  return `from ${fit.n} pages in this org, ${Math.round(fit.r2 * 100)}% of the variation explained · ${Math.round(fit.slopeMs)} ms per component`;
}

/**
 * Total time a fix gives back across everyone who opens the page.
 *
 * Milliseconds per page view are hard to care about; the same number times the
 * views a page actually gets is a business case. `views` comes from the
 * Lightning Usage app, so this is only offered where that count is real.
 */
export function annualHoursSaved(savedMsPerView: number, viewsPerDay: number): number | null {
  if (savedMsPerView <= 0 || viewsPerDay <= 0) return null;
  const hours = (savedMsPerView * viewsPerDay * 250) / 3_600_000; // 250 working days
  return Math.round(hours * 10) / 10;
}
