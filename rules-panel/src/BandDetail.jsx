import React,{useEffect,useRef,useMemo} from 'react';
import {X,ChevronUp,ChevronDown,ExternalLink,FileSpreadsheet,ArrowRight} from 'lucide-react';
import {previewPolicy} from './policy.mjs';
import {bandLabel,bandEvidence} from './band-matrix.mjs';
import {money,scenarioLink} from './market-model.mjs';
import {locationLabel} from './operations.mjs';
import {weekdayDate,signedPrice} from './visual-format.mjs';
import {PriceBadge} from './PriceBadge.jsx';
import {InlineDecision} from './InlineDecision.jsx';
import {mixedBand} from './attention-map.mjs';

export function BandDetail({date,cell,zone,group,result,location,transmission,data,model,workspace,service,onClose,onMove,canPrevious,canNext,onSelect,onRules,onExcel,rulesModel=model}) {
 const dialog=useRef(null),heading=useRef(null),previous=useRef(document.activeElement);
 const evidence=bandEvidence(result,cell.band[0]),record=evidence?.rows.find(row=>row.date===date);
 const minima=useMemo(()=>!zone||!group?[]:Array.from({length:cell.band[1]-cell.band[0]+1},(_,i)=>previewPolicy(rulesModel,{zone,group,pickupDate:date,duration:cell.band[0]+i}).floor).filter(Number.isFinite),[rulesModel,zone,group,date,cell.band]);
 const floor=minima.length?(Math.min(...minima)===Math.max(...minima)?money(minima[0]):money(Math.min(...minima))+'–'+money(Math.max(...minima))):'Brak minimum';
 const enriched=row=>({...row,excelSelection:{zone,group},excelEvidence:evidence});
 const selected=enriched(cell.rows[0]??{date,duration:cell.band[0],location,transmission});
 const query={zone,group,pickupDate:date,duration:selected.duration};
 useEffect(()=>{
  const element=dialog.current,media=matchMedia('(min-width:1024px)');
  function open(){if(element.open)element.close();media.matches?element.show():element.showModal();heading.current?.focus({preventScroll:true});}
  open();media.addEventListener('change',open);
  return()=>{media.removeEventListener('change',open);element.close();previous.current?.focus({preventScroll:true});};
 },[]);
 useEffect(()=>{heading.current?.focus({preventScroll:true});},[date,cell.band[0]]);
 return <dialog ref={dialog} className="market-detail band-detail" aria-labelledby="band-detail-title" onCancel={e=>{e.preventDefault();onClose();}} onKeyDown={e=>{
  if(e.key==='Escape'){e.preventDefault();onClose();}
  else if(!e.altKey&&!e.ctrlKey&&!e.metaKey&&!/INPUT|SELECT|TEXTAREA/.test(e.target.tagName)&&['ArrowUp','ArrowDown'].includes(e.key)){e.preventDefault();onMove(e.key==='ArrowUp'?-1:1);}
 }}>
  <header className="market-detail-header"><div><h2 id="band-detail-title" ref={heading} tabIndex={-1}>{weekdayDate(date,true)} · pasmo {bandLabel(cell.band)} dni</h2><p>{locationLabel(location)} · <span className="code">{group}</span> <span className="code">{zone}</span></p></div><button className="icon-button" title="Zamknij szczegóły pasma" aria-label="Zamknij szczegóły pasma" onClick={onClose}><X size={20}/></button></header>
  {result&&result.report.runId!==result.excel.runId&&<p className="alert">Excel i rynek pochodzą z różnych uruchomień. Stawka importowa nie jest aktualną ceną na stronie.</p>}
  {result?.warnings?.map((warning,i)=><p className="alert" key={i}>{warning}</p>)}
  <dl className="band-key-rates"><div><dt>Baza</dt><dd>{money(record?.baseline)}</dd></div><div><dt>Do importu</dt><dd>{money(record?.importRate)}</dd>{Number.isFinite(record?.baseline)&&Number.isFinite(record?.importRate)&&<small>{signedPrice(record.importRate-record.baseline)} PLN</small>}</div><div><dt>Minimum reguł teraz</dt><dd>{floor}</dd></div></dl>
  <p className="evidence-note">PLN/dobę. Minimum pochodzi z reguł wyświetlanych w panelu (także szkicu), nie z historycznej decyzji Excela.</p>
  {mixedBand(cell.rows)&&<p className="alert" role="status"><strong>Niespójne pasmo.</strong> Dla części długości MM jest droższe o ponad 5 PLN/d, a dla innych tańsze o ponad 5 PLN/d.</p>}
  <section className="band-scenarios" aria-label={`Najem ${bandLabel(cell.band)} dni`}><h3>Rynek w tym paśmie</h3>
   {cell.band[1]===20&&<p className="evidence-note">15–20 dni: brak sprawdzeń rynku. Stawka Excela obejmuje cały przedział 8–20.</p>}
   {cell.unavailable>0&&<p className="evidence-note">Brak potwierdzonych cen dla: {cell.expected.filter(d=>!cell.rows.some(r=>r.duration===d&&r.marketConfirmed)).join(', ')} dni.</p>}
   <table><thead><tr><th>Najem</th><th>MM</th><th><abbr title="Najtańszy konkurent">Konk.</abbr></th><th>Różnica</th><th>Pozycja</th><th></th></tr></thead><tbody>{cell.rows.map(row=><tr key={row.key}><th>{row.duration} dni</th><td>{row.marketConfirmed?money(row.mm):'?'}</td><td>{row.marketConfirmed?money(row.competitor):'?'}<small>{row.provider}</small></td><td><PriceBadge gap={row.gap} missing={row.marketConfirmed&&row.mm===null} unavailable={!row.marketConfirmed}/></td><td>{row.rankLabel??'Brak danych'}</td><td><button className="icon-button" title="Szczegóły scenariusza" aria-label="Szczegóły" onClick={()=>{onClose();onSelect(enriched(row),cell.rows.map(enriched));}}><ArrowRight size={15}/></button></td></tr>)}</tbody></table>
   {!cell.rows.length&&<p>Brak sprawdzonych scenariuszy w tym przedziale.</p>}
  </section>
  <details className="technical-details"><summary>Szczegóły zapisanej decyzji</summary>{evidence?<InlineDecision lockedSelection key={date+'-'+group+'-'+zone} row={selected} data={data} model={model} workspace={workspace} service={service}/>:<p>Brak odczytanego zapisu Excela dla tego pasma.</p>}</details>
  <div className="event-actions"><button className="button primary" disabled={!zone||!group} onClick={()=>{onClose();onRules(query);}}>Zobacz reguły dla tej pozycji</button>{cell.rows.length>0&&<a className="button" href={scenarioLink(data.report.runId,selected)} target="_blank" rel="noreferrer"><ExternalLink size={16}/>Scenariusz</a>}<button className="button" disabled={!zone} onClick={()=>{onClose();onExcel(selected);}}><FileSpreadsheet size={16}/>Pełna tabela</button></div>
  <nav className="detail-navigation" aria-label="Sąsiednie daty w paśmie"><button className="button" disabled={!canPrevious} onClick={()=>onMove(-1)}><ChevronUp size={16}/>Poprzedni dzień</button><button className="button" disabled={!canNext} onClick={()=>onMove(1)}><ChevronDown size={16}/>Następny dzień</button></nav>
 </dialog>;
}
