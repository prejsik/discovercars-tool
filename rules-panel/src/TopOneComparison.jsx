import React,{useMemo,useState} from 'react';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import {money} from './market-model.mjs';
import {groupedLocations} from './panel-format.mjs';
import {weekdayDate} from './visual-format.mjs';

export function TopOneLocations({values,locations,selected,onChange}) {
 const groups=groupedLocations(values,locations);
 const visible=selected?.filter(value=>values.includes(value))??groups.flatMap(group=>group.items.map(item=>item.value)).slice(0,2);
 return <details className="top-one-locations">
  <summary>Oddziały ({visible.length})</summary>
  <div className="top-one-options">{groups.map(group=><fieldset key={group.label}>
   <legend>{group.label}</legend>
   {group.items.map(({value,label})=><label key={value}><input type="checkbox" checked={visible.includes(value)}
    onChange={e=>onChange(e.target.checked?[...visible,value]:visible.filter(item=>item!==value))}/>{label}</label>)}
  </fieldset>)}</div>
 </details>;
}

export function TopOneComparison({data,locations,selected,days,durations,transmission}) {
 const columns=useMemo(()=>{
  const options=groupedLocations(locations,data.locations).flatMap(group=>group.items);
  return selected===null?options.slice(0,2):options.filter(item=>selected.includes(item.value));
 },[data.locations,locations,selected]);
 const [page,setPage]=useState(0);
 const pageSize=7;
 const dates=days.slice(page*pageSize,(page+1)*pageSize);
 const indexed=useMemo(()=>{
  const branches=new Set(columns.map(item=>item.value));
  const lengths=new Set(durations);
  const result=new Map();
  for(const row of data.rows){
   if(row.marketConfirmed&&row.transmission===transmission&&branches.has(row.location)&&lengths.has(row.duration)&&row.date>=days[0]&&row.date<=days.at(-1)){
    result.set(row.key,row);
   }
  }
  return result;
 },[data.rows,columns,days,durations,transmission]);
 if(!columns.length)return <p>Wybierz co najmniej jeden oddział.</p>;
 if(!days.length||!durations.length)return null;
 return <section className="top-one-comparison" aria-label="Stawki Top1">
  <h2>Stawki Top1 · PLN brutto/dobę</h2>
  <div className="top-one-scroll" role="region" aria-label="Stawki według oddziału" tabIndex={0}>
   <table aria-label="Porównanie stawek Top1">
    <thead><tr><th scope="col">Odbiór i najem</th>{columns.map(({value,label})=><th scope="col" key={value}>{label}</th>)}</tr></thead>
    <tbody>{dates.flatMap(date=>durations.map(duration=><tr key={`${date}|${duration}`}>
     <th scope="row">{weekdayDate(date)}<small>{duration} dni</small></th>
     {columns.map(({value})=>{
      const row=indexed.get(`${date}|${duration}|${value}|${transmission}`);
      const mm=Number.isFinite(row?.mm), competitor=Number.isFinite(row?.competitor);
      const own=mm&&(competitor?row.mm<=row.competitor:row.rank===1);
      return <td key={value}>{own||competitor?<><strong>{money(own?row.mm:row.competitor)}</strong><small>{own?'MM Cars Rental':row.provider??'Konkurencja'}</small></>:<span>Brak danych</span>}</td>;
     })}
    </tr>))}</tbody>
   </table>
  </div>
  {days.length>pageSize&&<nav className="top-one-pages" aria-label="Strony porównania">
   <button className="icon-button" aria-label="Poprzednie daty" title="Poprzednie daty" disabled={page===0} onClick={()=>setPage(page-1)}><ChevronLeft size={18}/></button>
   <span>{page+1} / {Math.ceil(days.length/pageSize)}</span>
   <button className="icon-button" aria-label="Kolejne daty" title="Kolejne daty" disabled={(page+1)*pageSize>=days.length} onClick={()=>setPage(page+1)}><ChevronRight size={18}/></button>
  </nav>}
 </section>;
}
