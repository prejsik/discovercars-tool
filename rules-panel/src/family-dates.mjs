import {buildRules,updateRule} from './policy.mjs';
import {groupRuleBands} from './editor.mjs';
export const canEditFamilyDates=family=>family.length>1&&family.every(r=>r.editable&&/^(group|scoped|priority|protected):/.test(r.id));
export function updateFamilyDates(model,ids,{startDate,endDate}){
 const valid=value=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
 if(!valid(startDate)||!valid(endDate)||startDate>endDate)throw new Error('Podaj poprawny początek i koniec okresu.');
 const family=groupRuleBands(buildRules(model)).find(rows=>rows.length===ids.length&&rows.every(r=>ids.includes(r.id)));
 if(!family||!canEditFamilyDates(family))throw new Error('Zakres reguły zmienił się. Otwórz edycję ponownie.');
 return family.reduce((next,row)=>updateRule(next,row.id,{startDate,endDate}),model);
}
