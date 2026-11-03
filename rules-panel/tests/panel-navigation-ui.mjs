import assert from 'node:assert/strict';
import { chromium } from '../../node_modules/playwright/index.mjs';
const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});
const page=await browser.newPage();
page.setDefaultTimeout(5000);
try {
  await page.route('**/api/workspace',r=>r.fulfill({status:404,json:{}}));
  await page.goto(origin);
  await page.getByRole('navigation',{name:'Panel DiscoverCars'}).waitFor();
  assert.deepEqual(await page.locator('nav[aria-label="Panel DiscoverCars"] button').allTextContents(),
    ['Pulpit','Ceny i rynek','Zasady cenowe','Baza i lokalizacje']);
  await page.getByRole('heading',{name:'Pulpit',exact:true}).waitFor();
  await page.getByRole('button',{name:'Zasady cenowe',exact:true}).click();
  await page.getByRole('tab',{name:'Klasy pojazdów',exact:true}).click();
  await page.getByRole('switch',{name:'Rekomendacje dla CDMV'}).waitFor();
  await page.getByRole('tab',{name:'Sprawdź minimum i ochronę',exact:true}).click();
  await page.getByText('Obowiązujące minimum',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:/Zmiany do publikacji:/}).count(),0);
  await page.goto(`${origin}/?view=sources`);
  await page.getByRole('heading',{name:'Pulpit',exact:true}).waitFor();
  await page.getByText('Konfiguracja techniczna',{exact:true}).click();
  assert.doesNotMatch(await page.locator('main').innerText(),/Invalid Date/);
  const snapshot=await(await page.request.get(`${origin}/policy-snapshot.json`)).json();
  await page.unroute('**/api/workspace');
  await page.route('**/api/workspace',r=>r.fulfill({json:{snapshot,capabilities:{sharedDraft:true,publish:true},draft:null,status:{},history:[
    {revision:'saved',action:'save',at:'2026-11-03T09:00:00Z',reason:'Praca nad szkicem'},
    {revision:'published',action:'publish',at:'2026-11-03T09:05:00Z',reason:'Zatwierdzone minimum',changes:[{path:'pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.airport',before:35,after:30}]},
    {revision:'pending',action:'approval_pending',at:'2026-11-03T09:04:00Z',reason:'Zatwierdzanie'},
  ]}}));
  await page.goto(`${origin}/?view=history`);
  await page.getByRole('heading',{name:'Opublikowane zmiany',exact:true}).waitFor();
  assert.equal(await page.locator('.history-list > li').count(),1);
  await page.getByText('Co zmieniono · 1 pól',{exact:true}).click();
  assert.deepEqual(await page.locator('.history-diff tbody tr > *').allTextContents(),['Minimum lotniska (PLN/dobę)','35','30']);
  await page.getByLabel('Pokaż również szkice i kroki techniczne').check();
  assert.equal(await page.locator('.history-list > li').count(),3,'Full technical audit remains available');
  assert.equal(await page.locator('nav [aria-current="page"]').innerText(),'Zasady cenowe');
  await page.getByRole('button',{name:'Pulpit',exact:true}).click();
  await page.goBack();
  await page.getByRole('heading',{name:'Historia zmian',exact:true}).waitFor();
  console.log('Panel navigation PASS: four sections, legacy links, rule tools, no empty publish action.');
} finally {await browser.close();}
