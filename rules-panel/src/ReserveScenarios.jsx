import React,{useEffect,useMemo,useState} from 'react';
import {ChevronRight} from 'lucide-react';
import {matchesReview} from './dashboard-model.mjs';
import {money} from './market-model.mjs';
import {countLabel,locationLabel} from './operations.mjs';
import {weekdayDate} from './visual-format.mjs';

export function ReserveScenarios({rows,location,onSelect}) {
 const matching=useMemo(()=>rows.filter(row=>(!location||row.location===location)&&matchesReview(row,'reserve')).sort((a,b)=>b.gap-a.gap||a.date.localeCompare(b.date)||a.location.localeCompare(b.location,'pl')||a.duration-b.duration),[rows,location]);
 const [limit,setLimit]=useState(20);
 useEffect(()=>{setLimit(20);onSelect(null);},[matching,onSelect]);
 return <section className="attention-view reserve-scenarios" aria-label="Top1 z zapasem ≥30 PLN/d">
  <header><h2>Top1 z zapasem ≥30 PLN/d</h2><p>{countLabel(matching.length,'scenariusz','scenariusze','scenariuszy')} · najem 2–14 dni · największy zapas najpierw</p></header>
  {matching.length?<>
   <table className="attention-table reserve-table"><thead><tr><th>Oddział</th><th>Start najmu</th><th>Najem</th><th>MM · PLN/d</th><th>Konkurent · PLN/d</th><th>Zapas · PLN/d</th><th><span className="sr-only">Szczegóły</span></th></tr></thead><tbody>
    {matching.slice(0,limit).map(row=><tr key={row.key??`${row.location}-${row.date}-${row.duration}`}>
     <td data-label="Oddział">{locationLabel(row.location)}</td><td data-label="Start najmu">{weekdayDate(row.date)}</td><td data-label="Najem">{row.duration} dni</td>
     <td data-label="MM · PLN/d">{money(row.mm)}</td><td data-label="Konkurent · PLN/d">{money(row.competitor)}<small>{row.provider}</small></td><td data-label="Zapas · PLN/d"><strong>{money(row.gap)}</strong></td>
     <td><button className="icon-button" title="Sprawdź scenariusz" aria-label={`Sprawdź scenariusz: ${locationLabel(row.location)}, ${weekdayDate(row.date)}, ${row.duration} dni`} onClick={()=>onSelect(row,matching)}><ChevronRight size={18}/></button></td>
    </tr>)}
   </tbody></table>
   <div className="event-actions"><span>{Math.min(limit,matching.length)} z {matching.length}</span>{limit<matching.length&&<button className="button" onClick={()=>setLimit(value=>value+20)}>Pokaż kolejne 20</button>}</div>
  </>:<p>Brak scenariuszy Top1 z zapasem co najmniej 30 PLN/dobę w wybranym zakresie.</p>}
 </section>;
}
