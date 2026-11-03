import React, { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Search, RotateCcw } from 'lucide-react';
import { locationOptions } from './editor.mjs';
import { knownGroups, DURATION_BANDS } from './policy.mjs';
import { timestamp } from './display.mjs';
import './price-views.css';
import {weekdayDate as dayLabel} from './visual-format.mjs';

const money=value=>typeof value==='number'&&Number.isFinite(value)?value.toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2}):'Brak danych';
const bandLabel=days=>{const band=DURATION_BANDS.find(([low,high])=>low<=days&&days<=high);return band?band[0]===band[1]?String(band[0]):band.join('–'):'Brak danych';};
const list=value=>Array.isArray(value)?value.length?value.join(', '):'Brak':'Brak danych';

export function PricesView({model,workspace,service,selection,onSelectionChange}) {
  const zones=useMemo(()=>locationOptions(model),[model]);
  const groups=useMemo(()=>knownGroups(model),[model]);
  const {zone,duration,transmission,from,to}=selection;
  const setZone=zone=>onSelectionChange({zone});const setDuration=duration=>onSelectionChange({duration});
  const setTransmission=transmission=>onSelectionChange({transmission});const setFrom=from=>onSelectionChange({from});const setTo=to=>onSelectionChange({to});
  const [group,setGroup]=useState(groups.includes('CDMV')?'CDMV':groups[0]??'');
  const [data,setData]=useState(null);const [busy,setBusy]=useState(false);const [error,setError]=useState('');
  const [selected,setSelected]=useState('');const [limit,setLimit]=useState(20);
  const report=workspace?.status?.report;const excel=workspace?.status?.excel;
  const query={zone,group,duration,transmission,reportRunId:report?.runId,excelRunId:excel?.runId};
  const key=JSON.stringify([query,report?.reportSha256,excel?.files,excel?.baselineSha256]);
  const requestKey=React.useRef(key);requestKey.current=key;
  useEffect(()=>{setData(null);setError('');setSelected('');setLimit(20);},[key]);
  async function load() {
    setBusy(true);setError('');setData(null);const current=key;
    try {const result=await service.prices(query);if(requestKey.current===current){setData(result);setSelected('');setLimit(20);}}
    catch(error){if(requestKey.current===current)setError(error.message);}
    finally{setBusy(false);}
  }
  const rows=(data?.rows??[]).filter(row=>(!from||row.date>=from)&&(!to||row.date<=to));
  return <section className="prices-view" aria-label="Ceny i rynek">
    <form className="price-filters" onSubmit={event=>{event.preventDefault();load();}}>
      <label>Lokalizacja<select value={zone} onChange={e=>setZone(e.target.value)}><option value="">Wybierz lokalizację</option>{zones.map(item=><option key={item.value} value={item.value}>{item.label}</option>)}</select></label>
      <label>Klasa w Excelu<select value={group} onChange={e=>setGroup(e.target.value)}>{groups.map(item=><option key={item}>{item}</option>)}</select></label>
      <label>Długość najmu<select value={duration} onChange={e=>setDuration(Number(e.target.value))}>{Array.from({length:14},(_,i)=>i+1).map(day=><option key={day} value={day}>{day} dni · Excel {bandLabel(day)}</option>)}</select></label>
      <label>Skrzynia<select value={transmission} onChange={e=>setTransmission(e.target.value)}><option value="all">Wszystkie auta</option><option value="automatic">Tylko automaty</option></select></label>
      <button className="button primary" disabled={busy||!report||!excel||!zone||!group}><Search size={17}/>{busy?'Odczytywanie plików…':'Pokaż ceny'}</button>
    </form>
    {!report||!excel?<p className="freshness-warning">Do porównania potrzebny jest potwierdzony raport i poprawny Excel. Sprawdź Pulpit.</p>:null}
    {error&&<div className="alert error" role="alert">{error}<button className="button" disabled={busy} onClick={load}><RotateCcw size={16}/>Ponów odczyt</button></div>}
    {busy&&<p role="status">Odczytywanie opublikowanych wyników. Bez uruchamiania scrapera.</p>}
    {data&&<>
      <div className="price-context"><span>PLN brutto / dobę · Excel: {bandLabel(duration)} dni</span><span>Raport: {timestamp(data.report.generatedAt)} · Excel: {timestamp(data.excel.generatedAt)}</span></div>
      <p className="evidence-note">MM na stronie i konkurencja: najtańsze oferty w wybranym widoku rynku, niezależnie od klasy. Klasa {group} dotyczy stawek w Excelu.</p>
      {data.report.runId!==data.excel.runId&&<div className="alert">Raport cen i Excel pochodzą z różnych uruchomień. Ceny rynku nie są dowodem decyzji tego Excela.</div>}
      {Date.now()-Date.parse(data.report.sourceStartedAt)>86400000&&<p className="freshness-warning">Raport zawiera dane sprzed ponad 24 godzin.</p>}
      {data.warnings.map((text,i)=><p className="freshness-warning" key={i}>{text}</p>)}
      <div className="price-date-filters"><label>Start od<input type="date" value={from} onChange={e=>{setFrom(e.target.value);setLimit(20);}}/></label><label>Start do<input type="date" value={to} onChange={e=>{setTo(e.target.value);setLimit(20);}}/></label><span>{rows.length} dat startu</span></div>
      <table className="prices-table"><thead><tr><th>Start najmu</th><th>Baza użyta w Excelu</th><th>MM na stronie</th><th>Najtańsza konkurencja</th><th>Do importu</th><th>Prognoza / decyzja</th></tr></thead><tbody>
        {rows.slice(0,limit).map(row=><React.Fragment key={row.date}><tr className={selected===row.date?'selected-price':''}>
          <td data-label="Start najmu">{dayLabel(row.date)}</td><td data-label="Baza użyta w Excelu">{money(row.baseline)}</td><td data-label="MM na stronie">{money(row.mm)}<small>{row.rank}</small></td><td data-label="Najtańsza konkurencja">{money(row.competitor)}<small>{row.provider}</small></td><td data-label="Do importu"><strong>{money(row.importRate)}</strong>{row.changed!==null&&<small>{row.changed?`${row.importRate>row.baseline?'+':''}${money(row.importRate-row.baseline)} względem bazy`:'Bez zmiany względem bazy'}</small>}</td>
          <td data-label="Prognoza / decyzja">{row.predicted!==null?<span>{money(row.predicted)} po narzucie</span>:<span>Brak zapisanej prognozy dla klasy</span>}<button className="text-button price-explain" aria-expanded={selected===row.date} aria-controls={`decision-${row.date}`} onClick={()=>setSelected(selected===row.date?'':row.date)}>{selected===row.date?<ChevronUp size={15}/>:<ChevronDown size={15}/>}Dlaczego?</button></td>
        </tr>{selected===row.date&&<tr className="decision-row"><td colSpan="6"><DecisionEvidence row={row} data={data} duration={duration}/></td></tr>}</React.Fragment>)}
      </tbody></table>
      {!rows.length&&<p>Brak pozycji w wybranym zakresie.</p>}
      {rows.length>limit&&<button className="button" onClick={()=>setLimit(value=>value+20)}>Pokaż kolejne 20 dat</button>}
      <details className="technical-details"><summary>Źródła i wersje</summary><dl className="source-list"><div><dt>Uruchomienie raportu / Excela</dt><dd>{data.report.runId} / {data.excel.runId}</dd></div><div><dt>Wersja użyta przez Excel</dt><dd>{data.excel.revision}</dd></div><div><dt>SHA256 użytej bazy</dt><dd>{data.excel.baselineSha256}</dd></div><div><dt>Zbieranie danych od</dt><dd>{timestamp(data.report.sourceStartedAt)}</dd></div></dl></details>
    </>}
  </section>;
}

