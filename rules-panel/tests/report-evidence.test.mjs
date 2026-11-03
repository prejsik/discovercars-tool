import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { zipSync, strToU8 } from 'fflate';
import { GitHubRepository } from '../worker/github.mjs';
import { bindReportEvidence } from '../../src/reportEvidenceManifest.js';
const sha=value=>createHash('sha256').update(value).digest('hex');
const record={runId:'123',revision:'a'.repeat(40),baselineSha256:'b'.repeat(64),files:{'rates-import-ready.xlsx':'c'.repeat(64),'rates-updated.xlsx':'d'.repeat(64)}};
const manifest={run_id:'123',git_sha:record.revision,baseline:{workbook_sha256:record.baselineSha256},excel_files:record.files};
function repository({proof=manifest,stats={increase_count:1,decrease_count:2}}={}) {
  const archive=zipSync({'run-manifest.json':strToU8(JSON.stringify(proof)),'excel-rate-update-summary.json':strToU8(JSON.stringify({input_workbook_sha256:record.baselineSha256,change_statistics:stats})),'report.html':strToU8('<html><body>Run 123</body></html>')});
  return new GitHubRepository({}, {api:async path=>path.endsWith('/zip')?archive:{artifacts:[{id:1,name:path.includes('/123/')?'discovercars-excel-import-10':'wrong',expired:false,size_in_bytes:archive.length}]}});
}
test('legacy statistics bind the authenticated artifact to run, baseline and both generated workbooks',async()=>{
  const proof=await repository().publishedStatistics(record);
  assert.equal(proof.runId,'123');assert.equal(proof.importSha256,record.files['rates-import-ready.xlsx']);
  for(const patch of [{run_id:'999'},{git_sha:'f'.repeat(40)},{baseline:{workbook_sha256:'f'.repeat(64)}},{excel_files:{...record.files,'rates-import-ready.xlsx':'e'.repeat(64)}}])
    await assert.rejects(repository({proof:{...manifest,...patch}}).publishedStatistics(record),error=>error.status===409);
});
test('new manifest carries same-run statistics and report/summary digests without changing files',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'discovercars-manifest-proof-'));
  try {
    const statistics={increase_count:10,decrease_count:20,average_increase_pln_day:5,average_decrease_pln_day:-2};
    const summary=JSON.stringify({input_workbook_sha256:record.baselineSha256,change_statistics:statistics});
    const html='<html>report</html>';
    await writeFile(join(directory,'run-manifest.json'),JSON.stringify(manifest));
    await writeFile(join(directory,'excel-rate-update-summary.json'),summary);
    await writeFile(join(directory,'report.html'),html);
    const result=bindReportEvidence(directory);
    assert.equal(result.run_id,'123');assert.deepEqual(result.excel_change_statistics,statistics);
    assert.equal(result.excel_summary_sha256,sha(summary));assert.equal(result.report_html_sha256,sha(html));
    assert.equal(await readFile(join(directory,'report.html'),'utf8'),html);
    await writeFile(join(directory,'excel-rate-update-summary.json'),JSON.stringify({input_workbook_sha256:'different',change_statistics:statistics}));
    assert.equal(bindReportEvidence(directory).excel_change_statistics,null);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('failed Excel diagnostic is bound to the manifest, with no stale failure after success', async () => {
  const directory=await mkdtemp(join(tmpdir(),'discovercars-error-proof-'));
  try {
    await writeFile(join(directory,'run-manifest.json'),JSON.stringify({...manifest,status:'failure'}));
    const diagnostics={code:'city_airport_cap',total:1,positions:[{group:'CDMV',zone:'KRDW',pickupDate:'2026-12-09',column:'M',rate:80,limit:77,rateOrigin:'baseline'}]};
    await writeFile(join(directory,'excel-rate-update-summary.json'),JSON.stringify({status:'error',error:{message:'Cap error',diagnostics}}));
    assert.deepEqual(bindReportEvidence(directory).excel_generation_error.diagnostics,diagnostics);
    await writeFile(join(directory,'excel-rate-update-summary.json'),JSON.stringify({status:'ok'}));
    assert.equal(bindReportEvidence(directory).excel_generation_error,undefined);
  } finally {await rm(directory,{recursive:true,force:true});}
});

test('diagnostics from an older run are pinned to its workflow and SHA, not the latest report', async () => {
  const archive=zipSync({'run-manifest.json':strToU8(JSON.stringify({...manifest,status:'failure',quality:{blocking_alerts:['ZIP error']}}))});
  const repository=new GitHubRepository({}, {api:async path => {
    if(path === '/actions/runs/123')return {id:123,path:'.github/workflows/discovercars-daily.yml',head_sha:record.revision,status:'completed',conclusion:'failure'};
    if(path.includes('/artifacts?'))return {artifacts:[{id:1,name:'discovercars-results-10',size_in_bytes:archive.length}]};
    if(path.endsWith('/zip'))return archive;
    if(path.includes('/jobs?'))return {jobs:[]};
    throw new Error(path);
  }});
  const result=await repository.runIncident('123');
  assert.equal(result.report.runId,'123');
  assert.equal(result.report.incident.code,'unknown');
  assert.equal(result.report.revision,record.revision);
  await assert.rejects(repository.runIncident('../1'),error=>error.status===422);
});

test('mismatched or oversized historical diagnostic artifacts are rejected', async () => {
  for (const patch of [{run_id:'999'},{git_sha:'f'.repeat(40)}]) {
    const archive=zipSync({'run-manifest.json':strToU8(JSON.stringify({...manifest,...patch}))});
    const repository=new GitHubRepository({}, {api:async path=>path === '/actions/runs/123' ? {id:123,path:'.github/workflows/discovercars-daily.yml',head_sha:record.revision} : path.endsWith('/zip') ? archive : {artifacts:[{id:1,name:'discovercars-results-10',size_in_bytes:archive.length}]}});
    await assert.rejects(repository.runIncident('123'),error=>error.status===409);
  }
});
