import React,{useMemo} from 'react';
import {ArrowRight,Download,RotateCcw} from 'lucide-react';
import {timestamp} from './display.mjs';
import {weekdayDate} from './visual-format.mjs';
import {warsawToday} from './market-model.mjs';
import {countLabel} from './operations.mjs';
import {nextSchedule} from './change-review.mjs';
import {dashboardOverview} from './dashboard-model.mjs';
import {reviewDayLabel} from './panel-format.mjs';


export function Dashboard({workspace,onMarket,market,changeCount=0,largeCount=0,onReview,onDiagnostics,transmission='automatic',onTransmissionChange}) {
 const {report,excel,links={},executions}=workspace?.status??{};
 const {data,busy,error,load}=market;
 const setTransmission=onTransmissionChange;
 const today=warsawToday(),overview=useMemo(()=>dashboardOverview(data,today,transmission),[data,today,transmission]);
 const old=report&&Date.now()-Date.parse(report.sourceStartedAt)>86400000;
 const next=nextSchedule(__SCRAPER_PLAN__),last=executions?.latestScrape;
 const latestUnknown=last&&last.runId!==report?.runId;
 const excelState=latestUnknown?'Sprawdź ostatni przebieg':report?.quality==='failure'?'Excel nieopublikowany':excel?'Excel dostępny':'Brak poprawnego Excela';
 const coverage=report?.coverage?.expected>0?(100*report.coverage.found/report.coverage.expected).toLocaleString('pl-PL',{maximumFractionDigits:1})+'% sprawdzeń':null;
 const longDay=reviewDayLabel(today);
 return <section className="operations-dashboard" aria-label="Podsumowanie raportu">
  <div className="dashboard-status">
   <div><span>Raport cen</span><strong>{!report?'Brak potwierdzonego raportu':old?'Starszy niż 24 h':'Aktualny'}</strong><small>{report?.sourceStartedAt?'Zbieranie cen od '+timestamp(report.sourceStartedAt):'Brak czasu odczytu cen'}{coverage&&' · '+coverage}</small></div>
   <div><span>Excel</span><button className="text-button" onClick={onDiagnostics}>{excelState}</button><small>{latestUnknown?'Diagnostyka ostatniego uruchomienia':report?.incident?.title??(excel?timestamp(excel.generatedAt):'Brak plików')}</small></div>
   <div><span>Szkic zasad</span>{changeCount>0?<><button className="text-button" onClick={onReview}>{countLabel(changeCount,'zmiana','zmiany','zmian')} · Przejrzyj</button><small>{largeCount?countLabel(largeCount,'duża zmiana','duże zmiany','dużych zmian'):'Brak dużych zmian'}</small></>:<strong>Brak zmian w szkicu</strong>}</div>
   <div><span>Następny planowany start</span><strong>{next?next.time:'Brak harmonogramu'}</strong><small>{next?weekdayDate(next.date)+' · rolling '+next.rollingDays+' dni':''} · czas polski</small></div>
  </div>
  <header className="dashboard-heading"><div><h2>Przegląd na {longDay}</h2><p>Najbliższe 14 dni · {data?countLabel(overview.locationCount,'oddział','oddziały','oddziałów'):'odczyt oddziałów'} · najem 2–14 dni · {transmission==='automatic'?'automaty':'wszystkie auta'} · {data?overview.rows.length.toLocaleString('pl-PL'):'—'} sprawdzeń</p></div><button className="button primary" onClick={()=>onMarket('all',null,[],transmission)}>Zacznij przegląd<ArrowRight size={17}/></button></header>
  <div className="segmented" role="group" aria-label="Skrzynia na Pulpicie">{[['all','Wszystkie auta'],['automatic','Automaty']].map(([value,label])=><button key={value} aria-pressed={transmission===value} onClick={()=>setTransmission(value)}>{label}</button>)}</div>
  <div className="review-actions">{excel&&links.import&&<a className="button" href={links.import}><Download size={17}/>Import · {timestamp(excel.generatedAt)}</a>}{excel&&links.recommendations&&<a className="button" href={links.recommendations}><Download size={17}/>Rekomendacje · {timestamp(excel.generatedAt)}</a>}</div>
  {excel&&report?.runId!==excel.runId&&<p className="alert">Pliki Excel pochodzą z innego uruchomienia niż raport cen. Nie przedstawiamy ich jako nowych plików tego przebiegu.</p>}
  {busy&&<p role="status">Odczytywanie raportu cenowego…</p>}
  {error&&<div role="alert" className="alert error">{error}<button className="button" onClick={load}><RotateCcw size={16}/>Ponów odczyt cen</button></div>}
  {data&&<><div className="dashboard-metrics">{overview.metrics.map(metric=><button key={metric.reason} className="dashboard-metric" onClick={()=>onMarket(metric.reason,null,[],transmission)}><span>{metric.label}</span><strong>{metric.count.toLocaleString('pl-PL')}</strong><small>w {metric.branches} z {overview.locationCount} oddziałów</small><span className={'metric-bars metric-'+metric.reason} role="img" aria-label={metric.days.map(day=>weekdayDate(day.date,true)+': '+day.count).join('; ')}>{metric.days.map(day=><i key={day.date} style={{height:Math.max(2,36*day.count/Math.max(1,...metric.days.map(d=>d.count)))}}/>)}</span></button>)}</div>

  </>}
 </section>;
}
