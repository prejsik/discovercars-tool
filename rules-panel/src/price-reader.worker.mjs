import { loadPriceEvidence, loadMarketEvidence } from './price-loader.mjs';
self.onmessage=async ({data})=>{
  try {self.postMessage({result:await (data.mode==='market'?loadMarketEvidence(data):loadPriceEvidence(data))});}
  catch(error){self.postMessage({error:error.message,status:error.status});}
};
