import React,{useLayoutEffect,useRef} from 'react';
import {CalendarDays} from 'lucide-react';
import {eventsForDay,warsawToday} from './market-model.mjs';
import {locationLabel} from './operations.mjs';
import {signedPrice,weekdayDate,isWeekend} from './visual-format.mjs';

export function AttentionMap({branches,dates,locations,events=[],onOpen}) {
 const viewport=useRef(null),legend=useRef(null);
 useLayoutEffect(()=>{
  const element=viewport.current;
  function fit(){element.style.maxHeight=Math.max(180,innerHeight-element.getBoundingClientRect().top-scrollY-legend.current.offsetHeight-48)+'px';}
  let frame;
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(fit);};
  const observer=new ResizeObserver(schedule);observer.observe(element.closest('.market-workspace'));window.addEventListener('resize',schedule);fit();
  return()=>{observer.disconnect();window.removeEventListener('resize',schedule);cancelAnimationFrame(frame);};
 },[]);
 const today=warsawToday();
 return <>
  <div ref={viewport} className="attention-map-scroll" tabIndex={0} role="region" aria-label="Mapa cen oddziałów według dat startu">
   <table className="attention-map"><thead><tr><th>Oddział</th>{dates.map(date=><th key={date} className={isWeekend(date)?'weekend':''}>{weekdayDate(date,true)}{date===today&&<small>dziś</small>}</th>)}<th title="Liczba dni z brakiem MM w większości długości pasma lub medianą MM − konkurent ponad 10 PLN/dobę">Σ</th></tr></thead>
   <tbody>{branches.map(branch=>{
    const zones=locations.find(item=>item.scraper_label===branch.location)?.zones??[];
    return <tr key={branch.location}><th scope="row"><button title={`${locationLabel(branch.location)} · ${zones[0]??''}`} onClick={()=>onOpen(branch.location)}><span className="map-branch-name">{locationLabel(branch.location)}</span> <span className="code">{zones[0]}</span></button></th>{branch.cells.map(cell=>{
     const entries=eventsForDay(events,cell.date,zones);
     const description=(cell.missing?`Brak MM: ${cell.missing}/${cell.total} sprawdzeń, najem ${cell.missingDurations.join(', ')} dni. `:'')+(cell.tone==='missing'?'Brak oferty MM':cell.tone==='nodata'?'Brak potwierdzonych danych':`MM ${cell.value>0?'droższe':'tańsze'} o ${Math.abs(cell.value).toLocaleString('pl-PL')} PLN/dobę`);
     const label=`${locationLabel(branch.location)}, ${weekdayDate(cell.date)}: ${description}${entries.length?' · '+entries.map(e=>e.title).join(', '):''}`;
     return <td key={cell.date}><button className={`map-cell tone-${cell.tone}`} aria-label={label} title={label} onClick={()=>onOpen(branch.location,cell.date)}>{cell.tone==='missing'?'brak':cell.tone==='nodata'?'?':cell.tone==='neutral'?'·':signedPrice(cell.value,0)}{cell.missing>0&&cell.tone!=='missing'&&<span className="partial-missing-dot" title={`Brak MM dla najmu: ${cell.missingDurations.join(', ')} dni`} aria-hidden="true"/>}{entries.length>0&&<CalendarDays size={12}/>}</button></td>;
    })}<td className="map-total">{branch.problems}</td></tr>;
   })}</tbody></table>
  </div>
  <p ref={legend} className="map-legend">{[['missing','brak MM'],['over-2','+ MM droższe'],['neutral','· do ±5 PLN'],['under-2','− MM tańsze'],['nodata','? brak danych']].map(([tone,label])=><span key={tone}><i className={'legend-square tone-'+tone} aria-hidden="true"/>{label}</span>)}<span><i className="legend-partial" aria-hidden="true"/>częściowy brak MM</span><span>Mediana · PLN/dobę</span></p>
 </>;
}
