import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/playwright/index.mjs';

const origin = process.env.PANEL_URL ?? 'http://127.0.0.1:4317';
const browser = await chromium.launch({ headless: true });
const output = new URL('../../output/playwright/location-onboarding/', import.meta.url);
await mkdir(output, { recursive: true });
const file = { name: 'new-locations.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: Buffer.from('PK onboarding fixture') };
const bands = { '1': 11, '2': 12, '3-4': 13, '5-7': 14, '8-20': 15, '21-35': 16 };
const summary = { sha256: 'checked-file', rowCount: 24000, groups: ['CDMV'], zones: ['KRLO', 'NCT1', 'NCT2'], firstDate: '2026-10-27', lastDate: '2027-02-26' };
const onboarding = {
  unknownZones: ['NCT1', 'NCT2'], ready: false,
  locations: [
    { id: 'krakow-airport', scraper_label: 'Kraków Lotnisko', city: 'Kraków', kind: 'airport', zones: ['NOTABLE', 'KRLO'], daily: true },
    { id: 'katowice-city', scraper_label: 'Katowice Centrum', city: 'Katowice', kind: 'city', zones: ['KATC'], daily: false },
  ],
  markupSources: [
    { zone: 'KRLO', label: 'Kraków Lotnisko', amounts: { ...bands, '1': 21 } },
    { zone: 'KATC', label: 'Katowice Centrum', amounts: bands },
  ],
  addedLocations: [],
};
const discovery = { summary, sourceRevision: 'source-discovery', previousSha256: 'old-file', onboarding };
const validated = {
  summary, sourceRevision: 'source-validated', previousSha256: 'old-file', onboardingHash: 'checked-onboarding',
  onboarding: { ...onboarding, ready: true, addedLocations: [
    { zone: 'NCT1', label: 'Katowice Dworzec PKP', city: 'Katowice', kind: 'city', daily: true, markupSourceZone: 'KATC', airportLabels: ['Katowice Pyrzowice Lotnisko'] },
    { zone: 'NCT2', label: 'Kraków Lotnisko', city: 'Kraków', kind: 'airport', daily: true, markupSourceZone: 'KRLO', airportLabels: [] },
  ] },
};
const expectedAssignments = [
  { zone: 'NCT1', placeId: 5002, query: 'Katowice dworzec', markupSourceZone: 'KATC', daily: true },
  { zone: 'NCT2', existingLocationId: 'krakow-airport', daily: true },
];
const errors = [];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function setup(width) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  const snapshot = await (await context.request.get(`${origin}/policy-snapshot.json`)).json();
  const workspace = { snapshot: { ...snapshot, baseline: { ...snapshot.baseline, filename: 'old-active.xlsx' } }, draft: null, preview: null, history: [], status: {}, capabilities: { publish: true, sharedDraft: true } };
  const checks = []; const searches = []; const publications = [];
  const handlers = {
    check: input => input.locationAdditions ? { json: validated } : { json: discovery },
    search: () => ({ json: { candidates: [{ placeId: 5002, label: 'Katowice Dworzec PKP', city: 'Katowice', kind: 'city' }] } }),
    publish: () => ({ json: { revision: 'published', sha256: 'checked-file' } }),
  };
  await page.route('**/api/workspace', route => route.fulfill({ json: workspace }));
  for (const [path, name, requests] of [['baseline/check', 'check', checks], ['locations/search', 'search', searches], ['baseline/publish', 'publish', publications]]) {
    await page.route(`**/api/${path}`, async route => {
      assert.equal(route.request().method(), 'POST');
      assert.equal(route.request().headers()['x-panel-request'], '1');
      const input = route.request().postDataJSON();
      requests.push(input);
      await route.fulfill(await handlers[name](input));
    });
  }
  await page.goto(origin);
  await page.getByRole('button', { name: 'Plik bazowy', exact: true }).click();
  return { context, page, workspace, checks, searches, publications, handlers };
}

