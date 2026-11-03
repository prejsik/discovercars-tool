import React,{useEffect,useMemo,useState} from 'react';
import { marketSignals,marketSignalLabels,money,validDate,plusDays,warsawToday } from './market-model.mjs';
import { compareAttention,gapLabel } from './market-review.mjs';

const allDurations=()=>Array.from({length:13},(_,i)=>i+2);
export function AttentionView({data,onSelect,selected,request}) {
  const [location,setLocation]=useState('*');const [kind,setKind]=useState('all');const [transmission,setTransmission]=useState('all');
  const [durations,setDurations]=useState(allDurations);const [from,setFrom]=useState(warsawToday);const [to,setTo]=useState(()=>plusDays(warsawToday(),13));
  const [reason,setReason]=useState(()=>request?.reason??'all');const [sort,setSort]=useState('priority');const [limits,setLimits]=useState({});const [expanded,setExpanded]=useState(new Set());
  const first=warsawToday();const end=plusDays(first,13);
  useEffect(()=>{setLimits({});setExpanded(new Set());onSelect(null);},[location,kind,transmission,durations,from,to,reason,sort,onSelect]);
  const valid=validDate(from)&&validDate(to)&&from<=to;
  const filtered=useMemo(()=>valid?(data?.rows??[]).filter(row=>row.transmission===transmission&&(kind==='all'||row.type===kind)&&(location==='*'||row.location===location)&&durations.includes(row.duration)&&row.date>=from&&row.date<=to):[],[data,kind,location,transmission,durations,from,to,valid]);
  const flagged=useMemo(()=>filtered.map(row=>({...row,signals:marketSignals(row,data?.report)})),[filtered,data]);
  const matches=(row,id)=>id==='all'?row.signals.length:id==='over10'?row.marketConfirmed&&row.gap!=null&&row.gap<-10:row.signals.includes(id);
  const attention=useMemo(()=>flagged.filter(row=>matches(row,reason)).sort((a,b)=>compareAttention(a,b,sort)),[flagged,reason,sort]);
  useEffect(()=>{if(!selected)return;const local=attention.filter(row=>row.location===selected.location);const index=local.findIndex(row=>row.key===selected.key);if(index<0)return;setExpanded(old=>new Set([...old,selected.location]));setLimits(old=>({...old,[selected.location]:Math.max(old[selected.location]??20,Math.ceil((index+1)/20)*20)}));},[selected,attention]);
  const groups=new Map();
  for(const row of attention){if(!groups.has(row.location))groups.set(row.location,{rows:[],visible:[]});groups.get(row.location).rows.push(row);}
  for(const [label,group] of groups)group.visible=group.rows.slice(0,limits[label]??20);
  function reset(){setLocation('*');setKind('all');setTransmission('all');setDurations(allDurations());setFrom(first??'');setTo(end);setReason('all');setSort('priority');}
  return <section className="attention-view" aria-label="Przegląd wszystkich oddziałów">
    <div className="section-title"><h2>Do sprawdzenia</h2><button className="button" disabled={!first} onClick={reset}>Pełny przegląd 14 dni</button></div>
    <p className="evidence-note">Różnica cen nie oznacza możliwości zmiany stawki: mogą obowiązywać minima lub ochrona dat.</p>
    <div className="market-filters">
      <label>Oddziały przeglądu<select value={kind} onChange={e=>{setKind(e.target.value);setLocation('*');}}><option value="all">Wszystkie oddziały</option><option value="airport">Lotniska</option><option value="branch">Poza lotniskami</option></select></label>
      <label>Lokalizacja przeglądu<select value={location} onChange={e=>setLocation(e.target.value)}><option value="*">Wszystkie lokalizacje</option>{[...new Set((data?.rows??[]).filter(row=>kind==='all'||row.type===kind).map(row=>row.location))].sort().map(label=><option key={label}>{label}</option>)}</select></label>
      <label>Skrzynia w przeglądzie<select value={transmission} onChange={e=>setTransmission(e.target.value)}><option value="all">Wszystkie auta</option><option value="automatic">Tylko automaty</option></select></label>
      <details className="duration-select"><summary>Najem w przeglądzie: {durations.length===13?'2–14':durations.join(', ')||'brak'} dni</summary><fieldset><legend>Długości najmu w przeglądzie</legend>{allDurations().map(day=><label key={day}><input type="checkbox" checked={durations.includes(day)} onChange={e=>setDurations(old=>e.target.checked?[...old,day].sort((a,b)=>a-b):old.filter(value=>value!==day))}/>{day} dni</label>)}</fieldset></details>
      <label>Start przeglądu od<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Start przeglądu do<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label>

      <label className="attention-sort">Sortowanie<select value={sort} onChange={e=>setSort(e.target.value)}><option value="priority">Priorytet problemu</option><option value="above">MM droższe o najwięcej</option><option value="gap">Największy zapas do konkurenta</option><option value="date">Najbliższa data</option></select></label>
    </div>
    <div className="reason-filters" role="group" aria-label="Powody sprawdzenia">{[['all','Wszystkie'],['missing','Brak MM'],['outside','Poza Top1'],['over10','MM droższe >10 PLN/d'],['gap30','Top1: zapas ≥30 PLN/d'],['gap20','Top1: zapas 20–29,99 PLN/d'],['unavailable','Brak danych']].map(([id,title])=><button type="button" key={id} className="button" aria-pressed={reason===id} onClick={()=>setReason(id)}>{title} · {flagged.filter(row=>matches(row,id)).length}</button>)}</div>
    {!valid&&<p className="alert error">Wybierz prawidłowy zakres dat.</p>}
    {!durations.length&&<p className="alert">Wybierz co najmniej jedną długość najmu.</p>}
    <p>{filtered.length} sprawdzeń w zakresie · {attention.length} pozycji do sprawdzenia · {groups.size} lokalizacji</p>
    {[...groups].map(([label,group])=>{
      const worst=group.rows.reduce((value,row)=>row.gap==null?value:value==null?row.gap:Math.min(value,row.gap),null);
      return <details className="attention-group" key={label} open={expanded.has(label)}><summary onClick={e=>{e.preventDefault();setExpanded(old=>{const next=new Set(old);next.has(label)?next.delete(label):next.add(label);return next;});}}><strong>{label}</strong><span>{group.rows.length} pozycji · brak danych: {group.rows.filter(row=>row.signals.includes('unavailable')).length} · brak MM: {group.rows.filter(row=>row.signals.includes('missing')).length}</span><span>Najmniej korzystne porównanie: {gapLabel(worst)}</span></summary>
        {expanded.has(label)&&<><p>Pokazano {group.visible.length} z {group.rows.length} pozycji</p><table className="attention-table"><thead><tr><th>Data / najem</th><th>MM / konkurencja</th><th>Różnica cen</th><th>Powód</th><th></th></tr></thead><tbody>{group.visible.map(row=><tr key={row.key} aria-current={selected?.key===row.key?'true':undefined}><td data-label="Data / najem">{row.date}<small>{row.duration} dni</small></td><td data-label="MM / konkurencja">{money(row.mm)} / {money(row.competitor)}<small>{row.provider}</small></td><td className={row.gap<0?'price-above':row.gap>0?'price-below':''} data-label="Różnica cen">{gapLabel(row.gap)}<small>{gapLabel(row.totalGap,true)}</small></td><td data-label="Powód">{row.signals.map(signal=>marketSignalLabels[signal]).join(' · ')}</td><td><button className="text-button" onClick={()=>onSelect(row,attention)}>Szczegóły</button></td></tr>)}</tbody></table>
        {group.visible.length<group.rows.length&&<button className="button" onClick={()=>setLimits(old=>({...old,[label]:(old[label]??20)+20}))}>Pokaż kolejne 20</button>}</>}
      </details>;
    })}
    {valid&&!attention.length&&<p>Brak pozycji spełniających wybrane kryteria.</p>}
  </section>;
}
