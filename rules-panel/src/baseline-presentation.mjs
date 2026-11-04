import {dayLabel,countLabel} from './operations.mjs';
import {locationOptions} from './editor.mjs';
export const baselineRange=c=>c?.firstDate&&c?.lastDate?`${dayLabel(c.firstDate)} – ${dayLabel(c.lastDate)}`:'Brak danych';
export function baselineWarnings(before,after,model){
 if(!before||!after)return [];
 const labels=locationOptions(model);
 return [...(before.zones??[]).filter(z=>!(after.zones??[]).includes(z)).map(z=>`Brakuje kodu ${z} (${labels.find(l=>l.value===z)?.label??'brak powiązania'})`),...(before.groups??[]).filter(g=>!(after.groups??[]).includes(g)).map(g=>`Brakuje klasy ${g}`),...(before.lastDate&&after.lastDate&&after.lastDate<before.lastDate?[`Zakres dat kończy się wcześniej: ${dayLabel(after.lastDate)} zamiast ${dayLabel(before.lastDate)}`]:[])];
}
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
