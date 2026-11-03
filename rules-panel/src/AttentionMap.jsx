import React from 'react';
import {CalendarDays} from 'lucide-react';
import {eventsForDay,warsawToday} from './market-model.mjs';
import {locationLabel} from './operations.mjs';
import {signedPrice,weekdayDate,isWeekend} from './visual-format.mjs';

export function AttentionMap({branches,dates,locations,events=[],onOpen}) {
 const today=warsawToday();
 return <>
  <p className="map-legend"><span className="price-badge tone-missing">brak MM</span><span className="price-badge tone-over-2">+ MM droższe</span><span className="price-badge tone-neutral">· do ±5 PLN</span><span className="price-badge tone-under-2">− MM tańsze</span><span className="price-badge tone-nodata">? brak danych</span><span>PLN/dobę · najgorsza różnica w dniu</span></p>
  <div className="attention-map-scroll" tabIndex={0} role="region" aria-label="Mapa cen oddziałów według dat startu">
   <table className="attention-map"><thead><tr><th>Oddział</th>{dates.map(date=><th key={date} className={isWeekend(date)?'weekend':''}>{weekdayDate(date,true)}{date===today&&<small>dziś</small>}</th>)}<th title="Liczba dni z brakiem MM lub różnicą ponad 10 PLN">Σ</th></tr></thead>
   <tbody>{branches.map(branch=>{
    const zones=locations.find(item=>item.scraper_label===branch.location)?.zones??[];
    return <tr key={branch.location}><th scope="row"><button onClick={()=>onOpen(branch.location)}>{locationLabel(branch.location)} <span className="code">{zones[0]}</span></button></th>{branch.cells.map(cell=>{
     const entries=eventsForDay(events,cell.date,zones);
     const description=cell.tone==='missing'?'Brak oferty MM':cell.tone==='nodata'?'Brak potwierdzonych danych':`MM ${cell.value>0?'droższe':'tańsze'} o ${Math.abs(cell.value).toLocaleString('pl-PL')} PLN/dobę`;
     return <td key={cell.date}><button className={`map-cell tone-${cell.tone}`} aria-label={`${locationLabel(branch.location)}, ${weekdayDate(cell.date)}: ${description}${entries.length?' · '+entries.map(e=>e.title).join(', '):''}`} onClick={()=>onOpen(branch.location,cell.date)}>{cell.tone==='missing'?'brak':cell.tone==='nodata'?'?':cell.tone==='neutral'?'·':signedPrice(cell.value,0)}{entries.length>0&&<CalendarDays size={12}/>}</button></td>;
    })}<td className="map-total">{branch.problems}</td></tr>;
   })}</tbody></table>
  </div>
 </>;
}
