import { money,plusDays,warsawToday } from './market-model.mjs';

export function overviewRows(data,today=warsawToday(),transmission='all') {
  const end=plusDays(today,13);
  return (data?.rows??[]).filter(row=>row.transmission===transmission&&row.duration>=2&&row.duration<=14&&row.date>=today&&row.date<=end);
}

export function gapLabel(gap, total=false) {
  if(typeof gap!=='number'||!Number.isFinite(gap))return 'Brak porównania cen';
  if(gap===0)return 'Taka sama cena';
  return `MM ${gap<0?'droższe':'tańsze'} o ${money(Math.abs(gap))} ${total?'PLN za najem':'PLN/dobę'}`;
}
const finite=value=>typeof value==='number'&&Number.isFinite(value);
export function priceScale(rows) {
  const values=rows.flatMap(row=>[row.mm,row.competitor]).filter(finite);
  if(!values.length)return {min:0,max:10};
  let low=Infinity,high=-Infinity;
  for(const value of values){low=Math.min(low,value);high=Math.max(high,value);}
  const margin=Math.max(5,(high-low)*.1);
  return {min:Math.max(0,Math.floor(low-margin)),max:Math.ceil(high+margin)};
}
const over=row=>finite(row.gap)?-row.gap:-Infinity;
const priority=row=>row.signals.includes('unavailable')?0:row.signals.includes('missing')?1:row.signals.includes('outside')?2:row.signals.some(s=>s==='gap30'||s==='gap20')?3:4;
export function compareAttention(a,b,sort) {
  const date=a.date.localeCompare(b.date)||a.duration-b.duration||a.location?.localeCompare(b.location??'')||0;
  if(sort==='date')return date;
  if(sort==='above')return over(b)-over(a)||date;
  if(sort==='gap')return (b.gap??-Infinity)-(a.gap??-Infinity)||date;
  return priority(a)-priority(b)||(priority(a)===2?over(b)-over(a):priority(a)===3?(b.gap??0)-(a.gap??0):0)||date;
}
