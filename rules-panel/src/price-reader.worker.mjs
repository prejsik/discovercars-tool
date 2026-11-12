import { loadPriceEvidence, loadMarketEvidence } from './price-loader.mjs';
import {createPriceSourceCache} from './price-source-cache.mjs';
const cache=createPriceSourceCache(),jobs=new Map();
self.onmessage=async({data:{id,query,cancel}})=>{
  if(cancel){jobs.get(id)?.abort();return;}
  const controller=new AbortController();jobs.set(id,controller);
  try{
    const load=query.mode==='market'?loadMarketEvidence:loadPriceEvidence;
    const result=await load(query,undefined,{signal:controller.signal,cache});
    if(!controller.signal.aborted)self.postMessage({id,result});
  }catch(error){
    if([401,403,409].includes(error.status))cache.clear();
    if(!controller.signal.aborted)self.postMessage({id,error:error.message,status:error.status});
  }finally{jobs.delete(id);}
};
