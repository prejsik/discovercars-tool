import React, { useRef, useState } from 'react';
import { Upload, FileCheck2, CheckCheck } from 'lucide-react';
import { timestamp } from './display.mjs';
import { LocationOnboarding, VerifiedLocations } from './LocationOnboarding.jsx';

export function BaselineView({ snapshot, service, enabled, onPublished }) {
  const [file, setFile] = useState(null);
  const [check, setCheck] = useState(null);
  const [onboarding, setOnboarding] = useState(null);
  const [additions, setAdditions] = useState({});
  const [confirmed, setConfirmed] = useState(true);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [published, setPublished] = useState(null);
  const selection = useRef(0);
  const zones = onboarding?.unknownZones ?? [];
  const hasNewZones = zones.length > 0;
  const assignments = zones.map(zone => additions[zone]);
  const configured = hasNewZones && assignments.every(Boolean);
  const checked = check?.version === selection.current ? check.result : null;
  const ready = Boolean(checked && (!hasNewZones || (checked.onboarding?.ready === true && checked.onboardingHash)));
  const configure = (zone, assignment) => {
    selection.current++;
    setCheck(null); setError(''); setPublished(null);
    setBusy(current => current === 'check' ? '' : current);
    setAdditions(current => ({ ...current, [zone]: assignment }));
  };
  const choose = async event => {
    const version = ++selection.current;
    setCheck(null); setFile(null); setError(''); setPublished(null); setConfirmed(true);
    setOnboarding(null); setAdditions({}); setBusy('');
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
    if (!file || busy || !enabled || (hasNewZones && !configured)) return;
    const version = ++selection.current;
    const locationAdditions = hasNewZones ? assignments : undefined;
    setBusy('check'); setError(''); setCheck(null);
    try {
      const result = await service.checkBaseline({ ...file, ...(locationAdditions ? { locationAdditions } : {}) });
      if (version !== selection.current) return;
      if (result.onboarding) setOnboarding(result.onboarding);
      if (result.onboarding?.ready === false) return;
      if ((hasNewZones || result.onboarding?.unknownZones.length) && (!locationAdditions || result.onboarding?.ready !== true || !result.onboardingHash)) {
        setError('Nie potwierdzono konfiguracji lokalizacji. Sprawdź konfigurację ponownie.');
        return;
      }
      setCheck({ result, version, locationAdditions });
    }
    catch (error) { if (version === selection.current) setError(error.message); }
    finally { if (version === selection.current) setBusy(''); }
  };
  const publish = async () => {
    if (!file || !ready || busy || !enabled) return;
    if (!window.confirm(`Ustawić ${file.filename} jako nową bazę dla obu harmonogramów i kolejnych plików Excel na Telegramie?`)) return;
    const version = selection.current;
    setBusy('publish'); setError('');
    try {
      const result = await service.publishBaseline({ ...file, ...(check.locationAdditions ? { locationAdditions: check.locationAdditions, checkedOnboardingHash: checked.onboardingHash } : {}), sourceRevision: checked.sourceRevision, previousSha256: checked.previousSha256, checkedSha256: checked.summary.sha256, importConfirmed: confirmed });
      if (version !== selection.current) return;
      setPublished(result); setCheck(null); setFile(null);
      setOnboarding(null); setAdditions({});
      await onPublished();
    } catch (error) { if (version === selection.current) { setError(error.message); setCheck(null); } }
    finally { if (version === selection.current) setBusy(''); }
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
    <label className="baseline-file">Plik Excel (.xlsx)<input aria-label="Nowy plik bazowy" type="file" accept=".xlsx" disabled={!enabled || busy === 'publish'} onChange={choose} /></label>
    {!hasNewZones && <div className="review-actions"><button className="button" disabled={!file || Boolean(busy) || !enabled} onClick={validate}><FileCheck2 size={18} />{busy === 'check' ? 'Sprawdzanie pliku…' : 'Sprawdź plik'}</button></div>}
    {error && <div className="alert error" role="alert">{error}</div>}
    {hasNewZones && <>
      <LocationOnboarding onboarding={onboarding} service={service} disabled={!enabled || busy === 'publish'} onChange={configure} />
      <div className="review-actions"><button className="button" disabled={!configured || Boolean(busy) || !enabled} onClick={validate}><FileCheck2 size={18} />{busy === 'check' ? 'Sprawdzanie konfiguracji…' : 'Sprawdź konfigurację'}</button></div>
    </>}
    {ready && <>
      <div className="alert" role="status"><CheckCheck size={18} />Plik przeszedł kontrolę układu, dat, stawek, klas i lokalizacji.</div>
      <dl className="source-list">
        <div><dt>Wybrany plik</dt><dd>{file.filename}</dd></div>
        <div><dt>Wiersze cennika</dt><dd>{checked.summary.rowCount.toLocaleString('pl-PL')}</dd></div>
        <div><dt>Daty startu</dt><dd>{checked.summary.firstDate} – {checked.summary.lastDate}</dd></div>
        <div><dt>Klasy / lokalizacje</dt><dd>{checked.summary.groups.length} / {checked.summary.zones.length}</dd></div>
      </dl>
      {hasNewZones && <VerifiedLocations onboarding={checked.onboarding} />}
      <label className="baseline-confirm"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)} onChange={event => setConfirmed(event.target.checked)} />Ten plik jest już wgrany do DiscoverCars</label>
      <button className="button primary" disabled={Boolean(busy) || !enabled} onClick={publish}><Upload size={18} />{busy === 'publish' ? 'Zapisywanie bazy…' : 'Ustaw jako bazę'}</button>
    </>}
    {published && <div className="alert" role="status">Nowa baza zapisana na GitHubie. Kolejne uruchomienia użyją jej do obu plików Excel.{published.url && <> <a href={published.url} target="_blank" rel="noreferrer">Zobacz zapis</a></>}</div>}
  </section>;
}
