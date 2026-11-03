import React from 'react';
import { ArrowRight } from 'lucide-react';
import { timestamp } from './display.mjs';
import { marketSignals,money } from './market-model.mjs';
import { gapLabel,overviewRows } from './market-review.mjs';
import { nextSchedule } from './change-review.mjs';

export function Dashboard({workspace,market,changes,confirmations,onReview,onMarket}) {
  const {report,excel}=workspace?.status??{};const next=nextSchedule(__SCRAPER_PLAN__);
  const rows=overviewRows(market.data).map(row=>({...row,signals:marketSignals(row,report)}));
  const above=rows.filter(row=>row.marketConfirmed&&row.mm!=null&&row.competitor!=null&&row.gap<0).sort((a,b)=>a.gap-b.gap||a.date.localeCompare(b.date)||a.duration-b.duration);
  const counters=[['missing','Brak oferty MM',rows.filter(row=>row.signals.includes('missing')).length],['over10','MM droższe o ponad 10 PLN/dobę',above.filter(row=>row.gap<-10).length],['gap30','Top1: zapas co najmniej 30 PLN/dobę',rows.filter(row=>row.signals.includes('gap30')).length],['unavailable','Brak potwierdzonych danych',rows.filter(row=>row.signals.includes('unavailable')).length]];
  const old=report&&Date.now()-Date.parse(report.sourceStartedAt)>86400000;
  return <section className="operations-dashboard" aria-label="Poranny przegląd">
    <div className="dashboard-toolbar"><p>{next?`Planowany start: ${next.date.split('-').reverse().join('.')} · ${next.time}, czas polski · rolling ${next.rollingDays} dni`:'Brak potwierdzonego planu harmonogramu'}</p><button className="button primary" onClick={()=>onMarket('all')}>Zacznij przegląd<ArrowRight size={17}/></button></div>
    <div className="dashboard-status">
      <article><h2>Raport cen · {report?old?'starszy niż 24 h':'dostępny':'brak danych'}</h2><strong>{report?timestamp(report.generatedAt):'Brak potwierdzonego raportu'}</strong><p>{report?`Zbieranie danych od ${timestamp(report.sourceStartedAt)}`:'Nie potwierdzono źródła danych.'}</p>{report?.coverage&&<p>{report.coverage.found.toLocaleString('pl-PL')} / {report.coverage.expected.toLocaleString('pl-PL')} sprawdzeń</p>}</article>
      <article className={report?.quality==='failure'?'status-warning':''}><h2>Excel · {excel?'ostatnie poprawne pliki':'brak poprawnych plików'}</h2><strong>{excel?timestamp(excel.generatedAt):'Nie opublikowano'}</strong>{report?.quality==='failure'&&<p>Ten raport nie opublikował nowych plików Excel.</p>}{excel&&report?.runId!==excel.runId&&<p>Excel pochodzi z innego uruchomienia niż raport cen.</p>}<a className="text-button" href="#results-heading">Pliki i diagnostyka</a></article>
      <article className={changes.length?'status-draft':''}><h2>Zasady · {changes.length?'szkic nieopublikowany':'brak zmian w szkicu'}</h2><strong>{changes.length} zmian pól</strong><p>{confirmations.length} potwierdzeń dużych kwot</p>{changes.length>0&&<button className="text-button" onClick={onReview}>Przejrzyj zmiany</button>}</article>
    </div>
    <div className="section-title"><h2>Do sprawdzenia · najbliższe 14 dni</h2><span>Wszystkie lokalizacje · wszystkie auta · najem 2–14 dni</span></div>
    {market.busy&&<p role="status">Odczytywanie raportu do przeglądu…</p>}
    {market.error&&<div className="alert error" role="alert">Nie odczytano cen do przeglądu. {market.error}<button className="button" onClick={market.load}>Ponów odczyt cen</button></div>}
    <div className="dashboard-counters">{counters.map(([id,title,count])=><button key={id} className={`counter-item ${id}`} disabled={!market.data} onClick={()=>onMarket(id)}><span>{title}</span><strong>{market.data?count:'—'}</strong></button>)}</div>
    <div className="section-title"><h2>MM droższe od konkurencji</h2><button className="text-button" onClick={()=>onMarket('outside')}>Pełna lista<ArrowRight size={16}/></button></div>
    <table className="dashboard-prices"><thead><tr><th>Lokalizacja</th><th>Start / najem</th><th>MM</th><th>Najtańszy konkurent</th><th>Różnica</th><th></th></tr></thead><tbody>{above.slice(0,5).map(row=><tr key={row.key}><th data-label="Lokalizacja" scope="row">{row.location}</th><td data-label="Start / najem">{row.date} · {row.duration} dni</td><td data-label="MM">{money(row.mm)}</td><td data-label="Najtańszy konkurent">{money(row.competitor)} · {row.provider}</td><td className="price-above" data-label="Różnica">{gapLabel(row.gap)}</td><td><button className="text-button" onClick={()=>onMarket('outside',row,above)}>Otwórz</button></td></tr>)}</tbody></table>
    {market.data&&!above.length&&<p>Brak potwierdzonych pozycji z ceną MM wyższą od najtańszego konkurenta w tym zakresie.</p>}
  </section>;
}
