import React,{useMemo} from 'react';
import {ArrowRight,Download,RotateCcw} from 'lucide-react';
import {timestamp} from './display.mjs';
import {weekdayDate} from './visual-format.mjs';
import {money,warsawToday} from './market-model.mjs';
import {locationLabel,countLabel} from './operations.mjs';
import {nextSchedule} from './change-review.mjs';
import {dashboardOverview} from './dashboard-model.mjs';
import {PriceBadge} from './PriceBadge.jsx';

export function Dashboard({workspace,onMarket,market,changeCount=0,largeCount=0,onReview,onDiagnostics}) {
 const {report,excel,links={},executions}=workspace?.status??{};
 const {data,busy,error,load}=market;
 const today=warsawToday(),overview=useMemo(()=>dashboardOverview(data,today),[data,today]);
 const old=report&&Date.now()-Date.parse(report.sourceStartedAt)>86400000;
 const next=nextSchedule(__SCRAPER_PLAN__),last=executions?.latestScrape;
 const latestUnknown=last&&last.runId!==report?.runId;
 const excelState=latestUnknown?'Sprawdź ostatni przebieg':report?.quality==='failure'?'Excel nieopublikowany':excel?'Excel dostępny':'Brak poprawnego Excela';
 const coverage=report?.coverage?.expected>0?(100*report.coverage.found/report.coverage.expected).toLocaleString('pl-PL',{maximumFractionDigits:1})+'% sprawdzeń':null;
 const zone=location=>data?.locations?.find(item=>item.scraper_label===location)?.zones?.[0];
 const longDay=new Intl.DateTimeFormat('pl-PL',{weekday:'long',day:'numeric',month:'long',timeZone:'Europe/Warsaw'}).format(new Date(today+'T12:00:00Z'));
 return <section className="operations-dashboard" aria-label="Podsumowanie raportu">
  <div className="dashboard-status">
   <div><span>Raport cen</span><strong>{!report?'Brak potwierdzonego raportu':old?'Starszy niż 24 h':'Aktualny'}</strong><small>{report?timestamp(report.generatedAt):'Brak danych'}{coverage&&' · '+coverage}</small></div>
   <div><span>Excel</span><button className="text-button" onClick={onDiagnostics}>{excelState}</button><small>{latestUnknown?'Diagnostyka ostatniego uruchomienia':report?.incident?.title??(excel?timestamp(excel.generatedAt):'Brak plików')}</small></div>
   <div><span>Szkic zasad</span><button className="text-button" onClick={onReview}>{countLabel(changeCount,'zmiana','zmiany','zmian')} · Przejrzyj</button><small>{largeCount?countLabel(largeCount,'duża zmiana','duże zmiany','dużych zmian'):'Brak dużych zmian'}</small></div>
   <div><span>Następny planowany start</span><strong>{next?next.time:'Brak harmonogramu'}</strong><small>{next?weekdayDate(next.date)+' · rolling '+next.rollingDays+' dni':''} · czas polski</small></div>
  </div>
  <header className="dashboard-heading"><div><h2>Przegląd na {longDay}</h2><p>Najbliższe 14 dni · {data?countLabel(overview.locationCount,'oddział','oddziały','oddziałów'):'odczyt oddziałów'} · najem 2–14 dni · wszystkie auta · {data?overview.rows.length.toLocaleString('pl-PL'):'—'} sprawdzeń</p></div><button className="button primary" onClick={()=>onMarket('all')}>Zacznij przegląd<ArrowRight size={17}/></button></header>
  <div className="review-actions">{excel&&links.import&&<a className="button" href={links.import}><Download size={17}/>Import</a>}{excel&&links.recommendations&&<a className="button" href={links.recommendations}><Download size={17}/>Rekomendacje</a>}</div>
  {excel&&report?.runId!==excel.runId&&<p className="alert">Pliki Excel pochodzą z innego uruchomienia niż raport cen. Nie przedstawiamy ich jako nowych plików tego przebiegu.</p>}
  {busy&&<p role="status">Odczytywanie raportu cenowego…</p>}
  {error&&<div role="alert" className="alert error">{error}<button className="button" onClick={load}><RotateCcw size={16}/>Ponów odczyt cen</button></div>}
  {data&&<><div className="dashboard-metrics">{overview.metrics.map(metric=><button key={metric.reason} className="dashboard-metric" onClick={()=>onMarket(metric.reason)}><span>{metric.label}</span><strong>{metric.count.toLocaleString('pl-PL')}</strong><small>w {metric.branches} z {overview.locationCount} oddziałów</small><span className={'metric-bars metric-'+metric.reason} role="img" aria-label={metric.days.map(day=>weekdayDate(day.date,true)+': '+day.count).join('; ')}>{metric.days.map(day=><i key={day.date} style={{height:Math.max(2,36*day.count/Math.max(1,...metric.days.map(d=>d.count)))}}/>)}</span></button>)}</div>
   <div className="dashboard-lists"><section className="dashboard-urgent"><div className="section-title"><h3>Najpilniejsze</h3><button className="text-button" onClick={()=>onMarket('urgent')}>Wszystkie ({overview.urgent.length})</button></div>
    <table><thead><tr><th>Oddział</th><th>Start</th><th>Najem</th><th>MM</th><th>Konkurent</th><th>MM − konkurent</th></tr></thead><tbody>{overview.urgent.slice(0,6).map(row=><tr key={row.key}><th data-label="Oddział"><button className="text-button" onClick={()=>onMarket('all',row)}>{locationLabel(row.location)}</button> <span className="code">{zone(row.location)}</span></th><td data-label="Start">{weekdayDate(row.date,true)}</td><td data-label="Najem">{row.duration} dni</td><td data-label="MM">{row.mm===null?'brak MM':money(row.mm)}</td><td data-label="Konkurent">{money(row.competitor)}</td><td data-label="MM − konkurent"><PriceBadge gap={row.gap} missing={row.mm===null}/></td></tr>)}</tbody></table>
    {!overview.urgent.length&&<p>Brak potwierdzonych braków MM i różnic ponad 10 PLN/dobę.</p>}
   </section><section className="dashboard-branches"><h3>Oddziały z największą liczbą pozycji</h3><p className="evidence-note">Brak MM / MM droższe &gt;10 PLN/dobę</p>{overview.branches.filter(branch=>branch.missing+branch.over>0).slice(0,6).map(branch=><button key={branch.location} onClick={()=>onMarket('all',{location:branch.location})}><span>{locationLabel(branch.location)}</span><strong>{branch.missing+branch.over}</strong><span className="branch-bars" role="img" aria-label={branch.missing+' braków MM, '+branch.over+' droższych ofert'}><i className="tone-missing" style={{width:100*branch.missing/Math.max(1,...overview.branches.map(b=>b.missing+b.over))+'%'}}/><i className="tone-over-3" style={{width:100*branch.over/Math.max(1,...overview.branches.map(b=>b.missing+b.over))+'%'}}/></span></button>)}</section></div>
  </>}
 </section>;
}
