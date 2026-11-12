import assert from 'node:assert/strict';
import {chromium} from '../../node_modules/playwright/index.mjs';
import {compactFixture} from './market-compact-fixture.mjs';

const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch();
try {
  for(const width of [1440,390]) {
    const page=await browser.newPage({viewport:{width,height:width===1440?1000:844}});
    const errors=[],writes=[],reads=[];let release,held,hold=false;
    page.on('pageerror',error=>errors.push(error.message));
    page.on('request',request=>{if(request.method()==='POST')writes.push(request.url());});
    await page.addInitScript(()=>{
      const NativeWorker=window.Worker;window.priceJobs=[];window.priceWorkers=0;
      window.Worker=class extends NativeWorker {
        constructor(url,options){super(url,options);if(String(url).includes('price-reader.worker')){window.priceWorkers++;const send=this.postMessage.bind(this);this.postMessage=message=>{window.priceJobs.push(message);send(message);};}}
      };
    });
    await page.clock.setFixedTime(new Date('2026-11-04T12:00:00Z'));
    const snapshot=await(await page.request.get(`${origin}/policy-snapshot.json`)).json();
    const fixture=await compactFixture(snapshot);
    await page.route('**/api/workspace',route=>route.fulfill({json:{snapshot,capabilities:{sharedDraft:true,publish:true},draft:null,history:[],status:{report:fixture.meta.report,excel:fixture.meta.excel}}}));
    await page.route('**/api/calendar-events',route=>route.fulfill({json:{items:[],revision:0}}));
    await page.context().route(/\/api\/report\/(prices|price-source)\?/,async route=>{
      const url=route.request().url(),params=new URL(url).searchParams;reads.push(params);
      if(hold&&!params.get('mode')&&!params.get('kind')&&params.get('group')==='CDMV'){
        hold=false;held?.();await new Promise(resolve=>{release=resolve;});
      }
      const response=await fixture.transport(url);
      await route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())}).catch(()=>{});
    });
    await page.goto(`${origin}/?view=prices`);
    await page.locator('.attention-map tbody th button').first().click();
    await page.locator('.band-matrix .band-cell strong').first().filter({hasText:'63'}).waitFor();
    hold=true;const started=new Promise(resolve=>{held=resolve;});
    await page.getByRole('tab',{name:'Stawki w Excelu'}).click();await started;
    await page.getByLabel('Klasa w Excelu').selectOption('EDMV');
    await page.locator('.prices-table tbody tr').first().getByText('73,00',{exact:true}).waitFor();
    release();await page.waitForTimeout(200);
    assert.equal(await page.locator('.prices-table tbody tr').first().getByText('73,00',{exact:true}).count(),1);
    await page.getByLabel('Klasa w Excelu').selectOption('CDMV');
    await page.getByRole('group',{name:'Długość najmu w Excelu'}).getByRole('button',{name:'4 dni · Excel 3–4',exact:true}).click();
    await page.locator('.prices-table tbody tr').first().getByText('63,00',{exact:true}).waitFor();
    assert.equal(await page.evaluate(()=>window.priceWorkers),1);
    assert.ok(await page.evaluate(()=>window.priceJobs.some(job=>job.cancel)));
    for(const kind of ['market','workbook','baseline','summary'])assert.equal(reads.filter(params=>params.get('kind')===kind).length,1,kind);
    assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await page.close();
  }
}finally{await browser.close();}
console.log('Price cancellation UI PASS: one worker, obsolete jobs aborted, verified bytes reused, exact prices, no writes (390/1440).');
