import React, { useEffect, useState } from 'react';
import { Download, ExternalLink, RotateCcw } from 'lucide-react';
import { dateRanges, durationScope, timestamp } from './display.mjs';
import { RunDiagnostics } from './RunDiagnostics.jsx';

const amount = value => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('pl-PL', {minimumFractionDigits:2,maximumFractionDigits:2})} PLN/dobę` : 'Brak danych';
const runLabel = run => !run ? 'Brak danych' : run.skipped ? 'Pominięto powtórne uruchomienie' : run.status !== 'completed' ? (run.status === 'in_progress' ? 'W trakcie' : 'Oczekuje na uruchomienie') : run.conclusion === 'success' ? 'Zakończono' : run.conclusion === 'cancelled' ? 'Anulowano' : 'Błąd';

export function ReportsView({ workspace, service, onRefresh, onPublished }) {
  const status = workspace?.status ?? {};
  const { report, excel, executions, links = {} } = status;
  const busy=false;
  const [diagnostics,setDiagnostics] = useState(null);
  const requestedId = new URLSearchParams(window.location.search).get('runId');
  const lastRun = executions?.latestScrape ?? (executions?.latest?.skipped ? null : executions?.latest);
  const targetId = requestedId ?? lastRun?.runId ?? report?.runId;
  const needsFetch = Boolean(targetId && targetId !== report?.runId);
  useEffect(() => {
    let cancelled = false;
    setDiagnostics(null);
    if (needsFetch) {
      service.diagnostics(targetId).then(result=>{if(!cancelled)setDiagnostics(result);})
        .catch(error=>{if(!cancelled)setDiagnostics({error:error.message});});
    }
    return () => {cancelled=true;};
  },[targetId,needsFetch,service,status.checkedAt]);
  const diagnosticRecord = needsFetch ? diagnostics?.report : report;
  return <details className="reports-diagnostics technical-details" open={requestedId?true:undefined}><summary>Diagnostyka uruchomienia · przebieg {targetId??"niepotwierdzony"} · start {timestamp(lastRun?.createdAt??report?.sourceStartedAt)} · {report?.quality==='failure'?'Excel nieopublikowany':excel?'Excel dostępny':'brak Excela'}</summary><section className="reports-view" aria-labelledby="results-heading">
    <div className="section-title"><h2 id="results-heading">Wyniki scrapera</h2><button className="icon-button" title="Odśwież wyniki" aria-label="Odśwież wyniki" disabled={busy} onClick={onRefresh}><RotateCcw size={18}/></button></div>
    <details className="technical-details"><summary>Harmonogram</summary><div className="schedule-summary" aria-label="Plan harmonogramu"><span>Planowany start · czas polski</span>{__SCRAPER_PLAN__.map(slot=><span key={slot.slot}><strong>{slot.time}</strong> · rolling {slot.rollingDays} dni</span>)}</div></details>
    {status.error && <div className="alert error" role="alert">{status.error}</div>}
    {status.warnings?.map((warning,index)=><p className="freshness-warning" key={index}>{warning}</p>)}
    {diagnosticRecord?.quality==='success'&&!diagnosticRecord?.incident&&!needsFetch&&!requestedId&&(!lastRun||lastRun.status==='completed'&&lastRun.conclusion==='success')?<details className="technical-details"><summary>Ostatni przebieg · bez zgłoszonego błędu</summary><RunDiagnostics record={diagnosticRecord} run={lastRun} locations={workspace.snapshot?.documents?.locations}/></details>:<>
    <h3>{requestedId ? 'Wybrane uruchomienie' : 'Ostatni faktyczny przebieg'}</h3>
    {requestedId && <p><a href="?view=results">Pokaż ostatni przebieg</a></p>}
    {needsFetch && !diagnostics ? <p role="status">Odczytywanie diagnostyki przebiegu {targetId}…</p> : diagnostics?.error ? <div className="alert error" role="alert">{diagnostics.error} Nie zastępujemy tych danych raportem z innego uruchomienia.</div> : targetId ? <RunDiagnostics key={targetId} record={diagnosticRecord} run={diagnostics?.run ?? lastRun} locations={workspace.snapshot?.documents?.locations} unavailable={diagnostics?.unavailable}/> : <p>Nie potwierdzono jeszcze faktycznego przebiegu.</p>}
    </>}
    {executions?.active?.length > 0 && <section aria-label="Bieżące uruchomienia"><h3>Bieżące uruchomienia</h3>{executions.active.map(run=><p key={run.runId}><strong>{runLabel(run)}</strong> · {timestamp(run.createdAt)} · <a href={run.url} target="_blank" rel="noreferrer">Zobacz przebieg</a></p>)}</section>}
    <details className="technical-details"><summary>Szczegóły raportu i plików</summary><h3>Ostatni raport cenowy</h3>
    {report ? <>
      <ResultFacts record={report}/>
      {report.coverage && <p>Dane cenowe: <strong>{report.coverage.found.toLocaleString('pl-PL')} / {report.coverage.expected.toLocaleString('pl-PL')}</strong> sprawdzeń{report.coverage.expected > 0 ? ` (${(100 * report.coverage.found / report.coverage.expected).toLocaleString('pl-PL',{maximumFractionDigits:2})}%)` : ''}.</p>}
      {report.quality === 'failure' && <div className="alert error">Ten raport nie zawiera nowych poprawnych plików Excel. Przyczynę pokazano w diagnostyce uruchomienia.</div>}
      {!report.incident && report.alerts?.map((alert,index)=><p className="freshness-warning" key={index}>{alert}</p>)}
      {Date.parse(workspace.publication?.approvedAt) > Date.parse(report.sourceStartedAt) && <p className="freshness-warning">Raport powstał na zasadach sprzed ostatniej zatwierdzonej zmiany.</p>}
      {links.report && <a className="button" href={links.report} target="_blank" rel="noreferrer"><ExternalLink size={18}/>Otwórz raport</a>}
    </> : <p>Brak potwierdzonego raportu cenowego.</p>}
    <h3>Ostatnie poprawne pliki Excel</h3>
    {excel ? <>
      {report && report.runId !== excel.runId && <p className="freshness-warning">Excel i raport pochodzą z różnych uruchomień. Zakres i czas Excela podano poniżej.</p>}
      <ResultFacts record={excel}/>
      <details className="technical-details"><summary>Zmiany stawek i użyta baza</summary><dl className="source-list">
        <div><dt>Podwyżki / obniżki</dt><dd>{excel.statistics?.increases ?? 'Brak danych'} / {excel.statistics?.decreases ?? 'Brak danych'}</dd></div>
        <div><dt>Średnia podwyżka</dt><dd>{amount(excel.statistics?.averageIncrease)}</dd></div>
        <div><dt>Średnia obniżka</dt><dd>{amount(excel.statistics?.averageDecrease)}</dd></div>
        <div><dt>Użyty plik bazowy</dt><dd>{excel.baselineFilename ?? 'Nie potwierdzono nazwy'}<small>{excel.baselineMatchesCurrent === true ? 'Ta sama baza co obecnie w panelu' : excel.baselineMatchesCurrent === false ? 'Inna baza niż obecnie w panelu' : 'Nie potwierdzono zgodności bazy'}</small></dd></div>
      </dl></details>
      <div className="review-actions">{links.import && <a className="button" href={links.import}><Download size={18}/>Pobierz import</a>}{links.recommendations && <a className="button" href={links.recommendations}><Download size={18}/>Pobierz rekomendacje</a>}</div>
      <a href="?view=baseline">Ustaw plik jako bazę w „Baza i lokalizacje”</a>
    </> : <p>Brak potwierdzonych plików Excel.</p>}
    </details>
    <details className="technical-details"><summary>Wersje raportu i Excela</summary><dl className="source-list">{[['Raport',report],['Excel',excel]].map(([label,record])=><div key={label}><dt>{label}</dt><dd>{record?.runId ?? 'Brak przebiegu'}<small>{record?.revision ?? 'Brak wersji'}</small></dd></div>)}</dl></details>
    {executions?.latest && <details className="technical-details"><summary>Ostatnia próba uruchomienia</summary><p>{runLabel(executions.latest)} · {timestamp(executions.latest.createdAt)} · <a href={executions.latest.url} target="_blank" rel="noreferrer">GitHub Actions</a></p></details>}
  </section></details>;
}

function ResultFacts({ record }) {
  const dates = dateRanges(record.startDates);
  return <dl className="source-list">
    <div><dt>Wygenerowano</dt><dd>{timestamp(record.generatedAt)}</dd></div>
    <div><dt>Zbieranie danych od</dt><dd>{timestamp(record.sourceStartedAt)}{Date.now()-Date.parse(record.sourceStartedAt)>86400000 && <small className="freshness-warning">Dane sprzed ponad 24 godzin</small>}</dd></div>
    <div><dt>Daty startu najmu</dt><dd>{dates.join(', ') || 'Brak danych'}</dd></div>
    <div><dt>Długość najmu</dt><dd>{durationScope(record.durations)}</dd></div>
  </dl>;
}
