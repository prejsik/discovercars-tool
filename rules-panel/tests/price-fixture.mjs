import { zipSync, strToU8 } from 'fflate';
import { loadPriceEvidence } from '../server/reports.mjs';

export async function priceFixture({changeDuringRead=false,wrongBaseline=false,wrongWorkbook=false}={}) {
  const sheet=(rate)=>`<worksheet><sheetData><row r="5"><c r="A5" t="inlineStr"><is><t>CDMV</t></is></c><c r="D5" t="inlineStr"><is><t>KRLO</t></is></c><c r="G5" t="inlineStr"><is><t>2026-11-04</t></is></c><c r="H5" t="inlineStr"><is><t>2027-12-31</t></is></c><c r="K5"><v>${rate}</v></c></row></sheetData></worksheet>`;
  const workbook=rate=>zipSync(Object.fromEntries(Object.entries({
    'xl/workbook.xml':'<workbook xmlns:r="urn:r"><sheets><sheet name="Sheet1" r:id="r1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':sheet(rate),
  }).map(([key,value])=>[key,strToU8(value)])));
  const digest=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
  const base=workbook(65);const final=workbook(63);
  const values=['Flex','','74,00 PLN/d','','','MM Cars Rental','','80,00 PLN/d','','','Brak oferty','80,00 PLN/d','','Top 2'];
  const html=strToU8(`<script type="application/json" id="report-data">${JSON.stringify({scenarios:[{date:'2026-11-04',duration:'3',rows:[['Krakow Airport (KRK)','airport',values,values]]}]})}</script>`);
  const manifest={run_id:'123',git_sha:'a'.repeat(40),generated_at:'2026-11-03T12:00:00Z',source_started_at:'2026-11-03T09:00:00Z',start_dates:['2026-11-04'],durations:[3],status:'success',baseline:{workbook_sha256:await digest(base)},excel_files:{'rates-updated.xlsx':await digest(final)},report_html_sha256:await digest(html)};
  const summary=strToU8(JSON.stringify({input_workbook_sha256:manifest.baseline.workbook_sha256,changes:[{zone:'KRLO',group:'CDMV',pickup_date:'2026-11-04',duration_min_days:3,duration_max_days:4,old_rate:65,new_rate:63,predicted_site_rate:73,minimum_rate_pln_day:30,reason:'Zapisana decyzja',controlling_duration_days:3,covered_duration_days:[3,4],required_missing_duration_days:[]}]}));
  manifest.excel_summary_sha256=await digest(summary);
  let reads=0;
  const fetcher=async (url,options)=>{
    const request=new Request(url,options);const path=new URL(request.url).pathname;
    if(path.endsWith('run-manifest.json')){reads++;return Response.json(changeDuringRead&&reads>2?{...manifest,run_id:'124'}:manifest);}
    if(path.endsWith('rates-updated.xlsx'))return new Response(wrongWorkbook?base:final);
    if(path.endsWith('report.html'))return new Response(html);
    if(path.endsWith('excel-rate-update-summary.json'))return new Response(summary);
    throw new Error(`Unexpected request ${path}`);
  };
  const repository={json:async()=>({locations:[{zones:['KRLO'],scraper_label:'Krakow Airport (KRK)'}]}),baselineBytes:async()=>wrongBaseline?final:base};
  return loadPriceEvidence({zone:'KRLO',group:'CDMV',duration:3,transmission:'automatic',reportRunId:'123',excelRunId:'123'},repository,fetcher);
}
