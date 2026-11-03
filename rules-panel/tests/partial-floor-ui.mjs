import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '../../node_modules/playwright/index.mjs';

// Browser plugin not available; exercise only the local app in an isolated profile.
const origin = process.env.PANEL_URL ?? 'http://127.0.0.1:4317';
const output = path.join(os.tmpdir(), 'discovercars-partial-floor-qa');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
page.on('console', message => {
  const expectedLocalFallback = message.location().url === `${origin}/api/workspace` && message.text().includes('404');
  if (message.type() === 'error' && !expectedLocalFallback) errors.push(message.text());
});
try {
  const snapshot = await (await context.request.get(`${origin}/policy-snapshot.json`)).json();
  const original = snapshot.documents.pricing.pricing.mandatoryScopedFloorsPlnDay ?? [];
  await page.route('**/api/workspace', route => route.fulfill({ status: 404, json: {} }));
  await page.route('**/favicon.ico', route => route.fulfill({ status: 204 }));
  await page.goto(`${origin}/?view=rules`);
  assert.equal(new URL(page.url()).origin, origin);
  assert.ok(await page.title());
  await page.getByRole('heading', { name: 'Zasady cenowe', exact: true }).waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(), 0);
  await page.getByRole('button', { name: 'Dodaj regułę', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Gdańsk · Lotnisko (GDLO)', exact: true }).check();
  await dialog.getByRole('checkbox', { name: 'CDMV', exact: true }).check();
  await dialog.getByLabel('Data startu od').fill('2026-11-03');
  await dialog.getByLabel('Data startu do').fill('2026-11-30');
  await dialog.getByRole('button', { name: 'Zapisz w szkicu' }).click();
  await dialog.getByRole('alert').filter({ hasText: 'Podaj stawkę dla przynajmniej jednego przedziału' }).waitFor();
  const chosen = dialog.getByLabel('8–20 dni · PLN / dobę', { exact: true });
  await chosen.fill('60');
  for (const label of ['1 dzień', '2 dni', '3–4 dni', '5–7 dni', '21–35 dni']) {
    const input = dialog.getByLabel(`${label} · PLN / dobę`, { exact: true });
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.getAttribute('placeholder'), 'Bez zmian');
    assert.equal(await input.getAttribute('required'), null);
  }
  await chosen.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'desktop.png') });
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await chosen.scrollIntoViewIfNeeded();
    const inputBox = await chosen.boundingBox();
    const footerBox = await dialog.locator('.dialog-footer').boundingBox();
    assert.ok(inputBox.y >= 0 && inputBox.y + inputBox.height <= footerBox.y, `duration input covered at ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await chosen.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, 'mobile.png') });
  await dialog.getByRole('button', { name: 'Zapisz w szkicu' }).click();
  await dialog.waitFor({ state: 'hidden' });
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('discovercars-rules-draft-v1')).model);
  const floors = saved.pricing.pricing.mandatoryScopedFloorsPlnDay;
  assert.deepEqual(floors.slice(0, original.length), original);
  assert.deepEqual(floors.slice(original.length), [{ groups: ['CDMV'], zones: ['GDLO'],
    startDate: '2026-11-03', endDate: '2026-11-30', minDays: 8, maxDays: 20,
    minimumRatePlnDay: 60, overrideProtected: false }]);
  assert.deepEqual(saved.excel, snapshot.documents.excel);
  await page.reload();
  const row = page.locator(`[data-rule-id="scoped:${original.length}"]`);
  await row.waitFor();
  assert.match(await row.innerText(), /8–20 dni/);
  assert.deepEqual(errors, []);
  console.log(`PASS partial-band UI: empty validation, single 8-20 at 60, other rules and protection unchanged, saved and reloaded, responsive 320/390/768/1440. Screenshots: ${output}`);
} finally {
  await browser.close();
}
