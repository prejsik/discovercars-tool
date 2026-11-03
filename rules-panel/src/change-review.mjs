import { buildRules,knownGroups } from './policy.mjs';

export const LARGE_AMOUNT_FACTOR=3;
export const amountValid=value=>value!==''&&value!=null&&Number.isFinite(Number(value))&&Number(value)>0&&Number(value)<=100000;
export function amountChange(before,after) {
  if(!amountValid(before)||!amountValid(after))return null;
  before=Number(before);after=Number(after);
  return {before,after,delta:Math.round((after-before)*100)/100,percent:(after/before-1)*100,factor:after/before,large:after>=before*LARGE_AMOUNT_FACTOR||after*LARGE_AMOUNT_FACTOR<=before};
}
export const sameConfirmation=(a,b)=>a.ruleId===b.ruleId&&a.before===b.before&&a.after===b.after;
export function requiredConfirmations(model,original) {
  const before=new Map(buildRules(original).map(row=>[row.id,row]));
  return buildRules(model).flatMap(row=>{
    const old=before.get(row.id);const delta=amountChange(old?.amount,row.amount);
    return delta?.large?[{ruleId:row.id,before:delta.before,after:delta.after}]:[];
  });
}
export function confirmedChanges(required,provided=[]) {
  if(!Array.isArray(provided)||required.some(change=>!provided.some(item=>item&&sameConfirmation(item,change))))throw new Error('Potwierdź dokładne kwoty dużych zmian przed zapisem szkicu.');
  return required.map(item=>({...item}));
}
export function ruleScope(model,rule) {
  const points=(model.locations.locations??model.locations).flatMap(point=>point.zones.filter(zone=>(rule.zones.includes('*')||rule.zones.includes(zone))&&(rule.kind==='all'||rule.kind===(point.kind==='airport'?'airport':'city'))));
  const groups=rule.groups.includes('*')?knownGroups(model):rule.groups;
  const active=points.filter(zone=>groups.some(group=>!(model.excel.omitted_group_zones?.[zone]??[]).includes(group)));
  return `${active.length} lokalizacji · ${groups.length} klas · ${rule.minDays}–${rule.maxDays} dni`;
}
export function nextSchedule(plan,now=new Date()) {
  const parts=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(now).split(' ');
  const slots=[...plan].sort((a,b)=>a.time.localeCompare(b.time));if(!slots.length)return null;
  const slot=slots.find(item=>item.time>parts[1])??slots[0];
  const day=slots.some(item=>item.time>parts[1])?parts[0]:new Date(Date.parse(parts[0]+'T12:00:00Z')+86400000).toISOString().slice(0,10);
  return {...slot,date:day};
}
