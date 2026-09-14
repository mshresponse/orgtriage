#!/usr/bin/env node
/**
 * Screenshots for the website, taken from the real UI.
 *
 *   npm run dev:preview        (in one terminal)
 *   node tools/capture-site.mjs
 *
 * The preview harness mounts the actual panel and report pages against the
 * fixture org (Northwind Trading — a fixture, not a customer), so these are
 * captures of the shipping interface rather than mock-ups. The website says as
 * much beneath them.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.env.PREVIEW_URL ?? 'http://localhost:5178';
const OUT = 'site/images';
const ORG_ID = '00Dau0000012ABCEA2';

mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();

/** The panel, at the width Chrome's side panel actually opens at. */
async function panel(file, prepare) {
  const page = await browser.newPage({ viewport: { width: 470, height: 900 }, deviceScaleFactor: 2 });
  await page.goto(`${BASE}/dev/preview.html?frame`);
  await page.waitForSelector('.os-tabs', { timeout: 15_000 });
  await page.waitForTimeout(1200);
  if (prepare) await prepare(page);
  await page.screenshot({ path: `${OUT}/${file}` });
  console.log(`${OUT}/${file}`);
  await page.close();
}

await panel('panel-overview.png');

await panel('panel-work.png', async (page) => {
  await page.getByRole('tab', { name: /Work/ }).click();
  await page.waitForTimeout(900);
});

await panel('panel-area.png', async (page) => {
  await page.getByRole('tab', { name: /Areas/ }).click();
  await page.waitForTimeout(700);
  // The card's name is the button that opens the area; clicking the card body
  // does nothing, which is how an earlier run captured the grid instead.
  await page.locator('.os-areacard__name').first().click();
  await page.waitForTimeout(900);
  const finding = page.locator('details.os-finding').first();
  if (await finding.count()) {
    await finding.locator('summary').first().click();
    await page.waitForTimeout(600);
  }
});

{
  const page = await browser.newPage({ viewport: { width: 1280, height: 980 }, deviceScaleFactor: 2 });
  // The org travels in the hash, as `planLink.planUrl` builds it.
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
  await page.screenshot({ path: `${OUT}/report.png` });
  console.log(`${OUT}/report.png`);
  await page.close();
}

await browser.close();
