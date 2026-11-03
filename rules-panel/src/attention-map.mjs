import {locationLabel} from './operations.mjs';
import {priceTone} from './market-model.mjs';

export function mapCell(rows) {
 const confirmed=rows.filter(row=>row.marketConfirmed);
 const missing=confirmed.filter(row=>row.mm===null).length;
 const counts={missing,total:rows.length,missingDurations:confirmed.filter(row=>row.mm===null).map(row=>row.duration)};
 const comparable=confirmed.filter(row=>Number.isFinite(row.gap));
 if(!comparable.length)return {...counts,tone:missing?'missing':'nodata',value:null,problem:missing>0};
 const value=Math.max(...comparable.map(row=>-row.gap));
 return {...counts,tone:priceTone(value),value,problem:missing>0||value>10};
}
export function buildAttentionMap(rows,dates) {
 const branches=new Map();
 for(const row of rows){
  if(!branches.has(row.location))branches.set(row.location,new Map());
  const days=branches.get(row.location);
  if(!days.has(row.date))days.set(row.date,[]);
  days.get(row.date).push(row);
 }
 return [...branches].map(([location,days])=>{
  const cells=dates.map(date=>({date,...mapCell(days.get(date)??[])}));
  return {location,cells,problems:cells.filter(cell=>cell.problem).length};
 }).sort((a,b)=>b.problems-a.problems||locationLabel(a.location).localeCompare(locationLabel(b.location),'pl'));
}
export const mixedBand=rows=>rows.some(r=>r.marketConfirmed&&Number.isFinite(r.gap)&&r.gap>5)&&rows.some(r=>r.marketConfirmed&&Number.isFinite(r.gap)&&r.gap<-5);
export function calendarSummary(rows) {
 const comparable=rows.filter(r=>r.marketConfirmed&&Number.isFinite(r.mm)&&Number.isFinite(r.competitor)&&Number.isFinite(r.gap));
 return {comparable:comparable.length,top1:comparable.filter(r=>r.rank===1).length,average:comparable.length?-comparable.reduce((sum,r)=>sum+r.gap,0)/comparable.length:null};
}
