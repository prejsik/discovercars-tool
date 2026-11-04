import {dashboardOverview} from './dashboard-model.mjs';
import {locationLabel} from './operations.mjs';
export const missingOfferCount=(data,today,transmission)=>data?dashboardOverview(data,today,transmission).metrics.find(m=>m.reason==='missing').count:null;
export function reviewDayLabel(today){const date=new Date(today+'T12:00:00Z');const weekday=['niedzielę','poniedziałek','wtorek','środę','czwartek','piątek','sobotę'][date.getUTCDay()];return `${weekday}, ${new Intl.DateTimeFormat('pl-PL',{day:'numeric',month:'long',timeZone:'UTC'}).format(date)}`;}
export function groupedLocations(values,locations=[]){
 const options=values.map(value=>typeof value==='string'?{value,label:locationLabel(value)}:value);
 const kindOf=option=>(option.kind??locations.find(l=>l.scraper_label===option.value||l.zones?.includes(option.value))?.kind)==='airport'?'airport':'city';
 return ['airport','city'].map(kind=>({label:kind==='airport'?'Lotniska':'Poza lotniskami',items:options.filter(option=>kindOf(option)===kind).sort((a,b)=>a.label.localeCompare(b.label,'pl'))})).filter(group=>group.items.length);
}
export function reportFreshness(report){
 const raw=report?.sourceStartedAt??report?.generatedAt,date=new Date(raw);
 return {label:Number.isFinite(date.getTime())?`Dane z ${new Intl.DateTimeFormat('pl-PL',{timeZone:'Europe/Warsaw',day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}).format(date)}`:'Brak potwierdzonej daty danych.',stale:Number.isFinite(date.getTime())&&Date.now()-date.getTime()>86400000};
}
