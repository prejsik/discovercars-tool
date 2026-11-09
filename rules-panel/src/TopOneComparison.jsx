import React,{useMemo} from 'react';
import {CalendarDays} from 'lucide-react';
import {MarketMap} from './AttentionMap.jsx';
import {eventsForDay,money} from './market-model.mjs';
import {locationLabel} from './operations.mjs';
import {groupedLocations} from './panel-format.mjs';
import {weekdayDate} from './visual-format.mjs';

export function TopOneLocations({values,locations,selected,onChange}) {
 const groups=groupedLocations(values,locations);
 const visible=selected?.filter(value=>values.includes(value))??values;
 return <details className="top-one-locations">
  <summary>{visible.length===values.length?'Wszystkie oddziały':`Oddziały (${visible.length})`}</summary>
  <div className="top-one-options">
   <div className="top-one-option-actions">
    <button type="button" className="text-button" onClick={()=>onChange(null)}>Wszystkie oddziały</button>
    <button type="button" className="text-button" onClick={()=>onChange([])}>Wyczyść wybór</button>
   </div>
   {groups.map(group=><fieldset key={group.label}>
   <legend>{group.label}</legend>
   {group.items.map(({value,label})=><label className="checkbox-label" key={value}><input type="checkbox" checked={visible.includes(value)}
    onChange={e=>onChange(e.target.checked?[...visible,value]:visible.filter(item=>item!==value))}/><span>{label}</span></label>)}
  </fieldset>)}</div>
 </details>;
}

export function TopOneComparison({data,locations,selected,days,durations,transmission,events,onOpen,onSelect}) {
 const branches=useMemo(()=>{
  const options=groupedLocations(locations,data.locations).flatMap(group=>group.items);
  return options.filter(item=>selected===null||selected.includes(item.value)).map(item=>({location:item.value}));
 },[data.locations,locations,selected]);
 const reportDates=useMemo(()=>new Set(data.report.startDates),[data.report.startDates]);
 const indexed=useMemo(()=>{
  const selectedBranches=new Set(branches.map(item=>item.location));
  const selectedDates=new Set(days);
  const lengths=new Set(durations);
  const result=new Map();
  for(const row of data.rows){
   if(row.marketConfirmed&&row.transmission===transmission&&selectedBranches.has(row.location)&&lengths.has(row.duration)&&selectedDates.has(row.date)){
    result.set(row.key,row);
   }
  }
  return result;
 },[data.rows,branches,days,durations,transmission]);
 if(!branches.length)return <p>Wybierz co najmniej jeden oddział.</p>;
 if(!days.length||!durations.length)return null;
 return <section className="attention-view top-one-comparison" aria-label="Stawki Top1">
  <h2>Stawki Top1</h2>
  <MarketMap branches={branches} dates={days} locations={data.locations} onOpen={onOpen}
   tableLabel="Porównanie stawek Top1" regionLabel="Mapa stawek Top1 według dat startu"
   legend={<><span><i className="legend-square tone-under-2" aria-hidden="true"/>MM Cars Rental</span><span><i className="legend-square tone-neutral" aria-hidden="true"/>Konkurencja</span><span><i className="legend-square tone-nodata" aria-hidden="true"/>? brak danych</span><span>Top1 · PLN brutto/dobę</span></>}
   renderCell={({location},date,zones)=>{
    if(!reportDates.has(date))return <span className="map-cell tone-nodata" title="Brak danych" role="img" aria-label="Brak danych">?</span>;
    const entries=eventsForDay(events,date,zones);
    return <div className="top-one-quotes">{durations.map((duration,index)=>{
     const row=indexed.get(`${date}|${duration}|${location}|${transmission}`);
     const mm=Number.isFinite(row?.mm),competitor=Number.isFinite(row?.competitor);
     const own=mm&&(competitor?row.mm<=row.competitor:row.rank===1);
     const available=own||competitor;
     const rate=available?money(own?row.mm:row.competitor):'?';
     const provider=own?'MM Cars Rental':row?.provider??'Konkurencja';
     const label=`${locationLabel(location)}, ${weekdayDate(date)}, ${duration} ${duration===1?'dzień':'dni'}: ${available?`${rate} PLN/dobę · ${provider}`:'Brak danych'}${entries.length?' · '+entries.map(e=>e.title).join(', '):''}`;
     const content=<>{durations.length>1&&<small>{duration} d</small>}<strong>{rate}</strong>{index===0&&entries.length>0&&<CalendarDays size={12} aria-hidden="true"/>}</>;
     return available?<button key={duration} className={`map-cell tone-${own?'under-2':'neutral'}`} aria-label={label} title={label}
      onClick={()=>onSelect(row,days.map(day=>indexed.get(`${day}|${duration}|${location}|${transmission}`)).filter(Boolean))}>{content}</button>
     :<span key={duration} className="map-cell tone-nodata" role="img" aria-label={label} title={label}>{content}</span>;
    })}</div>;
   }}/>
 </section>;
}
