import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {chromium} from '../../node_modules/playwright/index.mjs';
const before=process.argv.includes('--before'),origin=process.env.PANEL_URL??'http://127.0.0.1:4318';
const browser=await chromium.launch(),page=await browser.newPage();page.on('pageerror',e=>console.error(e.message));
const snapshot=await(await page.request.get(`${origin}/policy-snapshot.json`)).json();
const model=structuredClone(snapshot.documents);model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.airport+=1;
const workspace={snapshot,draft:{revision:'a',model},history:[],capabilities:{sharedDraft:true,publish:false,preview:true},status:{available:false},preview:{draftRevision:'a',status:'success',dataCollectedAt:'2026-11-04T08:37:00Z',impact:{increasedRateCells:14411,decreasedRateCells:2,unchangedRateCells:1000,samples:[{position:{zone:'KRLO',group:'CDMV',pickupDate:'2026-12-20',durationBand:'3-4'},beforeRate:30,afterRate:50}]}}};
await page.route('**/api/workspace',r=>r.fulfill({json:workspace}));
const dir=new URL(`../docs/rules-followup/${before?'before':'after'}/`,import.meta.url);await mkdir(dir,{recursive:true});
const shot=(name,w)=>page.screenshot({path:fileURLToPath(new URL(`${name}-${w}.png`,dir))});
try{for(const width of [1440,390]){
 await page.setViewportSize({width,height:width===1440?1000:844});await page.goto(`${origin}/?view=rules`);await page.locator('.rule-family').first().waitFor();await shot('list',width);
 const family=page.locator('.rule-family').filter({has:page.locator('summary',{hasText:'FVMD:'})}).first();await family.locator('summary').click();await family.scrollIntoViewIfNeeded();await shot('family',width);
 if(!before&&width===1440){for(const col of ['rate-cell','dates-cell']){const a=await page.locator(`article.rule-row .${col}`).first().boundingBox(),b=await family.locator(`summary .${col}`).boundingBox();assert.ok(Math.abs(a.x-b.x)<2,`${col} aligned`);}}
 await page.getByRole('button',{name:'Kalendarz',exact:true}).click();await page.locator('.rule-calendar-view').waitFor();await page.locator('.rule-calendar-view select').nth(1).selectOption('FVMD');
 if(before)await page.getByLabel('Miesiąc',{exact:true}).fill('2026-12');else{await page.getByRole('button',{name:'Następny miesiąc',exact:true}).click();await page.getByText('grudzień 2026',{exact:true}).waitFor();}
 const cell=page.locator('.rule-calendar button').filter({hasText:/^20/});await cell.click();
 if(!before){assert.match(await cell.innerText(),/600/);assert.match(await cell.getAttribute('aria-label'),/chroniona data, minimum 600 PLN/);assert.equal(await cell.locator('svg').count(),1);assert.equal(await page.locator('.exception-day').filter({hasText:'—'}).count(),0);}
 await page.locator('.rule-calendar-view').scrollIntoViewIfNeeded();await shot('calendar',width);
 await page.goto(`${origin}/?view=review`);await page.locator('.impact-review').waitFor();
 if(!before){await page.getByText('Próbka:',{exact:false}).waitFor();const text=(await page.locator('.impact-review').innerText()).replaceAll('\u00a0',' ');assert.match(text,/14 411/);assert.match(text,/3–4/);assert.match(text,/Excel z 04.11.2026, 09:37/);assert.match(text,/Kraków/);}
 await shot('review',width);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(before&&width===390){await page.locator('.warning-list').scrollIntoViewIfNeeded();await shot('warnings',width);await page.setViewportSize({width:1440,height:1000});await page.locator('.warning-list').scrollIntoViewIfNeeded();await shot('warnings',1440);}
 if(!before&&width===390){await page.getByText('Znane nakładania: droższe dłuższe pasma',{exact:false}).waitFor({timeout:240000});const warnings=page.getByRole('region',{name:'Minima według długości najmu',exact:true});await warnings.locator('details summary').click();await warnings.scrollIntoViewIfNeeded();await shot('warnings',width);await page.setViewportSize({width:1440,height:1000});await warnings.scrollIntoViewIfNeeded();await shot('warnings',1440);}
}}catch(e){console.error((await page.locator('main').innerText()).slice(0,5000));throw e;}finally{await browser.close();}console.log('Rules follow-up UI PASS');
