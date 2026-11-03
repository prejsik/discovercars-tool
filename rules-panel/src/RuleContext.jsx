import React,{useMemo} from 'react';
import {ArrowLeft,Pencil,X} from 'lucide-react';
import {previewPolicy,buildRules} from './policy.mjs';
import {ruleScope} from './change-review.mjs';
import {dayLabel} from './operations.mjs';
import {money} from './market-model.mjs';

export function RuleContext({query,model,draft,blocked,onEdit,onBack,onClear}) {
 const result=useMemo(()=>previewPolicy(model,query),[model,query]);
 const matching=useMemo(()=>buildRules(model).filter(r=>result.matchedRuleIds.includes(r.id)),[model,result]);
 return <section className="rule-context">
  <div className="market-toolbar"><h2>Minima i ochrona dla pozycji</h2><button className="icon-button" aria-label="Zamknij kontekst pozycji" title="Wszystkie zasady" onClick={onClear}><X size={18}/></button></div>
  <p><strong>{query.group} · {query.zone} · {dayLabel(query.pickupDate)} · {query.duration} dni</strong></p>
  <p className="alert">{draft?'Reguły ze szkicu, jeszcze nieopublikowane.':'Aktualnie wyświetlane reguły.'} To nie jest historyczne uzasadnienie stawki z Excela.</p>
  <p>Minimum reguł: <strong>{money(result.floor)} PLN/dobę</strong> · {result.protected?'Termin chroniony':'Termin niechroniony'} · {result.marketAllowed?'Klasa dopuszczona do zmian rynkowych':'Zmiany rynkowe niedopuszczone'}</p>
  {result.reasons.map((reason,i)=><p className="evidence-note" key={i}>{reason}</p>)}
  {matching.map(rule=><div className="context-rule" key={rule.id}><div><strong>{rule.title}</strong><p>{ruleScope(model,rule)}</p><p>{rule.startDate?dayLabel(rule.startDate):'Bez daty początkowej'} – {rule.endDate?dayLabel(rule.endDate):'bez daty końcowej'}{rule.amount!=null?` · ${money(rule.amount)} PLN/dobę`:''}</p></div><button className="button" disabled={blocked||!rule.editable} onClick={()=>onEdit(rule)}><Pencil size={16}/>Edytuj regułę</button></div>)}
  {!matching.length&&<p>Brak pasujących reguł minimum lub ochrony dat.</p>}
  <details className="technical-details"><summary>Zakres podglądu</summary>{result.limitations.map((text,i)=><p key={i}>{text}</p>)}</details>
  <button className="button" onClick={onBack}><ArrowLeft size={16}/>Wróć do cen</button>
 </section>;
}
