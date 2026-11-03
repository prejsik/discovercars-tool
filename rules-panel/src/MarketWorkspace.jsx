import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChartLine, ChevronLeft, ChevronRight, ExternalLink, FileSpreadsheet, ListFilter, Search } from 'lucide-react';
import {ViewTabs} from './ViewTabs.jsx';
import { MarketDetail } from './MarketDetail.jsx';
import { AttentionView } from './AttentionView.jsx';
import { gapLabel,priceScale } from './market-review.mjs';
import { PricesView } from './PricesView.jsx';
import { CalendarEvents } from './CalendarEvents.jsx';
import { timestamp } from './display.mjs';
import { dateRange, eventsForDay, lineSegments, money, monthDates, plusDays, scenarioLink, validDate, warsawToday } from './market-model.mjs';
import './market.css';
import {locationLabel} from './operations.mjs';

const dayLabel=day=>`${day.slice(8)}.${day.slice(5,7)}.${day.slice(0,4)}`;
const shortMoney=value=>value===null?'—':new Intl.NumberFormat('pl-PL',{maximumFractionDigits:0,notation:value>=10000?'compact':'standard'}).format(value);
const tabs=[['attention','Do sprawdzenia',ListFilter],['chart','Wykres',ChartLine],['calendar','Kalendarz cen',CalendarDays],['excel','Stawki w Excelu',FileSpreadsheet]];

