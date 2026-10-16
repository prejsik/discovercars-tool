import React, { useRef, useState } from 'react';
import { Upload, FileCheck2, CheckCheck } from 'lucide-react';
import { timestamp } from './display.mjs';

export function BaselineView({ snapshot, service, enabled, onPublished }) {
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);
  const [confirmed, setConfirmed] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [published, setPublished] = useState(null);
  const selection = useRef(0);
  const choose = async event => {
    const version = ++selection.current;
    setCheck(null); setFile(null); setError(''); setPublished(null); setConfirmed(true);
    const selected = event.target.files?.[0];
    if (!selected) return;
    if (!/\.xlsx$/i.test(selected.name) || selected.size > 8 * 1024 * 1024 || !selected.size) { setError('Wybierz plik .xlsx o rozmiarze do 8 MB.'); return; }
    try {
      const content = await new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error('Nie można odczytać pliku. Wybierz go ponownie.'));
        reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.readAsDataURL(selected);
      });
      if (selection.current === version) setFile({ filename: selected.name, content });
    } catch (error) { if (selection.current === version) setError(error.message); }
  };
  const validate = async () => {
    if (!file || busy) return;
    setBusy('check'); setError(''); setCheck(null);
    try { setCheck(await service.checkBaseline(file)); }
    catch (error) { setError(error.message); }
    finally { setBusy(''); }
  };
  const publish = async () => {
    if (!file || !check || busy) return;
    if (!window.confirm(`Ustawić ${file.filename} jako nową bazę dla obu harmonogramów i kolejnych plików Excel na Telegramie?`)) return;
    setBusy('publish'); setError('');
    try {
      const result = await service.publishBaseline({ ...file, sourceRevision: check.sourceRevision, previousSha256: check.previousSha256, checkedSha256: check.summary.sha256, importConfirmed: confirmed });
      setPublished(result); setCheck(null); setFile(null);
      await onPublished();
    } catch (error) { setError(error.message); }
    finally { setBusy(''); }
  };
  return <section className="baseline-view" aria-labelledby="baseline-heading">
    <h2 id="baseline-heading">Aktualna baza cennika</h2>
    <dl className="source-list">
      <div><dt>Plik</dt><dd>{snapshot.baseline.filename}</dd></div>
      <div><dt>Zatwierdzony</dt><dd>{timestamp(snapshot.baseline.approvedAt)}</dd></div>
      <div><dt>Import do DiscoverCars</dt><dd>{snapshot.baseline.importConfirmed ? 'Potwierdzony' : 'Niepotwierdzony'}</dd></div>
    </dl>
    <h2>Podmień bazę</h2>
    {!enabled && <p className="alert">Podmiana bazy wymaga aktywnego połączenia z GitHubem.</p>}
    <label className="baseline-file">Plik Excel (.xlsx)<input aria-label="Nowy plik bazowy" type="file" accept=".xlsx" disabled={!enabled || Boolean(busy)} onChange={choose} /></label>
    <div className="review-actions"><button className="button" disabled={!file || Boolean(busy) || !enabled} onClick={validate}><FileCheck2 size={18} />{busy === 'check' ? 'Sprawdzanie pliku…' : 'Sprawdź plik'}</button></div>
    {error && <div className="alert error" role="alert">{error}</div>}
    {check && <>
      <div className="alert" role="status"><CheckCheck size={18} />Plik przeszedł kontrolę układu, dat, stawek, klas i lokalizacji.</div>
      <dl className="source-list">
        <div><dt>Wybrany plik</dt><dd>{file.filename}</dd></div>
        <div><dt>Wiersze cennika</dt><dd>{check.summary.rowCount.toLocaleString('pl-PL')}</dd></div>
        <div><dt>Daty startu</dt><dd>{check.summary.firstDate} – {check.summary.lastDate}</dd></div>
        <div><dt>Klasy / lokalizacje</dt><dd>{check.summary.groups.length} / {check.summary.zones.length}</dd></div>
      </dl>
      <label className="baseline-confirm"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={event => setConfirmed(event.target.checked)} />Ten plik jest już wgrany do DiscoverCars</label>
      <button className="button primary" disabled={Boolean(busy) || !enabled} onClick={publish}><Upload size={18} />{busy === 'publish' ? 'Zapisywanie bazy…' : 'Ustaw jako bazę'}</button>
    </>}
    {published && <div className="alert" role="status">Nowa baza zapisana na GitHubie. Kolejne uruchomienia użyją jej do obu plików Excel.{published.url && <> <a href={published.url} target="_blank" rel="noreferrer">Zobacz zapis</a></>}</div>}
  </section>;
}
