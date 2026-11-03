import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChartLine, ChevronLeft, ChevronRight, ExternalLink, FileSpreadsheet, ListFilter, Search } from 'lucide-react';
import {PriceCalendar,DurationChips} from './PriceCalendar.jsx';
import {monthLabel} from './visual-format.mjs';
import {ViewTabs} from './ViewTabs.jsx';
import { MarketDetail } from './MarketDetail.jsx';
import { AttentionView } from './AttentionView.jsx';
import { gapLabel,priceScale } from './market-review.mjs';
import { PricesView } from './PricesView.jsx';
import { CalendarEvents } from './CalendarEvents.jsx';
import { timestamp } from './display.mjs';
import { dateRange, eventsForDay, lineSegments, money, monthDates, initialMarketWindow, scenarioLink, validDate, warsawToday } from './market-model.mjs';
import './market.css';
import {locationLabel} from './operations.mjs';
import {reviewReasons} from './dashboard-model.mjs';

const dayLabel=day=>`${day.slice(8)}.${day.slice(5,7)}.${day.slice(0,4)}`;
const shortMoney=value=>value===null?'—':new Intl.NumberFormat('pl-PL',{maximumFractionDigits:0,notation:value>=10000?'compact':'standard'}).format(value);
const tabs=[['attention','Przegląd rynku',ListFilter],['chart','Wykres',ChartLine],['calendar','Kalendarz cen',CalendarDays],['excel','Stawki w Excelu',FileSpreadsheet]];