export function MarketWorkspace({model,workspace,service,calendar,market,request,onRules}) {
  const [view,setView]=useState('attention');const {data,busy,error,load}=market;const handledRequest=useRef(null);
  const [kind,setKind]=useState('airport');const [location,setLocation]=useState('Krakow Airport (KRK)');const [transmission,setTransmission]=useState('all');
  const [durations,setDurations]=useState([3]);const [from,setFrom]=useState('');const [to,setTo]=useState('');const [month,setMonth]=useState(warsawToday().slice(0,7));
  const [selected,setSelected]=useState(null);const neighbors=useRef([]);const selectRow=useCallback((row,items=[])=>{neighbors.current=items;setSelected(row);},[]);
  const [excelVisited,setExcelVisited]=useState(false);const [excelZone,setExcelZone]=useState('KRLO');const [excelDuration,setExcelDuration]=useState(3);
  const marketLocations=model.locations.locations??model.locations;
  useEffect(()=>{if(view==='excel')setExcelVisited(true);},[view]);
  useEffect(()=>{const zones=marketLocations.find(l=>l.scraper_label===location)?.zones??[];setExcelZone(old=>zones.includes(old)?old:zones[0]??'');},[location,model.locations]);
  const excelSelection={zone:excelZone,duration:durations.includes(excelDuration)?excelDuration:durations[0]??3,transmission,from,to};
  function changeExcel(patch) {
    if ('zone' in patch) {setExcelZone(patch.zone);const item=marketLocations.find(l=>l.zones.includes(patch.zone));if(item){setLocation(item.scraper_label);setKind(item.kind==='airport'?'airport':'branch');}}
    if ('duration' in patch) {setExcelDuration(patch.duration);setDurations([patch.duration]);}
    if ('transmission' in patch) setTransmission(patch.transmission);
    if ('from' in patch) {setFrom(patch.from);if(validDate(patch.from))setMonth(patch.from.slice(0,7));}
    if ('to' in patch) setTo(patch.to);
  }
  const report=workspace?.status?.report;
  useEffect(()=>{if(!data)return;const dates=[...new Set(data.rows.map(row=>row.date))].sort();const first=dates.find(day=>day>=warsawToday())??dates[0];if(first&&!from&&!to){setFrom(first);setTo([plusDays(first,13),dates.at(-1)].sort()[0]);setMonth(first.slice(0,7));}setLocation(old=>old==='*'||data.rows.some(row=>row.location===old)?old:'*');setSelected(null);},[data]);
  const locations=useMemo(()=>[...new Set((data?.rows??[]).filter(r=>kind==='all'||r.type===kind).map(r=>r.location))].sort(),[data,kind]);
  const rangeValid=validDate(from)&&validDate(to)&&from<=to&&Date.parse(to)-Date.parse(from)<366*86400000;
  const rows=useMemo(()=>rangeValid?(data?.rows??[]).filter(r=>r.transmission===transmission&&(kind==='all'||r.type===kind)&&(location==='*'||r.location===location)&&durations.includes(r.duration)&&r.date>=from&&r.date<=to):[],[data,kind,location,transmission,durations,from,to,rangeValid]);
  const scale=useMemo(()=>priceScale(rows),[rows]);
  const days=useMemo(()=>rangeValid?dateRange(from,to):[],[from,to,rangeValid]);
  const applicableZones=data?.locations?.find(l=>l.scraper_label===location)?.zones??[];
  const series=duration=>{const found=new Map(rows.filter(r=>r.duration===duration).map(r=>[r.date,r]));return days.map(date=>found.get(date)??{date,duration,location,transmission,mm:null,competitor:null,marketConfirmed:false,gap:null,missingScenario:true});};
  useEffect(()=>{setSelected(null);},[kind,location,transmission,durations,from,to]);
  useEffect(()=>{if(!request||handledRequest.current===request.id||!data||!from||!to)return;handledRequest.current=request.id;setView('attention');selectRow(request.row??null,request.neighbors??[]);},[request,data,from,to,selectRow]);
  function preset(count){const dates=[...new Set(data.rows.map(r=>r.date))].sort();const start=dates.find(d=>d>=warsawToday())??dates[0];setFrom(start);setTo(count?([plusDays(start,count-1),dates.at(-1)].sort()[0]):dates.at(-1));setMonth(start.slice(0,7));}
  function changeMonth(value){const dates=monthDates(value);if(dates.length){setMonth(value);setFrom(dates[0]);setTo(dates.at(-1));}}
  function shiftMonth(step){const [y,m]=month.split('-').map(Number);changeMonth(new Date(Date.UTC(y,m-1+step,1)).toISOString().slice(0,7));}
  function openExcel(row){const zones=data.locations.find(l=>l.scraper_label===row.location)?.zones??[];if(zones.length){changeExcel({zone:zones[0],duration:row.duration,transmission:row.transmission,from:row.date,to:row.date});setView('excel');}}
  const reportLink=report?`/api/report/open?runId=${report.runId}`:null;
  return <section className={`market-workspace ${selected?'has-detail':''}`}>
    <div className="market-toolbar"><ViewTabs items={tabs} value={view} onChange={setView} label="Widok cen"/>{reportLink&&<a className="text-button" href={reportLink} target="_blank" rel="noreferrer"><ExternalLink size={16}/>Pełny raport HTML</a>}</div>
    {excelVisited&&<div hidden={view!=='excel'}><PricesView selection={excelSelection} onSelectionChange={changeExcel} model={model} workspace={workspace} service={service}/></div>}
    <div hidden={view==='excel'}>
      <div className="market-source"><span>{data?`Raport: ${timestamp(data.report.generatedAt)} · zbieranie danych od ${timestamp(data.report.sourceStartedAt)}`:report?`Dostępny raport: ${timestamp(report.generatedAt)}`:'Brak potwierdzonego raportu cenowego.'}</span><button className="button" disabled={busy||!report} onClick={load}><Search size={16}/>{busy?'Odczytywanie…':data?'Odśwież ceny':'Pokaż ceny'}</button></div>
      {error&&<div className="alert error" role="alert">{error}</div>}
      {busy&&<p role="status">Odczytywanie raportu cenowego…</p>}

      {data&&<>
        <p className="evidence-note">Ceny na DiscoverCars · PLN brutto / dobę · najtańsze oferty niezależnie od klasy.</p>
        {data.report.quality==='failure'&&<div className="alert">Dane rynku są dostępne. Ten przebieg nie opublikował nowych plików Excel.</div>}
        {Date.now()-Date.parse(data.report.sourceStartedAt)>86400000&&<div className="alert">Zbieranie danych rozpoczęło się ponad 24 godziny temu. Dokładny czas odczytu poszczególnych cen nie jest zapisany w tym raporcie.</div>}
      </>}
      <div hidden={view!=='attention'||!data}><AttentionView model={model} workspace={workspace} service={service} key={request?.id??"default"} request={request} data={data} onSelect={selectRow} selected={selected}/></div>
      {data&&<>
        <div hidden={view==='attention'} className="market-filters chart-filters"><label>Oddziały<select value={kind} onChange={e=>{setKind(e.target.value);setLocation('*');}}><option value="airport">Lotniska</option><option value="all">Wszystkie oddziały</option><option value="branch">Poza lotniskami</option></select></label><label>Lokalizacja rynku<select value={location} onChange={e=>setLocation(e.target.value)}><option value="*">Wszystkie lokalizacje</option>{locations.map(l=><option key={l} value={l}>{locationLabel(l)}</option>)}</select></label><label>Skrzynia<select value={transmission} onChange={e=>setTransmission(e.target.value)}><option value="all">Wszystkie auta</option><option value="automatic">Tylko automaty</option></select></label>
        <details className="duration-select"><summary>Długość najmu: {durations.length?durations.join(', '):'brak'} dni</summary><fieldset><legend>Długości najmu</legend>{Array.from({length:13},(_,i)=>i+2).map(d=><label key={d}><input type="checkbox" checked={durations.includes(d)} onChange={e=>setDurations(old=>e.target.checked?[...old,d].sort((a,b)=>a-b):old.filter(n=>n!==d))}/>{d} dni</label>)}</fieldset></details>
        <label>Start od<input type="date" value={from} onChange={e=>{setFrom(e.target.value);if(validDate(e.target.value))setMonth(e.target.value.slice(0,7));}}/></label><label>Start do<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div>
        <div hidden={view==='attention'} className="market-range" role="group" aria-label="Zakres dat">{[7,14,30,0].map(n=><button key={n} className="text-button" onClick={()=>preset(n)}>{n?`${n} dni`:'Cały raport'}</button>)}</div>
        {!rangeValid&&<p className="alert error">Wybierz prawidłowy zakres dat, nie dłuższy niż rok.</p>}
        {!durations.length&&<p className="alert">Wybierz co najmniej jedną długość najmu.</p>}
        <div hidden={view==='attention'} className="market-counts"><span><strong>{rows.length}</strong> sprawdzeń w filtrze</span><span>Top1: <strong>{rows.filter(r=>r.rank===1&&r.marketConfirmed).length}/{rows.filter(r=>r.rankLabel&&r.marketConfirmed).length}</strong> ocenionych</span><span>Brak MM: <strong>{rows.filter(r=>r.marketConfirmed&&r.mm===null).length}</strong></span><span>Bez potwierdzonych danych: <strong>{rows.filter(r=>!r.marketConfirmed).length}</strong></span></div>
        {(view==='chart'||view==='calendar')&&location==='*'?<p>Wybierz jedną lokalizację. Zestawienie wszystkich lokalizacji jest w „Do sprawdzenia”.</p>:view==='chart'?durations.map(duration=><PriceChart key={duration} rows={series(duration)} scale={scale} duration={duration} onSelect={row=>selectRow(row,series(duration))}/>):view==='calendar'?<>
          <div className="calendar-month"><button className="icon-button" aria-label="Poprzedni miesiąc cen" title="Poprzedni miesiąc" onClick={()=>shiftMonth(-1)}><ChevronLeft size={18}/></button><label>Miesiąc cen<input type="month" value={month} onChange={e=>changeMonth(e.target.value)}/></label><button className="icon-button" aria-label="Następny miesiąc cen" title="Następny miesiąc" onClick={()=>shiftMonth(1)}><ChevronRight size={18}/></button></div>
          {durations.map(duration=><PriceCalendar key={duration} month={month} rows={series(duration)} duration={duration} events={calendar.items} zones={applicableZones} onSelect={setSelected}/>)}
          <p className="evidence-note">Cena MM: PLN/dobę, zaokrąglona. Różnica % względem najtańszego konkurenta. Zielony: MM tańsze. Czerwony: MM droższe. Kreska: brak danych. Puste dni: poza filtrem dat.</p>
          {calendar.error&&<p className="freshness-warning">Nie potwierdzono oznaczeń wydarzeń. {calendar.error}</p>}
          <details className="technical-details"><summary>Wydarzenia i święta</summary><CalendarEvents calendar={calendar} model={model}/></details>
        </>:null}
        {selected&&<MarketDetail onRules={query=>{setSelected(null);onRules(query);}} model={model} workspace={workspace} service={service} row={selected} data={data} calendar={calendar} canExplain={Boolean(workspace?.status?.excel&&data.locations.some(l=>l.scraper_label===selected.location&&l.zones?.length))} onExcel={()=>{openExcel(selected);setSelected(null);}} onClose={()=>setSelected(null)} neighbors={neighbors.current} onSelect={selectRow}/>}
      </>}
    </div>
  </section>;
}

