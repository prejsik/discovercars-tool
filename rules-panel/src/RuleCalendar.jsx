import {dayLabel} from './operations.mjs';
import React, { useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight, LockKeyhole, Pencil, CalendarDays } from 'lucide-react';
import { DURATION_BANDS, knownGroups, previewPolicy } from './policy.mjs';
import { locationOptions } from './editor.mjs';
import './price-views.css';
import { CalendarEvents } from './CalendarEvents.jsx';
import { eventsForDay } from './market-model.mjs';
import './market.css';

const today=()=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date());
const label=([low,high])=>low===high?`${low} ${low===1?'dzień':'dni'}`:`${low}–${high} dni`;
export function RuleCalendar({model,rules,onEdit,blocked,draft,calendar}) {
  const zones=useMemo(()=>locationOptions(model),[model]);const groups=useMemo(()=>knownGroups(model),[model]);
  const [zone,setZone]=useState(zones.find(row=>row.value==='KRLO')?.value??zones[0]?.value??'');
  const [group,setGroup]=useState(groups.includes('CDMV')?'CDMV':groups[0]??'');
  const [duration,setDuration]=useState(3);const [month,setMonth]=useState(today().slice(0,7));const [day,setDay]=useState(today());
  const dates=useMemo(()=>{
    const [year,m]=month.split('-').map(Number);const count=new Date(Date.UTC(year,m,0)).getUTCDate();
    return Array.from({length:count},(_,i)=>`${month}-${String(i+1).padStart(2,'0')}`);
  },[month]);
  const selected=dates.includes(day)?day:dates[0];
  const checks=useMemo(()=>dates.map(pickupDate=>previewPolicy(model,{zone,group,duration,pickupDate})),[model,zone,group,duration,dates]);
  const result=checks[dates.indexOf(selected)];
  const counts=new Map();checks.forEach(c=>counts.set(c.floor,(counts.get(c.floor)??0)+1));
  const typical=[...counts].sort((a,b)=>b[1]-a[1])[0]?.[0];
  const allBands=useMemo(()=>DURATION_BANDS.map(([low])=>previewPolicy(model,{zone,group,duration:low,pickupDate:selected})),[model,zone,group,selected]);
  const matched=rules.filter(rule=>result.matchedRuleIds.includes(rule.id));
  const offset=(new Date(`${dates[0]}T12:00:00Z`).getUTCDay()+6)%7;
  const shift=step=>{const [year,m]=month.split('-').map(Number);setMonth(new Date(Date.UTC(year,m-1+step,1)).toISOString().slice(0,7));};
  return <section className="rule-calendar-view" aria-label="Kalendarz reguł">
    <div className="price-context"><h2>Kalendarz reguł</h2><span>{draft?'Szkic · nieopublikowane zmiany':'Opublikowane zasady'} · daty startu najmu</span></div>
    <div className="price-filters"><label>Lokalizacja<select value={zone} onChange={e=>setZone(e.target.value)}>{zones.map(row=><option key={row.value} value={row.value}>{row.label}</option>)}</select></label><label>Klasa<select value={group} onChange={e=>setGroup(e.target.value)}>{groups.map(code=><option key={code}>{code}</option>)}</select></label><label>Przedział najmu<select value={duration} onChange={e=>setDuration(Number(e.target.value))}>{DURATION_BANDS.map(band=><option key={band[0]} value={band[0]}>{label(band)}</option>)}</select></label></div>
    <div className="calendar-month"><button className="icon-button" aria-label="Poprzedni miesiąc" title="Poprzedni miesiąc" onClick={()=>shift(-1)}><ChevronLeft size={20}/></button><label>Miesiąc<input type="month" value={month} onChange={e=>{if(/^\d{4}-(0[1-9]|1[0-2])$/.test(e.target.value)&&Number(e.target.value.slice(0,4))>=1900&&Number(e.target.value.slice(0,4))<=2200)setMonth(e.target.value);}}/></label><button className="icon-button" aria-label="Następny miesiąc" title="Następny miesiąc" onClick={()=>shift(1)}><ChevronRight size={20}/></button></div>
    <div className="calendar-week" aria-hidden="true">{['Pon','Wt','Śr','Czw','Pt','Sob','Nd'].map(name=><span key={name}>{name}</span>)}</div>
    <div className="rule-calendar">{Array.from({length:offset},(_,i)=><span key={`blank-${i}`}/>)}{dates.map((date,i)=>{const check=checks[i];const entries=eventsForDay(calendar?.items??[],date,[zone]);const value=check.omitted?'Pominięta':check.protected?'Ochrona':check.floor!==null?`${check.floor} PLN`:'Z bazy';return <button key={date} className={`calendar-day ${check.protected?'protected-day':check.floor===typical&&!check.matchedRuleIds.some(id=>rules.find(r=>r.id===id)?.overrideProtected)?'typical-day':'exception-day'}`} aria-label={`${dayLabel(date)}, ${value}`} aria-pressed={date===selected} onClick={()=>setDay(date)}><span>{Number(date.slice(-2))}{entries.length>0&&<CalendarDays className="event-day-marker" size={12} aria-label={entries.map(e=>e.title).join(', ')}/>}</span>{check.protected?<LockKeyhole size={16} aria-hidden="true"/>:<strong>{check.omitted?'—':check.floor??'—'}</strong>}</button>;})}</div>
    <p className="evidence-note">Kwoty: minimum PLN / dobę. Kłódka: chroniona data. Kreska: brak samodzielnego minimum lub pominięta pozycja.</p>
    {calendar?.error&&<p className="freshness-warning">Nie potwierdzono oznaczeń wydarzeń. {calendar.error}</p>}
    <section aria-live="polite" className="calendar-selection"><h3>{dayLabel(selected)} · {group} / {zone}</h3>
      <p>{result.omitted?'Pozycja pomijana w Excelu':result.protected?'Data chroniona':result.marketAllowed?'Zmiany rynkowe dozwolone':'Zmiany rynkowe wyłączone'}</p>
      {eventsForDay(calendar?.items??[],selected,[zone]).map(event=><p key={event.id}><CalendarDays size={15}/> {event.title} · notatka, nie reguła cenowa{event.notes?` · ${event.notes}`:''}</p>)}
      {result.reasons.map((reason,i)=><p key={i}>{reason}</p>)}
      <h4>Pasujące reguły</h4>{matched.length?matched.map(rule=><div className="calendar-rule" key={rule.id}><div><strong>{rule.title}</strong><small>{rule.startDate?dayLabel(rule.startDate):'Bez początku'} – {rule.endDate?dayLabel(rule.endDate):'Bez końca'}{rule.amount!=null?` · ${rule.amount} PLN`:''}</small></div>{rule.editable&&<button className="icon-button" aria-label={`Edytuj ${rule.title}`} title="Edytuj regułę" disabled={blocked} onClick={()=>onEdit(rule)}><Pencil size={17}/></button>}</div>):<p>Brak pasujących reguł minimum.</p>}
      <h4>Minimum według długości najmu</h4><dl className="source-list">{allBands.map((check,i)=><div key={i}><dt>{label(DURATION_BANDS[i])}</dt><dd>{check.floor===null?'Brak minimum':`${check.floor} PLN / dobę`}{check.protected?' · ochrona daty':''}{check.omitted?' · pozycja pomijana':''}</dd></div>)}</dl><details className="technical-details"><summary>Ograniczenia podglądu</summary>{result.limitations.map((text,i)=><p key={i}>{text}</p>)}</details>
    </section>
    {calendar&&<details><summary>Wydarzenia i święta</summary><CalendarEvents calendar={calendar} model={model}/></details>}
  </section>;
}
