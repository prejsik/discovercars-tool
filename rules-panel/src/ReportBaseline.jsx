import React,{useEffect,useRef,useState} from 'react';
import {FileCheck2,Upload} from 'lucide-react';
import {reportRunLabel} from './baseline-presentation.mjs';
import {BaselineComparison} from './BaselineComparison.jsx';
export function ReportBaseline({workspace,service,enabled,onPublished}){
 const excel=workspace?.status?.excel,sha=excel?.files?.['rates-import-ready.xlsx'];
 const alreadyCurrent=Boolean(sha&&sha===workspace?.snapshot?.baseline?.sha256);
 const key=excel?.runId&&sha?JSON.stringify([excel.runId,sha,workspace?.snapshot?.baseline?.sha256,workspace?.snapshot?.source?.revision]):'';
 const current=useRef(key);current.current=key;
 const [confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(''),[error,setError]=useState(''),[saved,setSaved]=useState(null),[check,setCheck]=useState(null);
 useEffect(()=>{current.current=key;setConfirmed(false);setError('');setSaved(null);setCheck(null);return()=>{if(current.current===key)current.current='';};},[key]);
 const checked=check?.key===key?check.result:null;
 async function validate(){if(!key||busy||!enabled||alreadyCurrent)return;const version=key;setBusy('check');setError('');setCheck(null);try{
  const result=await service.checkReportBaseline({runId:excel.runId,fileSha256:sha});if(current.current===version)setCheck({key:version,result});
 }catch(e){if(current.current===version)setError(e.message);}finally{setBusy('');}}
 async function publish(){if(!confirmed||!checked||busy||!enabled||alreadyCurrent)return;const version=key;setBusy('publish');setError('');try{
  const receipt=await service.publishReportBaseline({runId:excel.runId,fileSha256:sha,sourceRevision:checked.sourceRevision,previousSha256:checked.previousSha256,checkedSha256:checked.summary.sha256,importConfirmed:true});
  if(current.current!==version)return;setSaved(receipt);setConfirmed(false);setCheck(null);await onPublished();
 }catch(e){if(current.current===version){setError(e.message);setCheck(null);}}finally{setBusy('');}}
 return <section className="baseline-option report-baseline"><h3>Plik z ostatniego przebiegu <span className="badge">Zalecane</span></h3>{excel&&sha?<><p><strong>rates-import-ready.xlsx</strong></p><p title="Pora dnia według faktycznej godziny startu, nie identyfikator harmonogramu">{reportRunLabel(excel)}</p>{alreadyCurrent?<p className="positive">Ten plik jest już aktualną bazą</p>:<>{workspace.status.links?.import&&<a href={workspace.status.links.import}>Pobierz ten plik</a>}{!checked?<div className="review-actions"><button className="button" aria-label="Sprawdź plik z ostatniego przebiegu" disabled={!enabled||Boolean(busy)} onClick={validate}><FileCheck2 size={18}/>{busy==='check'?'Sprawdzanie pliku…':'Sprawdź plik'}</button></div>:<><BaselineComparison before={workspace.snapshot?.baseline?.coverage} after={checked.summary} model={workspace.snapshot.documents}/><label className="baseline-confirm"><input type="checkbox" checked={confirmed} disabled={Boolean(busy)||!enabled} onChange={e=>setConfirmed(e.target.checked)}/>Wgrałem ten plik do DiscoverCars</label><div className="baseline-publish-actions"><button className="button primary" disabled={!confirmed||!enabled||Boolean(busy)} onClick={publish}><Upload size={18}/>{busy==='publish'?'Zapisywanie bazy…':'Ustaw jako bazę'}</button><button className="button" disabled={Boolean(busy)} onClick={()=>{setCheck(null);setConfirmed(false);setError('');}}>Anuluj</button></div></>}</>}</>:<p>Brak potwierdzonego pliku z ostatniego przebiegu.</p>}{error&&<p className="alert error" role="alert">{error}</p>}{saved&&<p className="alert baseline-success" role="status">Plik importowy ustawiony jako nowa baza.{saved.url&&<> <a href={saved.url} target="_blank" rel="noreferrer">Zobacz zapis</a></>}</p>}</section>;
}
