import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from '../../node_modules/playwright/index.mjs';
import {strToU8} from 'fflate';
import {loadPriceContext,loadPriceSource} from '../server/reports.mjs';
import {openMarketFilters} from './market-ui-controls.mjs';

const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage(),errors=[],writes=[],priceRequests=[];
page.on('pageerror',e=>errors.push(e.message));
context.on('request',r=>{if(r.method()==='POST')writes.push(r.url());if(/\/api\/report\/(prices|price-source)\?/.test(r.url()))priceRequests.push(r.url());});
const price=value=>`${value.toFixed(2).replace('.',',')} PLN/d`;
const values=(mm,competitor)=>['Flex To Go (8)','',price(competitor),'','','MM Cars Rental (8)','',price(mm),'Kaizen','',price(140),price(mm),'',mm<competitor?'Top 1':'Top 2','5','',false];
const scenarios=Array.from({length:15},(_,i)=>[2,3,4,10,14].map(duration=>({date:`2026-11-${String(i+5).padStart(2,'0')}`,duration:String(duration),rows:[
 ['Krakow Airport (KRK)','airport',values(60,duration===3?89.99:duration===4?55:90),values(60,95)],
 ['Warsaw Downtown','branch',values(80,125),values(80,100)]
],errors:[]}))).flat();
const bytes=strToU8(`<script type="application/json" id="report-data">${JSON.stringify({scenarios})}</script>`);
const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
const manifest={run_id:'123',git_sha:'a'.repeat(40),generated_at:'2026-11-04T09:00:00Z',source_started_at:'2026-11-04T08:00:00Z',start_dates:[...new Set(scenarios.map(r=>r.date))],durations:[2,3,4,10,14],status:'failure',report_html_sha256:hash};
const repository={json:async()=>({locations:[{zones:['KRLO'],scraper_label:'Krakow Airport (KRK)'},{zones:['WA1'],scraper_label:'Warsaw Downtown'}]})};
const fetcher=async url=>url.endsWith('run-manifest.json')?Response.json(manifest):new Response(bytes);
try {
 await page.clock.setFixedTime(new Date('2026-11-04T10:00:00Z'));
 const snapshot=await(await context.request.get(`${origin}/policy-snapshot.json`)).json();
 const meta=await loadPriceContext({mode:'market',reportRunId:'123'},repository,fetcher);
 await context.route('**/api/workspace',r=>r.fulfill({json:{snapshot,capabilities:{sharedDraft:true,publish:true},draft:null,history:[],status:{report:meta.report,excel:null,links:{report:'/api/report/open?runId=123'}}}}));
 await context.route(/\/api\/report\/(prices|price-source)\?/,async route=>{
  const query=Object.fromEntries(new URL(route.request().url()).searchParams);assert.equal(query.mode,'market');
  const body=query.kind?await loadPriceSource(query,repository,fetcher):JSON.stringify(await loadPriceContext(query,repository,fetcher));
  return route.fulfill({body:typeof body==='string'?body:Buffer.from(body),contentType:query.kind?'application/octet-stream':'application/json'});
 });
 await context.route('**/api/calendar-events',r=>r.fulfill({json:{items:[]}}));
 await page.goto(`${origin}/?view=prices`);
 await page.locator('.attention-map tbody tr').first().waitFor();
 // Leave unrelated filters behind, then verify the dashboard drill-down replaces them.
 await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption('Krakow Airport (KRK)');
 await page.locator('.range-picker summary').click();
 await page.getByLabel('Start od',{exact:true}).fill('2026-11-18');
 await page.getByLabel('Start do',{exact:true}).fill('2026-11-19');
 await page.getByRole('button',{name:'Pulpit',exact:true}).click();
 const card=page.locator('.dashboard-metric').filter({hasText:'Top1 z zapasem'});
 assert.equal(await card.locator('strong').innerText(),'104');
 const requestCount=priceRequests.length;
 await card.click();
 assert.equal(await page.getByRole('combobox',{name:'Pokaż',exact:true}).inputValue(),'reserve');
 const list=page.getByRole('region',{name:'Top1 z zapasem ≥30 PLN/d'});
 await list.waitFor();
 assert.match(await list.innerText(),/104 scenariusze/);
 assert.equal(await page.getByRole('combobox',{name:'Skrzynia',exact:true}).inputValue(),'automatic');
 assert.equal(await page.getByLabel('Start od',{exact:true}).inputValue(),'2026-11-04');
 assert.equal(await page.getByLabel('Start do',{exact:true}).inputValue(),'2026-11-17');
 assert.equal(await page.getByRole('group',{name:'Pasmo mapy'}).count(),0);
 assert.equal(await list.locator('tbody tr').count(),20);
 assert.match(await list.locator('tbody tr').first().innerText(),/Warszawa.*45,00/s);
 await list.getByRole('button',{name:'Pokaż kolejne 20',exact:true}).click();
 assert.equal(await list.locator('tbody tr').count(),40);
 await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption('Krakow Airport (KRK)');
 assert.match(await list.innerText(),/39 scenariuszy/);
 assert.equal(await list.locator('tbody tr').count(),20,'Changing branch resets pagination');
 await list.getByRole('button',{name:'Pokaż kolejne 20',exact:true}).click();
 assert.equal(await list.locator('tbody tr').count(),39);
 const rows=await list.locator('tbody tr').allTextContents();
 assert.ok(rows.every(row=>row.includes('30,00')&&!row.includes('29,99')),'Include exactly 30, exclude 29.99');
 assert.ok(rows.some(row=>row.includes('10 dni'))&&rows.some(row=>row.includes('14 dni')),'Do not restrict results to the map band');
 assert.ok(rows.every(row=>!row.includes('18.11.2026')&&!row.includes('19.11.2026')),'Keep the dashboard window, not the previous market range');
 await list.getByRole('button',{name:/Sprawdź scenariusz/}).first().click();
 await page.getByRole('dialog').waitFor();
 assert.match(await page.locator('.market-detail').innerText(),/60,00.*90,00/s);
 await page.getByRole('button',{name:'Zamknij szczegóły',exact:true}).click();
 await page.getByRole('button',{name:'Pulpit',exact:true}).click();
 await page.getByRole('group',{name:'Skrzynia na Pulpicie'}).getByRole('button',{name:'Wszystkie auta',exact:true}).click();
 assert.equal(await card.locator('strong').innerText(),'65');
 await card.click();
 assert.match(await list.innerText(),/65 scenariuszy/);
 assert.equal(await page.getByRole('combobox',{name:'Skrzynia',exact:true}).inputValue(),'all');
 await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption('Warsaw Downtown');
 assert.match(await list.innerText(),/Brak scenariuszy/);
 await page.getByRole('combobox',{name:'Oddział',exact:true}).selectOption('*');
 await mkdir('../output/playwright/reserve-drilldown',{recursive:true});
 for(const width of [1440,1024,390,320]){
  await page.setViewportSize({width,height:1000});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`reserve list overflow ${width}`);
  await page.screenshot({path:`../output/playwright/reserve-drilldown/list-${width}.png`,fullPage:true});
 }
 await openMarketFilters(page);
 await page.getByRole('combobox',{name:'Pokaż',exact:true}).selectOption('all');
 await page.locator('.attention-map').waitFor();
 assert.equal(await list.count(),0,'Can return to the unchanged band map');
 await page.setViewportSize({width:1440,height:1000});
 await page.getByRole('tab',{name:'Stawki Top1',exact:true}).click({timeout:4000});
 const comparison=page.getByRole('table',{name:'Porównanie stawek Top1'});
 await page.getByRole('button',{name:'Kolejne daty',exact:true}).click();
 assert.match(await comparison.locator('tbody tr').first().innerText(),/11.11.2026/);
 await page.getByRole('group',{name:'Długości najmu'}).getByRole('button',{name:'4 d',exact:true}).click();
 await page.locator('.range-picker summary').click();
 await page.getByLabel('Start od',{exact:true}).fill('2026-11-05');
 await page.getByLabel('Start do',{exact:true}).fill('2026-11-05');
 await page.locator('.range-picker summary').click();
 assert.equal(await comparison.locator('tbody tr').count(),2);
 assert.equal(await comparison.getByRole('columnheader').count(),3);
 assert.match(await comparison.locator('tbody tr').first().innerText(),/60,00.*80,00/s);
 await page.getByRole('combobox',{name:'Skrzynia',exact:true}).selectOption('automatic');
 assert.match(await comparison.locator('tbody tr').last().innerText(),/55,00.*Flex To Go.*80,00/s);
 const fiveDays=page.getByRole('group',{name:'Długości najmu'}).getByRole('button',{name:'5 d',exact:true});
 await fiveDays.click();
 assert.match(await comparison.locator('tbody tr').last().innerText(),/5 dni.*Brak danych.*Brak danych/s);
 await fiveDays.click();
 await page.locator('.top-one-locations summary').click();
 await page.getByRole('checkbox',{name:/Warszawa · Miasto/}).uncheck();
 assert.equal(await comparison.getByRole('columnheader').count(),2);
 await page.getByRole('checkbox',{name:/Warszawa · Miasto/}).check();
 await page.locator('.top-one-locations summary').click();
 for(const width of [1440,390,320]){
  await page.setViewportSize({width,height:844});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`Top1 comparison overflow ${width}`);
  await page.screenshot({path:`../output/playwright/reserve-drilldown/top-one-${width}.png`});
 }
 assert.equal(priceRequests.length,requestCount,'Drill-down and details reuse loaded report; no extra price API requests');
 assert.deepEqual(writes,[]);assert.deepEqual(errors,[]);
 console.log('Reserve and Top1 comparison UI passed: dates, transmission, durations, multiple branches, prices, missing data, pagination, responsive widths, no writes or extra price requests.');
} finally {await browser.close();}
