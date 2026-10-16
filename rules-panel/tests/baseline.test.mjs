import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { zipSync, strToU8 } from 'fflate';
import { inspectBaseline, decodeBaseline, compareBaselineCoverage } from '../server/baseline.mjs';
import { readSnapshot } from '../server/snapshot.mjs';
import { GitHubRepository } from '../worker/github.mjs';

const documents = { excel: { apply_groups:['CDMV'], excluded_groups:['FVMD'], omitted_group_zones:{} }, locations:{ locations:[{zones:['KRLO']}] } };
const cell = (address, value) => `<c r="${address}" t="inlineStr"><is><t>${value}</t></is></c>`;
function fixture(edit = value => value, extra = {}) {
  const headers=['Group','Description','Rate code','Zone','Booking start date','Booking end date','Pickup start date','Pickup end date',...Array(6).fill('Per day')];
  const row = (number, values) => `<row r="${number}">${values.map((value,index)=>cell(`${String.fromCharCode(65+index)}${number}`,value)).join('')}</row>`;
  const sheet=edit(`<worksheet><sheetData>${row(2,['Min days','','','','Date format:','','','',1,2,3,5,8,21])}${row(3,['Max days','','','','dd-MM-yy','','','',1,2,4,7,20,35])}${row(4,headers)}${row(5,['CDMV','','','KRLO','27-04-26','16-11-26','16-10-26','16-10-26',35,35,35,40,40,100])}${row(6,['FVMD','','','KRLO','27-04-26','16-11-26','16-10-26','16-10-26',400,400,400,400,400,400])}</sheetData></worksheet>`);
  return zipSync(Object.fromEntries(Object.entries({
    '[Content_Types].xml':'<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    'xl/workbook.xml':'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Sheet1" r:id="rId1"/></sheets></workbook>',
    'xl/_rels/workbook.xml.rels':'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet"/></Relationships>',
    'xl/worksheets/sheet1.xml':sheet,...extra,
  }).map(([name,value])=>[name,strToU8(value)])));
}
test('actual baseline preserves all hidden/filtered rows, classes, zones and hash', async () => {
  const snapshot = await readSnapshot();
  const summary = await inspectBaseline(await readFile(new URL('../../input/mm-cars-rental-rates-inclusive-fp.xlsx',import.meta.url)),snapshot.documents);
  assert.equal(summary.sha256,snapshot.baseline.sha256);
  const manifest=JSON.parse(await readFile(new URL('../../input/baseline-manifest.json',import.meta.url),'utf8'));
  assert.deepEqual(summary,manifest.coverage);
});
test('valid workbook produces scope and accepts unchanged complete coverage', async () => {
  const summary=await inspectBaseline(fixture(),documents);
  assert.equal(summary.rowCount,2); assert.equal(summary.firstDate,'2026-10-16');
  compareBaselineCoverage(summary,summary);
  assert.throws(()=>compareBaselineCoverage(summary,{pairs:['CDMV/WA2']}),/CDMV\/WA2/);
});
for (const [name,edit] of [
  ['wrong headers',text=>text.replace('>Zone<','>Location<')],
  ['unknown class',text=>text.replace('>CDMV<','>HACK<')],
  ['missing class',text=>text.replace(/<row r="6">[\s\S]*?<\/row>/,'')],
  ['zero rate',text=>text.replace('>35<','>0<')],
  ['invalid date',text=>text.replaceAll('16-10-26','31-02-26')],
  ['unsupported date separators',text=>text.replaceAll('16-10-26','16.10.26')],
  ['duplicate row numbers',text=>text.replace('row r="6"','row r="5"')],
  ['mismatched cell address',text=>text.replace('r="A5"','r="A999"')],
  ['formula',text=>text.replace('<c r="I5"','<c r="I5"').replace('<c r="I5" t="inlineStr">','<c r="I5" t="inlineStr"><f>1+1</f>')],
  ['malformed XML',text=>text.replace('</worksheet>','')],
]) test(`rejects ${name}`,async()=>assert.rejects(inspectBaseline(fixture(edit),documents),error=>error.status===422));
test('rejects macros, non-xlsx inputs and corrupt zip',async()=>{
  await assert.rejects(inspectBaseline(fixture(undefined,{'xl/vbaProject.bin':'macro'}),documents));
  await assert.rejects(inspectBaseline(new Uint8Array([1,2,3]),documents));
  assert.throws(()=>decodeBaseline({filename:'bad.xls',content:'abcd'}));
});
test('rejects missing workbook declarations and dangling drawing references',async()=>{
  await assert.rejects(inspectBaseline(fixture(undefined,{'[Content_Types].xml':'<Types/>'}),documents),/deklaracji/);
  await assert.rejects(inspectBaseline(fixture(undefined,{'xl/worksheets/_rels/sheet1.xml.rels':'<Relationships><Relationship Target="../drawings/missing.xml"/></Relationships>'}),documents),/brakujacego/);
});
test('accepts workbook content type declared by extension Default',async()=>{
  const types='<Types><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  const summary=await inspectBaseline(fixture(undefined,{'[Content_Types].xml':types}),documents);
  assert.equal(summary.rowCount,2);
});
test('accepts worksheet content type declared by extension Default',async()=>{
  const types='<Types><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>';
  const summary=await inspectBaseline(fixture(undefined,{'[Content_Types].xml':types}),documents);
  assert.equal(summary.rowCount,2);
});
test('explicit incorrect workbook Override takes precedence over valid Default',async()=>{
  const types='<Types><Default Extension="xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>';
  await assert.rejects(inspectBaseline(fixture(undefined,{'[Content_Types].xml':types}),documents),/deklaracji/);
});
test('numeric Excel dates require a date style readable by openpyxl',async()=>{
  const numeric=sheet=>sheet.replace('<c r="G5" t="inlineStr"><is><t>16-10-26</t></is></c>','<c r="G5" s="0"><v>46311</v></c>');
  await assert.rejects(inspectBaseline(fixture(numeric),documents),/G5/);
  const summary=await inspectBaseline(fixture(numeric,{'xl/styles.xml':'<styleSheet><cellXfs><xf numFmtId="14"/></cellXfs></styleSheet>'}),documents);
  assert.equal(summary.firstDate,'2026-10-16');
});
test('baseline publication writes only original binary and its matching manifest atomically',async()=>{
  const calls=[];
  const repository=new GitHubRepository({}, {api:async(path,options={})=>{
    calls.push({path,...options});
    if(path.startsWith('/git/commits/')&&!options.method)return {tree:{sha:'old-tree'}};
    if(path==='/git/blobs')return {sha:'binary-blob'};
    if(path==='/git/trees')return {sha:'new-tree'};
    if(path==='/git/commits')return {sha:'b'.repeat(40)};
    if(path==='/git/refs/heads/main')return {};
    throw new Error(path);
  }});
  await repository.publishBaseline({input:{content:'ORIGINAL_BYTES',filename:'rates.xlsx',importConfirmed:false},summary:{sha256:'a'.repeat(64)},snapshot:{source:{revision:'c'.repeat(40)},baseline:{sha256:'d'.repeat(64)}},approvedAt:'2026-10-15T15:00:00Z'});
  assert.equal(calls.find(call=>call.path==='/git/blobs').body.content,'ORIGINAL_BYTES');
  const tree=calls.find(call=>call.path==='/git/trees').body.tree;
  assert.deepEqual(tree.map(file=>file.path),['input/mm-cars-rental-rates-inclusive-fp.xlsx','input/baseline-manifest.json']);
  assert.equal(JSON.parse(tree[1].content).workbook_sha256,'a'.repeat(64));
  assert.equal(calls.at(-1).body.force,false);
});
