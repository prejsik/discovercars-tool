import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Search, TriangleAlert } from 'lucide-react';
import { timestamp } from './display.mjs';

const money = value => value.toLocaleString('pl-PL',{minimumFractionDigits:2,maximumFractionDigits:2});
const date = value => value.split('-').reverse().join('.');
const origins = {baseline:'Stawka zachowana z bazy',market:'Rekomendacja rynkowa',group_parity:'Wyrównanie klas',mandatory_floor:'Obowiązkowe minimum',unknown:'Nie potwierdzono źródła'};
const REPO = 'https://github.com/prejsik/discovercars-tool';

export function RunDiagnostics({ record, run, locations, unavailable }) {
  const [search,setSearch] = useState('');
  const [page,setPage] = useState(0);
  const incident = record?.incident;
  const list = locations?.locations ?? locations ?? [];
  const label = row => row.location && row.location !== row.zone ? row.location : list.find(item => item.zones?.includes(row.zone))?.scraper_label ?? row.zone;
  const filtered = (incident?.positions ?? []).filter(row => `${row.zone} ${label(row)} ${row.group} ${row.pickupDate} ${date(row.pickupDate)} ${row.duration}`.toLocaleLowerCase('pl').includes(search.trim().toLocaleLowerCase('pl')));
  const pageCount = Math.max(1,Math.ceil(filtered.length/20));
  const currentPage = Math.min(page,pageCount-1);
  const revision = /^[a-f0-9]{40}$/.test(record?.revision ?? run?.revision ?? '') ? record?.revision ?? run?.revision : null;
  return <section className="run-diagnostics" aria-label="Diagnostyka uruchomienia">
    <p className="run-time"><strong>Start procesu:</strong> {timestamp(record?.sourceStartedAt ?? run?.startedAt ?? run?.createdAt)}{record?.runId && <> · przebieg {record.runId}</>}</p>
    {incident ? <>
      <div className="incident-heading"><TriangleAlert size={21}/><h3>{incident.title}</h3></div>
      <p>{incident.explanation}</p>
      <p className="incident-next"><strong>{incident.owner === 'configuration' ? 'Do decyzji osoby zarządzającej zasadami.' : 'Do sprawdzenia technicznego.'}</strong> {incident.nextStep}</p>
      <details className="incident-details"><summary>Pokaż szczegóły błędu{incident.positions.length > 0 ? ` · ${incident.complete ? incident.total : incident.positions.length} ${incident.complete ? 'pozycji' : 'zapisanych przykładów'}` : ''}</summary>
      {incident.positions.length > 0 ? <>
        <div className="diagnostic-tools">
          <h4>Problematyczne pozycje</h4>
          <label className="diagnostic-search"><Search size={16}/><input aria-label="Filtruj problematyczne pozycje" type="search" placeholder="Lokalizacja, data lub klasa" value={search} onChange={event=>{setSearch(event.target.value);setPage(0);}}/></label>
        </div>
        <p className="diagnostic-scope">{incident.complete ? `Zapisano wszystkie pozycje: ${incident.total}.` : incident.total !== null ? `Zapisano ${incident.positions.length} z ${incident.total} pozycji.` : `Starszy raport zawiera ${incident.positions.length} przykładowych pozycji. Pełna liczba i źródło stawek nie zostały zapisane.`}</p>
        <table className="diagnostic-table" aria-label="Pozycje blokujące Excel">
          <thead><tr>{['Lokalizacja','Start najmu','Klasa','Najem','Stawka / doba','Limit / doba','Źródło stawki'].map(name=><th key={name} scope="col">{name}</th>)}</tr></thead>
          <tbody>{filtered.slice(currentPage*20,currentPage*20+20).map((row,index)=><tr key={`${row.zone}-${row.pickupDate}-${row.group}-${row.column}-${index}`}>
            <td data-label="Lokalizacja"><strong>{row.zone}</strong><small>{label(row)}</small></td>
            <td data-label="Start najmu">{date(row.pickupDate)}</td>
            <td data-label="Klasa">{row.group}</td>
            <td data-label="Najem">{row.duration.replace('-','–')} dni</td>
            <td data-label="Stawka / doba" className="diagnostic-rate">{money(row.rate)} PLN</td>
            <td data-label="Limit / doba">{money(row.limit)} PLN{row.airportZone && <small>Lotnisko: {row.airportZone}</small>}</td>
            <td data-label="Źródło stawki">{origins[row.rateOrigin] ?? origins.unknown}</td>
          </tr>)}</tbody>
        </table>
        {!filtered.length && <p role="status">Brak pozycji pasujących do filtra.</p>}
        {pageCount > 1 && <nav className="diagnostic-pagination" aria-label="Strony problematycznych pozycji">
          <span>{currentPage*20+1}–{Math.min((currentPage+1)*20,filtered.length)} z {filtered.length}</span>
          <button className="icon-button" title="Poprzednie pozycje" aria-label="Poprzednie pozycje" disabled={currentPage===0} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={18}/></button>
          <button className="icon-button" title="Następne pozycje" aria-label="Następne pozycje" disabled={currentPage===pageCount-1} onClick={()=>setPage(currentPage+1)}><ChevronRight size={18}/></button>
        </nav>}
      </> : <p>Ten raport nie wskazuje konkretnych komórek. Nie przypisujemy błędu do przypadkowych stawek.</p>}
      <details className="technical-details"><summary>Szczegóły techniczne</summary><pre>{incident.technicalDetails || 'Brak zapisanego komunikatu.'}</pre></details>
      </details>
    </> : unavailable ? <div className="alert" role="status">{unavailable}{run?.failureStage && <p>Etap: {run.failureStage}</p>}</div> : <p>Brak zgłoszonego błędu w tym raporcie.</p>}
    <div className="diagnostic-sources">
      {revision && <details><summary>Zasady i baza użyte w tym przebiegu</summary>
        <p>To wersje z uruchomienia, nie aktualny szkic panelu.</p>
        <ul><li><a href={`${REPO}/blob/${revision}/pricing-rules.config.example.json`} target="_blank" rel="noreferrer">Zasady cenowe z tego przebiegu</a></li>
          <li><a href={`${REPO}/blob/${revision}/excel-rate-update.config.example.json`} target="_blank" rel="noreferrer">Zasady kontroli Excela z tego przebiegu</a></li>
          <li><a href={`${REPO}/blob/${revision}/input/baseline-manifest.json`} target="_blank" rel="noreferrer">Potwierdzenie użytej bazy</a></li></ul>
      </details>}
      {(run?.url || record?.runUrl) && <a href={run?.url ?? record.runUrl} target="_blank" rel="noreferrer">Przebieg w GitHub Actions</a>}
    </div>
  </section>;
}
