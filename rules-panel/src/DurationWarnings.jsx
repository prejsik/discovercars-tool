import React,{useEffect,useState} from 'react';
import {dayLabel} from './operations.mjs';
export function DurationWarnings({model,original}){
 const [state,setState]=useState(null);
 useEffect(()=>{setState(null);const worker=new Worker(new URL('./duration-warnings.worker.mjs',import.meta.url),{type:'module'});worker.onmessage=e=>setState(e.data);worker.onerror=()=>setState({error:'Nie można odczytać ostrzeżeń długości najmu.'});worker.postMessage({model,original,today:new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Warsaw'}).format(new Date())});return()=>worker.terminate();},[model,original]);
 const rows=items=>items.map(r=><p key={r.key}>{r.message}<small style={{display:'block'}}>Próbkowane daty: {r.dates.map(dayLabel).join(', ')}. Ostrzeżenie nie blokuje publikacji.</small></p>);
 return <section aria-label="Minima według długości najmu"><h4>Minima według długości najmu</h4>{!state?<p role="status">Sprawdzanie sześciu pasm… Publikacja pozostaje dostępna.</p>:state.error?<p>{state.error}</p>:<>{state.added.length?rows(state.added):<p>Brak nowych ostrzeżeń o droższym dłuższym paśmie.</p>}<details><summary>Znane nakładania: droższe dłuższe pasma ({state.known.length})</summary>{rows(state.known)}</details></>}</section>;
}
