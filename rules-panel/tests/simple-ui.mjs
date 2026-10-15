import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/playwright/index.mjs';

const origin = process.env.PANEL_URL ?? 'http://127.0.0.1:4317';
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
const page = await context.newPage();
page.setDefaultTimeout(5000);
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const output = new URL('../../output/playwright/simple-panel/', import.meta.url);
await mkdir(output, { recursive: true });
try {
  await page.route('**/api/workspace', route => route.fulfill({ status: 404, json: {} }));
  await page.goto(origin);
  await page.getByRole('heading', { name: 'Zasady cenowe', exact: true }).waitFor();
  assert.equal(await page.locator('.topbar').count(), 0, 'No duplicate technical header');
  assert.equal(await page.getByRole('button', { name: 'Opublikuj', exact: true }).count(), 0, 'Publication belongs to review only');
  for (const name of ['Minima podstawowe', 'Minima szczególne', 'Chronione terminy', 'Cel cenowy']) await page.getByRole('heading', { name, exact: true }).waitFor();
  const legacy = page.locator('.supplementary-rules');
  assert.equal(await legacy.getAttribute('open'), null);
  assert.equal(await legacy.locator('.rule-row:visible').count(), 0);
  const szlo = page.locator('.rule-family').filter({ has: page.locator('summary', { hasText: 'SZLO:' }) });
  assert.equal(await szlo.getAttribute('open'), null);
  await szlo.locator('summary').click();
  assert.equal(await szlo.locator('article.rule-row:visible').count(), 6);
  await szlo.locator('article.rule-row').first().getByRole('button').click();
  assert.equal(await page.getByLabel('Stawka minimalna (PLN / dobę)', { exact: true }).inputValue(), '300');
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'hidden' });
  await szlo.locator('summary').click();
  await page.getByLabel('Szukaj zasad').fill('SZLO');
  assert.equal(await page.locator('article.rule-row:visible').count(), 6, 'Search exposes matching duration bands');
  await page.getByRole('button', { name: 'Wyczyść wyszukiwanie' }).click();
  await page.getByLabel('Rodzaj reguły').selectOption('legacy');
  assert.ok(await page.locator('.supplementary-rules article.rule-row:visible').count() > 0, 'Explicit filter reveals supplementary rules');
  await page.getByLabel('Rodzaj reguły').selectOption('all');
  for (const [width, height] of [[1440, 960], [1024, 900], [768, 900], [390, 844], [320, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => window.scrollTo(0, 0));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `rules overflow ${width}`);
    const overflowingCells = await page.locator('.rule-row:visible > .duration-cell, .rule-row:visible > .rate-cell, .rule-row:visible > .dates-cell').evaluateAll(cells => cells.filter(cell => cell.scrollWidth > cell.clientWidth + 1).map(cell => cell.textContent));
    assert.deepEqual(overflowingCells, [], `cell overflow ${width}`);
    await page.screenshot({ path: fileURLToPath(new URL(`rules-${width}.png`, output)) });
  }
  await page.getByRole('button', { name: /Podgląd zmian/ }).click();
  assert.equal(await page.getByRole('button', { name: 'Opublikuj', exact: true }).isDisabled(), true);
  await page.getByRole('button', { name: 'Źródła i publikacja', exact: true }).click();
  assert.equal(await page.getByText('pricing-rules.config.example.json', { exact: true }).isVisible(), false);
  await page.getByText('Konfiguracja techniczna', { exact: true }).click();
  await page.getByText('pricing-rules.config.example.json', { exact: true }).waitFor();
  const snapshot = await (await context.request.get(`${origin}/policy-snapshot.json`)).json();
  const model = structuredClone(snapshot.documents);
  model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city += 1;
  const workspace = { snapshot, history: [], status: {}, capabilities: { sharedDraft: true, preview: true, publish: true },
    draft: { revision: 'ui-test-draft', model, modelHash: 'test-model', sourceRevision: snapshot.source.revision, sourceHash: snapshot.source.policyHash, baselineSha256: snapshot.baseline.sha256 },
    preview: null };
  await page.unroute('**/api/workspace');
  await page.route('**/api/workspace', route => route.fulfill({ json: workspace }));
  let publications = 0;
  await page.route('**/api/publish', route => {
    publications++;
    assert.deepEqual(route.request().postDataJSON(), { draftRevision: 'ui-test-draft' });
    return route.fulfill({ json: { revision: 'ui-test-commit' } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Podgląd zmian', exact: true }).click();
  const publish = page.getByRole('button', { name: 'Opublikuj', exact: true });
  assert.equal(await publish.isEnabled(), true);
  page.once('dialog', dialog => dialog.dismiss());
  await publish.click();
  assert.equal(publications, 0, 'Dismissed confirmation cannot publish');
  page.once('dialog', dialog => dialog.accept());
  await publish.click();
  await page.getByRole('status').filter({ hasText: 'Opublikowano konfigurację' }).waitFor();
  assert.equal(publications, 1, 'Verified publication remains clickable only after confirmation');
  assert.deepEqual(errors, []);
  console.log('Simple UI PASS: grouped rules, discoverable details, review-only publish, desktop/mobile.');
} finally { await browser.close(); }
