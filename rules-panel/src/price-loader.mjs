import { workbookRows, selectRates, selectReviews, readMarket, readMarketRows, combineEvidence } from './price-evidence.mjs';
import {MATRIX_BANDS} from './band-matrix.mjs';

function requestOptions(signal) {
  signal?.throwIfAborted();
  const timeout=AbortSignal.timeout(60000);
  return {credentials:'same-origin',cache:'no-store',signal:signal?AbortSignal.any([signal,timeout]):timeout};
}

async function sourceBytes(kind,context,request,{signal,cache}) {
  signal?.throwIfAborted();
  const source=kind==='market'?context.report:context.excel;
  const hash=kind==='market'?source.reportSha256:kind==='workbook'?source.files?.['rates-updated.xlsx']:kind==='baseline'?source.baselineSha256:context.summarySha256;
  const key=/^[a-f0-9]{64}$/.test(hash??'')?JSON.stringify([kind,source.runId,source.revision,hash]):null;
  const cached=key&&cache?.get(key);if(cached)return cached;
  const bytes=await request(kind);signal?.throwIfAborted();
  if(key){
    const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
    signal?.throwIfAborted();
    if(digest!==hash)throw Object.assign(new Error('Źródło cen zmieniło się podczas odczytu. Odśwież panel.'),{status:409});
    cache?.set(key,bytes);
  }
  return bytes;
}

export async function loadMarketEvidence(query,fetcher=(...args)=>fetch(...args),options={}) {
  const params=new URLSearchParams({mode:'market',reportRunId:query.reportRunId});
  async function request(kind) {
    const response=await fetcher(kind?`/api/report/price-source?${params}&kind=market`:`/api/report/prices?${params}`,requestOptions(options.signal));
    if(!response.ok){const body=await response.json().catch(()=>({}));throw Object.assign(new Error(body.error||'Nie można odczytać raportu rynku.'),{status:response.status});}
    return kind?new Uint8Array(await response.arrayBuffer()):response.json();
  }
  const context=await request();const rows=readMarketRows(await sourceBytes('market',context,request,options));
  if((await request()).signature!==context.signature) throw Object.assign(new Error('Raport zmienił się podczas odczytu. Odśwież panel.'),{status:409});
  return {...context,rows};
}

export async function loadPriceEvidence(query, fetcher=(...args)=>fetch(...args),options={}) {
  const params=new URLSearchParams(query);
  async function request(kind) {
    const url=kind?`/api/report/price-source?${params}&kind=${kind}`:`/api/report/prices?${params}`;
    const response=await fetcher(url,requestOptions(options.signal));
    if(!response.ok) {
      const data=await response.json().catch(()=>null);
      throw Object.assign(new Error(data?.error||`Odczyt źródła nie powiódł się (HTTP ${response.status}).`),{status:response.status});
    }
    return kind?new Uint8Array(await response.arrayBuffer()):response.json();
  }
  const context=await request();const {report,excel,location}=context;const warnings=[];
  const source=kind=>sourceBytes(kind,context,request,options);
  const bytes=await source('workbook');
  const finalRows=workbookRows(bytes,'Sheet1');
  const reviewRows=workbookRows(bytes,'Recommendations Review');
  let baseRows=[];let market=[];let changes=[];
  try {baseRows=workbookRows(await source('baseline'),'Sheet1');}
  catch(error){options.signal?.throwIfAborted();if(error.status===409)throw error;warnings.push('Nie potwierdzono historycznej bazy tego Excela. Nie zastąpiono jej obecną bazą.');}
  try {if(query.mode!=='matrix')market=readMarket(await source('market'),{...query,location});}
  catch(error){options.signal?.throwIfAborted();if(error.status===409)throw error;warnings.push('Nie można odczytać cen rynkowych. Stawki i uzasadnienia z Excela są nadal dostępne.');}
  if(context.summarySha256) {
    try {
      const summary=JSON.parse(new TextDecoder().decode(await source('summary')));
      if(summary.input_workbook_sha256!==excel.baselineSha256)throw new Error('different baseline');
      changes=Array.isArray(summary.changes)?summary.changes:[];
    } catch(error){options.signal?.throwIfAborted();if(error.status===409)throw error;warnings.push('Szczegóły liczbowe decyzji są niedostępne. Dostępne uzasadnienia pochodzą z arkusza rekomendacji.');}
  }
  if((await request()).signature!==context.signature)throw Object.assign(new Error('Wyniki zmieniły się podczas odczytu. Odśwież panel.'),{status:409});
  const dates=[...new Set([...report.startDates,...excel.startDates,...market.map(row=>row.date)])].sort();
  if(query.mode==='matrix')return {query,report,excel,warnings,location,bands:MATRIX_BANDS.map(([duration])=>{
    const selection={...query,duration};
    return {duration,rows:combineEvidence({dates,base:selectRates(baseRows,selection),final:selectRates(finalRows,selection),reviews:selectReviews(reviewRows,selection),changes,market:[],sameRun:report.runId===excel.runId,query:selection})};
  })};
  const base=selectRates(baseRows,query),final=selectRates(finalRows,query),reviews=selectReviews(reviewRows,query);
  return {query,report,excel,warnings,location,
    rows:combineEvidence({dates,base,final,reviews,changes,market,sameRun:report.runId===excel.runId,query}),
    baselineVerified:base.length>0,reviewCount:reviews.length};
}
