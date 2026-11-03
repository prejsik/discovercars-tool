import test from 'node:test';
import assert from 'node:assert/strict';
import * as review from '../src/market-review.mjs';

test('gap labels explain direction and never call price gaps lost revenue',()=>{
  assert.equal(typeof review.gapLabel,'function');
  assert.equal(review.gapLabel(-7.85),'MM droższe o 7,85 PLN/dobę');
  assert.equal(review.gapLabel(7.85),'MM tańsze o 7,85 PLN/dobę');
  assert.equal(review.gapLabel(0),'Taka sama cena');
  assert.equal(review.gapLabel(null),'Brak porównania cen');
});
test('overview separates unavailable from missing and prioritizes overpricing before headroom',()=>{
  assert.equal(typeof review.compareAttention,'function');
  const rows=[
    {id:'headroom',signals:['gap30'],gap:40,date:'2026-11-04',duration:3},
    {id:'outside',signals:['outside'],gap:-8,date:'2026-11-04',duration:3},
    {id:'outsideLarge',signals:['outside'],gap:-20,date:'2026-11-05',duration:3},
    {id:'missing',signals:['missing'],gap:null,date:'2026-11-04',duration:3},
    {id:'unavailable',signals:['unavailable'],gap:null,date:'2026-11-04',duration:3},
  ];
  assert.deepEqual([...rows].sort((a,b)=>review.compareAttention(a,b,'priority')).map(r=>r.id),['unavailable','missing','outsideLarge','outside','headroom']);
  assert.equal([...rows].sort((a,b)=>review.compareAttention(a,b,'above'))[0].id,'outsideLarge');
});
test('chart scale fits finite visible prices without treating missing values as zero',()=>{
  assert.equal(typeof review.priceScale,'function');
  const scale=review.priceScale([{mm:80,competitor:82},{mm:null,competitor:81}]);
  assert.ok(scale.min>0&&scale.min<80&&scale.max>82);
  assert.ok(scale.max-scale.min>=10);
  assert.deepEqual(review.priceScale([{mm:null,competitor:null}]),{min:0,max:10});
  const zero=review.priceScale([{mm:0,competitor:10}]);
  assert.equal(zero.min,0);assert.ok(zero.max>10);
  assert.ok(review.priceScale([{mm:80,competitor:80}]).max>80);
});
