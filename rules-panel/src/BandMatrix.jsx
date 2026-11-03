import React,{useEffect,useMemo,useState} from 'react';
import {knownGroups} from './policy.mjs';
import {buildBandMatrix,bandLabel,bandEvidence,MATRIX_BANDS} from './band-matrix.mjs';
import {money} from './market-model.mjs';
import {dayLabel} from './operations.mjs';
import {gapLabel} from './market-review.mjs';

export function BandMatrix({data,rows,dates,location,transmission,model,workspace,service,onSelect}) {
 const groups=knownGroups(model),zones=data.locations.find(l=>l.scraper_label===location)?.zones??[];
 const [group,setGroup]=useState(groups.includes('CDMV')?'CDMV':groups[0]);
 const [chosen,setChosen]=useState('');const zone=zones.includes(chosen)?chosen:zones[0];
 const [state,setState]=useState({}),[attempt,setAttempt]=useState(0),[expanded,setExpanded]=useState(null),[limit,setLimit]=useState(20);
 const excel=workspace?.status?.excel;
 const key=JSON.stringify([zone,group,data.report.runId,excel?.runId,excel?.files]);
 useEffect(()=>{let active=true;setState({key,busy:true});
  if(!excel||!zone||!group){setState({key,error:'Brak poprawnego Excela lub powiązania lokalizacji.'});return;}
  service.prices({mode:'matrix',zone,group,duration:2,transmission,reportRunId:data.report.runId,excelRunId:excel.runId})
   .then(result=>{if(active)setState({key,data:result});}).catch(error=>{if(active)setState({key,error:error.message});});
  return()=>{active=false;};
 },[key,attempt,service]);
 useEffect(()=>{setExpanded(null);setLimit(20);onSelect(null);},[key,dates.join(','),transmission,onSelect]);
 const current=state.key===key?state:{};
 const matrix=useMemo(()=>buildBandMatrix(dates,rows,data.report.durations),[dates,rows,data.report.durations]);
 function enriched(row){return {...row,excelSelection:{zone,group},excelEvidence:bandEvidence(current.data,row.duration)};}
 return <section className="band-workspace">
  <div className="market-filters"><label>Klasa w tabeli<select value={group} onChange={e=>setGroup(e.target.value)}>{groups.map(g=><option key={g}>{g}</option>)}</select></label>{zones.length>1&&<label>Kod w tabeli<select value={zone} onChange={e=>setChosen(e.target.value)}>{zones.map(z=><option key={z}>{z}</option>)}</select></label>}<span className="evidence-note">Stawka do importu · {zone??'brak kodu'} · PLN/dobę</span></div>
  <details className="technical-details"><summary>Źródła i zakres porównania</summary><p>Stawka do importu: wybrana klasa i kod z ostatniego poprawnego Excela. Różnica rynku: najtańsze oferty MM i konkurencji, niezależnie od klasy. W przedziale pokazano największą przewagę konkurencji, nie średnią. Brak MM oznacza potwierdzony brak oferty; brak danych oznacza niepotwierdzony odczyt.</p></details>
  {current.error&&<p role="alert">{current.error}<button className="text-button" onClick={()=>setAttempt(n=>n+1)}>Ponów odczyt Excela</button></p>}
  {current.data&&current.data.report.runId!==current.data.excel.runId&&<p className="alert">Excel i rynek pochodzą z różnych uruchomień. Nie traktuj stawki importowej jako aktualnej ceny na stronie.</p>}
  {current.data?.warnings?.map((w,i)=><p className="alert" key={i}>{w}</p>)}
  <table className="band-matrix"><thead><tr><th>Data startu</th>{MATRIX_BANDS.map(b=><th key={b[0]}>{bandLabel(b)} dni{b[1]===20&&<small>rynek 8–14 dni</small>}</th>)}</tr></thead><tbody>{matrix.slice(0,limit).map(day=><React.Fragment key={day.date}><tr className="band-date"><th scope="row">{dayLabel(day.date)}</th>{day.cells.map(cell=>{
   const id=day.date+'-'+cell.band[0],open=expanded===id;
   const rate=bandEvidence(current.data,cell.band[0])?.rows.find(r=>r.date===day.date)?.importRate;
   return <td key={id}><button className="band-cell" aria-label={`${dayLabel(day.date)} · ${bandLabel(cell.band)} dni`} aria-expanded={open} onClick={()=>setExpanded(open?null:id)}><small className="mobile-band">{bandLabel(cell.band)} dni</small><strong>{current.busy?'Odczyt…':rate==null?'Brak stawki':money(rate)}</strong><span className={cell.worstGap<0?'above':''}>{gapLabel(cell.worstGap)}</span>{cell.missingMM>0&&<small>Brak MM: {cell.missingMM}</small>}{cell.unavailable>0&&<small>Brak danych: {cell.unavailable}/{cell.expected.length}</small>}{!cell.expected.length&&<small>Brak odczytów</small>}</button></td>;
  })}</tr>{day.cells.filter(c=>expanded===day.date+'-'+c.band[0]).map(cell=><tr className="band-expanded" key={cell.band[0]}><td colSpan={5}><section className="band-scenarios" aria-label={`Najem ${bandLabel(cell.band)} dni`}><h3>{dayLabel(day.date)} · {bandLabel(cell.band)} dni</h3>{cell.band[1]===20&&<p className="evidence-note">15–20 dni: brak sprawdzeń rynku. Stawka Excela obejmuje cały przedział 8–20.</p>}{cell.unavailable>0&&<p className="evidence-note">Brak potwierdzonych cen dla: {cell.expected.filter(d=>!cell.rows.some(r=>r.duration===d&&r.marketConfirmed)).join(', ')} dni.</p>}<table><thead><tr><th>Najem</th><th>MM / dobę</th><th>Konkurencja / dobę</th><th>Różnica</th><th></th></tr></thead><tbody>{cell.rows.map(row=><tr key={row.key}><th>{row.duration} dni</th><td>{row.marketConfirmed?money(row.mm):'Brak danych'}</td><td>{row.marketConfirmed?money(row.competitor):'Brak danych'}<small>{row.provider}</small></td><td>{gapLabel(row.gap)}</td><td><button className="text-button" onClick={()=>onSelect(enriched(row),cell.rows.map(enriched))}>Szczegóły</button></td></tr>)}</tbody></table>{!cell.rows.length&&<p>Brak sprawdzonych scenariuszy w tym przedziale.</p>}</section></td></tr>)}</React.Fragment>)}</tbody></table>
  {matrix.length>limit&&<button className="button" onClick={()=>setLimit(n=>n+20)}>Pokaż kolejne 20 dat</button>}
 </section>;
}
