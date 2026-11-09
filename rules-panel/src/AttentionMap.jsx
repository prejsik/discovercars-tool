import React,{useLayoutEffect,useRef} from 'react';
import {CalendarDays} from 'lucide-react';
import {eventsForDay,warsawToday} from './market-model.mjs';
import {locationLabel} from './operations.mjs';
import {signedPrice,weekdayDate,isWeekend} from './visual-format.mjs';

export function MarketMap({branches,dates,locations,onOpen,renderCell,legend,summaryLabel,tableLabel,regionLabel}) {
 const viewport=useRef(null),legendRef=useRef(null);
 useLayoutEffect(()=>{
  const element=viewport.current;
  function fit(){
   const mobile=innerWidth<=760,table=element.querySelector('table'),head=table.tHead;
   const gap=parseFloat(getComputedStyle(element.closest('.attention-view')).rowGap)||0,padding=parseFloat(getComputedStyle(element.closest('main')).paddingBottom)||0;
   element.style.maxHeight=mobile?'none':Math.max(180,innerHeight-element.getBoundingClientRect().top-legendRef.current.offsetHeight-gap-padding-2)+'px';
   // Horizontal overflow creates a sticky ancestor; follow page scrolling on mobile.
   const box=table.getBoundingClientRect();head.style.transform=mobile?`translateY(${Math.max(0,Math.min(-box.top,box.height-head.offsetHeight))}px)`:'';
  }
  let frame;
  const schedule=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(fit);};
  const observer=new ResizeObserver(schedule);observer.observe(element.closest('.market-workspace'));window.addEventListener('resize',schedule);window.addEventListener('scroll',schedule,{passive:true});fit();
  return()=>{observer.disconnect();window.removeEventListener('resize',schedule);window.removeEventListener('scroll',schedule);cancelAnimationFrame(frame);};
 },[]);
 const today=warsawToday();
 return <>
  <div ref={viewport} className="attention-map-scroll" tabIndex={0} role="region" aria-label={regionLabel}>
   <table className="attention-map" aria-label={tableLabel}><thead><tr><th scope="col">Oddział</th>{dates.map(date=><th scope="col" key={date} className={isWeekend(date)?'weekend':''}>{weekdayDate(date,true)}{date===today&&<small>dziś</small>}</th>)}{summaryLabel&&<th scope="col" title={summaryLabel}>Σ</th>}</tr></thead>
   <tbody>{branches.map(branch=>{
    const zones=locations.find(item=>item.scraper_label===branch.location)?.zones??[];
    return <tr key={branch.location}><th scope="row"><button title={`${locationLabel(branch.location)} · ${zones[0]??''}`} onClick={()=>onOpen(branch.location)}><span className="map-branch-name">{locationLabel(branch.location)}</span> <span className="code">{zones[0]}</span></button></th>
     {dates.map((date,index)=><td key={date}>{renderCell(branch,date,zones,index)}</td>)}{summaryLabel&&<td className="map-total">{branch.problems}</td>}</tr>;
   })}</tbody></table>
  </div>
  <p ref={legendRef} className="map-legend">{legend}</p>
 </>;
}

export function AttentionMap({branches,dates,locations,events=[],onOpen}) {
 return <MarketMap branches={branches} dates={dates} locations={locations} onOpen={onOpen}
  regionLabel="Mapa cen oddziałów według dat startu"
  summaryLabel="Liczba dni z brakiem MM w większości długości pasma lub medianą MM − konkurent ponad 10 PLN/dobę"
  legend={<>{[['missing','brak MM'],['over-2','+ MM droższe'],['neutral','· do ±5 PLN'],['under-2','− MM tańsze'],['nodata','? brak danych']].map(([tone,label])=><span key={tone}><i className={'legend-square tone-'+tone} aria-hidden="true"/>{label}</span>)}<span><i className="legend-partial" aria-hidden="true"/>częściowy brak MM</span><span>Mediana · PLN/dobę</span></>}
  renderCell={(branch,date,zones,index)=>{
   const cell=branch.cells[index];
   const entries=eventsForDay(events,date,zones);
   const description=(cell.missing?`Brak MM: ${cell.missing}/${cell.total} sprawdzeń, najem ${cell.missingDurations.join(', ')} dni. `:'')+(cell.tone==='missing'?'Brak oferty MM':cell.tone==='nodata'?'Brak potwierdzonych danych':`MM ${cell.value>0?'droższe':'tańsze'} o ${Math.abs(cell.value).toLocaleString('pl-PL')} PLN/dobę`);
   const label=`${locationLabel(branch.location)}, ${weekdayDate(date)}: ${description}${entries.length?' · '+entries.map(e=>e.title).join(', '):''}`;
   return <button className={`map-cell tone-${cell.tone}`} aria-label={label} title={label} onClick={()=>onOpen(branch.location,date)}>{cell.tone==='missing'?'brak':cell.tone==='nodata'?'?':cell.tone==='neutral'?'·':signedPrice(cell.value,0)}{cell.missing>0&&cell.tone!=='missing'&&<span className="partial-missing-dot" title={`Brak MM dla najmu: ${cell.missingDurations.join(', ')} dni`} aria-hidden="true"/>}{entries.length>0&&<CalendarDays size={12}/>}</button>;
  }}/>;
}
