import React,{useMemo,useState,useEffect} from 'react';
import {ChevronLeft,ChevronRight,ChevronDown} from 'lucide-react';
import {weekdayDate} from './visual-format.mjs';
import {matchesReview,reviewReasons} from './dashboard-model.mjs';
import {AttentionMap} from './AttentionMap.jsx';
import {buildAttentionMap} from './attention-map.mjs';
import {warsawToday,plusDays,validDate,dateRange} from './market-model.mjs';
import {branchOverview,locationLabel} from './operations.mjs';
import {BandMatrix} from './BandMatrix.jsx';
export function AttentionView({data,onSelect,request,model,workspace,service,calendar,onRules,onExcel,active=true,rulesModel=model}) {
 const [from,setFrom]=useState(warsawToday);const [to,setTo]=useState(()=>plusDays(warsawToday(),13));
 const [transmission,setTransmission]=useState('all');const [kind,setKind]=useState('all');
 const [location,setLocation]=useState(request?.row?.location??'');
 const [reason,setReason]=useState(request?.reason??'all');
 const [mode,setMode]=useState('map'),[highlight,setHighlight]=useState(request?.row?.date??'');
 const rangeValid=validDate(from)&&validDate(to)&&from<=to&&Date.parse(to)-Date.parse(from)<366*86400000;
 const rows=useMemo(()=>(rangeValid?data?.rows??[]:[]).filter(r=>r.transmission===transmission&&r.duration>=2&&r.duration<=14&&(kind==='all'||r.type===kind)&&r.date>=from&&r.date<=to),[data,from,to,transmission,kind,rangeValid]);
 const branches=useMemo(()=>branchOverview(rows),[rows]);
 useEffect(()=>{onSelect(null);},[from,to,transmission,kind,location,onSelect]);

 const dates=useMemo(()=>rangeValid?dateRange(from,to):[],[from,to,rangeValid]);
 const map=useMemo(()=>buildAttentionMap(rows,dates),[rows,dates]);
 const visibleLocations=new Set(rows.filter(row=>matchesReview(row,reason)).map(row=>row.location));
 const visibleMap=reason==='all'?map:map.filter(branch=>visibleLocations.has(branch.location));
 function openBranch(name,date=''){setLocation(name);setHighlight(date);}
 const position=map.findIndex(item=>item.location===location),summary=branches.find(item=>item.location===location);
 const rangeInputs=<><details className="range-picker"><summary>{weekdayDate(from,true)} – {weekdayDate(to,true)} <ChevronDown size={14}/></summary><div><label>Start od<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Start do<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label></div></details><div><span className="filter-label">Skrzynia w przeglądzie</span><div className="segmented" role="group" aria-label="Skrzynia w przeglądzie">{[['all','Wszystkie auta'],['automatic','Automaty']].map(([value,label])=><button key={value} aria-pressed={transmission===value} onClick={()=>setTransmission(value)}>{label}</button>)}</div></div></>;
 return <section className="attention-view" aria-label="Przegląd oddziałów">
 {location?<header className="branch-header"><div><button className="text-button" onClick={()=>setLocation('')}>Wszystkie oddziały ›</button><h2>{locationLabel(location)}</h2><div className="branch-navigation"><button className="icon-button" title="Poprzedni oddział" aria-label="Poprzedni oddział" disabled={position<=0} onClick={()=>openBranch(map[position-1].location)}><ChevronLeft size={18}/></button><span>{position+1} z {map.length} w przeglądzie</span><button className="icon-button" title="Następny oddział" aria-label="Następny oddział" disabled={position<0||position>=map.length-1} onClick={()=>openBranch(map[position+1].location)}><ChevronRight size={18}/></button></div></div>{summary&&<p>{summary.missingDates} dni bez MM · {summary.over} z {summary.comparable} MM droższe &gt;10 · {summary.unavailable} brak danych</p>}</header>:<h2>Przegląd oddziałów</h2>}
 {!location&&<div className="market-filters"><label>Pozycje przeglądu<select value={reason} onChange={e=>setReason(e.target.value)}>{Object.entries(reviewReasons).map(([value,label])=><option value={value} key={value}>{label}</option>)}</select></label>{rangeInputs}<label>Oddziały przeglądu<select value={kind} onChange={e=>{setKind(e.target.value);setLocation('');}}><option value="all">Wszystkie oddziały</option><option value="airport">Lotniska</option><option value="branch">Poza lotniskami</option></select></label></div>}
 {!location&&reason!=='all'&&<p className="evidence-note">Oddziały z pozycjami: {reviewReasons[reason]}. Pozostałe dni i ceny tych oddziałów pozostają widoczne.</p>}
 {!rangeValid&&<p role="alert">Początek zakresu musi poprzedzać koniec.</p>}
 {!location?<><div className="segmented" aria-label="Układ przeglądu"><button aria-pressed={mode==='map'} onClick={()=>setMode('map')}>Mapa</button><button aria-pressed={mode==='table'} onClick={()=>setMode('table')}>Tabela oddziałów</button></div>{mode==='map'?<AttentionMap branches={visibleMap} dates={dates} locations={data?.locations??[]} events={calendar?.items??[]} onOpen={openBranch}/>:<><p className="evidence-note">Brak MM: liczba dat z przynajmniej jednym potwierdzonym brakiem oferty. Różnica cen nie oznacza błędu ani możliwości obniżki.</p><table className="attention-table"><thead><tr><th>Oddział</th><th>Daty bez MM</th><th>MM droższe &gt;10 PLN/dobę</th><th>Brak danych</th><th></th></tr></thead><tbody>{branches.filter(b=>visibleLocations.has(b.location)).map(b=><tr key={b.location}><th scope="row" data-label="Oddział">{locationLabel(b.location)}</th><td data-label="Daty bez MM">{b.missingDates}</td><td data-label="MM droższe >10 PLN/dobę">{b.share===null?'Brak porównania':`${(b.share*100).toLocaleString('pl-PL',{maximumFractionDigits:0})}% (${b.over}/${b.comparable})`}</td><td data-label="Brak danych">{b.unavailable}</td><td><button className="text-button" onClick={()=>openBranch(b.location)}>Sprawdź oddział</button></td></tr>)}</tbody></table><p className="evidence-note">Procent dotyczy sprawdzeń z potwierdzoną ceną MM i konkurenta. Braki ofert i danych nie wchodzą do mianownika.</p></>}</>:<>{data&&<BandMatrix activeView={active} rulesModel={rulesModel} data={data} rows={rows.filter(r=>r.location===location)} dates={dates} location={location} transmission={transmission} model={model} workspace={workspace} service={service} onSelect={onSelect} highlight={highlight} filters={rangeInputs} onRules={onRules} onExcel={onExcel}/>}</>}
 {!rows.length&&<p>Brak danych w wybranym zakresie.</p>}
 </section>;
}
