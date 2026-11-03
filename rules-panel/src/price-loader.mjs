import { workbookRows, selectRates, selectReviews, readMarket, readMarketRows, combineEvidence } from './price-evidence.mjs';

export async function loadMarketEvidence(query,fetcher=(...args)=>fetch(...args)) {
  const params=new URLSearchParams({mode:'market',reportRunId:query.reportRunId});
  async function request(kind) {
    const response=await fetcher(kind?`/api/report/price-source?${params}&kind=market`:`/api/report/prices?${params}`,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(60000)});
    if(!response.ok){const body=await response.json().catch(()=>({}));throw Object.assign(new Error(body.error||'Nie można odczytać raportu rynku.'),{status:response.status});}
    return kind?new Uint8Array(await response.arrayBuffer()):response.json();
  }
  const context=await request();const rows=readMarketRows(await request('market'));
  if((await request()).signature!==context.signature) throw Object.assign(new Error('Raport zmienił się podczas odczytu. Odśwież panel.'),{status:409});
  return {...context,rows};
}

export async function loadPriceEvidence(query, fetcher=(...args)=>fetch(...args)) {
  const params=new URLSearchParams(query);
  async function request(kind) {
    const url=kind?`/api/report/price-source?${params}&kind=${kind}`:`/api/report/prices?${params}`;
    const response=await fetcher(url,{credentials:'same-origin',cache:'no-store',signal:AbortSignal.timeout(60000)});
    if(!response.ok) {
      const data=await response.json().catch(()=>null);
      throw Object.assign(new Error(data?.error||`Odczyt źródła nie powiódł się (HTTP ${response.status}).`),{status:response.status});
    }
    return kind?new Uint8Array(await response.arrayBuffer()):response.json();
  }
  const context=await request();const {report,excel,location}=context;const warnings=[];
  const bytes=await request('workbook');
  const final=selectRates(workbookRows(bytes,'Sheet1'),query);
  const reviews=selectReviews(workbookRows(bytes,'Recommendations Review'),query);
  let base=[];let market=[];let changes=[];
  try {base=selectRates(workbookRows(await request('baseline'),'Sheet1'),query);}
  catch(error){if(error.status===409)throw error;warnings.push('Nie potwierdzono historycznej bazy tego Excela. Nie zastąpiono jej obecną bazą.');}
  try {market=readMarket(await request('market'),{...query,location});}
  catch(error){if(error.status===409)throw error;warnings.push('Nie można odczytać cen rynkowych. Stawki i uzasadnienia z Excela są nadal dostępne.');}
  if(context.summarySha256) {
    try {
      const summary=JSON.parse(new TextDecoder().decode(await request('summary')));
      if(summary.input_workbook_sha256!==excel.baselineSha256)throw new Error('different baseline');
      changes=Array.isArray(summary.changes)?summary.changes:[];
    } catch(error){if(error.status===409)throw error;warnings.push('Szczegóły liczbowe decyzji są niedostępne. Dostępne uzasadnienia pochodzą z arkusza rekomendacji.');}
  }
  if((await request()).signature!==context.signature)throw Object.assign(new Error('Wyniki zmieniły się podczas odczytu. Odśwież panel.'),{status:409});
  const dates=[...new Set([...report.startDates,...excel.startDates,...market.map(row=>row.date)])].sort();
  return {query,report,excel,warnings,location,
    rows:combineEvidence({dates,base,final,reviews,changes,market,sameRun:report.runId===excel.runId,query}),
    baselineVerified:base.length>0,reviewCount:reviews.length};
}
