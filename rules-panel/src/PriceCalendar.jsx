import React from 'react';
import {CalendarDays} from 'lucide-react';
import {monthDates,eventsForDay,money,priceTone,warsawToday} from './market-model.mjs';
import {weekdayDate,isWeekend,signedPrice,monthLabel} from './visual-format.mjs';
import {calendarSummary} from './attention-map.mjs';

export function DurationChips({values,onChange}) {
 const chip=d=><button key={d} type="button" aria-pressed={values.includes(d)} onClick={()=>onChange(values.includes(d)?values.filter(n=>n!==d):[...values,d].sort((a,b)=>a-b))}>{d} d</button>;
 return <div className="duration-chips" role="group" aria-label="Długości najmu">{[2,3,4,5,7,10,14].map(chip)}<details><summary>więcej</summary><div>{[6,8,9,11,12,13].map(chip)}</div></details></div>;
}
const shortMoney=value=>Number.isFinite(value)?value.toLocaleString('pl-PL',{maximumFractionDigits:0,notation:value>=10000?'compact':'standard'}):'—';
export function PriceCalendar({month,rows,duration,events,zones,onSelect,reportDates}) {
 const days=monthDates(month),indexed=new Map(rows.map(row=>[row.date,row]));
 const offset=days.length?(new Date(days[0]+'T12:00:00Z').getUTCDay()+6)%7:0;
 const summary=calendarSummary(rows.filter(row=>row.date.startsWith(month)));
 return <section className="market-calendar"><header className="calendar-section-heading"><h2>{monthLabel(month)} · {duration} dni</h2><span>MM Top1: {summary.top1} z {summary.comparable} porównanych dni · średnio {summary.average===null?'brak porównania':signedPrice(summary.average)+' PLN/d'}</span></header>
  <div className="calendar-week">{['Pon','Wt','Śr','Czw','Pt','Sob','Nd'].map(day=><span key={day}>{day}</span>)}</div>
  <div className="market-calendar-grid">{Array.from({length:offset},(_,i)=><span key={i}/>)}{days.map(day=>{
   const row=indexed.get(day),outside=!reportDates.includes(day),enabled=Boolean(row&&!row.missingScenario);
   const missing=row?.marketConfirmed&&row.mm===null;
   const tone=missing?'missing':row?.marketConfirmed&&Number.isFinite(row.gap)?priceTone(-row.gap):'nodata';
   const entries=eventsForDay(events,day,zones);
   const description=outside?'poza raportem':!row?'poza filtrem dat':!row.marketConfirmed?'brak potwierdzonych danych':missing?`brak MM, konkurent ${money(row.competitor)} PLN/d`:`MM ${money(row.mm)}, konkurent ${money(row.competitor)}, różnica ${Number.isFinite(row.gap)?signedPrice(-row.gap)+' PLN/d':'brak porównania'}`;
   return <button key={day} disabled={!enabled} className={`market-day tone-${tone} ${outside||!row?'outside-report':''} ${isWeekend(day)?'weekend':''} ${day===warsawToday()?'today':''}`} aria-label={`${weekdayDate(day)}, ${description}`} onClick={()=>onSelect(row)}><span>{Number(day.slice(8))}{entries.length>0&&<CalendarDays className="event-day-marker" size={12} aria-label={entries.map(e=>e.title).join(', ')}/>}</span>{outside||!row?<small>{outside?'poza raportem':'poza filtrem'}</small>:<><strong>{missing?'brak MM':row.marketConfirmed?shortMoney(row.mm):'?'}</strong><small>konk. {row.marketConfirmed?shortMoney(row.competitor):'?'}</small><small>{Number.isFinite(row.gap)&&row.marketConfirmed?signedPrice(-row.gap,0):'?'}</small></>}</button>;
  })}</div>
 </section>;
}
