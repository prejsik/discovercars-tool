import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/playwright/index.mjs';
const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:960}});
const page=await context.newPage();
const errors=[]; page.on('pageerror',error=>errors.push(error.message));
const output=new URL('../../output/playwright/baseline-panel/',import.meta.url);
await mkdir(output,{recursive:true});
try {
  const snapshot=await (await context.request.get(`${origin}/policy-snapshot.json`)).json();
  const workspace={snapshot,draft:null,preview:null,history:[],status:{},capabilities:{publish:true,sharedDraft:true}};
  await page.route('**/api/workspace',route=>route.fulfill({json:workspace}));
  let checks=0; let publications=0;
  await page.route('**/api/baseline/check',route=>{
    checks++; assert.equal(route.request().headers()['x-panel-request'],'1');
    return route.fulfill({json:{summary:{sha256:'new-hash',rowCount:24877,groups:['CDMV'],zones:['KRLO'],firstDate:'2026-10-15',lastDate:'2027-01-22'},sourceRevision:'source-a',previousSha256:'old-hash'}});
  });
  await page.route('**/api/baseline/publish',route=>{
    publications++; const input=route.request().postDataJSON();
    assert.equal(input.checkedSha256,'new-hash'); assert.equal(input.sourceRevision,'source-a');
    assert.equal(input.previousSha256,'old-hash'); assert.equal(input.importConfirmed,true);
    assert.ok(input.content.startsWith('UEs'));
    workspace.snapshot={...snapshot,baseline:{...snapshot.baseline,filename:input.filename,sha256:'new-hash',importConfirmed:true}};
    return route.fulfill({json:{revision:'commit-a',sha256:'new-hash'}});
  });
  await page.goto(origin); await page.getByRole('button',{name:'Plik bazowy',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Sprawdź plik',exact:true}).isDisabled(),true);
  await page.getByLabel('Nowy plik bazowy').setInputFiles(fileURLToPath(new URL('../../input/mm-cars-rental-rates-inclusive-fp.xlsx',import.meta.url)));
  await page.getByRole('button',{name:'Sprawdź plik',exact:true}).click();
  await page.getByText('Plik przeszedł kontrolę układu, dat, stawek, klas i lokalizacji.',{exact:true}).waitFor();
  assert.equal(checks,1); assert.equal(publications,0);
  for(const width of [1440,390,320]){
    await page.setViewportSize({width,height:960});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`baseline overflow ${width}`);
    await page.screenshot({path:fileURLToPath(new URL(`baseline-${width}.png`,output))});
  }
  await page.getByRole('checkbox',{name:'Ten plik jest już wgrany do DiscoverCars',exact:true}).check();
  page.once('dialog',dialog=>dialog.dismiss());
  await page.getByRole('button',{name:'Ustaw jako bazę',exact:true}).click();
  assert.equal(publications,0);
  page.once('dialog',dialog=>dialog.accept());
  await page.getByRole('button',{name:'Ustaw jako bazę',exact:true}).click();
  await page.getByRole('status').filter({hasText:'Nowa baza zapisana na GitHubie'}).waitFor();
  assert.equal(publications,1);
  workspace.draft={revision:'published-draft',sourceRevision:'old-source',sourceHash:'old-policy',model:snapshot.documents};
  workspace.publication={draftRevision:'published-draft',policyMatchesCurrent:true};
  await page.reload();
  await page.getByRole('heading',{name:'Zasady cenowe',exact:true}).waitFor();
  assert.equal(await page.getByText('Poprzedni szkic ma inną wersję źródła',{exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'Dodaj regułę',exact:true}).isEnabled(),true);
  assert.deepEqual(errors,[]);
  console.log('Baseline UI PASS: check, explicit confirmation, unchanged binary, refresh and mobile.');
} finally {await browser.close();}
