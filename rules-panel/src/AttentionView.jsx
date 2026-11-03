import React,{useEffect,useMemo,useState} from 'react';
import { marketSignals,marketSignalLabels,money,validDate,plusDays,warsawToday } from './market-model.mjs';
import { compareAttention,gapLabel } from './market-review.mjs';

const allDurations=()=>Array.from({length:13},(_,i)=>i+2);
export function AttentionView({data,onSelect,selected}) {
  const [location,setLocation]=useState('*');const [kind,setKind]=useState('all');const [transmission,setTransmission]=useState('all');
  const [durations,setDurations]=useState(allDurations);const [from,setFrom]=useState('');const [to,setTo]=useState('');
  const [reason,setReason]=useState('all');const [sort,setSort]=useState('priority');const [limits,setLimits]=useState({});const [expanded,setExpanded]=useState(new Set());
  const dates=useMemo(()=>[...new Set((data?.rows??[]).map(row=>row.date))].sort(),[data]);
  const first=dates.find(day=>day>=warsawToday())??dates[0];
  const end=first?[plusDays(first,13),dates.at(-1)].sort()[0]:'';
  useEffect(()=>{if(first){setFrom(old=>old||first);setTo(old=>old||end);}},[first,end]);
  useEffect(()=>{setLimits({});setExpanded(new Set());onSelect(null);},[location,kind,transmission,durations,from,to,reason,sort,onSelect]);
  const valid=validDate(from)&&validDate(to)&&from<=to;
  const filtered=useMemo(()=>valid?(data?.rows??[]).filter(row=>row.transmission===transmission&&(kind==='all'||row.type===kind)&&(location==='*'||row.location===location)&&durations.includes(row.duration)&&row.date>=from&&row.date<=to):[],[data,kind,location,transmission,durations,from,to,valid]);
  const attention=useMemo(()=>filtered.map(row=>({...row,signals:marketSignals(row,data.report)})).filter(row=>reason==='all'?row.signals.length:row.signals.includes(reason)).sort((a,b)=>compareAttention(a,b,sort)),[filtered,data,reason,sort]);
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
      <label>Powód sprawdzenia<select value={reason} onChange={e=>setReason(e.target.value)}><option value="all">Wszystkie powody</option>{Object.entries(marketSignalLabels).map(([id,label])=><option key={id} value={id}>{label}</option>)}</select></label>
      <label className="attention-sort">Sortowanie<select value={sort} onChange={e=>setSort(e.target.value)}><option value="priority">Priorytet problemu</option><option value="above">MM droższe o najwięcej</option><option value="gap">Największy zapas do konkurenta</option><option value="date">Najbliższa data</option></select></label>
    </div>
    {!valid&&<p className="alert error">Wybierz prawidłowy zakres dat.</p>}
    {!durations.length&&<p className="alert">Wybierz co najmniej jedną długość najmu.</p>}
    <p>{filtered.length} sprawdzeń w zakresie · {attention.length} pozycji do sprawdzenia · {groups.size} lokalizacji</p>
    {[...groups].map(([label,group])=>{
      const worst=group.rows.reduce((value,row)=>row.gap==null?value:value==null?row.gap:Math.min(value,row.gap),null);
      return <details className="attention-group" key={label} open={expanded.has(label)}><summary onClick={e=>{e.preventDefault();setExpanded(old=>{const next=new Set(old);next.has(label)?next.delete(label):next.add(label);return next;});}}><strong>{label}</strong><span>{group.rows.length} pozycji · brak danych: {group.rows.filter(row=>row.signals.includes('unavailable')).length} · brak MM: {group.rows.filter(row=>row.signals.includes('missing')).length}</span><span>Najmniej korzystne porównanie: {gapLabel(worst)}</span></summary>
        {expanded.has(label)&&<><p>Pokazano {group.visible.length} z {group.rows.length} pozycji</p><table className="attention-table"><thead><tr><th>Data / najem</th><th>MM / konkurencja</th><th>Różnica cen</th><th>Powód</th><th></th></tr></thead><tbody>{group.visible.map(row=><tr key={row.key} aria-current={selected?.key===row.key?'true':undefined}><td data-label="Data / najem">{row.date}<small>{row.duration} dni</small></td><td data-label="MM / konkurencja">{money(row.mm)} / {money(row.competitor)}<small>{row.provider}</small></td><td data-label="Różnica cen">{gapLabel(row.gap)}<small>{gapLabel(row.totalGap,true)}</small></td><td data-label="Powód">{row.signals.map(signal=>marketSignalLabels[signal]).join(' · ')}</td><td><button className="text-button" onClick={()=>onSelect(row,attention)}>Szczegóły</button></td></tr>)}</tbody></table>
        {group.visible.length<group.rows.length&&<button className="button" onClick={()=>setLimits(old=>({...old,[label]:(old[label]??20)+20}))}>Pokaż kolejne 20</button>}</>}
      </details>;
    })}
    {valid&&!attention.length&&<p>Brak pozycji spełniających wybrane kryteria.</p>}
  </section>;
}
