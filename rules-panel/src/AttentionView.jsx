import React,{useMemo,useState,useEffect} from 'react';
import {warsawToday,plusDays,validDate} from './market-model.mjs';
import {branchOverview,locationLabel} from './operations.mjs';
import {BandMatrix} from './BandMatrix.jsx';
export function AttentionView({data,onSelect,request,model,workspace,service}) {
 const [from,setFrom]=useState(warsawToday);const [to,setTo]=useState(()=>plusDays(warsawToday(),13));
 const [transmission,setTransmission]=useState('all');const [kind,setKind]=useState('all');
 const [location,setLocation]=useState(request?.row?.location??'');
 const rangeValid=validDate(from)&&validDate(to)&&from<=to;
 const rows=useMemo(()=>(rangeValid?data?.rows??[]:[]).filter(r=>r.transmission===transmission&&r.duration>=2&&r.duration<=14&&(kind==='all'||r.type===kind)&&r.date>=from&&r.date<=to),[data,from,to,transmission,kind,rangeValid]);
 const branches=useMemo(()=>branchOverview(rows),[rows]);
 useEffect(()=>{onSelect(null);},[from,to,transmission,kind,location,onSelect]);

 const dates=[...new Set(data?.report.startDates??[])].filter(d=>rangeValid&&d>=from&&d<=to).sort();
 return <section className="attention-view" aria-label="Przegląd oddziałów">
 <h2>{location?locationLabel(location):'Przegląd oddziałów'}</h2>
 <div className="market-filters"><label>Start od<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>Start do<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><label>Skrzynia w przeglądzie<select value={transmission} onChange={e=>setTransmission(e.target.value)}><option value="all">Wszystkie auta</option><option value="automatic">Automaty</option></select></label><label>Oddziały przeglądu<select value={kind} onChange={e=>{setKind(e.target.value);setLocation('');}}><option value="all">Wszystkie oddziały</option><option value="airport">Lotniska</option><option value="branch">Poza lotniskami</option></select></label></div>
 {!rangeValid&&<p role="alert">Początek zakresu musi poprzedzać koniec.</p>}
 {!location?<><p className="evidence-note">Brak MM: liczba dat z przynajmniej jednym potwierdzonym brakiem oferty. Różnica cen nie oznacza błędu ani możliwości obniżki.</p><table className="attention-table"><thead><tr><th>Oddział</th><th>Daty bez MM</th><th>MM droższe &gt;10 PLN/dobę</th><th>Brak danych</th><th></th></tr></thead><tbody>{branches.map(b=><tr key={b.location}><th scope="row" data-label="Oddział">{locationLabel(b.location)}</th><td data-label="Daty bez MM">{b.missingDates}</td><td data-label="MM droższe >10 PLN/dobę">{b.share===null?'Brak porównania':`${(b.share*100).toLocaleString('pl-PL',{maximumFractionDigits:0})}% (${b.over}/${b.comparable})`}</td><td data-label="Brak danych">{b.unavailable}</td><td><button className="text-button" onClick={()=>setLocation(b.location)}>Sprawdź oddział</button></td></tr>)}</tbody></table><p className="evidence-note">Procent dotyczy sprawdzeń z potwierdzoną ceną MM i konkurenta. Braki ofert i danych nie wchodzą do mianownika.</p></>:<><button className="button" onClick={()=>setLocation('')}>Wszystkie oddziały</button>{data&&<BandMatrix data={data} rows={rows.filter(r=>r.location===location)} dates={dates} location={location} transmission={transmission} model={model} workspace={workspace} service={service} onSelect={onSelect}/>}</>}
 {!rows.length&&<p>Brak danych w wybranym zakresie.</p>}
 </section>;
}
