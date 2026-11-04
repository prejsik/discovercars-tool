import React,{useState} from 'react';
import {dayLabel} from './operations.mjs';
export function ImpactReview({workspace,service,onRefresh}) {
 const [busy,setBusy]=useState(false);const [error,setError]=useState('');
 const preview=workspace?.preview;
 const current=Boolean(workspace?.draft?.revision&&preview?.draftRevision===workspace.draft.revision);
 const impact=current&&preview.status==='success'?preview.impact:null;
 const hosted=workspace?.snapshot?.capabilities?.mode==='github';
 const pending=current&&['running','queued','requesting'].includes(preview.status);
 async function calculate(){setBusy(true);setError('');try{await service.preview(workspace.draft.revision);await onRefresh();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <section className="impact-review" aria-label="Wpływ na stawki"><h2>Wpływ na stawki</h2>
 {impact?<><p>Na ostatnim Excelu: {impact.increasedRateCells} stawek w górę, {impact.decreasedRateCells} w dół, {impact.unchangedRateCells} bez zmian</p><ul>{(impact.samples??[]).slice(0,5).map((sample,i)=><li key={i}>{sample.position?.zone} · {sample.position?.group} · {dayLabel(sample.position?.pickupDate)} · {sample.position?.durationBand} dni: {sample.beforeRate} → {sample.afterRate} PLN</li>)}</ul></>:!hosted?<p>Podgląd wpływu dostępny w opublikowanym panelu</p>:<><button className="button" disabled={busy||pending||!workspace?.draft||!workspace?.capabilities?.preview} onClick={calculate}>Policz wpływ</button>{pending&&<p>Przeliczanie w toku. <button className="text-button" onClick={onRefresh}>Odśwież wynik</button></p>}{current&&preview?.status==='failure'&&<p role="alert">{preview.error||'Nie udało się przeliczyć wpływu.'}</p>}</>}
 {error&&<p role="alert">{error}</p>}
 </section>;
}
