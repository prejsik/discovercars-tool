export const plNumber=value=>Number.isFinite(value)?value.toLocaleString('pl-PL',{maximumFractionDigits:2,useGrouping:'always'}):'Brak danych';
export const displayBand=value=>String(value??'').replace(/-/g,'–');
export function impactSampleStats(impact,model){
 const rows=(impact.samples??[]).filter(r=>Number.isFinite(r.beforeRate)&&Number.isFinite(r.afterRate));
 const zones=new Set(rows.map(r=>r.position?.zone).filter(Boolean));
 const branches=new Set([...zones].map(zone=>model?.locations?.locations?.find(l=>l.zones.includes(zone))?.id??zone));
 return {branches:branches.size,mean:rows.length?rows.reduce((sum,r)=>sum+r.afterRate-r.beforeRate,0)/rows.length:null,count:rows.length};
}
export function excelTimestamp(value){const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(date):null;}
