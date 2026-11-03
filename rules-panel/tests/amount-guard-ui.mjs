import assert from 'node:assert/strict';
import { chromium } from '../../node_modules/playwright/index.mjs';
const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:1440,height:1000}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
try {
  await page.route('**/api/workspace',r=>r.fulfill({status:404,json:{}}));
  await page.goto(`${origin}/?view=rules`);
  await page.locator('[data-rule-id="location:airport"]').getByRole('button').click();
  const dialog=page.getByRole('dialog');const amount=dialog.getByLabel('Stawka minimalna (PLN / dobę)',{exact:true});const save=dialog.getByRole('button',{name:'Zapisz w szkicu',exact:true});
  for(const bad of ['', '0', '-1']){await amount.fill(bad);assert.equal(await save.isDisabled(),true);await dialog.getByText('Podaj kwotę większą od 0 i nie większą niż 100 000 PLN.',{exact:true}).waitFor();}
  await amount.fill('4999');await dialog.getByRole('alert').filter({hasText:'Duża zmiana kwoty'}).waitFor();assert.equal(await save.isDisabled(),true);
  await dialog.getByRole('checkbox',{name:/Potwierdzam kwotę/}).check();assert.equal(await save.isEnabled(),true);
  await amount.fill('4998');assert.equal(await save.isDisabled(),true,'Changing an amount invalidates confirmation');
  await amount.fill('4999');await dialog.getByRole('checkbox',{name:/Potwierdzam kwotę/}).check();
  for(const width of [1440,1024,390]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);}
  await save.click();await dialog.waitFor({state:'hidden'});
  const draft=await page.evaluate(()=>JSON.parse(localStorage.getItem('discovercars-rules-draft-v1')));
  assert.equal(draft.amountConfirmations[0].after,4999);
  await page.reload();await page.locator('[data-rule-id="location:airport"]').getByRole('button').click();
  assert.equal(await dialog.getByRole('checkbox',{name:/Potwierdzam kwotę/}).isChecked(),true);
  await page.keyboard.press('Escape');assert.deepEqual(errors,[]);
  console.log('Amount guard UI PASS: invalid input, exact acknowledgement, scope, mobile, persistent draft metadata.');
}finally{await browser.close();}
