import assert from 'node:assert/strict';
import {chromium} from '../../node_modules/playwright/index.mjs';
import {priceFixture} from './price-fixture.mjs';
const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
 await page.clock.setFixedTime(new Date('2026-11-03T13:00:00Z'));
 const errors=[],writes=[],reads=[];page.on('pageerror',e=>errors.push(e.message));
 page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
 const snapshot=await(await page.request.get(origin+'/policy-snapshot.json')).json();
 const proof=await priceFixture(),transport=await priceFixture({transportOnly:true});
 await page.route('**/api/workspace',r=>r.fulfill({json:{snapshot,draft:null,history:[],capabilities:{publish:true},status:{report:proof.report,excel:proof.excel}}}));
 await page.context().route(/\/api\/report\/(prices|price-source)\?/,async r=>{
  reads.push(r.request().url());
  const response=await transport(r.request().url());
  await r.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
 await page.goto(origin+'/?view=prices');
 await page.locator('.attention-map').getByRole('button',{name:/04.11.2026: MM droższe/}).click();
 assert.equal(await page.locator('#band-day-2026-11-04.highlight-day').count(),1);
 await page.locator('.band-matrix').waitFor();
 assert.equal(await page.getByLabel('Oddziały przeglądu').count(),0);
 assert.equal(await page.getByRole('group',{name:'Skrzynia w przeglądzie'}).isVisible(),true);
 await page.getByRole('button',{name:'śr 04.11.2026 · 3–4 dni'}).getByText('63,00',{exact:true}).waitFor();
 await page.getByRole('button',{name:'śr 04.11.2026 · 3–4 dni'}).click();
 await page.locator('.band-detail').waitFor();
 assert.match(await page.locator('.band-key-rates').innerText(),/65,00.*63,00.*Minimum reguł teraz/s);
 await page.keyboard.press('ArrowDown');await page.getByRole('heading',{name:'cz 05.11 · pasmo 3–4 dni'}).waitFor();
 await page.keyboard.press('ArrowUp');await page.getByRole('heading',{name:'śr 04.11 · pasmo 3–4 dni'}).waitFor();
 for(const width of [1440,1024,390,320]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'band detail overflow '+width);
  assert.equal(await page.locator('.band-detail').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,'band dialog overflow '+width);
  if(width===1440||width===390)await page.screenshot({path:'docs/ui-redesign-3/verification/stage-3-'+width+'.png',fullPage:true});
 }
 await page.locator('.band-scenarios').getByRole('button',{name:'Szczegóły',exact:true}).click();
 await page.locator('.inline-decision').getByText('Zapisana decyzja',{exact:true}).waitFor();
 assert.equal(reads.filter(url=>url.includes('kind=workbook')).length,1,'Details reuse the matrix workbook');
 await page.getByRole('button',{name:'Zobacz aktualne reguły',exact:true}).click();
 await page.locator('.rule-context').waitFor();
 assert.equal(await page.locator('.rules-register').count(),0,'Only relevant rules, not a second full register');
 assert.match(await page.locator('.rule-context').innerText(),/CDMV.*KRLO.*04.11.2026.*3 dni/s);
 await page.locator('.context-rule').getByRole('button',{name:'Edytuj regułę',exact:true}).first().click();
 await page.getByRole('dialog').getByText(/Zmiana obejmie pełny zakres reguły/).waitFor();
 await page.getByRole('button',{name:'Zamknij edycję',exact:true}).click();
 await page.screenshot({path:'../output/matrix-rule-context.png',fullPage:true});
 await page.getByRole('button',{name:'Wróć do cen',exact:true}).click();
 await page.locator('.band-matrix').waitFor();
 for(const width of [1440,1024,390,320]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'matrix overflow '+width);
  await page.screenshot({path:'../output/matrix-'+width+'.png',fullPage:true});
 }
 await page.getByLabel('Klasa w tabeli').selectOption('EDMV');
 await page.getByRole('button',{name:'śr 04.11.2026 · 3–4 dni'}).getByText('Brak stawki',{exact:true}).waitFor();
 assert.doesNotMatch(await page.locator('.band-matrix').innerText(),/63,00/);
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 console.log('Matrix/rules UI PASS: exact band rates, visible filters, context preserved, full edit scope, responsive, class switch, no writes.');
} finally {await browser.close();}
