#!/usr/bin/env node
/**
 * Chrome Web Store screenshots, 1280×800 exactly, taken from the real UI.
 *
 *   npm run dev:preview        (in one terminal)
 *   node tools/capture-store.mjs
 *
 * Same harness and fixture org as tools/capture-site.mjs (Northwind Trading,
 * a fixture, not a customer). The panel shots use a 1000×625 viewport at 1.28×,
 * which is wide enough for the footer to fit on one line and yields the
 * store's 1280×800; the plan page is captured at 1280×800 directly, since it
 * is a full-width page.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:5178';
const OUT = 'brand/05-chrome-extension/store/screenshots';
const ORG_ID = '00Dau0000012ABCEA2';

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

async function panel(file, prepare) {
  const page = await browser.newPage({ viewport: { width: 1000, height: 625 }, deviceScaleFactor: 1.28 });
  await page.goto(`${BASE}/dev/preview.html?frame`);
  await page.waitForSelector('.os-tabs', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  if (prepare) await prepare(page);
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log(`${OUT}/${file}`);
  await page.close();
}

await panel('1-overview-light.png');

await panel('2-finding.png', async (page) => {
  await page.getByRole('tab', { name: /Areas/ }).click();
  await page.waitForTimeout(700);
  await page.locator('.os-areacard__name').first().click();
  await page.waitForTimeout(900);
  const finding = page.locator('details.os-finding').first();
  if (await finding.count()) {
    await finding.locator('summary').first().click();
    await page.waitForTimeout(600);
    // Put the findings list's header at the top of the frame, under the tabs:
    // scroll the finding to the top, then back up by the header's height.
    await finding.evaluate((el) => {
      el.scrollIntoView({ block: 'start' });
      const scroller = el.closest('.os-main') ?? document.scrollingElement;
      scroller?.scrollBy(0, -120);
    });
    await page.waitForTimeout(300);
  }
});

await panel('3-work.png', async (page) => {
  await page.getByRole('tab', { name: /Work/ }).click();
  await page.waitForTimeout(900);
});

{
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  const org = new URLSearchParams({
    orgId: ORG_ID,
    name: 'Northwind Trading',
    type: 'Enterprise Edition',
    sandbox: 'false',
    instance: 'NA142',
    api: '67.0',
    host: 'northwind.lightning.force.com',
    user: 'Dana Okonkwo',
  });
  await page.goto(`${BASE}/report.html?preview#${org}`);
  await page.waitForSelector('.rp-toolbar', { timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/4-plan.png` });
  console.log(`${OUT}/4-plan.png`);
  await page.close();
}

await panel('5-overview-dark.png', async (page) => {
  const toggle = page.locator('[aria-label*="theme" i], button[title*="theme" i]').first();
  if (await toggle.count()) {
    await toggle.click();
    await page.waitForTimeout(600);
  }
});

await browser.close();
