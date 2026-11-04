import {dayLabel,countLabel} from './operations.mjs';
import {locationOptions} from './editor.mjs';
export const baselineRange=c=>c?.firstDate&&c?.lastDate?`${dayLabel(c.firstDate)} – ${dayLabel(c.lastDate)}`:'Brak danych';
export function baselineWarnings(before,after,model){
 if(!before||!after)return [];
 const labels=locationOptions(model);
 return [...(before.zones??[]).filter(z=>!(after.zones??[]).includes(z)).map(z=>{let label=labels.find(l=>l.value===z)?.label??'brak powiązania';const suffix=` (${z})`;if(label.endsWith(suffix))label=label.slice(0,-suffix.length);if(label.startsWith(`${z} · `))label=label.slice(z.length+3);return `Brakuje kodu ${z} · ${label}`;}),...(before.groups??[]).filter(g=>!(after.groups??[]).includes(g)).map(g=>`Brakuje klasy ${g}`),...(before.lastDate&&after.lastDate&&after.lastDate<before.lastDate?[`Zakres dat kończy się wcześniej: ${dayLabel(after.lastDate)} zamiast ${dayLabel(before.lastDate)}`]:[])];
}
export function baselineDelta(before,after){if(!Number.isFinite(before)||!Number.isFinite(after))return 'Brak danych porównawczych';const n=after-before;return n===0?'bez zmian':`${n<0?'−':'+'}${Math.abs(n).toLocaleString('pl-PL',{useGrouping:'always'})}`;}
export function codesDelta(before,after){if(!Array.isArray(before)||!Array.isArray(after))return 'Brak danych porównawczych';const removed=before.filter(v=>!after.includes(v)),added=after.filter(v=>!before.includes(v));return [removed.length?`−${removed.length}: ${removed.join(', ')}`:'',added.length?`+${added.length}: ${added.join(', ')}`:''].filter(Boolean).join('; ')||'bez zmian';}
export function reportRunLabel(record){const start=record?.sourceStartedAt,date=new Date(start??record?.generatedAt);if(!Number.isFinite(date.getTime()))return 'Przebieg · brak potwierdzonej daty';const hour=Number(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Warsaw',hour:'2-digit',hourCycle:'h23'}).format(date));const name=!start?'Przebieg':hour>=6&&hour<15?'Przebieg poranny':hour>=15?'Przebieg wieczorny':'Przebieg';return `${name} · ${new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).format(date)}`;}
export function locationCoverage(location,data){
 if(!data)return null;
 if(!data.locations?.some(l=>l.scraper_label===location.scraper_label))return {missing:null,total:0,label:'Punkt poza zakresem tego raportu'};
 const dates=data.report?.startDates??[],durations=data.report?.durations??[];
 if(!dates.length||!durations.length)return null;
 const selected=data.rows.filter(r=>r.location===location.scraper_label&&r.transmission==='all');
 if(!selected.length)return {missing:null,total:dates.length,label:'Brak pozycji tego punktu w raporcie · nie potwierdzono zakresu'};
 const rows=new Map(selected.map(r=>[`${r.date}|${r.duration}`,r]));
 const missing=dates.filter(date=>durations.some(duration=>!rows.get(`${date}|${duration}`)?.marketConfirmed)).length;
 return {missing,total:dates.length,label:missing?`Braki ${missing} z ${dates.length} dni · niepotwierdzone ceny lub brak scenariusza`:`Komplet · ${countLabel(dates.length,'dzień','dni','dni')}`};
}
