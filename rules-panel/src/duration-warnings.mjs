import {DURATION_BANDS,knownGroups,previewPolicy} from './policy.mjs';
export const bandLabel=([a,b])=>a===b?`${a} ${a===1?'dzień':'dni'}`:`${a}–${b} dni`;
export function sampleDates(today){const [y,m]=today.split('-').map(Number);return [today,...Array.from({length:12},(_,i)=>new Date(Date.UTC(y,m+i,1,12)).toISOString().slice(0,10))];}
export function durationWarnings(model,today){
 const found=new Map(),points=model.locations.locations,groups=knownGroups(model);
 for(const point of points)for(const zone of point.zones)for(const group of groups)for(const pickupDate of sampleDates(today)){
  const checks=DURATION_BANDS.map(([duration])=>previewPolicy(model,{zone,group,pickupDate,duration}));
  for(let i=1;i<checks.length;i++){
   const a=checks[i-1],b=checks[i];if(a.omitted||b.omitted||!Number.isFinite(a.floor)||!Number.isFinite(b.floor)||b.floor<=a.floor)continue;
   const key=JSON.stringify([point.kind,zone,group,i,a.floor,b.floor]);
   if(!found.has(key))found.set(key,{kind:point.kind,zone,group,i,before:a.floor,after:b.floor,dates:[]});found.get(key).dates.push(pickupDate);
  }
 }
 const byGroup=new Map();for(const item of found.values()){
  const key=JSON.stringify([item.kind,item.group,item.i,item.before,item.after,item.dates]);
  if(!byGroup.has(key))byGroup.set(key,{...item,zones:[]});byGroup.get(key).zones.push(item.zone);
 }
 const buckets=new Map();for(const item of byGroup.values()){
  item.zones.sort();const key=JSON.stringify([item.kind,item.zones,item.i,item.before,item.after,item.dates]);
  if(!buckets.has(key))buckets.set(key,{...item,groups:[]});buckets.get(key).groups.push(item.group);
 }
 return [...buckets.values()].map(item=>{
  const all=points.filter(p=>p.kind===item.kind).flatMap(p=>p.zones).sort();
  const scope=JSON.stringify(all)===JSON.stringify(item.zones)?item.kind==='airport'?'Lotniska':'Poza lotniskami':item.zones.length>3?`${item.zones.length} lokalizacji`:item.zones.join(', ');
  return {key:JSON.stringify(['duration-floor',item.kind,item.zones,item.groups.sort(),item.i,item.before,item.after]),message:`${scope} · ${item.groups.join(', ')}: ${bandLabel(DURATION_BANDS[item.i-1])} ${item.before} PLN → ${bandLabel(DURATION_BANDS[item.i])} ${item.after} PLN`,dates:item.dates};
 });
}
export function compareDurationWarnings(current,before){const keys=new Set(before.map(r=>r.key));return {added:current.filter(r=>!keys.has(r.key)),known:current.filter(r=>keys.has(r.key))};}
