import {loadPriceContext,loadPriceSource} from './reports.mjs';
import {PanelError} from './workspace-service.mjs';

// This reader runs in the existing private Durable Object, not the HTTP CPU budget.
export class PriceEvidenceReader {
 constructor(createRepository,fetcher=(...args)=>fetch(...args)){
  this.createRepository=createRepository;this.fetcher=fetcher;this.configs=new Map();
 }
 async locations(repository,path,revision){
  if(path!=='locations.config.json'||!/^[a-f0-9]{40}$/.test(revision??''))throw new PanelError(502,'Nieprawidłowa wersja konfiguracji lokalizacji.');
  if(!this.configs.has(revision)){
   const pending=repository.json(path,revision).then(value=>{
    if(!Array.isArray(value?.locations))throw new PanelError(502,'Nieprawidłowa konfiguracja lokalizacji.');
    return value;
   });
   this.configs.set(revision,pending);
   pending.catch(()=>{if(this.configs.get(revision)===pending)this.configs.delete(revision);});
   if(this.configs.size>8)this.configs.delete(this.configs.keys().next().value);
  }
  return this.configs.get(revision);
 }
 async read(input,source){
  try{
   const repository=this.createRepository();
   const pinned={json:(path,revision)=>this.locations(repository,path,revision),
    baselineBytes:revision=>repository.baselineBytes(revision),reportHtml:record=>repository.reportHtml(record)};
   const headers={'Cache-Control':'private, no-store'};
   if(source)return new Response(await loadPriceSource(input,pinned,this.fetcher),{headers:{...headers,'Content-Type':'application/octet-stream'}});
   return Response.json(await loadPriceContext(input,pinned,this.fetcher),{headers});
  }catch(error){
   return Response.json({error:error.status?error.message:'Nie można odczytać cen. Odśwież panel lub otwórz Excel.'},{status:error.status??502,headers:{'Cache-Control':'private, no-store'}});
  }
 }
}
