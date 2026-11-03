import { buildRules,knownGroups,validateModel } from './policy.mjs';

const has=(values,value)=>values.includes('*')||values.includes(value);
const identity=row=>JSON.stringify([row.category,row.title,row.groups,row.zones,row.kind,row.startDate,row.endDate]);
const datesOverlap=(a,b)=>(a.startDate||'0000')<=(b.endDate||'9999')&&(b.startDate||'0000')<=(a.endDate||'9999');
const bandOverlap=(a,b)=>a.minDays<=b.maxDays&&b.minDays<=a.maxDays;
const name=row=>`${row.title}${row.zones.includes('*')?'':` (${row.zones.join(', ')})`}`;

// Presentation only: policy validation and the pricing engine retain their original results.
export function presentWarnings(model,raw=validateModel(model,model).warnings) {
  const rows=buildRules(model);const groups=knownGroups(model);const points=model.locations.locations??model.locations;
  const zones=points.flatMap(point=>point.zones.map(zone=>({zone,kind:point.kind==='airport'?'airport':'city'})));
  const result=new Map();
  const applies=(row,zone,group)=>has(row.zones,zone.zone)&&has(row.groups,group)&&(row.kind==='all'||row.kind===zone.kind)&&!(model.excel.omitted_group_zones?.[zone.zone]??[]).includes(group);
  for(const warning of raw){
    if(/Nakładające się minima|Okresy ochrony dat odbioru nakładają|Reguły priorytetowe nakładają/.test(warning.message))continue;
    const row=rows.find(item=>item.id===warning.path);const key=JSON.stringify([row?identity(row):warning.path,warning.message]);
    result.set(key,{key,message:row?`${name(row)}: ${warning.message}`:warning.message});
  }
  for(const category of ['mandatory','protected','priority']){
    const candidates=rows.filter(row=>row.category===category);
    for(let i=0;i<candidates.length;i++)for(const b of candidates.slice(i+1)){
      const a=candidates[i];
      if(!datesOverlap(a,b)||category!=='protected'&&!bandOverlap(a,b))continue;
      if(category==='mandatory'&&!a.id.startsWith('scoped:')&&a.id.split(':').slice(0,2).join(':')===b.id.split(':').slice(0,2).join(':'))continue;
      if(category!=='protected'&&!zones.some(zone=>groups.some(group=>applies(a,zone,group)&&applies(b,zone,group))))continue;
      const key=JSON.stringify([identity(a),identity(b)].sort());
      const band=`${Math.max(a.minDays,b.minDays)}–${Math.min(a.maxDays,b.maxDays)} dni`;
      if(!result.has(key))result.set(key,{key,message:`${name(a)} i ${name(b)}: ${category==='protected'?'ochronie podlega łączny zakres':category==='priority'?'obowiązuje pierwsza pasująca reguła':'obowiązuje najwyższa pasująca stawka, nie suma'}`,bands:[]});
      if(!result.get(key).bands.includes(band))result.get(key).bands.push(band);
    }
  }
  return [...result.values()].map(item=>({...item,message:item.bands?.length?`${item.message} · ${item.bands.join(', ')}`:item.message}));
}
export function warningChanges(model,original) {
  const before=new Set(presentWarnings(original).map(item=>item.key));const current=presentWarnings(model);
  return {added:current.filter(item=>!before.has(item.key)),known:current.filter(item=>before.has(item.key))};
}
