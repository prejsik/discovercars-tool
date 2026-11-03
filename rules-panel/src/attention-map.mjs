import {locationLabel} from './operations.mjs';
import {priceTone} from './market-model.mjs';

export const mapBands={'2':[2],'3-4':[3,4],'5-7':[5,6,7],'8-20':[8,9,10,11,12,13,14]};
export function mapCell(rows,band='3-4') {
 const lengths=mapBands[band]??mapBands['3-4'];
 const confirmed=rows.filter(row=>lengths.includes(row.duration)&&row.marketConfirmed);
 const missingDurations=[...new Set(confirmed.filter(row=>row.mm===null).map(row=>row.duration))];
 const missing=missingDurations.length,majorityMissing=missing>lengths.length/2;
 const counts={missing,total:lengths.length,missingDurations};
 const values=confirmed.filter(row=>Number.isFinite(row.mm)&&Number.isFinite(row.gap)).map(row=>-row.gap).sort((a,b)=>a-b);
 const middle=Math.floor(values.length/2);
 const value=values.length?(values.length%2?values[middle]:(values[middle-1]+values[middle])/2):null;
 return {...counts,tone:majorityMissing?'missing':priceTone(value),value,problem:majorityMissing||(value!==null&&value>10)};
}
export function buildAttentionMap(rows,dates,band='3-4') {
 const branches=new Map();
 for(const row of rows){
  if(!branches.has(row.location))branches.set(row.location,new Map());
  const days=branches.get(row.location);
  if(!days.has(row.date))days.set(row.date,[]);
  days.get(row.date).push(row);
 }
 return [...branches].map(([location,days])=>{
  const cells=dates.map(date=>({date,...mapCell(days.get(date)??[],band)}));
  return {location,cells,problems:cells.filter(cell=>cell.problem).length};
 }).sort((a,b)=>b.problems-a.problems||locationLabel(a.location).localeCompare(locationLabel(b.location),'pl'));
}
export const mixedBand=rows=>rows.some(r=>r.marketConfirmed&&Number.isFinite(r.gap)&&r.gap>5)&&rows.some(r=>r.marketConfirmed&&Number.isFinite(r.gap)&&r.gap<-5);
export function calendarSummary(rows) {
 const comparable=rows.filter(r=>r.marketConfirmed&&Number.isFinite(r.mm)&&Number.isFinite(r.competitor)&&Number.isFinite(r.gap));
 return {comparable:comparable.length,top1:comparable.filter(r=>r.rank===1).length,average:comparable.length?-comparable.reduce((sum,r)=>sum+r.gap,0)/comparable.length:null};
}
