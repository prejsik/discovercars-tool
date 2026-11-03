import React, { useState } from 'react';
import { History, RotateCcw } from 'lucide-react';
import { timestamp } from './display.mjs';

const short = value => value ? String(value).slice(0,12) : 'Brak danych';
const actionLabels = {save:'Zapis szkicu',approval_pending:'Rozpoczęcie zatwierdzenia',publish:'Publikacja konfiguracji',rollback:'Przywrócenie do szkicu'};
const fieldLabel = path => ({
  'pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.airport':'Minimum lotniska (PLN/dobę)',
  'pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind.city':'Minimum poza lotniskami (PLN/dobę)',
  'excel.apply_groups':'Klasy dopuszczone do rekomendacji',
  'excel.excluded_groups':'Klasy wyłączone z rekomendacji',
  'pricing.pricing.mandatoryScopedFloorsPlnDay':'Minima dla wybranych klas i lokalizacji',
  'pricing.pricing.protectedPickupDateRanges':'Chronione terminy',
}[path] ?? path);
const valueLabel = value => value == null ? 'Brak' : typeof value === 'boolean' ? value ? 'Tak' : 'Nie' : typeof value === 'object' ? JSON.stringify(value) : String(value);

export function SharedHistory({workspace,busy,blocked,onRollback}) {
  const [all,setAll] = useState(false);
  const history = [...workspace.history].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at));
  const items = all ? history : history.filter(item=>item.action==='publish');
  return <section className="history-view">
    <div className="section-title"><h2>{all?'Pełny dziennik':'Opublikowane zmiany'}</h2><span>{items.length} wpisów</span></div>
    <label className="history-filter"><input type="checkbox" checked={all} onChange={e=>setAll(e.target.checked)}/>Pokaż również szkice i kroki techniczne</label>
    {items.length ? <ol className="history-list">{items.map(item=><li key={`${item.revision}:${item.at}:${item.action}`}>
      <span className="history-icon"><History size={16}/></span>
      <div className="history-content"><strong>{item.reason||'Bez podanego powodu'}</strong><span>{timestamp(item.at)} · {item.actor} · {actionLabels[item.action]??item.action}</span>
        {item.changes?.length>0 ? <details className="history-diff"><summary>Co zmieniono · {item.changes.length} pól</summary><table><thead><tr><th>Pole</th><th>Przed</th><th>Po</th></tr></thead><tbody>{item.changes.map((change,i)=><tr key={i}><th scope="row">{fieldLabel(change.path)}</th><td>{valueLabel(change.before)}</td><td>{valueLabel(change.after)}</td></tr>)}</tbody></table></details> : <p className="evidence-note">Ten zapis nie zawiera szczegółowego porównania.</p>}
        <details className="technical-details"><summary>Szczegóły techniczne</summary><span>Rewizja {short(item.revision)} · źródło {short(item.sourceRevision)}</span></details>
      </div>
      <button className="icon-button" disabled={busy||blocked||!workspace.capabilities.sharedDraft} title="Przygotuj szkic z tej wersji" aria-label={`Przygotuj szkic z wersji ${item.revision}`} onClick={()=>onRollback(item.revision)}><RotateCcw size={18}/></button>
    </li>)}</ol> : <p className="empty-copy">{all?'Brak zapisów współdzielonych.':'Brak publikacji w dostępnej historii. Szkice są w pełnym dzienniku.'}</p>}
  </section>;
}
