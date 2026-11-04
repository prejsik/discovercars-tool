import {RulesWorkspace} from '../worker/workspace.mjs';
import {PriceEvidenceReader} from '../server/price-evidence-reader.mjs';
const baseline=new Uint8Array(1024*1024).fill(5);
const hash=BufferLikeHex(await crypto.subtle.digest('SHA-256',baseline));
function BufferLikeHex(bytes){return [...new Uint8Array(bytes)].map(v=>v.toString(16).padStart(2,'0')).join('');}

export class PriceProbe extends RulesWorkspace{
 constructor(ctx,env){
  super(ctx,env);this.version='a';this.configReads=0;
  this.priceReader=new PriceEvidenceReader(()=>({json:async()=>{this.configReads++;return {locations:[{zones:['KRLO'],scraper_label:'Airport '+this.version}]};},baselineBytes:async()=>baseline}),async()=>Response.json({
   run_id:this.version==='a'?'123':'124',generated_at:'2026-11-04T13:00:00Z',source_started_at:'2026-11-04T08:37:00Z',git_sha:this.version.repeat(40),status:'success',quality:{details:'x'.repeat(630000)},baseline:{workbook_sha256:hash},excel_files:{'rates-updated.xlsx':'c'.repeat(64)},
  }));
 }
 changeVersion(){this.version='b';}
 async stats(){return {configReads:this.configReads,storageEntries:(await this.ctx.storage.list()).size};}
}
export default {async fetch(request,env){
 const url=new URL(request.url),reader=env.PROBE.getByName('price-read');
 if(url.pathname==='/stats')return Response.json(await reader.stats());
 if(url.pathname==='/change'){await reader.changeVersion();return Response.json({ok:true});}
 return reader.priceEvidence({zone:'KRLO',group:url.searchParams.get('group')??'CDMV',duration:3,transmission:'automatic',reportRunId:url.searchParams.get('run')??'123',excelRunId:url.searchParams.get('run')??'123',kind:'baseline'},url.searchParams.get('actor')??'owner@example.test',url.pathname==='/binary');
}};