export function DecisionEvidence({row,data,duration,compact=false}) {
  const detail=row.detail;const decision=row.decision;
  const has=value=>value!==null&&value!==undefined&&value!=='';
  const benchmark=decision?.benchmark??detail?.benchmark_rate;
  const entries=[
    ['Minimum zapisane w decyzji',has(detail?.minimum_rate_pln_day)?money(detail.minimum_rate_pln_day):null],
    ['Narzut użyty w decyzji',decision?.markup || (detail?.broker_markup_model==='fixed_amount'&&has(detail?.broker_markup_amount_pln_day)?`${money(detail.broker_markup_amount_pln_day)} PLN / dobę`:has(detail?.broker_markup_percent)?`${detail.broker_markup_percent}%`:null)],
    ['Cel zapisany w Excelu',decision?.outcome?`${decision.outcome} · prognoza, nie potwierdzenie po imporcie`:null],
    ['Oferta odniesienia',has(benchmark)?`${decision?.benchmarkProvider||detail?.benchmark_provider||'Brak nazwy konkurenta'} · ${money(benchmark)} PLN / dobę`:null],
    ['Kontrolująca długość najmu',has(detail?.controlling_duration_days)?`${detail.controlling_duration_days} dni · przedział Excel ${bandLabel(duration)}`:null],
    ['Sprawdzone / wymagane brakujące długości najmu',Array.isArray(detail?.covered_duration_days)||Array.isArray(detail?.required_missing_duration_days)?`${list(detail?.covered_duration_days)} / ${list(detail?.required_missing_duration_days)}`:null],
    ['Czas danych zapisany w decyzji',detail?.source_generated_at?timestamp(detail.source_generated_at):null],
    ['Uwagi kontroli',decision?.notes],
  ].filter(([,value])=>has(value));
  if(compact&&!entries.some(([label])=>label==='Minimum zapisane w decyzji'))entries.unshift(['Minimum zapisane w decyzji','Nie zapisano w tym pliku']);
  return <section id={compact?undefined:`decision-${row.date}`} className="decision-evidence" aria-label={`Decyzja ${dayLabel(row.date)}`}>
    {!compact&&<h3>Dlaczego taka cena? · {dayLabel(row.date)}</h3>}
    <p>{decision?.reason || (row.changed===false?'Stawka pozostała taka jak w bazie. Brak zapisanego uzasadnienia pozostawienia tej pozycji.':'Brak zapisanego uzasadnienia dla tej pozycji.')}</p>
    {decision?.groups&&<p className="evidence-note">Uzasadnienie zbiorcze z Excela: {decision.groups}. Nie jest osobnym odczytem rynku dla każdej klasy.</p>}
    {entries.length>0&&(compact?<><dl className="source-list">{entries.filter(([label])=>label==='Minimum zapisane w decyzji').map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl><details><summary>Szczegóły zapisanej decyzji</summary><dl className="source-list">{entries.filter(([label])=>label!=='Minimum zapisane w decyzji').map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl></details></>:<dl className="source-list">{entries.map(([label,value])=><div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>)}
    <p className="evidence-note">Zapis z Excela uruchomienia {data.excel.runId}. Brakujące szczegóły nie są odtwarzane na podstawie aktualnych reguł. Brak danych nie oznacza braku kontroli.</p>
  </section>;
}
