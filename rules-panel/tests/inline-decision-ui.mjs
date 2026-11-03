import assert from 'node:assert/strict';
import {chromium} from '../../node_modules/playwright/index.mjs';
import {priceFixture} from './price-fixture.mjs';
const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});
try {
 const context=await browser.newContext({viewport:{width:1440,height:1000}});
 const page=await context.newPage();page.setDefaultTimeout(15000);
 await page.clock.setFixedTime(new Date('2026-11-03T13:00:00Z'));
 const errors=[],writes=[];let reads=0;
 page.on('pageerror',e=>errors.push(e.message));
 context.on('request',r=>{if(r.method()==='POST')writes.push(r.url());});
 const snapshot=await(await context.request.get(`${origin}/policy-snapshot.json`)).json();
 const proof=await priceFixture(),transport=await priceFixture({transportOnly:true});
 const workspace={snapshot,capabilities:{publish:false},history:[],draft:null,status:{report:proof.report,excel:proof.excel}};
 await context.route('**/api/workspace',r=>r.fulfill({json:workspace}));
 let fail=false,release=null,held=false,heldDone;
 await context.route(/\/api\/report\/(prices|price-source)\?/,async route=>{
   reads++;const q=new URL(route.request().url()).searchParams;
   if(fail&&q.get('mode')!=='market')return route.fulfill({status:502,json:{error:'Test: Excel niedostępny'}});
   let finish;
   if(held&&q.get('group')==='CDMV'){held=false;heldDone=new Promise(resolve=>{finish=resolve;});await new Promise(resolve=>{release=resolve;});}
   const response=await transport(route.request().url());
   await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
   finish?.();
 });
 await page.goto(`${origin}/?view=results`);
 await page.locator('.operations-dashboard').waitFor();
 assert.equal(reads,0,'Compact dashboard does not download entire market dataset');
 await page.getByRole('button',{name:'Przejrzyj ceny',exact:true}).click();
 await page.getByRole('button',{name:'Sprawdź oddział',exact:true}).waitFor();
 await page.getByRole('tab',{name:'Wykres',exact:true}).click();
 await page.getByRole('button',{name:'04.11.2026, MM 80,00 PLN, konkurencja 74,00 PLN',exact:true}).click();
 const detail=page.locator('.inline-decision');
 await detail.getByText('Zapisana decyzja',{exact:true}).waitFor();
 assert.match(await detail.innerText(),/65,00/);assert.match(await detail.innerText(),/63,00/);assert.match(await detail.innerText(),/30,00/);
 for(const width of [1440,390,320]){
   await page.setViewportSize({width,height:1000});
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`detail overflow ${width}`);
   assert.equal(await page.locator('.market-detail').evaluate(e=>e.scrollWidth<=e.clientWidth+1),true,`dialog overflow ${width}`);
   await page.screenshot({path:`../output/inline-decision-${width}.png`,fullPage:true});
 }
 await detail.getByLabel('Klasa w Excelu').selectOption('EDMV');
 await detail.getByText('Brak zapisanego uzasadnienia dla tej pozycji.',{exact:true}).waitFor();
 assert.doesNotMatch(await detail.innerText(),/Zapisana decyzja|63,00|65,00/,'Previous class evidence is removed');
 held=true;
 await detail.getByLabel('Klasa w Excelu').selectOption('CDMV');
 // A class change while an old response is still pending must not restore old evidence.
 await page.waitForFunction(()=>document.querySelector('.inline-decision [role=status]'));
 await detail.getByLabel('Klasa w Excelu').selectOption('EDMV');
 await detail.getByText('Brak zapisanego uzasadnienia dla tej pozycji.',{exact:true}).waitFor();
 assert.ok(release,'Old class request was held');release();await heldDone;
 assert.doesNotMatch(await detail.innerText(),/Zapisana decyzja|63,00/);
 fail=true;
 await detail.getByLabel('Klasa w Excelu').selectOption('CDMV');
 await detail.getByRole('alert').filter({hasText:'Test: Excel niedostępny'}).waitFor();
 fail=false;await detail.getByRole('button',{name:'Ponów',exact:true}).click();
 await detail.getByText('Zapisana decyzja',{exact:true}).waitFor();
 assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
 console.log('Inline evidence PASS: pinned Excel, base/import/minimum, class switch, stale response, read failure/retry, 3 widths, no writes.');
} finally {await browser.close();}