export function MarketWorkspace({model,workspace,service,calendar,market,request,onRules,active=true,rulesModel=model}) {
  const [view,setView]=useState('attention');const {data,busy,error,load}=market;const handledRequest=useRef(null);
  const [location,setLocation]=useState('*');const [transmission,setTransmission]=useState('automatic');
  const [durations,setDurations]=useState([3]);const [from,setFrom]=useState('');const [to,setTo]=useState('');const [month,setMonth]=useState(warsawToday().slice(0,7));
  const [calendarDuration,setCalendarDuration]=useState(3);
  const [band,setBand]=useState('3-4'),[reason,setReason]=useState('all');
  const shownDuration=durations.includes(calendarDuration)?calendarDuration:durations[0];
  function changeFilters(patch){if('from' in patch)setFrom(patch.from);if('to' in patch)setTo(patch.to);if('transmission' in patch)setTransmission(patch.transmission);if('location' in patch)setLocation(patch.location);}
  const [selected,setSelected]=useState(null);const neighbors=useRef([]);const selectRow=useCallback((row,items=[])=>{neighbors.current=items;setSelected(row);},[]);
  const [excelGroup,setExcelGroup]=useState(undefined);
  const [excelVisited,setExcelVisited]=useState(false);const [excelZone,setExcelZone]=useState('KRLO');const [excelDuration,setExcelDuration]=useState(3);
  const marketLocations=model.locations.locations??model.locations;
  useEffect(()=>{if(view==='excel')setExcelVisited(true);},[view]);
  useEffect(()=>{const zones=marketLocations.find(l=>l.scraper_label===location)?.zones??[];setExcelZone(old=>zones.includes(old)?old:zones[0]??'');},[location,model.locations]);
  const excelSelection={group:excelGroup,zone:excelZone,duration:durations.includes(excelDuration)?excelDuration:durations[0]??3,transmission,from,to};
  function changeExcel(patch) {
    if ('group' in patch) setExcelGroup(patch.group);
    if ('zone' in patch) {setExcelZone(patch.zone);const item=marketLocations.find(l=>l.zones.includes(patch.zone));if(item){setLocation(item.scraper_label);}}
    if ('duration' in patch) {setExcelDuration(patch.duration);setDurations([patch.duration]);}
    if ('transmission' in patch) setTransmission(patch.transmission);
    if ('from' in patch) {setFrom(patch.from);if(validDate(patch.from))setMonth(patch.from.slice(0,7));}
    if ('to' in patch) setTo(patch.to);
  }
  const report=workspace?.status?.report;
  useEffect(()=>{if(!data)return;const initial=initialMarketWindow(data);if(initial.from&&!from&&!to){setFrom(initial.from);setTo(initial.to);setMonth(initial.from.slice(0,7));}setLocation(old=>old==='*'||data.rows.some(row=>row.location===old)?old:'*');setSelected(null);},[data]);
  const locations=useMemo(()=>[...new Set((data?.rows??[]).map(r=>r.location))].sort(),[data]);
  const rangeValid=validDate(from)&&validDate(to)&&from<=to&&Date.parse(to)-Date.parse(from)<366*86400000;
  const rows=useMemo(()=>rangeValid?(data?.rows??[]).filter(r=>r.transmission===transmission&&(location==='*'||r.location===location)&&durations.includes(r.duration)&&r.date>=from&&r.date<=to):[],[data,location,transmission,durations,from,to,rangeValid]);
  const scale=useMemo(()=>priceScale(rows),[rows]);
  const days=useMemo(()=>rangeValid?dateRange(from,to):[],[from,to,rangeValid]);
  const applicableZones=data?.locations?.find(l=>l.scraper_label===location)?.zones??[];
  const series=(duration,calendarMonth=false)=>{const source=calendarMonth?(data?.rows??[]).filter(r=>r.transmission===transmission&&r.location===location):rows;const calendarDays=calendarMonth?monthDates(month).filter(day=>data.report.startDates.includes(day)):days;const found=new Map(source.filter(r=>r.duration===duration).map(r=>[r.date,r]));return calendarDays.map(date=>found.get(date)??{date,duration,location,transmission,mm:null,competitor:null,marketConfirmed:false,gap:null,missingScenario:true});};
  const countRows=data&&view==='calendar'?series(shownDuration,true).filter(row=>!row.missingScenario):rows;
  useEffect(()=>{setSelected(null);},[location,transmission,durations,from,to,view,active]);
  useEffect(()=>{if(!request||handledRequest.current===request.id||!data||!from||!to)return;handledRequest.current=request.id;setView('attention');setReason(request.reason??'all');if(request.transmission)setTransmission(request.transmission);setLocation(request.row?.location??'*');selectRow(null);},[request,data,from,to,selectRow]);
  function changeMonth(value){if(monthDates(value).length)setMonth(value);}
  function shiftMonth(step){const [y,m]=month.split('-').map(Number);changeMonth(new Date(Date.UTC(y,m-1+step,1)).toISOString().slice(0,7));}
  function openExcel(row){const zones=data.locations.find(l=>l.scraper_label===row.location)?.zones??[];if(zones.length){changeExcel({zone:row.excelSelection?.zone??zones[0],group:row.excelSelection?.group??excelGroup,duration:row.duration,transmission:row.transmission,from:row.date,to:row.date});setView('excel');}}
  const reportLink=report?`/api/report/open?runId=${report.runId}`:null;
  return <section className={`market-workspace ${selected?'has-detail':''}`}>
    {data&&<div className="market-filters shared-market-filters" aria-label="Filtry rynku">
      <label>Oddział<select value={location} onChange={e=>{setLocation(e.target.value);}}><option value="*">Wszystkie oddziały</option>{locations.map(l=><option key={l} value={l}>{locationLabel(l)}</option>)}</select></label>
      <label>Skrzynia<select value={transmission} onChange={e=>setTransmission(e.target.value)}><option value="automatic">Automaty</option><option value="all">Wszystkie auta</option></select></label>
      {view!=='calendar'&&<details key={view} className="range-picker"><summary>{dayLabel(from)} – {dayLabel(to)}</summary><div><label>Start od<input type="date" value={from} onChange={e=>{setFrom(e.target.value);if(validDate(e.target.value))setMonth(e.target.value.slice(0,7));}}/></label><label>Start do<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div></details>}
      {view==='attention'&&location==='*'&&<><div><span className="filter-label">Pasmo Excela</span><div className="segmented" role="group" aria-label="Pasmo mapy">{[['2','2'],['3-4','3–4'],['5-7','5–7'],['8-20','8–20']].map(([value,label])=><button key={value} aria-pressed={band===value} onClick={()=>setBand(value)}>{label}</button>)}</div></div><label>Pozycje przeglądu<select value={reason} onChange={e=>setReason(e.target.value)}>{Object.entries(reviewReasons).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label></>}
      {view==='calendar'?<DurationChips values={durations} onChange={setDurations}/>:view==='chart'?<details className="duration-select"><summary>Długość najmu: {durations.length?durations.join(', '):'brak'} dni</summary><fieldset><legend>Długości najmu</legend>{Array.from({length:13},(_,i)=>i+2).map(d=><label key={d}><input type="checkbox" checked={durations.includes(d)} onChange={e=>setDurations(old=>e.target.checked?[...old,d].sort((a,b)=>a-b):old.filter(n=>n!==d))}/>{d} dni</label>)}</fieldset></details>:null}
    </div>}
    <div className="market-toolbar"><ViewTabs items={tabs} value={view} onChange={setView} label="Widok cen"/>{reportLink&&<a className="text-button" href={reportLink} target="_blank" rel="noreferrer"><ExternalLink size={16}/>Pełny raport HTML</a>}</div>
    {excelVisited&&<div hidden={view!=='excel'}><PricesView sharedFilters selection={excelSelection} onSelectionChange={changeExcel} model={model} workspace={workspace} service={service}/></div>}
    <div hidden={view==='excel'}>
      <div className="market-source"><span>{data?`Zbieranie cen od ${timestamp(data.report.sourceStartedAt)}`:report?`Dostępny raport: ${timestamp(report.generatedAt)}`:'Brak potwierdzonego raportu cenowego.'}</span><button className="button" disabled={busy||!report} onClick={load}><Search size={16}/>{busy?'Odczytywanie…':data?'Wczytaj najnowszy raport':'Wczytaj raport'}</button></div>
      {error&&<div className="alert error" role="alert">{error}</div>}
      {busy&&<p role="status">Odczytywanie raportu cenowego…</p>}

      {data&&<>
        <p className="evidence-note">Ceny na DiscoverCars · PLN brutto / dobę · najtańsze oferty niezależnie od klasy.</p>
        {data.report.quality==='failure'&&<div className="alert">Dane rynku są dostępne. Ten przebieg nie opublikował nowych plików Excel.</div>}
        {Date.now()-Date.parse(data.report.sourceStartedAt)>86400000&&<div className="alert">Zbieranie danych rozpoczęło się ponad 24 godziny temu. Dokładny czas odczytu poszczególnych cen nie jest zapisany w tym raporcie.</div>}
      </>}
      <div hidden={view!=='attention'||!data}><AttentionView active={active&&view==='attention'} rulesModel={rulesModel} onRules={onRules} onExcel={openExcel} band={band} reason={reason} filters={{from,to,transmission,location}} onFilters={changeFilters} calendar={calendar} model={model} workspace={workspace} service={service} key={request?.id??"default"} request={request} data={data} onSelect={selectRow} selected={selected}/></div>
      {data&&<>
        {view!=='calendar'&&!rangeValid&&<p className="alert error">Wybierz prawidłowy zakres dat, nie dłuższy niż rok.</p>}
        {!durations.length&&<p className="alert">Wybierz co najmniej jedną długość najmu.</p>}
        <div hidden={view==='attention'} className="market-counts"><span><strong>{countRows.length}</strong> sprawdzeń w filtrze</span><span>Top1: <strong>{countRows.filter(r=>r.rank===1&&r.marketConfirmed).length}/{countRows.filter(r=>r.rankLabel&&r.marketConfirmed).length}</strong> ocenionych</span><span>Brak MM: <strong>{countRows.filter(r=>r.marketConfirmed&&r.mm===null).length}</strong></span><span>Bez potwierdzonych danych: <strong>{countRows.filter(r=>!r.marketConfirmed).length}</strong></span></div>
        {(view==='chart'||view==='calendar')&&location==='*'?<p>Wybierz jedną lokalizację. Zestawienie wszystkich lokalizacji jest w „Przegląd rynku”.</p>:view==='chart'?durations.map(duration=><PriceChart key={duration} rows={series(duration)} scale={scale} duration={duration} onSelect={row=>selectRow(row,series(duration))}/>):view==='calendar'?<>
          <div className="calendar-month"><button className="icon-button" aria-label="Poprzedni miesiąc cen" title="Poprzedni miesiąc" onClick={()=>shiftMonth(-1)}><ChevronLeft size={18}/></button><strong>{monthLabel(month)}</strong><button className="icon-button" aria-label="Następny miesiąc cen" title="Następny miesiąc" onClick={()=>shiftMonth(1)}><ChevronRight size={18}/></button></div>
          <div className="segmented" role="group" aria-label="Długość widocznego kalendarza">{durations.map(d=><button key={d} aria-pressed={shownDuration===d} onClick={()=>setCalendarDuration(d)}>{d} dni</button>)}</div>
          {[shownDuration].filter(Boolean).map(duration=><PriceCalendar key={duration} month={month} rows={series(duration,true)} duration={duration} events={calendar.items} zones={applicableZones} reportDates={data.report.startDates} onSelect={row=>selectRow(row,series(duration,true))}/>)}
          <p className="evidence-note">PLN/dobę, ceny na siatce zaokrąglone. + MM droższe · − MM tańsze · szary: różnica do ±5 PLN · brak MM: potwierdzony brak oferty · ?: brak danych. Dokładne kwoty w szczegółach.</p>
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