function PriceChart({rows,duration,scale,onSelect}) {
  const container=useRef(null);const [width,setWidth]=useState(800);const [hovered,setHovered]=useState(null);
  useEffect(()=>{const observer=new ResizeObserver(entries=>setWidth(Math.max(220,Math.floor(entries[0].contentRect.width))));observer.observe(container.current);return()=>observer.disconnect();},[]);
  const height=245,left=48,right=16,top=20,bottom=35;
  const {min,max}=scale;
  const x=i=>left+(width-left-right)*(rows.length<=1?.5:i/(rows.length-1));const y=v=>top+(height-top-bottom)*(1-(v-min)/(max-min));
  const labels=rows.length?[...new Set([0,Math.floor((rows.length-1)/2),rows.length-1])].filter(i=>i>=0):[];
  const current=rows.find(r=>r.date===hovered)??null;
  return <section className="market-chart" ref={container} aria-label={`Porównanie cen, ${duration} dni`}><div className="chart-heading"><h2>{duration} dni</h2><div className="chart-legend"><span className="mm-line">MM Cars</span><span className="competitor-line">Najtańszy konkurent</span><span>PLN/dobę</span></div></div>
    <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`} aria-label={`Ceny według dat startu, ${duration} dni`}>
      {[0,.25,.5,.75,1].map(n=><g key={n}><line x1={left} x2={width-right} y1={y(min+n*(max-min))} y2={y(min+n*(max-min))} className="chart-grid"/><text x={left-8} y={y(min+n*(max-min))+4} textAnchor="end">{shortMoney(min+n*(max-min))}</text></g>)}
      {['mm','competitor'].map(key=>lineSegments(rows,key,x,y).map((points,i)=><polyline className={`chart-line ${key}`} key={key+i} points={points}/>))}
      {rows.map((row,i)=><g key={row.date} role="button" tabIndex={0} aria-label={`${dayLabel(row.date)}, MM ${money(row.mm)} PLN, konkurencja ${money(row.competitor)} PLN`} onMouseEnter={()=>setHovered(row.date)} onFocus={()=>setHovered(row.date)} onClick={()=>onSelect(row)} onKeyDown={e=>{if(['Enter',' '].includes(e.key)){e.preventDefault();onSelect(row);}}}><title>{dayLabel(row.date)} · MM {money(row.mm)} · {row.provider??'Konkurencja'} {money(row.competitor)}</title><rect x={x(i)-Math.max(4,(width-left-right)/Math.max(1,rows.length)/2)} y={top} width={Math.max(8,(width-left-right)/Math.max(1,rows.length))} height={height-top-bottom} fill="transparent"/>{['mm','competitor'].map(key=>row[key]!==null?<circle key={key} className={`chart-point ${key}`} cx={x(i)} cy={y(row[key])} r={row.date===hovered?5:3}/>:null)}</g>)}
      {labels.map(i=><text key={i} x={x(i)} y={height-9} textAnchor={i===0?'start':i===rows.length-1?'end':'middle'}>{rows[i].date.slice(8)}.{rows[i].date.slice(5,7)}</text>)}
    </svg>
    <div className="chart-readout" aria-live="polite">{current?<><strong>{dayLabel(current.date)}</strong><span>MM: {money(current.mm)}</span><span>{current.provider??'Konkurencja'}: {money(current.competitor)}</span><span>{gapLabel(current.gap)} · {gapLabel(current.totalGap,true)}</span></>:<span>{rows.length?`${dayLabel(rows[0].date)} – ${dayLabel(rows.at(-1).date)}`:'Brak dat w wybranym zakresie'}</span>}</div>
  </section>;
}

function PriceCalendar({month,rows,duration,events,zones,onSelect}) {
  const days=monthDates(month);const indexed=new Map(rows.map(row=>[row.date,row]));const offset=days.length?(new Date(days[0]+'T12:00:00Z').getUTCDay()+6)%7:0;
  return <section className="market-calendar"><h2>{duration} dni</h2><div className="calendar-week">{['Pon','Wt','Śr','Czw','Pt','Sob','Nd'].map(day=><span key={day}>{day}</span>)}</div><div className="market-calendar-grid">{Array.from({length:offset},(_,i)=><span key={i}/>)}{days.map(day=>{const row=indexed.get(day);const comparable=row?.mm!=null&&row?.competitor!=null&&row.marketConfirmed;const percent=comparable?(row.mm/row.competitor-1)*100:null;const entries=eventsForDay(events,day,zones);return <button key={day} disabled={!row} title={!row?'Poza filtrem dat':undefined} className={`market-day ${!row?'out-of-range':percent===null?'unknown':percent>0?'above':percent<0?'below':'equal'}`} aria-label={`${dayLabel(day)}, ${!row?'poza filtrem dat':`MM ${money(row.mm)}, ${percent===null?'brak porównania':`${Math.round(percent)}% względem konkurencji`}`}`} onClick={()=>onSelect(row)}><span>{Number(day.slice(8))}{entries.length>0&&<CalendarDays className="event-day-marker" size={12} aria-label={entries.map(e=>e.title).join(', ')}/>}</span>{row&&<><strong>{shortMoney(row.mm)}</strong><small>{percent===null?'—':`${percent>0?'+':''}${Math.round(percent)}%`}</small></>}</button>;})}</div></section>;
}
