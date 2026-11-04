import assert from 'node:assert/strict';
import {chromium} from '../../node_modules/playwright/index.mjs';
const browser=await chromium.launch();const page=await browser.newPage();const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
try{
 await page.route('**/api/workspace',r=>r.fulfill({status:404,json:{}}));
 await page.goto(`${origin}/?view=rules`);
 const family=page.locator('.rule-family').filter({has:page.locator('summary',{hasText:'FVMD:'})}).first();await family.locator('summary').click();
 const original=await family.locator('.rule-band-row strong').allTextContents();
 await family.getByRole('button',{name:'Zmień daty wszystkich przedziałów'}).click();
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Data startu od').fill('2026-12-16');await dialog.getByLabel('Data startu do').fill('2027-01-08');await dialog.getByLabel('Powód zmiany').fill('Zmiana okresu bez zmiany stawek');
 await dialog.getByRole('button',{name:'Anuluj'}).click();assert.equal(await page.evaluate(()=>localStorage.getItem('discovercars-rules-draft-v1')),null);
 await family.getByRole('button',{name:'Zmień daty wszystkich przedziałów'}).click();await dialog.getByLabel('Data startu od').fill('2026-12-16');await dialog.getByLabel('Data startu do').fill('2027-01-08');await dialog.getByLabel('Powód zmiany').fill('Zmiana okresu bez zmiany stawek');
 await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 await dialog.getByRole('button',{name:'Zapisz w szkicu'}).click();await dialog.waitFor({state:'hidden'});
 assert.deepEqual(await family.locator('.rule-band-row strong').allTextContents(),original);
 const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem('discovercars-rules-draft-v1')).model.pricing.pricing.mandatoryGroupFloorsPlnDay.FVMD);
 assert.equal(saved.length,6);for(const r of saved){assert.equal(r.start_date,'2026-12-16');assert.equal(r.end_date,'2027-01-08');}
 console.log('Family dates UI PASS: cancel, all six dates, unchanged rates, mobile');
}finally{await browser.close();}
