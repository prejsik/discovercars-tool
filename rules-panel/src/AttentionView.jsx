import React,{useMemo,useState,useEffect} from 'react';
import {ChevronLeft,ChevronRight} from 'lucide-react';
import {matchesReview,reviewReasons} from './dashboard-model.mjs';
import {AttentionMap} from './AttentionMap.jsx';
import {buildAttentionMap} from './attention-map.mjs';
import {validDate,dateRange} from './market-model.mjs';
import {branchOverview,locationLabel} from './operations.mjs';
import {BandMatrix} from './BandMatrix.jsx';
export function AttentionView({data,onSelect,request,model,workspace,service,calendar,onRules,onExcel,active=true,rulesModel=model,filters,onFilters,band,reason}) {
 const {from,to,transmission}=filters;
 const location=filters.location==='*'?'':filters.location;
 const setLocation=value=>onFilters({location:value||'*'});
 const [highlight,setHighlight]=useState(request?.row?.date??'');
 const rangeValid=validDate(from)&&validDate(to)&&from<=to&&Date.parse(to)-Date.parse(from)<366*86400000;
 const rows=useMemo(()=>(rangeValid?data?.rows??[]:[]).filter(r=>r.transmission===transmission&&r.duration>=2&&r.duration<=14&&r.date>=from&&r.date<=to),[data,from,to,transmission,rangeValid]);
 const branches=useMemo(()=>branchOverview(rows),[rows]);
 useEffect(()=>{onSelect(null);},[from,to,transmission,location,onSelect]);

 const dates=useMemo(()=>rangeValid?dateRange(from,to):[],[from,to,rangeValid]);
 const map=useMemo(()=>buildAttentionMap(rows,dates,band),[rows,dates,band]);
 const visibleLocations=new Set(rows.filter(row=>matchesReview(row,reason)).map(row=>row.location));
 const visibleMap=reason==='all'?map:map.filter(branch=>visibleLocations.has(branch.location));
 function openBranch(name,date=''){setLocation(name);setHighlight(date);}
 const position=map.findIndex(item=>item.location===location),summary=branches.find(item=>item.location===location);
 return <section className="attention-view" aria-label="Przegląd oddziałów">
 {location?<header className="branch-header"><div className="branch-breadcrumb">
  <button className="text-button branch-back" aria-label="Wszystkie oddziały ›" onClick={()=>setLocation('')}><span>Wszystkie oddziały ›</span><span className="mobile-back-label">Oddziały ›</span></button>
  <button className="icon-button" title="Poprzedni oddział" aria-label="Poprzedni oddział" disabled={position<=0} onClick={()=>openBranch(map[position-1].location)}><ChevronLeft size={18}/></button>
  <h2 title={locationLabel(location)}>{locationLabel(location)}</h2>
  <button className="icon-button" title="Następny oddział" aria-label="Następny oddział" disabled={position<0||position>=map.length-1} onClick={()=>openBranch(map[position+1].location)}><ChevronRight size={18}/></button>
  <span className="branch-position">{position+1} z {map.length}</span>
 </div>{summary&&<p>{summary.missingDates} dni bez MM · {summary.over} z {summary.comparable} MM droższe &gt;10 · {summary.unavailable} brak danych</p>}</header>:<h2>Przegląd oddziałów</h2>}
 {!location&&reason!=='all'&&<p className="evidence-note">Oddziały z pozycjami: {reviewReasons[reason]}. Pozostałe dni i ceny tych oddziałów pozostają widoczne.</p>}
 {!rangeValid&&<p role="alert">Początek zakresu musi poprzedzać koniec.</p>}
 {!location?<AttentionMap branches={visibleMap} dates={dates} locations={data?.locations??[]} events={calendar?.items??[]} onOpen={openBranch}/>:<>{data&&<BandMatrix activeView={active} rulesModel={rulesModel} data={data} rows={rows.filter(r=>r.location===location)} dates={dates} location={location} transmission={transmission} model={model} workspace={workspace} service={service} onSelect={onSelect} highlight={highlight} onRules={onRules} onExcel={onExcel}/>}</>}
 {!rows.length&&<p>Brak danych w wybranym zakresie.</p>}
 </section>;
}
