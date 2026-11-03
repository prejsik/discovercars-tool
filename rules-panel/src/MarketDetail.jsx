import React,{useEffect,useRef} from 'react';
import { CalendarDays,ChevronUp,ChevronDown,ExternalLink,FileSpreadsheet,X } from 'lucide-react';
import { eventsForDay,money,scenarioLink } from './market-model.mjs';
import {InlineDecision} from './InlineDecision.jsx';
import {locationLabel} from './operations.mjs';
import {weekdayDate} from './visual-format.mjs';
import { gapLabel } from './market-review.mjs';

export function MarketDetail({row,data,calendar,onExcel,canExplain,onClose,neighbors,onSelect,model,workspace,service,onRules}) {
  const dialog=useRef(null);const heading=useRef(null);const previous=useRef(document.activeElement);
  const index=neighbors.findIndex(item=>item.date===row.date&&item.duration===row.duration&&item.location===row.location);
  function move(offset){const next=neighbors[index+offset];if(next)onSelect(next,neighbors);}
  useEffect(()=>{
    const element=dialog.current;const media=matchMedia('(min-width:1024px)');
    function open(){if(element.open)element.close();media.matches?element.show():element.showModal();heading.current?.focus({preventScroll:true});}
    open();media.addEventListener('change',open);
    return ()=>{media.removeEventListener('change',open);element.close();previous.current?.focus({preventScroll:true});};
  },[]);
  useEffect(()=>{heading.current?.focus({preventScroll:true});},[row.key,row.date,row.duration]);
  return <dialog ref={dialog} className="market-detail" aria-labelledby="market-detail-title" onCancel={e=>{e.preventDefault();onClose();}} onClick={e=>{if(e.target===dialog.current){const box=dialog.current.getBoundingClientRect();if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)onClose();}}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();onClose();}else if(!e.altKey&&!e.ctrlKey&&!e.metaKey&&!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();move(e.key==='ArrowUp'?-1:1);}}}>
    <header className="market-detail-header"><div><h2 id="market-detail-title" ref={heading} tabIndex={-1}>{weekdayDate(row.date)} · {row.duration} dni</h2><p>{locationLabel(row.location)||'Poza wybranym zakresem'} · {row.transmission==='automatic'?'Automaty':'Wszystkie auta'}</p></div><button type="button" className="icon-button" aria-label="Zamknij szczegóły" onClick={onClose}><X size={20}/></button></header>
    <p className={`gap-value ${row.gap<0?'above':row.gap>0?'below':''}`}>{row.marketConfirmed&&row.mm===null?`Brak oferty MM · konkurent ${money(row.competitor)} PLN/d`:gapLabel(row.gap)}{row.mm!==null&&<small>{gapLabel(row.totalGap,true)}</small>}</p>
    <dl className="source-list"><div><dt>MM Cars · PLN/dobę</dt><dd>{money(row.mm)}</dd></div><div><dt>Najtańszy konkurent · PLN/dobę</dt><dd>{money(row.competitor)} · {row.provider??'Brak danych'}</dd></div><div><dt>Pozycja MM / tańsze oferty</dt><dd>{row.rankLabel??'Brak danych'} / {row.cheaperOffers??'Brak danych'}</dd></div></dl>
    {!row.marketConfirmed&&<p className="alert">Brak potwierdzonych cen. To nie potwierdza braku samochodów.</p>}
    {eventsForDay(calendar.items,row.date,data.locations.find(item=>item.scraper_label===row.location)?.zones??[]).map(event=><p key={event.id}><CalendarDays size={14}/> {event.title}{event.notes?` · ${event.notes}`:''}</p>)}
    <div className="event-actions">{row.location&&<a className="button primary" href={scenarioLink(data.report.runId,row)} target="_blank" rel="noreferrer"><ExternalLink size={16}/>Scenariusz w raporcie</a>}{canExplain&&<button type="button" className="button" onClick={onExcel}><FileSpreadsheet size={16}/>Pełna tabela stawek</button>}</div>
    <InlineDecision onRules={onRules} key={row.key??`${row.location}-${row.date}-${row.duration}`} row={row} data={data} model={model} workspace={workspace} service={service}/><nav className="detail-navigation" aria-label="Sąsiednie pozycje"><button type="button" className="button" disabled={index<=0} onClick={()=>move(-1)}><ChevronUp size={16}/>Poprzednia</button><button type="button" className="button" disabled={index<0||index>=neighbors.length-1} onClick={()=>move(1)}><ChevronDown size={16}/>Następna</button></nav>
  </dialog>;
}
