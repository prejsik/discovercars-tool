import React from 'react';
import {baselineRange,baselineWarnings,baselineDelta,codesDelta} from './baseline-presentation.mjs';
import {TriangleAlert} from 'lucide-react';
export function BaselineComparison({before,after,model}){
 const count=v=>Number.isFinite(v)?v.toLocaleString('pl-PL',{useGrouping:'always'}):'Brak danych';
 const rows=[['Wiersze',before?.rowCount,after.rowCount,baselineDelta(before?.rowCount,after.rowCount)],['Daty startu',baselineRange(before),baselineRange(after),!before?'Brak danych porównawczych':baselineRange(before)===baselineRange(after)?'bez zmian':'Zmieniony zakres'],['Klasy',before?.groups?.length,after.groups?.length,codesDelta(before?.groups,after.groups)],['Kody stref',before?.zones?.length,after.zones?.length,codesDelta(before?.zones,after.zones)]];
 return <section className="baseline-comparison" aria-label="Nowa baza a obecna"><h3>Nowa baza a obecna</h3><div className="baseline-table-scroll"><table><thead><tr><th>Zakres</th><th>Obecna</th><th>Nowa</th><th>Zmiana</th></tr></thead><tbody>{rows.map(([name,a,b,delta])=><tr key={name}><th scope="row">{name}</th><td>{typeof a==='string'?a:count(a)}</td><td>{typeof b==='string'?b:count(b)}</td><td>{delta}</td></tr>)}</tbody></table></div>{baselineWarnings(before,after,model).map(text=><p className="alert baseline-warning" key={text}><TriangleAlert size={18} aria-hidden="true"/><span>{text}. Ostrzeżenie nie blokuje ustawienia bazy.</span></p>)}</section>;
}
