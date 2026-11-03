import { unzipSync, strFromU8 } from 'fflate';
import { SaxesParser } from 'saxes';
const fail = text => { throw Object.assign(new Error(text), {status:502}); };
const attr = (node,name) => Object.values(node.attributes).find(a=>a.name===name)?.value;
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const bands = [[1,1,'I'],[2,2,'J'],[3,4,'K'],[5,7,'L'],[8,20,'M'],[21,35,'N']];
export const rateBand = duration => bands.find(([low,high])=>duration>=low && duration<=high);
function xml(bytes, handlers) {
  if (!bytes) fail('Brak wymaganej części XLSX.');
  const parser=new SaxesParser({xmlns:true});
  parser.on('doctype',()=>fail('Niedozwolona deklaracja XML.'));
  for (const [event,handler] of Object.entries(handlers)) parser.on(event,handler);
  const text=strFromU8(bytes);
  for(let offset=0;offset<text.length;offset+=65536) parser.write(text.slice(offset,offset+65536));
  parser.close();
}

// Read-only projection. Hidden/filter state never removes tariff rows.
export function workbookRows(bytes, sheetName) {
  let expanded=0;const names=new Set();
  const meta=unzipSync(bytes,{filter:file=>{
    if(names.has(file.name) || file.name.includes('..')) fail('Nieprawidłowe archiwum XLSX.');
    names.add(file.name);expanded+=file.originalSize;
    if(expanded>96*1024*1024 || names.size>1000) fail('Plik jest zbyt duży do podglądu. Pobierz Excel.');
    return ['xl/workbook.xml','xl/_rels/workbook.xml.rels','xl/sharedStrings.xml'].includes(file.name);
  }});
  let id;let date1904=false;
  xml(meta['xl/workbook.xml'],{opentag:node=>{
    if(node.local==='sheet' && attr(node,'name')===sheetName) id=attr(node,'r:id');
    if(node.local==='workbookPr') date1904=['1','true'].includes(attr(node,'date1904'));
  }});
  if(!id) return [];
  let path;
  xml(meta['xl/_rels/workbook.xml.rels'],{opentag:node=>{
    if(node.local==='Relationship' && attr(node,'Id')===id && attr(node,'TargetMode')!=='External') {
      const target=attr(node,'Target')??'';path=target.startsWith('/')?target.slice(1):`xl/${target}`;
    }
  }});
  if(!path || !/^xl\/worksheets\/[\w.-]+\.xml$/.test(path)) fail('Nieprawidłowe powiązanie arkusza.');
  const strings=[];let capture=false;let value='';
  if(meta['xl/sharedStrings.xml']) xml(meta['xl/sharedStrings.xml'],{
    opentag:node=>{if(node.local==='si')value='';if(node.local==='t')capture=true;},
    text:text=>{if(capture)value+=text;},
    closetag:node=>{if(node.local==='t')capture=false;if(node.local==='si')strings.push(value);},
  });
  const sheet=unzipSync(bytes,{filter:file=>file.name===path});
  const rows=[];let row={};let ref;let type;let formula=false;
  xml(sheet[path],{
    opentag:node=>{
      if(node.local==='row')row={};
      if(node.local==='c'){ref=attr(node,'r')?.replace(/\d/g,'');type=attr(node,'t');value='';formula=false;}
      if(node.local==='f')formula=true;
      if(node.local==='v'||node.local==='t')capture=true;
    },text:text=>{if(capture)value+=text;},
    closetag:node=>{
      if(node.local==='v'||node.local==='t')capture=false;
      if(node.local==='c' && ref) row[ref]=formula?null:type==='s'?strings[Number(value)]:type==='inlineStr'||type==='str'||type==='d'?value:value===''?null:Number(value);
      if(node.local==='row')rows.push(row);
    },
  });
  rows.date1904=date1904;return rows;
}
function date(value,date1904=false) {
  if(typeof value==='number' && Number.isInteger(value) && value>0 && value<200000)
    return new Date(Date.UTC(date1904?1904:1899,date1904?0:11,date1904?1:30)+value*86400000).toISOString().slice(0,10);
  const text=String(value??'');
  if(/^\d{4}-\d{2}-\d{2}/.test(text))return text.slice(0,10);
  const match=text.match(/^(\d{2})-(\d{2})-(\d{2}|\d{4})$/);
  return match?`${match[3].length===2?'20':''}${match[3]}-${match[2]}-${match[1]}`:null;
}
export function selectRates(rows,query) {
  const band=rateBand(query.duration);
  return rows.filter(row=>row.A===query.group && row.D===query.zone).map(row=>({start:date(row.G,rows.date1904),end:date(row.H,rows.date1904),rate:row[band[2]]==null||row[band[2]]===''?null:number(Number(row[band[2]]))})).filter(row=>row.start&&row.end);
}
const displayedRate = value => {
  const match=String(value??'').match(/^([\d\s\u00a0]+,\d{2}) PLN\/d$/);
  return match?Number(match[1].replace(/\s/g,'').replace(',','.')):null;
};
export function readMarket(bytes,query) {
  const match=strFromU8(bytes).match(/<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/);
  if(!match) fail('Raport nie zawiera obsługiwanego zestawu cen. Otwórz raport cenowy.');
  const data=JSON.parse(match[1]);
  if(!Array.isArray(data.scenarios)) fail('Nieprawidłowe dane raportu cen.');
  return data.scenarios.filter(item=>Number(item.duration)===query.duration).map(item=>{
    const values=item.rows?.find(row=>row[0]===query.location)?.[query.transmission==='all'?3:2];
    const offers=values ? [[values[0],values[2]],[values[5],values[7]],[values[8],values[10]]]
      .map(([provider,price])=>({provider,rate:displayedRate(price)})).filter(row=>row.rate!==null&&!/mm\s+cars\s+rental/i.test(row.provider)) : [];
    offers.sort((a,b)=>a.rate-b.rate);
    return {date:item.date,mm:displayedRate(values?.[11]),competitor:offers[0]?.rate??null,provider:offers[0]?.provider??null,rank:values?.[13]??null};
  });
}
export function selectReviews(rows,query) {
  const [low,high]=rateBand(query.duration);const band=low===high?String(low):`${low}-${high}`;
  return rows.filter(row=>row.E===query.zone && String(row.F).split(/[,;\s]+/).includes(query.group) && String(row.H)===band).map(row=>({
    start:date(row.G),end:date(row.Z)||date(row.G),groups:row.F,status:row.B,notes:row.C,
    reason:row.W,outcome:row.P,type:row.O,markup:row.N,benchmarkProvider:row.Q,benchmark:number(row.R),
    scenario:row.X,cells:row.Y,
  }));
}
const uniqueRate = (rows,day) => {const matches=rows.filter(row=>row.start<=day&&day<=row.end);return matches.length===1?matches[0].rate:null;};
export function combineEvidence({dates,base,final,market,reviews,changes,sameRun,query}) {
  const [low,high]=rateBand(query.duration);
  const relevant=changes.filter(c=>c.group===query.group&&c.zone===query.zone&&c.duration_min_days===low&&c.duration_max_days===high);
  return dates.map(day=>{
    const offer=market.find(row=>row.date===day);
    const importRate=uniqueRate(final,day);const baseline=uniqueRate(base,day);
    const details=relevant.filter(c=>c.pickup_date<=day&&day<=(c.pickup_end_date||c.pickup_date));
    // Only exact final-cell matches may support a group-specific forecast.
    const detail=details.length===1 && details[0].new_rate===importRate?details[0]:null;
    const matches=reviews.filter(row=>row.start<=day&&day<=row.end);
    const review=matches.length===1?matches[0]:null;
    return {date:day,baseline,importRate,mm:offer?.mm??null,competitor:offer?.competitor??null,provider:offer?.provider??null,rank:offer?.rank??null,
      predicted:number(detail?.predicted_site_rate),detail,decision:detail?{...review,reason:detail.reason??review?.reason,outcome:review?.outcome??detail.recommendation_type}:review,
      sameRun,changed:baseline!==null&&importRate!==null?Math.abs(importRate-baseline)>.005:null};
  });
}
