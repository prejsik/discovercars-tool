import test from 'node:test';
import assert from 'node:assert/strict';
import {priceFixture} from './price-fixture.mjs';
import {loadPriceEvidence,loadMarketEvidence} from '../src/price-loader.mjs';
import {createPriceSourceCache} from '../src/price-source-cache.mjs';

const query={zone:'KRLO',group:'CDMV',duration:3,transmission:'automatic',reportRunId:'123',excelRunId:'123'};

test('changing filters reuses source bytes but always rechecks publication context',async()=>{
  const transport=await priceFixture({transportOnly:true}),calls=[];const cache=createPriceSourceCache();
  const fetcher=(url,options)=>{calls.push(url);return transport(url,options);};
  const first=await loadPriceEvidence(query,fetcher,{cache});
  const second=await loadPriceEvidence({...query,duration:4},fetcher,{cache});
  assert.equal(first.rows[0].importRate,63);assert.equal(second.rows[0].importRate,63);
  assert.equal(calls.filter(url=>url.startsWith('/api/report/prices?')).length,4);
  for(const kind of ['workbook','baseline','market','summary'])assert.equal(calls.filter(url=>url.endsWith(`kind=${kind}`)).length,1,kind);
  const market=await loadMarketEvidence({reportRunId:'123'},fetcher,{cache});
  assert.equal(market.rows[0].mm,80);
  assert.equal(calls.filter(url=>url.endsWith('kind=market')).length,1);
});

test('abort during a source read stops further downloads instead of becoming a warning',async()=>{
  const transport=await priceFixture({transportOnly:true});const controller=new AbortController(),calls=[];
  const fetcher=async(url,options)=>{
    calls.push(url);
    if(url.endsWith('kind=baseline')){controller.abort();throw controller.signal.reason;}
    return transport(url,options);
  };
  await assert.rejects(loadPriceEvidence(query,fetcher,{signal:controller.signal}),error=>error.name==='AbortError');
  assert.equal(calls.some(url=>url.endsWith('kind=market')),false);
});

test('cached files never bypass changed publication detection',async()=>{
  const transport=await priceFixture({transportOnly:true}),cache=new Map();
  await loadPriceEvidence(query,transport,{cache});
  let contexts=0;
  await assert.rejects(loadPriceEvidence(query,async(url,options)=>{
    const response=await transport(url,options);
    if(url.startsWith('/api/report/prices?')&&++contexts===2){const data=await response.json();return Response.json({...data,signature:'new run'});}
    return response;
  },{cache}),error=>error.status===409);
});

test('a changed hash cannot read cached bytes or poison the old source key',async()=>{
  const transport=await priceFixture({transportOnly:true}),cache=createPriceSourceCache();
  await loadPriceEvidence(query,transport,{cache});let downloads=0;
  await assert.rejects(loadPriceEvidence(query,async(url,options)=>{
    const response=await transport(url,options);
    if(url.startsWith('/api/report/prices?')){const data=await response.json();data.excel.files['rates-updated.xlsx']='f'.repeat(64);return Response.json(data);}
    if(url.endsWith('kind=workbook'))downloads++;
    return response;
  },{cache}),error=>error.status===409);
  assert.equal(downloads,1);
  assert.equal((await loadPriceEvidence(query,transport,{cache})).rows[0].importRate,63);
});

test('source cache has byte and entry bounds and evicts least recently used bytes',()=>{
  const cache=createPriceSourceCache(8,2);
  cache.set('a',new Uint8Array(3));cache.set('b',new Uint8Array(3));cache.get('a');
  cache.set('c',new Uint8Array(3));assert.equal(cache.get('b'),undefined);assert.ok(cache.get('a'));
  cache.set('large',new Uint8Array(9));assert.equal(cache.get('large'),undefined);assert.ok(cache.get('c'));
  cache.set('d',new Uint8Array(6));assert.equal(cache.get('a'),undefined);assert.equal(cache.get('c'),undefined);
  cache.clear();assert.equal(cache.get('d'),undefined);
});
