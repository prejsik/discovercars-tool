import {locationLabel} from './operations.mjs';
import {priceTone} from './market-model.mjs';

export function mapCell(rows) {
 const confirmed=rows.filter(row=>row.marketConfirmed);
 if(!confirmed.length)return {tone:'nodata',value:null,problem:false};
 if(confirmed.some(row=>row.mm===null))return {tone:'missing',value:null,problem:true};
 const comparable=confirmed.filter(row=>Number.isFinite(row.gap));
 if(!comparable.length)return {tone:'nodata',value:null,problem:false};
 const value=Math.max(...comparable.map(row=>-row.gap));
 return {tone:priceTone(value),value,problem:value>10};
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
