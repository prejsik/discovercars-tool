import { loadPriceEvidence } from './price-loader.mjs';
self.onmessage=async ({data})=>{
  try {self.postMessage({result:await loadPriceEvidence(data)});}
  catch(error){self.postMessage({error:error.message,status:error.status});}
};
