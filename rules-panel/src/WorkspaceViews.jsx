import React from "react";
import { ClipboardCheck, ExternalLink, History, RotateCcw } from "lucide-react";
import { locationOptions } from "./editor.mjs";
import { dateRanges, durationScope, timestamp, modeLabel } from "./display.mjs";

const short = value => value ? String(value).slice(0, 12) : "Brak danych";
const safeUrl = value => { try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : undefined; } catch { return undefined; } };
const countsLabels = { changedRateCells: "Zmienione komórki stawek", increasedRateCells: "Podwyżki", decreasedRateCells: "Obniżki", addedRateCells: "Dodane stawki", removedRateCells: "Usunięte stawki", unchangedRateCells: "Bez zmiany" };
const previewLabels = { requesting: "Zlecanie", queued: "W kolejce", running: "Przeliczanie", success: "Przeliczono", blocked: "Zablokowany", failure: "Błąd" };
const actionLabels = { save: "Zapis szkicu", approval_pending: "Rozpoczęcie zatwierdzenia", publish: "Publikacja konfiguracji", rollback: "Przywrócenie do szkicu" };

export function ImpactReview({ workspace, model, busy, blocked, publicationBlocker, onPreview, onRefresh }) {
  const { preview, draft, capabilities } = workspace;
  const matches = preview?.draftRevision === draft?.revision;
  const pending = matches && ["requesting", "queued", "running"].includes(preview?.status);
  const counts = preview?.impact;
  const samples = counts?.samples ?? [];
  const labels = new Map(locationOptions(model).map(item => [item.value, item.label]));
  return <section className="impact-review" aria-labelledby="impact-heading">
    <div className="section-title"><h2 id="impact-heading">Wpływ na dane raportu</h2><span className="badge">{modeLabel(workspace.snapshot.capabilities?.mode)}</span></div>
    <div className="review-actions"><button className="button" disabled={busy || blocked || pending || !draft || !capabilities.preview} onClick={onPreview}><ClipboardCheck size={17} />{busy ? "Przetwarzanie…" : "Przelicz wpływ szkicu"}</button><button className="icon-button" disabled={busy} onClick={onRefresh} title="Odśwież wynik podglądu" aria-label="Odśwież wynik podglądu"><RotateCcw size={18} /></button></div>
    {!preview ? <p className="empty-copy">Brak przeliczenia wpływu na rzeczywiste wiersze.</p> : <>
      <dl className="result-facts"><div><dt>Stan podglądu</dt><dd>{previewLabels[preview.status] ?? "Brak danych"}</dd></div><div><dt>Wersja podglądu</dt><dd>{short(preview.revision)}</dd></div><div><dt>Szkic</dt><dd>{matches ? "Aktualny" : "Inna wersja szkicu"} · {short(preview.draftRevision)}</dd></div><div><dt>Przeliczenie</dt><dd>{timestamp(preview.completedAt)}</dd></div><div><dt>Najstarsze dane źródłowe</dt><dd>{timestamp(preview.dataCollectedAt)}</dd></div></dl>
      {preview.error && <div className="alert error" role="alert">{typeof preview.error === "string" ? preview.error : preview.error.message}</div>}
      {counts && <dl className="impact-counts">{Object.entries(countsLabels).filter(([key]) => Number.isFinite(counts[key])).map(([key, label]) => <div key={key}><dt>{label}</dt><dd>{counts[key].toLocaleString("pl-PL")}</dd></div>)}</dl>}
      {samples.length > 0 && <div className="impact-samples"><h3>Próbka komórek stawek ({samples.length}{counts.samplesTruncated ? ", wynik skrócony" : ""})</h3><table><thead><tr><th>Lokalizacja / klasa</th><th>Start / najem</th><th>Przed (PLN)</th><th>Po (PLN)</th><th>Wynik</th></tr></thead><tbody>{samples.map((row, index) => <tr key={index}><td>{labels.get(row.position?.zone) ?? row.position?.zone ?? "Brak kodu"}<small>{row.position?.group} · {row.position?.cell}</small></td><td>{row.position?.pickupDate}<small>{row.position?.durationBand} dni</small></td><td>{row.beforeRate ?? "Brak"}</td><td>{row.afterRate ?? "Brak"}</td><td>{row.afterDecision?.reason ?? row.afterDecision?.status ?? "Brak danych"}</td></tr>)}</tbody></table></div>}
      {preview.limitations?.length > 0 && <ul className="preview-limitations">{preview.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul>}
      {!counts && !samples.length && <p className="empty-copy">Wynik nie zawiera jeszcze liczników ani próbek wierszy.</p>}
    </>}
    {publicationBlocker && <p className="empty-copy">{publicationBlocker}</p>}
  </section>;
}

export function SharedHistory({ workspace, busy, blocked, onRollback }) {
  return <section className="history-view"><div className="section-title"><h2>Historia współdzielona</h2><span>{workspace.history.length} wpisów</span></div>{workspace.history.length ? <ol className="history-list">{[...workspace.history].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).map(item => <li key={`${item.revision}:${item.at}:${item.action}`}><span className="history-icon"><History size={16} /></span><div><strong>{item.reason || "Bez podanego powodu"}</strong><span>{timestamp(item.at)} · {item.actor} · {actionLabels[item.action] ?? item.action}</span><span>Rewizja {short(item.revision)} · źródło {short(item.sourceRevision)}</span></div><button className="icon-button" disabled={busy || blocked || !workspace.capabilities.sharedDraft} title="Przygotuj szkic z tej wersji" aria-label={`Przygotuj szkic z wersji ${item.revision}`} onClick={() => onRollback(item.revision)}><RotateCcw size={18} /></button></li>)}</ol> : <p className="empty-copy">Brak zapisów współdzielonych.</p>}</section>;
}