const publishButton = page => page.getByRole('button', { name: 'Ustaw jako bazę', exact: true });
async function cannotPublish(page) {
  const button = publishButton(page);
  assert.ok(await button.count() === 0 || await button.isDisabled(), 'Unchecked or incomplete input must never allow publication');
}
async function discover(page) {
  await page.getByLabel('Nowy plik bazowy').setInputFiles(file);
  const response = page.waitForResponse(response => response.url().endsWith('/api/baseline/check'));
  await page.getByRole('button', { name: 'Sprawdź plik', exact: true }).click();
  await response;
  await page.getByRole('group', { name: 'Strefa NCT1', exact: true }).waitFor();
  assert.equal(await page.getByRole('group', { name: 'Strefa NCT1', exact: true }).count(), 1, 'Discovery must show an inline assignment for every unknown zone');
  await page.getByText('Obecna baza pozostaje aktywna.', { exact: true }).waitFor();
}
async function configure(page) {
  await page.getByLabel('Powiązanie NCT2', { exact: true }).selectOption('existing:katowice-city');
  assert.equal(await page.getByLabel('Codzienny scraper NCT2', { exact: true }).isChecked(), false, 'An existing point retains its current daily flag');
  assert.equal(await page.getByLabel('Codzienny scraper NCT2', { exact: true }).isEnabled(), true);
  await page.getByLabel('Powiązanie NCT2', { exact: true }).selectOption('existing:krakow-airport');
  const daily = page.getByLabel('Codzienny scraper NCT2', { exact: true });
  assert.equal(await daily.isChecked(), true);
  assert.equal(await daily.isDisabled(), true, 'Existing daily locations cannot be disabled');
  assert.match(await page.getByLabel('Źródło narzutów NCT2', { exact: true }).inputValue(), /KRLO/);
  assert.equal(await page.getByLabel('Źródło narzutów NCT2', { exact: true }).getAttribute('readonly'), '');
  await cannotPublish(page);
  assert.equal(await page.getByRole('button', { name: 'Sprawdź konfigurację', exact: true }).isDisabled(), true);
  await page.getByLabel('Powiązanie NCT1', { exact: true }).selectOption('new');
  assert.equal(await page.getByLabel('Codzienny scraper NCT1', { exact: true }).isChecked(), true);
  assert.equal(await page.getByLabel('Źródło narzutów NCT1', { exact: true }).inputValue(), '', 'A new point has no implicit donor');
  await page.getByLabel('Szukana lokalizacja NCT1', { exact: true }).fill('Katowice dworzec');
  await cannotPublish(page);
  await page.getByRole('button', { name: 'Szukaj lokalizacji NCT1', exact: true }).click();
  assert.equal(await page.getByLabel('Wynik wyszukiwania NCT1', { exact: true }).inputValue(), '', 'A search result must be explicitly selected');
  await page.getByLabel('Wynik wyszukiwania NCT1', { exact: true }).selectOption('5002');
  assert.equal(await page.getByRole('button', { name: 'Sprawdź konfigurację', exact: true }).isDisabled(), true);
  await page.getByLabel('Źródło narzutów NCT1', { exact: true }).selectOption('KATC');
}
async function validate(page) {
  await page.getByRole('button', { name: 'Sprawdź konfigurację', exact: true }).click();
  await publishButton(page).waitFor();
  assert.equal(await publishButton(page).isEnabled(), true);
}
async function screenshot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `Onboarding overflow: ${name}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  await rendered(page);
  await page.screenshot({ path: fileURLToPath(new URL(`${name}.png`, output)), fullPage: true });
}
async function rendered(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

try {
  for (const width of [1440, 390]) {
    const { context, page, checks, searches, publications } = await setup(width);
    try {
      await discover(page);
      assert.equal(await page.getByRole('alert').count(), 0, 'Discovery is not a global error');
      assert.equal(checks[0].locationAdditions, undefined);
      await cannotPublish(page);
      await configure(page);
      assert.deepEqual(searches, [{ query: 'Katowice dworzec' }]);
      await screenshot(page, `configured-${width}`);
      await validate(page);
      assert.deepEqual(checks.at(-1).locationAdditions, expectedAssignments);
      const review = page.getByRole('region', { name: 'Zweryfikowane lokalizacje', exact: true });
      await review.getByText('Katowice Pyrzowice Lotnisko', { exact: true }).waitFor();
      assert.match(await review.innerText(), /Katowice/);
      assert.match(await review.innerText(), /ogólne zasady dla klas, z rozróżnieniem lotnisko\/miasto/);
      assert.match(await review.innerText(), /nie kopiuje lokalnych minimów ani wyjątków/);
      for (const band of Object.keys(bands)) assert.ok((await review.innerText()).includes(band));
      for (const amount of Object.values(bands)) assert.ok((await review.innerText()).includes(`${amount} PLN`), `Missing verified markup ${amount}`);
      assert.equal(await page.getByLabel('Ten plik jest już wgrany do DiscoverCars', { exact: true }).isChecked(), true);
      await screenshot(page, `verified-${width}`);
      if (width === 390) {
        await page.setViewportSize({ width: 320, height: 960 });
        await screenshot(page, 'verified-320');
      }
      await page.getByLabel('Codzienny scraper NCT1', { exact: true }).uncheck();
      await cannotPublish(page);
      assert.equal(await review.count(), 0, 'Editing removes the checked summary');
      await page.getByLabel('Codzienny scraper NCT1', { exact: true }).check();
      await validate(page);
      page.once('dialog', dialog => dialog.dismiss());
      await publishButton(page).click();
      assert.equal(publications.length, 0);
      page.once('dialog', dialog => dialog.accept());
      await publishButton(page).click();
      await page.getByRole('status').filter({ hasText: 'Nowa baza zapisana na GitHubie' }).waitFor();
      assert.equal(publications.length, 1);
      assert.deepEqual(publications[0], { filename: file.name, content: file.buffer.toString('base64'), locationAdditions: expectedAssignments, sourceRevision: 'source-validated', previousSha256: 'old-file', checkedSha256: 'checked-file', checkedOnboardingHash: 'checked-onboarding', importConfirmed: true });
    } finally { await context.close(); }
  }

  const { context, page, handlers, publications, searches } = await setup(1440);
  try {
    await discover(page);
    await configure(page);
    handlers.check = () => ({ json: { ...validated, onboardingHash: undefined } });
    await page.getByRole('button', { name: 'Sprawdź konfigurację', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Nie potwierdzono konfiguracji lokalizacji' }).waitFor();
    await cannotPublish(page);
    handlers.check = () => ({ status: 422, json: { error: 'Brak potwierdzonego punktu w konfiguracji.' } });
    await page.getByRole('button', { name: 'Sprawdź konfigurację', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Brak potwierdzonego punktu' }).waitFor();
    assert.equal(await page.getByRole('group', { name: 'Strefa NCT1', exact: true }).count(), 1, 'A failed configuration check retains the wizard');
    await page.getByText('old-active.xlsx', { exact: true }).waitFor();
    await cannotPublish(page);

    const pending = deferred();
    handlers.check = async () => { await pending.promise; return { json: validated }; };
    await page.getByRole('button', { name: 'Sprawdź konfigurację', exact: true }).click();
    await page.getByLabel('Źródło narzutów NCT1', { exact: true }).selectOption('KRLO');
    const stale = page.waitForResponse(response => response.url().endsWith('/api/baseline/check'));
    pending.resolve(); await stale; await rendered(page);
    await cannotPublish(page);
    handlers.check = () => ({ json: validated });
    await page.getByLabel('Źródło narzutów NCT1', { exact: true }).selectOption('KATC');
    await validate(page);
    handlers.publish = () => ({ status: 409, json: { error: 'Konfiguracja źródłowa zmieniła się.' } });
    page.once('dialog', dialog => dialog.accept());
    await publishButton(page).click();
    await page.getByRole('alert').filter({ hasText: 'Konfiguracja źródłowa zmieniła się.' }).waitFor();
    await page.getByText('old-active.xlsx', { exact: true }).waitFor();
    await cannotPublish(page);
    handlers.publish = () => ({ json: { revision: 'published', sha256: 'checked-file' } });
    await validate(page);
    await page.getByLabel('Szukana lokalizacja NCT1', { exact: true }).fill('Katowice nowe');
    await cannotPublish(page);
    assert.equal(await page.getByRole('button', { name: 'Sprawdź konfigurację', exact: true }).isDisabled(), true, 'Changing a query invalidates its selected candidate');
    assert.equal(searches.length, 1, 'Typing never triggers a location search');

    const searchPending = deferred();
    handlers.search = async () => { await searchPending.promise; return { json: { candidates: [{ placeId: 'stale-place', label: 'Stary wynik', city: 'Katowice', kind: 'city' }] } }; };
    await page.getByRole('button', { name: 'Szukaj lokalizacji NCT1', exact: true }).click();
    await page.getByLabel('Szukana lokalizacja NCT1', { exact: true }).fill('Inne miasto');
    const staleSearch = page.waitForResponse(response => response.url().endsWith('/api/locations/search'));
    searchPending.resolve(); await staleSearch; await rendered(page);
    assert.equal(await page.getByRole('option', { name: /Stary wynik/ }).count(), 0);
    await cannotPublish(page);

    handlers.search = () => ({ status: 502, json: { error: 'Wyszukiwarka chwilowo niedostępna.' } });
    await page.getByRole('button', { name: 'Szukaj lokalizacji NCT1', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Wyszukiwarka chwilowo niedostępna.' }).waitFor();
    await page.getByText('old-active.xlsx', { exact: true }).waitFor();
    assert.equal(publications.length, 1, 'Only the rejected publication was attempted');

    const filePending = deferred();
    handlers.check = async () => { await filePending.promise; return { json: { summary, sourceRevision: 'stale-source', previousSha256: 'old-file' } }; };
    await page.getByLabel('Nowy plik bazowy').setInputFiles(file);
    await page.getByRole('button', { name: 'Sprawdź plik', exact: true }).click();
    await page.getByLabel('Nowy plik bazowy').setInputFiles({ ...file, name: 'different.xlsx', buffer: Buffer.from('PK different') });
    const staleFile = page.waitForResponse(response => response.url().endsWith('/api/baseline/check'));
    filePending.resolve(); await staleFile; await rendered(page);
    await cannotPublish(page);

    handlers.check = () => ({ json: { summary, sourceRevision: 'no-new-source', previousSha256: 'old-file' } });
    await page.getByRole('button', { name: 'Sprawdź plik', exact: true }).click();
    await publishButton(page).waitFor();
    assert.equal(await page.getByLabel('Ten plik jest już wgrany do DiscoverCars', { exact: true }).isChecked(), true);
    page.once('dialog', dialog => dialog.accept());
    await publishButton(page).click();
    await page.getByRole('status').filter({ hasText: 'Nowa baza zapisana na GitHubie' }).waitFor();
    assert.equal(publications.length, 2);
    assert.equal(publications[1].filename, 'different.xlsx');
    assert.equal(publications[1].locationAdditions, undefined, 'Known-zone upload keeps the existing request shape');
    assert.equal(publications[1].checkedOnboardingHash, undefined);
  } finally { await context.close(); }
  assert.deepEqual(errors, []);
  console.log('Location onboarding UI PASS: desktop/mobile, exact assignments and hash, invalidation, stale responses, failed checks/searches, unchanged active base and known-zone upload.');
} finally { await browser.close(); }
