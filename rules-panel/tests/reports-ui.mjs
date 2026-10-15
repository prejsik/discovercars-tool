import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/playwright/index.mjs';
const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1000}});
const page=await context.newPage();
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const output=new URL('../../output/playwright/results-panel/',import.meta.url);await mkdir(output,{recursive:true});
try {
  const snapshot=await(await context.request.get(`${origin}/policy-snapshot.json`)).json();
  const fileSha256='b'.repeat(64);
  const record={runId:'123',generatedAt:'2026-10-15T08:00:00Z',sourceStartedAt:'2026-10-15T02:00:00Z',startDates:['2026-10-15','2026-10-16'],durations:[2,3,4],quality:'success',coverage:{found:637,expected:650},baselineFilename:snapshot.baseline.filename,baselineMatchesCurrent:true,files:{'rates-import-ready.xlsx':fileSha256},statistics:{increases:2,decreases:3,averageIncrease:10,averageDecrease:7.4}};
  const workspace={snapshot,draft:null,preview:null,history:[],capabilities:{publish:true},status:{available:true,report:{...record,runId:'124'},excel:record,executions:{latest:{status:'completed',conclusion:'success',skipped:true,createdAt:'2026-10-15T09:00:00Z',url:'https://github.com/prejsik/discovercars-tool/actions/runs/125'},active:[{runId:'126',status:'queued',createdAt:'2026-10-15T10:00:00Z',url:'https://github.com/prejsik/discovercars-tool/actions/runs/126'}]},links:{report:'/api/report/open?runId=124',import:`/api/report/file?kind=import&runId=123&sha256=${fileSha256}`,recommendations:`/api/report/file?kind=recommendations&runId=123&sha256=${fileSha256}`}}};
  await page.route('**/api/workspace',route=>route.fulfill({json:workspace}));
  let checks=0;let publications=0;
  await page.route('**/api/report-baseline/check',route=>{
    checks++; assert.deepEqual(route.request().postDataJSON(),{runId:'123',fileSha256});
    return route.fulfill({json:{summary:{sha256:fileSha256,rowCount:24877},sourceRevision:snapshot.source.revision,previousSha256:snapshot.baseline.sha256}});
  });
  await page.route('**/api/report-baseline/publish',route=>{
    publications++;assert.deepEqual(route.request().postDataJSON(),{runId:'123',fileSha256,sourceRevision:snapshot.source.revision,previousSha256:snapshot.baseline.sha256,checkedSha256:fileSha256,importConfirmed:true});
    return route.fulfill({json:{revision:'new-base-commit'}});
  });
  await page.goto(`${origin}/?view=results`);
  await page.getByRole('heading',{name:'Ostatnie wyniki',exact:true}).waitFor();
  await page.getByText('Oczekuje na uruchomienie',{exact:true}).waitFor();
  await page.getByText('Excel i raport pochodzą z różnych uruchomień. Zakres i czas Excela podano poniżej.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Pobierz import',exact:true}).getAttribute('href'),workspace.status.links.import);
  const publish=page.getByRole('button',{name:'Ustaw ten plik jako nową bazę',exact:true});
  assert.equal(await publish.isDisabled(),true);assert.equal(checks,0);assert.equal(publications,0);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:1000});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`reports overflow ${width}`);
    await page.screenshot({path:fileURLToPath(new URL(`results-${width}.png`,output))});
  }
  await page.getByRole('checkbox',{name:'Wgrałem powyższy plik importowy do DiscoverCars',exact:true}).check();
  page.once('dialog',dialog=>dialog.dismiss());await publish.click();
  await page.waitForFunction(()=>!document.querySelector('.report-baseline button').disabled);
  assert.equal(checks,1);assert.equal(publications,0);
  page.once('dialog',dialog=>dialog.accept());await publish.click();
  await page.getByRole('status').filter({hasText:'Plik importowy ustawiony jako nowa baza.'}).waitFor();
  assert.equal(publications,1);assert.deepEqual(errors,[]);
  console.log('Results UI PASS: scoped files, partial runs, statistics, explicit import/confirmation, mobile and no automatic baseline changes.');
} finally {await browser.close();}
