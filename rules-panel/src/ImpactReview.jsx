import React,{useState} from 'react';
import {dayLabel,countLabel} from './operations.mjs';
import {locationOptions} from './editor.mjs';
import {plNumber,displayBand,impactSampleStats,excelTimestamp} from './impact-presentation.mjs';
export function ImpactReview({workspace,service,onRefresh}) {
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const preview=workspace?.preview;
 const current=Boolean(workspace?.draft?.revision&&preview?.draftRevision===workspace.draft.revision);
 const impact=current&&preview.status==='success'?preview.impact:null;
 const hosted=workspace?.snapshot?.capabilities?.mode==='github';
 const pending=current&&['running','queued','requesting'].includes(preview.status);
 const model=workspace?.draft?.model??workspace?.snapshot?.documents;
 const stats=impact?impactSampleStats(impact,model):null;
 const labels=model?locationOptions(model):[];
 const timestamp=preview?.dataCollectedAt?excelTimestamp(preview.dataCollectedAt):null;
 async function calculate(){setBusy(true);setError('');try{await service.preview(workspace.draft.revision);await onRefresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="impact-review" aria-label="Wpływ na stawki"><h2>Wpływ na stawki</h2>
 {impact?<><p>Na ostatnim Excelu: {plNumber(impact.increasedRateCells)} stawek w górę, {plNumber(impact.decreasedRateCells)} w dół, {plNumber(impact.unchangedRateCells)} bez zmian</p>{timestamp&&<p>Excel z {timestamp}</p>}{stats.count>0&&<p>Próbka: {countLabel(stats.branches,'oddział','oddziały','oddziałów')} · średnia zmiana {plNumber(stats.mean)} PLN/dobę ({countLabel(stats.count,'stawka','stawki','stawek')}). Nie jest to statystyka całego Excela.</p>}<ul>{(impact.samples??[]).slice(0,5).map((sample,i)=><li key={i}>{sample.position?.zone} · {labels.find(l=>l.value===sample.position?.zone)?.label??'Nazwa oddziału niedostępna'} · {sample.position?.group} · {dayLabel(sample.position?.pickupDate)} · {displayBand(sample.position?.durationBand)} dni: {plNumber(sample.beforeRate)} → {plNumber(sample.afterRate)} PLN</li>)}</ul></>:!hosted?<p>Podgląd wpływu dostępny w opublikowanym panelu</p>:<><button className="button" disabled={busy||pending||!workspace?.draft||!workspace?.capabilities?.preview} onClick={calculate}>Policz wpływ</button>{pending&&<p>Przeliczanie w toku. <button className="text-button" onClick={onRefresh}>Odśwież wynik</button></p>}{current&&preview?.status==='failure'&&<p role="alert">{preview.error||'Nie udało się przeliczyć wpływu.'}</p>}</>}
 {error&&<p role="alert">{error}</p>}
 </section>;
}
