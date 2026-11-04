import assert from 'node:assert/strict';import {mkdir} from 'node:fs/promises';import {fileURLToPath} from 'node:url';import {chromium} from '../../node_modules/playwright/index.mjs';
const before=process.argv.includes('--before'),origin=process.env.PANEL_URL??'http://127.0.0.1:4317';const browser=await chromium.launch();
const dir=new URL(`../docs/baseline-followup/${before?'before':'after'}/`,import.meta.url);await mkdir(dir,{recursive:true});
try{for(const width of [1440,390]){
 const context=await browser.newContext({viewport:{width,height:width===1440?1000:844}}),page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const snapshot=await(await page.request.get(`${origin}/policy-snapshot.json`)).json();snapshot.baseline.coverage={rowCount:200,groups:['CDMV'],zones:['KRLO','LU1'],firstDate:'2026-11-05',lastDate:'2027-12-21'};
 const sha='b'.repeat(64),summary={sha256:sha,rowCount:200,groups:['CDMV'],zones:['KRLO'],firstDate:'2026-11-05',lastDate:'2027-12-21'};
 const workspace={snapshot,draft:null,history:[],capabilities:{sharedDraft:true,publish:true},status:{excel:{runId:'123',sourceStartedAt:'2026-11-04T08:37:00Z',generatedAt:'2026-11-04T10:00:00Z',files:{'rates-import-ready.xlsx':sha}},links:{import:'/import.xlsx'}}};
 await page.route('**/api/workspace',r=>r.fulfill({json:workspace}));let checks=0,publishes=0;
 await page.route('**/api/report-baseline/check',r=>{checks++;return r.fulfill({json:{summary,sourceRevision:'source',previousSha256:'old'}});});await page.route('**/api/report-baseline/publish',r=>{publishes++;return r.fulfill({json:{revision:'saved'}});});
 const onboarding={unknownZones:['NCT1'],locations:[{id:'krakow_airport',scraper_label:'Krakow Airport (KRK)',city:'Krakow',kind:'airport',zones:['KRLO'],daily:true}],markupSources:[{zone:'KRLO',label:'Krakow Airport',amounts:{'1':10,'2':10,'3-4':10,'5-7':10,'8-20':10,'21-35':10}}],addedLocations:[],ready:false};
 await page.route('**/api/baseline/check',r=>{const input=r.request().postDataJSON();return r.fulfill({json:{summary:{...summary,zones:['KRLO','NCT1']},sourceRevision:'source',previousSha256:'old',onboardingHash:input.locationAdditions?'hash':undefined,onboarding:{...onboarding,ready:Boolean(input.locationAdditions)}}});});
 const shot=name=>page.screenshot({path:fileURLToPath(new URL(`${name}-${width}.png`,dir))});
 await page.goto(`${origin}/?view=baseline`);await page.locator('.report-baseline').waitFor();await page.evaluate(()=>scrollTo(0,0));await shot('start');
 if(!before&&width===1440){const headings=page.locator('.baseline-options>.baseline-option>h3');const a=await headings.nth(0).boundingBox(),b=await headings.nth(1).boundingBox();assert.ok(Math.abs(a.y-b.y)<1,JSON.stringify({a,b}));}
 const report=page.locator('.report-baseline');
 if(before){await report.getByRole('checkbox').check();await report.getByRole('button').click();await report.getByRole('status').waitFor();}else{
  await report.getByRole('button',{name:'Sprawdź plik z ostatniego przebiegu'}).click();await report.getByRole('region',{name:'Nowa baza a obecna'}).waitFor();assert.equal(checks,1);assert.equal(publishes,0);
  assert.match(await report.innerText(),/Brakuje kodu LU1 · Lubin · Miasto/);assert.match(await report.innerText(),/bez zmian/);
  const delta=await report.locator('thead th').last().boundingBox();assert.ok(delta.x+delta.width<=width+1);
  const buttons=report.locator('.baseline-publish-actions button');assert.match(await buttons.first().innerText(),/Ustaw jako bazę/);const a=await buttons.nth(0).boundingBox(),b=await buttons.nth(1).boundingBox();assert.equal(a.height,b.height);assert.ok(Math.abs(b.x-a.x-a.width-12)<2);
 }
 await report.scrollIntoViewIfNeeded();await shot('report-checked');
 if(!before){await report.getByRole('button',{name:'Anuluj',exact:true}).click();assert.equal(publishes,0);}
 await page.getByLabel('Nowy plik bazowy').setInputFiles({name:'new.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:Buffer.from('PK fixture')});await page.getByRole('button',{name:'Sprawdź plik',exact:true}).click();await page.getByLabel('Powiązanie NCT1').selectOption('existing:krakow_airport');
 if(!before){assert.equal(await page.getByRole('group',{name:'Strefa NCT1',exact:true}).isVisible(),false);await page.getByRole('button',{name:'Zmień',exact:true}).click();await page.getByRole('group',{name:'Strefa NCT1',exact:true}).waitFor();}
 await page.getByRole('button',{name:'Sprawdź konfigurację'}).click();await page.locator('.baseline-success').waitFor();
 if(!before){assert.equal(await page.getByRole('group',{name:'Strefa NCT1',exact:true}).isVisible(),false);assert.equal(await page.getByRole('button',{name:'Zmień',exact:true}).count(),1);}
 await page.locator('.location-onboarding').scrollIntoViewIfNeeded();await shot('new-codes');assert.deepEqual(errors,[]);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(!before){workspace.snapshot.baseline.sha256=sha;await page.reload();await page.getByText('Ten plik jest już aktualną bazą',{exact:true}).waitFor();assert.equal(await page.locator('.report-baseline input,.report-baseline button').count(),0);}
 await context.close();
}}finally{await browser.close();}console.log('Baseline follow-up UI PASS');
