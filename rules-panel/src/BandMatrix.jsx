import React,{useEffect,useMemo,useState} from 'react';
import {buildBandMatrix,bandLabel,bandEvidence,MATRIX_BANDS} from './band-matrix.mjs';
import {money} from './market-model.mjs';
import {weekdayDate,isWeekend} from './visual-format.mjs';
import {PriceBadge} from './PriceBadge.jsx';
import {BandDetail} from './BandDetail.jsx';
const dayLabel=value=>weekdayDate(value,true);


export function BandMatrix({data,rows,dates,location,transmission,model,workspace,service,onSelect,highlight,group,zone,onRules,onExcel,activeView=true,rulesModel=model}) {
 const [state,setState]=useState({}),[attempt,setAttempt]=useState(0),[expanded,setExpanded]=useState(null),[limit,setLimit]=useState(20);
 const excel=workspace?.status?.excel;
 const key=JSON.stringify([zone,group,data.report.runId,excel?.runId,excel?.files]);
 useEffect(()=>{if(!activeView||(state.key===key&&state.data))return;let active=true;setState({key,busy:true});
  if(!excel||!zone||!group){setState({key,error:'Brak poprawnego Excela lub powiązania lokalizacji.'});return;}
  const controller=new AbortController();
  service.prices({mode:'matrix',zone,group,duration:2,transmission,reportRunId:data.report.runId,excelRunId:excel.runId},{signal:controller.signal})
   .then(result=>{if(active)setState({key,data:result});}).catch(error=>{if(active)setState({key,error:error.message});});
  return()=>{active=false;controller.abort();};
 },[key,attempt,service,activeView]);
 useEffect(()=>{setExpanded(null);setLimit(20);onSelect(null);},[key,dates.join(','),transmission,onSelect]);
 useEffect(()=>{if(!highlight)return;setLimit(n=>Math.max(n,dates.indexOf(highlight)+1));requestAnimationFrame(()=>document.getElementById('band-day-'+highlight)?.scrollIntoView({block:'nearest'}));},[highlight,dates.join(',')]);
 useEffect(()=>{if(!activeView)setExpanded(null);},[activeView]);
 const current=state.key===key?state:{};
 const matrix=useMemo(()=>buildBandMatrix(dates,rows,data.report.durations),[dates,rows,data.report.durations]);
 const active=matrix.flatMap(day=>day.cells.map(cell=>({date:day.date,cell}))).find(item=>expanded===item.date+'-'+item.cell.band[0]);
 const dayIndex=active?matrix.findIndex(day=>day.date===active.date):-1;
 function moveDay(step){const day=matrix[dayIndex+step];if(day&&active){setExpanded(day.date+'-'+active.cell.band[0]);setLimit(n=>Math.max(n,dayIndex+step+1));}}

 return <section className="band-workspace">
  <details className="technical-details"><summary>Źródła i zakres porównania</summary><p>Stawka do importu: wybrana klasa i kod z ostatniego poprawnego Excela. Różnica rynku: najtańsze oferty MM i konkurencji, niezależnie od klasy. W przedziale pokazano największą przewagę konkurencji, nie średnią. Brak MM oznacza potwierdzony brak oferty; brak danych oznacza niepotwierdzony odczyt.</p></details>
  {current.error&&<p role="alert">{current.error}<button className="text-button" onClick={()=>setAttempt(n=>n+1)}>Ponów odczyt Excela</button></p>}
  {current.data&&current.data.report.runId!==current.data.excel.runId&&<p className="alert">Excel i rynek pochodzą z różnych uruchomień. Nie traktuj stawki importowej jako aktualnej ceny na stronie.</p>}
  {current.data?.warnings?.map((w,i)=><p className="alert" key={i}>{w}</p>)}
  <div className={`band-layout ${active?'has-band-detail':''}`}><div className="band-matrix-pane"><div className="band-matrix-scroll">
  <table className="band-matrix"><thead><tr><th>Start</th>{MATRIX_BANDS.map(b=><th key={b[0]}>{bandLabel(b)} dni{b[1]===20&&<small>rynek 8–14 dni</small>}</th>)}</tr></thead><tbody>{matrix.slice(0,limit).map(day=><tr key={day.date} id={'band-day-'+day.date} className={'band-date '+(isWeekend(day.date)?'weekend ':'')+(day.date===highlight?'highlight-day':'')}><th scope="row">{dayLabel(day.date)}</th>{day.cells.map(cell=>{
   const id=day.date+'-'+cell.band[0],open=expanded===id;
   const rate=bandEvidence(current.data,cell.band[0])?.rows.find(r=>r.date===day.date)?.importRate;
   return <td key={id}><button className="band-cell" aria-label={`${weekdayDate(day.date)} · ${bandLabel(cell.band)} dni${cell.missingMM?' · brak MM w '+cell.missingMM+' z '+cell.expected.length+' długości':''}`} aria-expanded={open} onClick={()=>setExpanded(open?null:id)}><small className="mobile-band">{bandLabel(cell.band)} dni</small><strong>{current.busy?'Odczyt…':rate==null?'Brak stawki':money(rate)}</strong><PriceBadge gap={cell.worstGap} missing={cell.missingMM>0} unavailable={cell.worstGap===null&&!cell.missingMM}/>{cell.unavailable>0&&<small className="band-unavailable" title={`Brak potwierdzonych danych: ${cell.unavailable}/${cell.expected.length} długości`}>?</small>}</button></td>;
  })}</tr>)}</tbody></table></div>
  <p className="evidence-note">Liczba: stawka do importu · etykieta: najgorsza różnica rynku MM − konkurent w paśmie · brak MM: potwierdzony brak oferty w paśmie</p>
  {matrix.length>limit&&<button className="button" onClick={()=>setLimit(n=>n+20)}>Pokaż kolejne 20 dat</button>}
  </div>{active&&<BandDetail rulesModel={rulesModel} {...active} zone={zone} group={group} result={current.data} location={location} transmission={transmission} data={data} model={model} workspace={workspace} service={service} onClose={()=>setExpanded(null)} onMove={moveDay} canPrevious={dayIndex>0} canNext={dayIndex<matrix.length-1} onSelect={onSelect} onRules={onRules} onExcel={onExcel}/>}
  </div>
 </section>;
}
