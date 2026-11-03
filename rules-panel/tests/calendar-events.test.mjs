import test from 'node:test';
import assert from 'node:assert/strict';
const api=await import('../server/calendar-events.mjs').catch(()=>({}));
const actor='director@example.com';
const event={title:'Targi',start:'2026-11-06',end:'2026-11-08',zones:['KRLO'],kind:'event',notes:'Notatka'};
function storage(){const values=new Map();let queue=Promise.resolve();const db={get:async key=>structuredClone(values.get(key)),put:async(key,v)=>values.set(key,structuredClone(v))};return {...db,transaction:fn=>{const result=queue.then(()=>fn(db));queue=result.catch(()=>{});return result;},values};}

test('calendar annotations persist privately, archive recoverably and never write pricing state',async()=>{
  assert.equal(typeof api.saveCalendarEvent,'function');const store=storage();
  const first=await api.saveCalendarEvent(store,{expectedRevision:null,event},actor,['KRLO']);
  assert.equal(first.items[0].title,'Targi');assert.equal(first.items[0].updatedBy,actor);
  assert.equal((await api.readCalendarEvents(store)).revision,first.revision);
  const second=await api.saveCalendarEvent(store,{expectedRevision:first.revision,event:{...first.items[0],active:false}},actor,['KRLO']);
  assert.equal(second.items[0].active,false);assert.equal(second.audit.length,2);
  const restored=await api.saveCalendarEvent(store,{expectedRevision:second.revision,event:{...second.items[0],active:true}},actor,['KRLO']);
  assert.equal(restored.items[0].active,true);
  assert.deepEqual([...store.values.keys()],['calendar-events']);
});

test('concurrent annotation saves conflict instead of overwriting another director',async()=>{
  assert.equal(typeof api.saveCalendarEvent,'function');const store=storage();
  const writes=await Promise.allSettled([api.saveCalendarEvent(store,{expectedRevision:null,event},actor,['KRLO']),api.saveCalendarEvent(store,{expectedRevision:null,event:{...event,title:'Inne'}},actor,['KRLO'])]);
  assert.equal(writes.filter(v=>v.status==='fulfilled').length,1);
  assert.equal(writes.find(v=>v.status==='rejected').reason.status,409);
});

test('annotation validation rejects unknown locations, invalid dates, forged actor and unbounded content',async()=>{
  assert.equal(typeof api.saveCalendarEvent,'function');
  for(const patch of [{start:'2026-02-30'},{end:'2026-10-01'},{zones:['EVIL']},{title:'x'.repeat(121)},{notes:'x'.repeat(501)},{kind:'price-rule'},{id:'unknown'}])await assert.rejects(api.saveCalendarEvent(storage(),{expectedRevision:null,event:{...event,...patch}},actor,['KRLO']),e=>e.status===422);
  await assert.rejects(api.saveCalendarEvent(storage(),{event},'', ['KRLO']),e=>e.status===403);
});
