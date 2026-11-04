import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import {chromium} from '../../node_modules/playwright/index.mjs';
const before=process.argv.includes('--before');
const origin=process.env.PANEL_URL??'http://127.0.0.1:4317';
const browser=await chromium.launch();
const page=await browser.newPage();
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const snapshot=await (await page.request.get(`${origin}/policy-snapshot.json`)).json();
const workspace={snapshot,draft:{revision:'draft-a',model:snapshot.documents},history:[],capabilities:{sharedDraft:true,preview:true,publish:false},status:{available:false},preview:{status:'success',draftRevision:'draft-a',impact:{increasedRateCells:12,decreasedRateCells:2,unchangedRateCells:48,samples:[{position:{zone:'GDLO',group:'CDMV',pickupDate:'2026-11-10',durationBand:'3-4'},beforeRate:70,afterRate:95}]}}};
await page.route('**/api/workspace',r=>r.fulfill({json:workspace}));
const output=new URL(`../docs/rules-clarity/${before?'before':'after'}/`,import.meta.url);
await mkdir(output,{recursive:true});
async function shot(name,width){await page.screenshot({path:new URL(`${name}-${width}.png`,output).pathname.replace(/^\/(\w:)/,'$1')});}
try {
for(const width of [1440,390]){
 await page.setViewportSize({width,height:width===1440?1000:844});
 await page.goto(`${origin}/?view=rules`);await page.locator('.rule-family').first().waitFor();
 await shot('list',width);
 if(!before){
  const titles=await page.locator('.rule-title').allTextContents();assert.equal(new Set(titles).size,titles.length);
  const contrast=await page.locator('.rules-view-switch [aria-pressed=true]').evaluate(el=>{
   const c=getComputedStyle(el);const lum=s=>{const a=s.match(/\d+/g).slice(0,3).map(Number).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return a[0]*.2126+a[1]*.7152+a[2]*.0722;};const a=lum(c.color),b=lum(c.backgroundColor);return (Math.max(a,b)+.05)/(Math.min(a,b)+.05);
  });assert.ok(contrast>=4.5);
 }
 await page.locator('.rule-family > summary').first().click();await shot('family',width);
 await page.getByRole('button',{name:'Kalendarz',exact:true}).click();await page.locator('.rule-calendar').waitFor();await shot('calendar',width);
 await page.getByRole('button',{name:'Dodaj regułę',exact:true}).click();await page.getByRole('dialog').waitFor();await shot('new-rule',width);await page.keyboard.press('Escape');
 if(!before){
  await page.getByRole('button',{name:'Dodaj regułę',exact:true}).click();const dialog=page.getByRole('dialog');
  assert.equal(await dialog.getByText('Nowa reguła · brak jednej dotychczasowej stawki do porównania',{exact:true}).count(),1);
  await dialog.getByRole('button',{name:'Wszystkie lotniska',exact:true}).click();
  const expected=snapshot.documents.locations.locations.filter(l=>l.kind==='airport').flatMap(l=>l.zones).length;
  assert.equal(await dialog.locator('.scope-picker').first().locator('input:checked').count(),expected);
  await dialog.getByLabel('Miasto',{exact:true}).selectOption('Krakow');
  assert.equal(await dialog.locator('.scope-picker').first().locator('input:checked').count(),snapshot.documents.locations.locations.filter(l=>l.city==='Krakow').flatMap(l=>l.zones).length);
  await page.keyboard.press('Escape');
 }
 await page.goto(`${origin}/?view=review`);await page.getByRole('heading',{name:'Podgląd zmian',exact:true}).waitFor();await shot('review',width);
 if(!before)assert.equal(await page.locator('.impact-review').count(),1);
 if(!before){assert.match(await page.locator('.impact-review').innerText(),/12 stawek w górę, 2 w dół, 48 bez zmian/);workspace.preview.draftRevision='old';await page.reload();await page.locator('.impact-review').waitFor();assert.doesNotMatch(await page.locator('.impact-review').innerText(),/12 stawek/);workspace.preview.draftRevision='draft-a';}
 await page.goto(`${origin}/?view=groups`);await page.getByRole('switch',{name:'Rekomendacje dla CFAV'}).waitFor();
 if(!before){await page.getByRole('switch',{name:'Rekomendacje dla CFAV'}).click();await page.getByRole('dialog').waitFor();}
 await shot('groups',width);
 if(!before){await page.getByRole('button',{name:'Anuluj',exact:true}).click();assert.equal(await page.getByRole('dialog').count(),0);}
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
}
assert.deepEqual(errors,[]);
if(!before){
 workspace.snapshot.capabilities={...workspace.snapshot.capabilities,mode:'github'};workspace.preview=null;
 let requested=0;await page.route('**/api/preview',r=>{assert.equal(r.request().postDataJSON().draftRevision,'draft-a');requested++;workspace.preview={draftRevision:'draft-a',status:'running'};return r.fulfill({json:workspace});});
 await page.goto(`${origin}/?view=review`);await page.getByRole('button',{name:'Policz wpływ',exact:true}).click();await page.getByText('Przeliczanie w toku.',{exact:false}).waitFor();assert.equal(requested,1);
}
}finally{await browser.close();}
console.log('Rules clarity screenshots and UI PASS');
