import { PanelError } from './workspace-service.mjs';
import { validDate } from '../src/market-model.mjs';
const KEY='calendar-events';
export async function readCalendarEvents(storage){return await storage.get(KEY)??{revision:null,items:[],audit:[]};}
export async function saveCalendarEvent(storage,input,actor,allowedZones) {
  if(typeof actor!=='string'||!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor))throw new PanelError(403,'Brak potwierdzonej tożsamości.');
  const e=input.event;
  if(!e||typeof e.title!=='string'||e.title.trim().length<2||e.title.length>120||typeof e.notes!=='string'||e.notes.length>500||!validDate(e.start)||!validDate(e.end)||e.start>e.end||!['event','holiday'].includes(e.kind)||!Array.isArray(e.zones)||!e.zones.length||e.zones.length>50||e.zones.some(z=>z!=='*'&&!allowedZones.includes(z))||(e.active!==undefined&&typeof e.active!=='boolean'))throw new PanelError(422,'Sprawdź nazwę, daty i lokalizację wydarzenia.');
  return storage.transaction(async db=>{
    const current=await readCalendarEvents(db);
    if((input.expectedRevision??null)!==current.revision)throw new PanelError(409,'Inna osoba zmieniła wydarzenia. Odśwież listę przed zapisem.');
    const index=current.items.findIndex(item=>item.id===e.id);
    if(e.id&&index<0)throw new PanelError(422,'Nie znaleziono tego wydarzenia.');
    if(!e.id&&current.items.length>=200)throw new PanelError(422,'Osiągnięto limit 200 wydarzeń. Edytuj istniejący wpis.');
    const now=new Date().toISOString();
    const event={id:e.id||crypto.randomUUID(),title:e.title.trim(),notes:e.notes.trim(),start:e.start,end:e.end,kind:e.kind,zones:[...new Set(e.zones)],active:e.active!==false,updatedAt:now,updatedBy:actor};
    const items=[...current.items];if(index<0)items.push(event);else items[index]=event;
    const result={revision:crypto.randomUUID(),items,audit:[{id:event.id,at:now,by:actor,action:event.active?'save':'archive'},...current.audit].slice(0,100)};
    if(new TextEncoder().encode(JSON.stringify(result)).length>96*1024)throw new PanelError(422,'Lista wydarzeń jest zbyt duża. Skróć notatki.');
    await db.put(KEY,result);return result;
  });
}
