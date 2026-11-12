// Keep only verified, immutable bytes, never a cached publication context.
export function createPriceSourceCache(maxBytes=32*1024*1024,maxEntries=8) {
  const entries=new Map();let size=0;
  return {
    get(key){const value=entries.get(key);if(value){entries.delete(key);entries.set(key,value);}return value;},
    set(key,value){
      if(entries.has(key)){size-=entries.get(key).byteLength;entries.delete(key);}
      if(value.byteLength>maxBytes)return;
      while(entries.size&&(size+value.byteLength>maxBytes||entries.size>=maxEntries)){
        const oldest=entries.keys().next().value;size-=entries.get(oldest).byteLength;entries.delete(oldest);
      }
      entries.set(key,value);size+=value.byteLength;
    },
    clear(){entries.clear();size=0;},
  };
}
