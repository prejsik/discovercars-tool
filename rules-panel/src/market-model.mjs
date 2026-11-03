export const marketSignalLabels={missing:'Brak MM',outside:'Poza Top1',gap20:'Top1: zapas 20–29,99 PLN/d',gap30:'Top1: zapas ≥30 PLN/d',unavailable:'Brak potwierdzonych danych'};
export const money=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2}):'Brak danych';
export const warsawToday=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
export const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number(value.slice(0,4))>=1900&&Number(value.slice(0,4))<=2200&&Number.isFinite(Date.parse(value))&&new Date(value+'T12:00:00Z').toISOString().slice(0,10)===value;
export const plusDays=(date,count)=>new Date(Date.parse(date+'T12:00:00Z')+count*86400000).toISOString().slice(0,10);
export function dateRange(from,to) {if(!validDate(from)||!validDate(to)||from>to)return [];const days=Math.min(366,Math.round((Date.parse(to)-Date.parse(from))/86400000)+1);return Array.from({length:days},(_,i)=>plusDays(from,i));}
export function monthDates(month) {if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!validDate(month+'-01'))return [];const [year,m]=month.split('-').map(Number);return dateRange(month+'-01',`${month}-${new Date(Date.UTC(year,m,0)).getUTCDate()}`);}
export function marketSignals(row,report,now=Date.now()) {
  const signals=[];
  if(!row.marketConfirmed)signals.push('unavailable');
  else if(row.mm===null)signals.push('missing');
  else if(row.rank>1||row.rankLabel==='Poza Top3')signals.push('outside');
  else if(row.rank===1&&row.gap>=30)signals.push('gap30');
  else if(row.rank===1&&row.gap>=20)signals.push('gap20');
  return signals;
}
export function lineSegments(rows,key,x,y) {
  const result=[];let part=[];
  for(let i=0;i<rows.length;i++){const value=rows[i][key];if(typeof value==='number'&&Number.isFinite(value))part.push(`${x(i)},${y(value)}`);else if(part.length){result.push(part.join(' '));part=[];}}
  if(part.length)result.push(part.join(' '));return result;
}
export function eventsForDay(events,date,zones) {return events.filter(e=>e.active!==false&&e.start<=date&&e.end>=date&&(e.zones.includes('*')||zones.some(zone=>e.zones.includes(zone))));}
export function scenarioLink(runId,row) {
  const query=new URLSearchParams({runId,view:row.transmission,from:row.date,to:row.date,duration:String(row.duration),location:row.location,branches:'all'});
  return `/api/report/open?${query}`;
}
