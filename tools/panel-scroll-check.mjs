#!/usr/bin/env node
/**
 * The sidebar must scroll its findings list, at every width.
 *
 * This exists because of a real bug. `<orgtriage-app>` is a custom element, so
 * an undefined element is `display: inline` with an auto height, and
 * `.os-app { height: 100% }` had no definite parent height to resolve
 * against — it silently fell back to content height. The app then grew past
 * the panel window instead of `.os-main` scrolling inside it, and since
 * <body> is `overflow: hidden` the document could not be scrolled by wheel at
 * all; only tabbing moved it, because the browser scrolls a hidden-overflow
 * box to reveal focus. It presented as "the 25% width doesn't scroll", since
 * at wider widths the content happened to fit.
 *
 * Run the preview first: `npm run dev:preview`, then
 * `CHROME_PATH=… node tools/panel-scroll-check.mjs`.
 */
import { chromium } from 'playwright';

const PREVIEW = process.env.PREVIEW_URL ?? 'http://localhost:5178/dev/preview.html?frame';
const WIDTHS = [1000, 700, 478, 420, 360];
const HEIGHT = 950;

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
let failed = false;

for (const width of WIDTHS) {
  const page = await browser.newPage({ viewport: { width, height: HEIGHT } });
  await page.goto(PREVIEW);
  await page.waitForSelector('.os-tab');
  // Work is the longest list in the panel — every open finding across every
  // area — so it is the hardest case for the scroll container.
  await page.click('.os-tab:has-text("Work")');
  await page.waitForSelector('.os-work');
  // Expand everything, so the list is certainly taller than the panel.
  await page.evaluate(async () => {
    for (const d of document.querySelectorAll('details')) d.open = true;
    for (const head of document.querySelectorAll('.os-work__head[aria-expanded="false"]')) {
      head.click();
    }
  });
  await page.waitForTimeout(200);

  const fills = await page.evaluate(
    (h) => Math.abs(document.querySelector('.os-app').getBoundingClientRect().height - h) <= 1,
    HEIGHT,
  );

  await page.mouse.move(width / 2, HEIGHT / 2);
  await page.mouse.wheel(0, 900);
  await page.waitForTimeout(250);

  const after = await page.evaluate(() => {
    const main = document.querySelector('.os-main');
    return {
      mainScrollTop: Math.round(main.scrollTop),
      overflow: main.scrollHeight - main.clientHeight,
      // The header must not have moved: if the document scrolled instead of
      // the main region, it slides out of view.
      headerTop: Math.round(document.querySelector('.os-header').getBoundingClientRect().top),
      documentScrolled: Math.round(Math.max(document.body.scrollTop, document.documentElement.scrollTop)),
    };
  });

  const ok = fills && after.overflow > 0 && after.mainScrollTop > 0 && after.headerTop === 0 && after.documentScrolled === 0;
  if (!ok) failed = true;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${String(width).padStart(4)}px  app fills window=${fills} · ` +
      `main overflow=${after.overflow}px scrolled=${after.mainScrollTop} · ` +
      `header top=${after.headerTop} · document scrolled=${after.documentScrolled}`,
  );
  await page.close();
}

await browser.close();
process.exit(failed ? 1 : 0);
