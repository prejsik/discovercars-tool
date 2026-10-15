import test from 'node:test';
import assert from 'node:assert/strict';
import { readOperationalStatus, loadPublishedWorkbook, loadPublishedReport, workbookInput } from '../server/reports.mjs';
import { GitHubRepository } from '../worker/github.mjs';
const bytes = new TextEncoder().encode('original generated XLSX bytes');
const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(value=>value.toString(16).padStart(2,'0')).join('');
const manifest = {generated_at:'2026-10-15T08:00:00Z',source_started_at:'2026-10-15T01:00:00Z',git_sha:'a'.repeat(40),run_id:'123',status:'success',start_dates:['2026-10-15','2026-10-16'],durations:[2,3],baseline:{workbook_sha256:'base-a'},excel_files:{'rates-import-ready.xlsx':digest,'rates-updated.xlsx':digest},quality:{expected_location_check_count:650,missing_top3_count:13}};
const summary = {input_workbook_sha256:'base-a',change_statistics:{increase_count:2,decrease_count:3,average_increase_pln_day:10,average_decrease_pln_day:-7.4}};
manifest.excel_change_statistics=summary.change_statistics;
function source({report=manifest,excel=manifest,stats=summary,book=bytes,changedAfter=false}={}) {
  let excelReads=0;
  return async url=>{
    const path=new URL(url).pathname;
    if(path.endsWith('/latest-full/run-manifest.json'))return report ? Response.json(report) : new Response('',{status:404});
    if(path.endsWith('/latest-excel/run-manifest.json')){
      excelReads++;
      return excel ? Response.json(changedAfter && excelReads>1 ? {...excel,run_id:'124'} : excel) : new Response('',{status:404});
    }
    if(path.endsWith('/excel-rate-update-summary.json'))return Response.json(stats);
    if(path.endsWith('.xlsx'))return new Response(book);
    if(path.endsWith('.html'))return new Response(book);
    throw new Error(`Unexpected URL ${path}`);
  };
}
test('same published data supplies Telegram-equivalent statistics and pinned links without selecting baseline',async()=>{
  const result=await readOperationalStatus({sha256:'current-base',filename:'base.xlsx'},source());
  assert.equal(result.available,true);
  assert.deepEqual(result.excel.statistics,{increases:2,decreases:3,averageIncrease:10,averageDecrease:7.4});
  assert.deepEqual(result.report.coverage,{found:637,expected:650});
  assert.equal(result.baseline.sha256,'current-base');
  assert.ok(result.links.import.includes(`runId=123&sha256=${digest}`));
});
test('failed report does not hide the older valid Excel and mismatched scopes stay distinct',async()=>{
  const result=await readOperationalStatus({},source({report:{...manifest,run_id:'124',status:'failure',start_dates:['2026-10-17']}}));
  assert.equal(result.report.quality,'failure'); assert.equal(result.excel.runId,'123');
  assert.ok(result.links.import); assert.equal(result.report.runId,'124');
});
test('partial manifest failure preserves remaining usable results',async()=>{
  const result=await readOperationalStatus({},source({report:null}));
  assert.equal(result.available,true); assert.equal(result.report,null); assert.ok(result.links.import); assert.ok(result.warnings.length);
});
test('failed or unverified Excel never offers a baseline/download link',async()=>{
  for(const excel of [{...manifest,status:'failure'},{...manifest,excel_files:{}}]){
    const result=await readOperationalStatus({},source({excel}));
    assert.equal(result.links.import,null); assert.equal(result.links.recommendations,null);
  }
});
test('legacy statistics require proof of exact run, workbook and baseline',async()=>{
  const legacy={...manifest}; delete legacy.excel_change_statistics;
  const proof={runId:'123',importSha256:digest,baselineSha256:'base-a',statistics:summary.change_statistics};
  for(const patch of [{runId:'999'},{baselineSha256:'other'},{importSha256:'f'.repeat(64)}]){
    const result=await readOperationalStatus({},source({excel:legacy}),undefined,async()=>({...proof,...patch}));
    assert.equal(result.excel.statistics,undefined); assert.ok(result.warnings.length);
  }
  const valid=await readOperationalStatus({},source({excel:legacy}),undefined,async()=>proof);
  assert.equal(valid.excel.statistics.increases,2);
});
test('download verifies run and digest and preserves bytes/base64 including arbitrary lengths',async()=>{
  const file=await loadPublishedWorkbook({kind:'import',runId:'123',sha256:digest},source());
  assert.deepEqual(file.bytes,bytes);
  assert.match(file.filename,/2026-10-15--2026-10-16-run-123\.xlsx$/);
  for(const size of [1,2,3,24576,24577,50000]){
    const data=Uint8Array.from({length:size},(_,index)=>index%256);
    assert.deepEqual(Uint8Array.from(atob(workbookInput({bytes:data,filename:'x.xlsx'}).content),char=>char.charCodeAt(0)),data);
  }
});
for(const [label,input,options] of [
  ['another run',{kind:'import',runId:'999',sha256:digest},{}],
  ['another digest',{kind:'import',runId:'123',sha256:'f'.repeat(64)},{}],
  ['changed workbook',{kind:'import',runId:'123',sha256:digest},{book:new TextEncoder().encode('other file')}],
  ['publication race',{kind:'import',runId:'123',sha256:digest},{changedAfter:true}],
])test(`download refuses ${label}`,async()=>assert.rejects(loadPublishedWorkbook(input,source(options)),error=>error.status===409));
test('invalid kind or arbitrary URLs are rejected before fetching',async()=>{
  for(const kind of ['__proto__','constructor','https://evil.example/'])await assert.rejects(loadPublishedWorkbook({kind,runId:'123',sha256:digest},()=>{throw new Error('Must not fetch');}),error=>error.status===422);
});
test('skipped cron attempts are distinguished from completed scraping',async()=>{
  const repository=new GitHubRepository({}, {api:async path=>path.includes('/jobs?')?{jobs:[{name:'Freeze scope and collection plan',conclusion:'skipped'}]}:{workflow_runs:[{id:123,status:'completed',conclusion:'success',created_at:'2026-10-15T11:00:00Z'},{id:122,status:'queued',created_at:'2026-10-15T10:00:00Z'}]}});
  const runs=await repository.latestRuns();
  assert.equal(runs.latest.skipped,true); assert.equal(runs.active[0].runId,'122');
});
test('HTML report refuses another run and checks its recorded hash',async()=>{
  await assert.rejects(loadPublishedReport('999',{},source()),error=>error.status===409);
  const data=await loadPublishedReport('123',{},source({report:{...manifest,report_html_sha256:digest}}));
  assert.deepEqual(data,bytes);
  await assert.rejects(loadPublishedReport('123',{},source({report:{...manifest,report_html_sha256:'f'.repeat(64)}})),error=>error.status===409);
});
test('legacy HTML comes from the requested run artifact instead of the mutable latest URL',async()=>{
  const result=await loadPublishedReport('123',{reportHtml:async record=>{assert.equal(record.runId,'123');return bytes;}},source());
  assert.deepEqual(result,bytes);
});
