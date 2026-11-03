import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from '../../node_modules/playwright/index.mjs';
import { priceFixture } from './price-fixture.mjs';
import { previewPolicy } from '../src/policy.mjs';

const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});
const context=await browser.newContext({viewport:{width:1440,height:1050}});
const page=await context.newPage();page.setDefaultTimeout(10000);
const errors=[];page.on('pageerror',error=>errors.push(error.message));
const directory=new URL('../../output/playwright/price-views/',import.meta.url);await mkdir(directory,{recursive:true});
try {
  const snapshot=await(await context.request.get(`${origin}/policy-snapshot.json`)).json();
  const proof=await priceFixture();
  const workspace={snapshot,capabilities:{publish:true},draft:null,history:[],status:{report:proof.report,excel:proof.excel}};
  await page.route('**/api/workspace',route=>route.fulfill({json:workspace}));
  let calls=0;let writes=0;
  context.on('request',request=>{if(request.method()==='POST')writes++;});
  const transport=await priceFixture({transportOnly:true,rowCount:35000});
  await context.route(/\/api\/report\/(prices|price-source)\?/,async route=>{
    calls++;const q=new URL(route.request().url()).searchParams;if(q.get('mode')!=='market')assert.equal(q.get('zone'),'KRLO');
    const response=await transport(route.request().url());
    return route.fulfill({status:response.status,headers:Object.fromEntries(response.headers),body:Buffer.from(await response.arrayBuffer())});
  });
  await page.goto(`${origin}/?view=prices`);
  await page.getByRole('heading',{name:'Ceny i rynek',exact:true}).waitFor();
  await page.getByRole('button',{name:'Wykres',exact:true}).click();
  await page.locator('.market-chart').waitFor({timeout:60000});
  assert.equal(writes,0,'Automatic report read must not dispatch or write');
  await page.getByRole('button',{name:'Stawki w Excelu',exact:true}).click();
  await page.getByRole('button',{name:'Pokaż ceny',exact:true}).click();
  await page.getByRole('button',{name:'Dlaczego?',exact:true}).click({timeout:60000});
  await page.getByText('Zapisana decyzja',{exact:true}).waitFor();
  assert.match(await page.locator('.prices-table').innerText(),/63,00/);
  assert.match(await page.locator('.decision-evidence').innerText(),/30,00/);
  for(const width of [1440,1024,390,320]) {
    await page.setViewportSize({width,height:1050});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`prices overflow ${width}`);
    await page.screenshot({path:fileURLToPath(new URL(`prices-${width}.png`,directory)),fullPage:true});
  }
  await page.locator('.prices-view').getByLabel('Start od',{exact:true}).fill('2027-01-01');
  await page.getByText('Brak pozycji w wybranym zakresie.',{exact:true}).waitFor();
  await page.getByLabel('Klasa w Excelu').selectOption('EDMV');
  assert.equal(await page.locator('.prices-table').count(),0,'Filter change cannot display a previous class result');
  await page.getByRole('button',{name:'Zasady cenowe',exact:true}).click();
  await page.getByRole('button',{name:'Kalendarz',exact:true}).click();
  await page.getByLabel('Miesiąc',{exact:true}).fill('2026-12');
  const protectedCheck=previewPolicy(snapshot.documents,{zone:'KRLO',group:'CDMV',duration:3,pickupDate:'2026-12-15'});
  await page.getByRole('button',{name:/^2026-12-15,/}).click();
  const expected=protectedCheck.protected?'Data chroniona':protectedCheck.marketAllowed?'Zmiany rynkowe dozwolone':'Zmiany rynkowe wyłączone';
  await page.locator('.calendar-selection').getByText(expected,{exact:true}).waitFor();
  await page.getByLabel('Przedział najmu').selectOption('8');
  for(const width of [1440,1024,390,320]) {
    await page.setViewportSize({width,height:1050});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`calendar overflow ${width}`);
    assert.equal(await page.locator('.calendar-day').count(),31);
    await page.screenshot({path:fileURLToPath(new URL(`calendar-${width}.png`,directory)),fullPage:true});
  }
  await page.getByLabel('Miesiąc',{exact:true}).fill('2027-12');
  await page.getByRole('button',{name:/^2027-12-07,/}).click();
  const edit=page.locator('.calendar-selection button').first();
  await edit.click();await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button',{name:'Lista',exact:true}).click();
  await page.getByLabel('Szukaj zasad').waitFor();
  assert.equal(writes,0,'Read-only views must not write, dispatch, change rules or baseline');
  assert.deepEqual(errors,[]);
  console.log('Price and calendar UI PASS: source-bound explanation, filters, 4 widths, protected dates, future months, existing editor, no mutations.');
} catch(error) {
  console.error(await page.locator('main').innerText());
  console.error(errors);
  throw error;
} finally {await browser.close();}
