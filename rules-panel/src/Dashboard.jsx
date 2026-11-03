import React from 'react';
import {ArrowRight,Download} from 'lucide-react';
import {timestamp,dateRanges} from './display.mjs';
export function Dashboard({workspace,onMarket}) {
 const {report,excel,links={}}=workspace?.status??{};
 return <section className="operations-dashboard" aria-label="Podsumowanie raportu">
 <p>{report?`Odczyt cen od ${timestamp(report.sourceStartedAt)} · starty ${dateRanges(report.startDates).join(', ')}`:'Brak potwierdzonego raportu cenowego.'}</p>
 <p>{excel?`Excel: ${timestamp(excel.generatedAt)}`:'Brak poprawnych plików Excel.'}{excel&&report?.runId!==excel.runId&&' Pliki pochodzą z innego uruchomienia niż raport cen.'}</p>
 {report&&Date.now()-Date.parse(report.sourceStartedAt)>86400000&&<p className="alert">Dane cenowe są starsze niż 24 godziny.</p>}
 <div className="review-actions">{excel&&links.import&&<a className="button primary" href={links.import}><Download size={17}/>Import</a>}{excel&&links.recommendations&&<a className="button" href={links.recommendations}><Download size={17}/>Rekomendacje</a>}<button className="button" onClick={()=>onMarket('all')}>Przejrzyj ceny<ArrowRight size={17}/></button></div>
 </section>;
}
