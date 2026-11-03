import React from 'react';
import { amountChange,amountValid,nextSchedule,sameConfirmation } from './change-review.mjs';
import { money } from './market-model.mjs';

export function AmountField({label,before,value,onChange,ruleId,scope,confirmations,onConfirm,optional=false,autoFocus=false}) {
  const delta=amountChange(before,value);const invalid=!amountValid(value)&&!(optional&&value==='');
  const item=delta?{ruleId,before:delta.before,after:delta.after}:null;
  const checked=item&&confirmations.some(record=>sameConfirmation(record,item));
  const next=nextSchedule(__SCRAPER_PLAN__);
  return <div className="amount-field"><label>{label}<input autoFocus={autoFocus} type="number" min="0.01" max="100000" step="0.01" aria-invalid={invalid} required={!optional} value={value??''} placeholder={optional?'Bez zmian':undefined} onChange={e=>onChange(e.target.value===''?'':Number(e.target.value))}/></label>
    <p className="amount-comparison">{before!=null?`Obecnie ${money(before)} PLN → ${amountValid(value)?money(Number(value)):'—'} PLN`:'Nowa reguła · brak jednej dotychczasowej stawki do porównania'}</p>
    {delta&&delta.delta!==0&&<p className="amount-delta">{delta.delta>0?'+':''}{money(delta.delta)} PLN · {delta.percent>0?'+':''}{delta.percent.toLocaleString('pl-PL',{maximumFractionDigits:2})}%{delta.large&&` · ×${delta.factor.toLocaleString('pl-PL',{maximumFractionDigits:2})}`}</p>}
    {invalid&&<p className="field-error" role="alert">Podaj kwotę większą od 0 i nie większą niż 100 000 PLN.</p>}
    {delta?.large&&<div className="large-amount-warning" role="alert"><strong>Duża zmiana kwoty</strong><p>Zakres reguły: {scope}.</p>{next&&<p>Planowany start: {next.date.split('-').reverse().join('.')} o {next.time}, czas polski. Zmiana dotyczy uruchomień rozpoczętych po publikacji.</p>}<label className="checkbox-label"><input type="checkbox" checked={Boolean(checked)} onChange={e=>onConfirm(item,e.target.checked)}/>Potwierdzam kwotę {money(Number(value))} PLN</label></div>}
  </div>;
}
