import React,{useEffect,useRef,useState} from 'react';
import {FileCheck2} from 'lucide-react';
import {timestamp} from './display.mjs';
export function ReportBaseline({workspace,service,enabled,onPublished}){
 const excel=workspace?.status?.excel,sha=excel?.files?.['rates-import-ready.xlsx'];
 const key=excel?.runId&&sha?`${excel.runId}:${sha}`:'';const current=useRef(key);current.current=key;
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState(''),[saved,setSaved]=useState(null);
 useEffect(()=>{current.current=key;setConfirmed(false);setError('');setSaved(null);return()=>{if(current.current===key)current.current='';};},[key]);
 async function publish(){if(!confirmed||!key||busy||!enabled)return;const selected={runId:excel.runId,fileSha256:sha},version=key;setBusy(true);setError('');try{
  const checked=await service.checkReportBaseline(selected);if(current.current!==version)return;
  const receipt=await service.publishReportBaseline({...selected,sourceRevision:checked.sourceRevision,previousSha256:checked.previousSha256,checkedSha256:checked.summary.sha256,importConfirmed:true});
  if(current.current!==version)return;setSaved(receipt);setConfirmed(false);await onPublished();
 }catch(e){if(current.current===version)setError(e.message);}finally{setBusy(false);}}
 return <section className="baseline-option report-baseline"><h3>Plik z ostatniego przebiegu <span className="badge">Zalecane</span></h3>{excel&&sha?<><p><strong>rates-import-ready.xlsx</strong></p><p>Przebieg {excel.runId} · {timestamp(excel.sourceStartedAt??excel.generatedAt)}</p><p>Plik wygenerowany: {timestamp(excel.generatedAt)}</p>{workspace.status.links?.import&&<a href={workspace.status.links.import}>Pobierz ten plik</a>}<label className="baseline-confirm"><input type="checkbox" checked={confirmed} disabled={busy||!enabled} onChange={e=>setConfirmed(e.target.checked)}/>Wgrałem ten plik do DiscoverCars</label><button className="button" disabled={!confirmed||!enabled||busy} onClick={publish}><FileCheck2 size={18}/>{busy?'Sprawdzanie i zapis bazy…':'Sprawdź i ustaw jako bazę'}</button></>:<p>Brak potwierdzonego pliku z ostatniego przebiegu.</p>}{error&&<p className="alert error" role="alert">{error}</p>}{saved&&<p className="alert baseline-success" role="status">Plik importowy ustawiony jako nowa baza.{saved.url&&<> <a href={saved.url} target="_blank" rel="noreferrer">Zobacz zapis</a></>}</p>}</section>;
}
