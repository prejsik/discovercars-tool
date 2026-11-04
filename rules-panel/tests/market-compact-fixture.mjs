import {zipSync,strToU8} from 'fflate';
import {loadPriceContext,loadPriceSource} from '../server/reports.mjs';

// Synthetic market and workbook, identical for both visual comparison captures.
export async function compactFixture(snapshot) {
 const locations=(snapshot.documents.locations.locations??snapshot.documents.locations).slice(0,25);
 const dates=Array.from({length:14},(_,i)=>`2026-11-${String(i+4).padStart(2,'0')}`);
 const durations=Array.from({length:13},(_,i)=>i+2);
 const price=value=>value===null?'Brak oferty':value.toFixed(2).replace('.',',')+' PLN/d';
 const values=(mm,other)=>['Flex To Go (8)','',price(other),'','','MM Cars Rental (8)','',price(mm),'Kaizen','',price(140),price(mm),'',mm===null?'Brak oferty':mm<other?'Top 1':'Top 2','5','',false];
 const scenarios=dates.flatMap((date,i)=>durations.map(duration=>({date,duration:String(duration),rows:locations.map((l,j)=>{
  const mm=j===0&&i===1?null:j===0&&i===0&&duration===4?null:74+(j%4===0?0.4:j%4===1?-0.3:j%4===2?16:-20)+(duration>=8?30:0);
  return [l.scraper_label,'airport',values(mm,74),values(mm===null?null:mm-2,74)];
 }),errors:[]})));
 const bytes=strToU8(`<script type="application/json" id="report-data">${JSON.stringify({scenarios})}</script>`);
 const workbook=delta=>zipSync(Object.fromEntries(Object.entries({
  'xl/workbook.xml':'<workbook xmlns:r="urn:r"><sheets><sheet name="Sheet1" r:id="r1"/></sheets></workbook>',
  'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
  'xl/worksheets/sheet1.xml':`<worksheet><sheetData>${locations.flatMap(l=>l.zones.flatMap(zone=>['CDMV','EDMV'].map(group=>({zone,group})))).map(({zone,group},i)=>`<row r="${i+5}"><c r="A${i+5}" t="inlineStr"><is><t>${group}</t></is></c><c r="D${i+5}" t="inlineStr"><is><t>${zone}</t></is></c><c r="G${i+5}" t="inlineStr"><is><t>2026-11-04</t></is></c><c r="H${i+5}" t="inlineStr"><is><t>2027-12-31</t></is></c>${['I','J','K','L','M','N'].map(col=>`<c r="${col}${i+5}"><v>${65+delta+(group==='EDMV'?10:0)+(zone==='KRTI'?1:0)}</v></c>`).join('')}</row>`).join('')}</sheetData></worksheet>`,
 }).map(([name,value])=>[name,strToU8(value)])));
 const base=workbook(0),final=workbook(-2);
 const digest=async value=>Buffer.from(await crypto.subtle.digest('SHA-256',value)).toString('hex');
 const summary=strToU8(JSON.stringify({input_workbook_sha256:await digest(base),changes:[]}));
 const manifest={run_id:'123',git_sha:'a'.repeat(40),generated_at:'2026-11-03T12:00:00Z',source_started_at:'2026-11-03T09:00:00Z',start_dates:dates,durations,status:'success',baseline:{workbook_sha256:await digest(base)},excel_files:{'rates-updated.xlsx':await digest(final)},report_html_sha256:await digest(bytes),excel_summary_sha256:await digest(summary)};
 const repository={json:async()=>({locations}),baselineBytes:async()=>base};
 const fetcher=async url=>{
  if(url.endsWith('run-manifest.json'))return Response.json(manifest);
  if(url.endsWith('rates-updated.xlsx'))return new Response(final);
  if(url.endsWith('report.html'))return new Response(bytes);
  if(url.endsWith('excel-rate-update-summary.json'))return new Response(summary);
  throw new Error('Unexpected fixture source '+url);
 };
 const meta=await loadPriceContext({mode:'matrix',zone:'KRLO',group:'CDMV',duration:3,transmission:'automatic',reportRunId:'123',excelRunId:'123'},repository,fetcher);
 return {locations,meta,transport:async url=>{
  const query=Object.fromEntries(new URL(url).searchParams);query.duration=Number(query.duration);
  try {return query.kind?new Response(await loadPriceSource(query,repository,fetcher)):Response.json(await loadPriceContext(query,repository,fetcher));}
  catch(error){return Response.json({error:error.message},{status:error.status??500});}
 }};
}