export function OperationalStatus({ workspace, snapshot }) {
  const status = workspace?.status ?? {};
  const baseline = status.baseline ?? snapshot.baseline;
  const mode = snapshot.capabilities?.mode ?? "local";
  return <section className="operational-status" aria-labelledby="operations-heading">
    <div className="section-title"><h2 id="operations-heading">Dane i wykonanie</h2><span className="badge">{modeLabel(mode)}</span></div>
    {status.error && <div className="alert error" role="alert">{typeof status.error === "string" ? status.error : status.error.message}</div>}
    <h3 className="manifest-heading">Raport cenowy</h3>
    <ManifestFacts record={status.report} label="Raport" />
    <h3 className="manifest-heading">Pliki Excel</h3>
    <ManifestFacts record={status.excel} label="Excel" />
    <h3 className="manifest-heading">Baza i import</h3>
    <dl className="source-list">
      <div><dt>Plik bazowy</dt><dd>{baseline?.filename ?? "Brak danych"}<small>Zatwierdzenie: {timestamp(baseline?.approvedAt)}</small></dd></div>
      <div><dt>Import do DiscoverCars</dt><dd><span className={`badge ${baseline?.importConfirmed === true ? "positive" : "amber"}`}>{baseline?.importConfirmed === true ? "Import potwierdzony" : "Import niepotwierdzony"}</span></dd></div>
      <div><dt>Wersja źródła panelu</dt><dd className="hash">{snapshot.source.revision}</dd></div>
    </dl>
    {!status.available && <p className="empty-copy">Stan wykonania niedostępny. Widoczna jest migawka konfiguracji, nie potwierdzenie działania produkcji.</p>}
    <div className="operational-links">{Object.entries({ report: "Raport", import: "Plik importowy", recommendations: "Rekomendacje", run: "Przebieg" }).filter(([key]) => safeUrl(status.links?.[key])).map(([key, title]) => <a key={key} href={safeUrl(status.links[key])} target="_blank" rel="noreferrer"><ExternalLink size={16} />{title}</a>)}</div>
  </section>;
}

function ManifestFacts({ record, label }) {
  const ranges = dateRanges(record?.startDates);
  const age = Date.now() - Date.parse(record?.sourceStartedAt);
  return <dl className="source-list">
    <div><dt>{label} wygenerowany</dt><dd>{timestamp(record?.generatedAt)}{label === "Excel" && <small>Wygenerowanie nie potwierdza importu.</small>}</dd></div>
    <div><dt>Początek zbierania danych</dt><dd>{timestamp(record?.sourceStartedAt)}{Number.isFinite(age) && age > 86400000 && <small className="freshness-warning">Dane sprzed ponad 24 godzin</small>}</dd></div>
    <div><dt>Wersja reguł: {label}</dt><dd className="hash">{record?.revision ?? "Brak danych"}</dd></div>
    <div><dt>Przebieg: {label}</dt><dd>{record?.runId ?? "Brak danych"}</dd></div>
    <div><dt>Daty startu</dt><dd>{ranges.length > 1 ? <details className="scope-details"><summary>{ranges.length} rozłączne okresy</summary><ul>{ranges.map(range => <li key={range}>{range}</li>)}</ul></details> : ranges[0] ?? "Brak danych"}</dd></div>
    <div><dt>Długości najmu</dt><dd>{durationScope(record?.durations)}</dd></div>
  </dl>;
}
