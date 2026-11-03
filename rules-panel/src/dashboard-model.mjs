import {overviewRows} from './market-review.mjs';
import {branchOverview} from './operations.mjs';
import {dateRange,plusDays,warsawToday} from './market-model.mjs';
export const reviewReasons={all:'Wszystkie',urgent:'Brak MM lub MM droższe >10 PLN/d',missing:'Brak oferty MM',over:'MM droższe o ponad 10 PLN/d',reserve:'Top1 z zapasem ≥30 PLN/d',unavailable:'Brak potwierdzonych danych'};
export function matchesReview(row,reason) {
 if(reason==='urgent')return matchesReview(row,'missing')||matchesReview(row,'over');
 if(reason==='missing')return row.marketConfirmed&&row.mm===null;
 if(reason==='unavailable')return !row.marketConfirmed;
 if(reason==='over')return row.marketConfirmed&&Number.isFinite(row.mm)&&Number.isFinite(row.competitor)&&row.gap < -10;
 if(reason==='reserve')return row.marketConfirmed&&row.rank===1&&Number.isFinite(row.gap)&&row.gap>=30;
 return true;
}
export function dashboardOverview(data,today=warsawToday()) {
 const rows=overviewRows(data,today),dates=dateRange(today,plusDays(today,13)),locations=new Set(rows.map(row=>row.location));
 const metrics=['missing','over','reserve','unavailable'].map(reason=>{
  const matching=rows.filter(row=>matchesReview(row,reason));
  return {reason,label:reviewReasons[reason],count:matching.length,branches:new Set(matching.map(row=>row.location)).size,days:dates.map(date=>({date,count:matching.filter(row=>row.date===date).length}))};
 });
 const urgent=rows.filter(row=>matchesReview(row,'urgent')).sort((a,b)=>Number(matchesReview(b,'missing'))-Number(matchesReview(a,'missing'))||(matchesReview(a,'missing')?0:a.gap-b.gap)||a.date.localeCompare(b.date)||a.duration-b.duration);
 const branches=branchOverview(rows).map(branch=>({...branch,missing:branch.items.filter(row=>matchesReview(row,'missing')).length})).sort((a,b)=>(b.missing+b.over)-(a.missing+a.over)||a.location.localeCompare(b.location));
 return {rows,metrics,urgent,branches,locationCount:locations.size,dates};
}
