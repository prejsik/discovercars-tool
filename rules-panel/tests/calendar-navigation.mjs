import {monthLabel} from '../src/visual-format.mjs';
export async function ruleMonth(page,target){
 const label=page.locator('.rule-calendar-view .calendar-month strong');
 const targetLabel=monthLabel(target);
 for(let i=0;i<36;i++){
  const text=await label.innerText();if(text===targetLabel)return;
  const year=Number(text.match(/\d{4}/)[0]);const names=Array.from({length:12},(_,m)=>monthLabel(`${year}-${String(m+1).padStart(2,'0')}`));const current=year*12+names.indexOf(text);
  const [y,m]=target.split('-').map(Number);await page.getByRole('button',{name:current<y*12+m-1?'Następny miesiąc':'Poprzedni miesiąc',exact:true}).click();
 }
 throw Error('Month navigation did not reach '+target);
}
