import React from 'react';
import {baselineRange,baselineWarnings} from './baseline-presentation.mjs';
export function BaselineComparison({before,after,model}){
 const count=v=>Number.isFinite(v)?v.toLocaleString('pl-PL',{useGrouping:'always'}):'Brak danych';
 const rows=[['Wiersze',before?.rowCount,after.rowCount],['Daty startu',baselineRange(before),baselineRange(after)],['Klasy',before?.groups?.length,after.groups?.length],['Kody stref',before?.zones?.length,after.zones?.length]];
 return <section aria-label="Nowa baza a obecna"><h3>Nowa baza a obecna</h3><div className="baseline-table-scroll"><table><thead><tr><th>Zakres</th><th>Obecna</th><th>Nowa</th><th>Zmiana</th></tr></thead><tbody>{rows.map(([name,a,b])=><tr key={name}><th scope="row">{name}</th><td>{typeof a==='string'?a:count(a)}</td><td>{typeof b==='string'?b:count(b)}</td><td>{typeof a==='number'&&typeof b==='number'?`${b-a>0?'+':''}${count(b-a)}`:a===b?'Bez zmian':'Zmieniony zakres'}</td></tr>)}</tbody></table></div>{baselineWarnings(before,after,model).map(text=><p className="freshness-warning" key={text}>{text}. Ostrzeżenie nie blokuje ustawienia bazy.</p>)}</section>;
}
