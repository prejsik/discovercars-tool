import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from '../../node_modules/playwright/index.mjs';
import {compactFixture} from './market-compact-fixture.mjs';

const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const before=process.argv.includes('--before');
const directory=`docs/market-compact/verification/${before?'before':'after'}`;
await mkdir(directory,{recursive:true});
const browser=await chromium.launch({headless:true});
const errors=[],writes=[],reads=[];
const failures=[];
function verify(name,fn){if(before)return;try{fn();}catch(error){failures.push(`${name}: ${error.message}`);}}
try {
 const page=await browser.newPage({viewport:{width:1440,height:1000}});page.setDefaultTimeout(15000);
 await page.clock.setFixedTime(new Date('2026-11-03T13:00:00Z'));
 page.on('pageerror',error=>errors.push(error.message));
 page.on('request',r=>{if(r.method()==='POST')writes.push(r.url());if(r.url().includes('/api/report/'))reads.push(r.url());});
 const snapshot=await(await page.request.get(origin+'/policy-snapshot.json')).json();
 const fixture=await compactFixture(snapshot);
 await page.route('**/api/workspace',r=>r.fulfill({json:{snapshot,draft:null,history:[],capabilities:{sharedDraft:true,publish:true},status:{report:fixture.meta.report,excel:fixture.meta.excel}}}));
 await page.route('**/api/calendar-events',r=>r.fulfill({json:{items:[],revision:0}}));
 await page.context().route(/\/api\/report\/(prices|price-source)\?/,async r=>{
  const response=await fixture.transport(r.request().url());
  await r.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
 });
 async function filters(){const toggle=page.getByRole('button',{name:/^Filtry rynku:/});if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='false')await toggle.click();}
 async function collapse(){const toggle=page.getByRole('button',{name:/^Filtry rynku:/});if(await toggle.isVisible()&&await toggle.getAttribute('aria-expanded')==='true')await toggle.click();}
 async function screenshot(name){await page.evaluate(()=>window.scrollTo(0,0));await page.screenshot({path:`${directory}/${name}.png`});}
 for(const width of [1440,390]){
  await page.setViewportSize({width,height:width===390?844:1000});await page.goto(origin+'/?view=prices');
  await page.locator('.attention-map tbody tr').nth(24).waitFor();await page.evaluate(()=>document.fonts.ready);
  await screenshot(`map-${width}`);
  const geometry=await page.locator('.attention-map tbody tr').evaluateAll(rows=>rows.map(e=>e.getBoundingClientRect().height));
  verify('map rows 36-40px',()=>assert.ok(geometry.every(h=>h>=36&&h<=40),String(geometry)));
  const mapBox=await page.locator('.attention-map-scroll').boundingBox();
  verify('map in first viewport',()=>assert.ok(mapBox.y<(width===390?844:1000)-100));
  if(width===1440){const noScroll=await page.evaluate(()=>document.documentElement.scrollHeight<=innerHeight+1);verify('desktop page does not scroll',()=>assert.ok(noScroll));}
  const neutral=await page.locator('.map-cell.tone-neutral').allTextContents();
  verify('neutral cells use dot',()=>assert.ok(neutral.length&&neutral.every(t=>t==='·')));
  const title=await page.locator('.map-cell.tone-neutral').first().getAttribute('title');
  verify('exact neutral value in title',()=>assert.match(title??'',/0,4|0,3|2,4|2,3/));
  const aria=await page.locator('.map-cell.tone-neutral').first().getAttribute('aria-label');verify('neutral tooltip matches accessible label',()=>assert.equal(title,aria));
  const divider=await page.locator('.attention-map thead th').nth(8).evaluate(e=>getComputedStyle(e).borderLeftWidth);verify('week divider',()=>assert.equal(divider,'2px'));
  const weekend=await page.locator('.attention-map thead .weekend').first().evaluate(e=>getComputedStyle(e).backgroundColor);verify('weekend header background',()=>assert.notEqual(weekend,'rgba(0, 0, 0, 0)'));
  await filters();
  if(!before){
   const mapReads=reads.length;
   const options=await page.getByRole('combobox',{name:'Pokaż',exact:true}).locator('option').allTextContents();
   verify('two map filter options',()=>assert.deepEqual(options,['Wszystkie oddziały','Tylko z problemami']));
   await page.getByRole('combobox',{name:'Pokaż',exact:true}).selectOption('problems');
   const totals=await page.locator('.map-total').allTextContents();verify('filter uses map problems',()=>assert.ok(totals.length<25&&totals.every(t=>Number(t)>0)));
   await page.getByRole('combobox',{name:'Pokaż',exact:true}).selectOption('all');
   assert.equal(reads.length,mapReads,'Map filtering does not make API requests');
  }
  await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption('Krakow Airport (KRK)');
  await page.locator('#band-day-2026-11-04 .band-cell').nth(1).getByText('63,00',{exact:true}).waitFor();
  if(!before){
   assert.equal(await page.locator('.shared-market-filters').getByLabel('Klasa w tabeli').count(),1);
   await page.getByLabel('Klasa w tabeli').selectOption('EDMV');
   await page.locator('#band-day-2026-11-04 .band-cell').nth(1).getByText('73,00',{exact:true}).waitFor();
   await page.getByLabel('Klasa w tabeli').selectOption('CDMV');
   await page.getByRole('group',{name:'Kod w tabeli',exact:true}).getByRole('button',{name:'KRTI',exact:true}).click();
   await page.locator('#band-day-2026-11-04 .band-cell').nth(1).getByText('64,00',{exact:true}).waitFor();
   await page.getByRole('group',{name:'Kod w tabeli',exact:true}).getByRole('button',{name:'KRLO',exact:true}).click();
   await page.locator('#band-day-2026-11-04 .band-cell').nth(1).getByText('63,00',{exact:true}).waitFor();
  }
  await collapse();
  const matrixWidth=await page.locator('.band-matrix').evaluate(e=>e.getBoundingClientRect().width);
  await page.locator('#band-day-2026-11-04 .band-cell').nth(1).click();await page.locator('.band-detail').waitFor();
  await screenshot(`band-detail-${width}`);
  if(width===1440){
   const openedWidth=await page.locator('.band-matrix').evaluate(e=>e.getBoundingClientRect().width);
   verify('matrix does not shrink',()=>assert.ok(Math.abs(matrixWidth-openedWidth)<2,`${matrixWidth} -> ${openedWidth}`));
   const clipped=await page.locator('.band-cell').evaluateAll(cells=>cells.some(e=>e.scrollWidth>e.clientWidth+1));verify('no clipped cell labels',()=>assert.equal(clipped,false));
   const sticky=await page.locator('.band-date > th').first().evaluate(e=>getComputedStyle(e).position);verify('sticky first matrix column',()=>assert.equal(sticky,'sticky'));
   const firstColumn=await page.locator('.band-date > th').first().boundingBox();
   await page.locator('.band-matrix-scroll').evaluate(e=>{e.scrollLeft=200;});
   const scrolledColumn=await page.locator('.band-date > th').first().boundingBox();
   verify('first matrix column stays in place during scroll',()=>assert.ok(Math.abs(firstColumn.x-scrolledColumn.x)<1));
   await page.locator('.band-matrix-scroll').evaluate(e=>{e.scrollLeft=0;});
  }
  await page.getByRole('button',{name:'Zamknij szczegóły pasma'}).click();
  await page.getByRole('tab',{name:'Kalendarz cen',exact:true}).click();await screenshot(`calendar-${width}`);
  const headings=await page.locator('.calendar-section-heading h2').count();verify('single duration heading hidden',()=>assert.equal(headings,0));
  await filters();await page.getByRole('group',{name:'Długości najmu',exact:true}).getByRole('button',{name:'4 d',exact:true}).click();
  await page.locator('.calendar-section-heading h2').waitFor();
  await page.getByRole('group',{name:'Długości najmu',exact:true}).getByRole('button',{name:'4 d',exact:true}).click();await collapse();
  await page.getByRole('tab',{name:'Stawki w Excelu',exact:true}).click();
  const ownLocation=await page.locator('.prices-view').getByRole('combobox',{name:'Lokalizacja',exact:true}).count();verify('no duplicate location select',()=>assert.equal(ownLocation,0));
  if(before)await page.getByRole('button',{name:'Pokaż ceny',exact:true}).click();await page.locator('.prices-table tbody > tr').nth(13).waitFor();
  await screenshot(`excel-${width}`);
  const warnings=await page.getByText('Brak zapisanej prognozy dla klasy',{exact:true}).count();verify('one missing prediction notice',()=>assert.equal(warnings,1));
  if(width===1440){const heights=await page.locator('.prices-table tbody > tr').evaluateAll(rows=>rows.map(e=>e.getBoundingClientRect().height));verify('compact Excel rows',()=>assert.ok(heights.every(h=>h<=56),String(heights)));}
  if(!before){
   const matrixReads=()=>reads.filter(url=>new URL(url).searchParams.get('mode')==='matrix').length;
   const excelReads=matrixReads();
   await page.locator('.prices-view').getByRole('group',{name:'Kod w tabeli',exact:true}).getByRole('button',{name:'KRTI',exact:true}).click();
   assert.equal(await page.locator('.prices-table').count(),0,'A code change clears old code prices');
   await page.locator('.prices-table tbody tr').first().getByText('64,00',{exact:true}).waitFor();
   assert.equal(matrixReads(),excelReads,'Code selection does not fetch the hidden branch matrix');
  }
  if(!before){await filters();await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption('*');await page.getByText('Wybierz oddział u góry',{exact:true}).waitFor();assert.equal(await page.locator('.prices-table').count(),0);await collapse();}
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No page overflow '+width);
 }
 if(!before){
  for(const width of [1024,320]){
   await page.setViewportSize({width,height:1000});await page.getByRole('tab',{name:'Przegląd rynku',exact:true}).click();
   await filters();await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption(fixture.locations[0].scraper_label);await collapse();
   await page.locator('#band-day-2026-11-05 .band-cell').nth(1).getByText('brak MM',{exact:true}).waitFor();
   await page.locator('#band-day-2026-11-05 .band-cell').nth(1).click();await page.locator('.band-detail').waitFor();
   assert.equal(await page.locator('.band-cell').evaluateAll(cells=>cells.some(e=>e.scrollWidth>e.clientWidth+1)),false,'Full missing-MM labels at '+width);
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'No page overflow with detail '+width);
   assert.equal(await page.locator('.band-detail').evaluate(e=>e.matches(':modal')),width<1024);
   await page.getByRole('button',{name:'Zamknij szczegóły pasma'}).click();
  }
  await page.setViewportSize({width:1440,height:1000});
  await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption('*');
  await page.locator('.shared-market-filters .range-picker > summary').click();
  await page.locator('.shared-market-filters').getByLabel('Start do',{exact:true}).fill('2026-11-10');
  assert.equal(await page.locator('.attention-map thead th').count(),9);
  assert.notEqual(await page.locator('.attention-map thead th').last().evaluate(e=>getComputedStyle(e).borderLeftWidth),'2px','A seven-day range has no divider before the summary');
 }
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 assert.deepEqual(failures,[]);
 console.log(`${before?'BEFORE captures':'Compact market UI PASS'}: 8 screenshots, shared filters, exact rates, no writes.`);
} finally {await browser.close();}
