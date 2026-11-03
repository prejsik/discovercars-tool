import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '../../node_modules/playwright/index.mjs';

const origin=process.env.PANEL_URL ?? 'http://127.0.0.1:4317';
const output=join(tmpdir(),'discovercars-diagnostics-qa');
await mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
try {
  const context=await browser.newContext({viewport:{width:1440,height:1100}});
  const page=await context.newPage();
  const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  const snapshot=await(await context.request.get(`${origin}/policy-snapshot.json`)).json();
  const record={runId:'41488117450',revision:'a'.repeat(40),generatedAt:'2026-11-03T03:34:26Z',sourceStartedAt:'2026-11-02T17:07:31Z',startDates:['2026-11-03','2026-12-17'],durations:[2,3,4,5,6,7,8,9,10,11,12,13,14],quality:'failure',coverage:{found:14625,expected:14625},incident:{code:'city_airport_cap',owner:'technical',title:'Excel zablokowany przez kontrolę limitu miasto–lotnisko',explanation:'Kontrola końcowa wykryła stawki miejskie powyżej dopuszczalnego limitu względem lotniska. Pliki Excel z tego uruchomienia nie zostały opublikowane.',nextStep:'Wymagana jest kontrola programu i kolejności stosowania zasad. Nie obniżaj minimów na podstawie samego tego komunikatu.',complete:false,total:null,positions:[{group:'CDMV',zone:'KRDW',pickupDate:'2026-12-09',column:'M',duration:'8-20',rate:80,limit:77,rateOrigin:'unknown'},{group:'CDMV',zone:'PO1',pickupDate:'2026-12-07',column:'M',duration:'8-20',rate:80,limit:79.49,rateOrigin:'unknown'}],technicalDetails:'ValueError: Final rates violate the city Top1 airport cap'}};
  const run={runId:record.runId,status:'completed',conclusion:'failure',startedAt:record.sourceStartedAt,url:`https://github.com/prejsik/discovercars-tool/actions/runs/${record.runId}`};
  const workspace={snapshot,draft:null,preview:null,history:[],capabilities:{publish:false},status:{available:true,report:record,excel:{...record,runId:'123',quality:'success',incident:null},executions:{latest:{runId:'999',status:'completed',conclusion:'success',skipped:true},latestScrape:run,active:[]},links:{}}};
  await page.route('**/api/workspace',route=>route.fulfill({json:workspace}));
  await page.route('**/api/report/diagnostics?runId=555',route=>route.fulfill({json:{run:{...run,runId:'555'},report:{...record,runId:'555',incident:{...record.incident,complete:true,total:21,positions:Array.from({length:21},(_,index)=>({...record.incident.positions[0],pickupDate:`2026-12-${String(index+1).padStart(2,'0')}`,rateOrigin:'baseline'}))}}}}));
  await page.route('**/api/report/diagnostics?runId=777',route=>route.fulfill({status:502,json:{error:'Artefakt diagnostyczny wygasł.'}}));
  await page.goto(`${origin}/?view=results`);
  await page.getByRole('heading',{name:'Excel zablokowany przez kontrolę limitu miasto–lotnisko',exact:true}).waitFor();
  assert.equal(await page.getByText('Nie potwierdzono źródła',{exact:true}).count(),2);
  assert.match(await page.getByRole('table',{name:'Pozycje blokujące Excel'}).innerText(),/79,49/);
  const search=page.getByRole('searchbox',{name:'Filtruj problematyczne pozycje'});
  await search.fill('PO1');
  assert.equal(await page.locator('tbody tr').count(),1);
  await search.fill('');
  for(const width of [1440,768,390,320]) {
    await page.setViewportSize({width,height:1100});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`overflow at ${width}`);
    if(width===1440 || width===390)await page.screenshot({path:join(output,`diagnostics-${width}.png`),fullPage:true});
  }
  await page.goto(`${origin}/?view=results&runId=555`);
  await page.getByText('Stawka zachowana z bazy',{exact:true}).first().waitFor();
  assert.equal(await page.locator('tbody tr').count(),20);
  await page.getByRole('button',{name:'Następne pozycje',exact:true}).click();
  assert.equal(await page.locator('tbody tr').count(),1);
  await page.getByText('Zasady i baza użyte w tym przebiegu',{exact:true}).click();
  assert.match(await page.getByRole('link',{name:'Zasady cenowe z tego przebiegu'}).getAttribute('href'),/\/a{40}\//);
  assert.equal(await page.getByText('Nie potwierdzono źródła',{exact:true}).count(),0);
  await page.goto(`${origin}/?view=results&runId=777`);
  await page.getByRole('alert').filter({hasText:'Artefakt diagnostyczny wygasł.'}).waitFor();
  assert.equal(await page.getByRole('table',{name:'Pozycje blokujące Excel'}).count(),0);
  assert.deepEqual(errors,[]);
  console.log(`Diagnostics UI PASS: failure is visible after skipped attempts, exact rows and filter, pinned history, no overflow at 1440/768/390/320. Screenshots: ${output}`);
} finally { await browser.close(); }
