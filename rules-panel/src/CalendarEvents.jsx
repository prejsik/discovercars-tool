import React, { useCallback, useEffect, useState } from 'react';
import { Archive, ArchiveRestore, CalendarDays, Pencil, Plus, RotateCcw, Save, X } from 'lucide-react';
import { locationOptions } from './editor.mjs';
import { timestamp } from './display.mjs';
import { warsawToday } from './market-model.mjs';

export function useCalendarEvents(service) {
  const [data,setData]=useState(null);const [error,setError]=useState('');const [busy,setBusy]=useState(false);
  const refresh=useCallback(async()=>{setBusy(true);setError('');try{setData(await service.calendarEvents());}catch(e){setError(e.message);}finally{setBusy(false);}},[service]);
  useEffect(()=>{refresh();},[refresh]);
  async function save(event){setBusy(true);setError('');try{const next=await service.saveCalendarEvent({expectedRevision:data?.revision??null,event});setData(next);return true;}catch(e){setError(e.message);return false;}finally{setBusy(false);}}
  return {items:data?.items??[],ready:data!==null,error,busy,refresh,save};
}

export function CalendarEvents({calendar,model}) {
  const [editor,setEditor]=useState(null);const [archived,setArchived]=useState(false);
  const zones=locationOptions(model);
  const fresh=()=>({title:'',notes:'',start:warsawToday(),end:warsawToday(),kind:'event',zones:['*'],active:true});
  const patch=(field,value)=>setEditor(old=>({...old,[field]:value}));
  return <section className="calendar-events" aria-label="Wydarzenia i święta">
    <div className="section-title"><h2>Wydarzenia i święta</h2><div className="event-actions"><button className="icon-button" aria-label="Odśwież wydarzenia" title="Odśwież wydarzenia" disabled={calendar.busy} onClick={calendar.refresh}><RotateCcw size={18}/></button><button className="button" disabled={!calendar.ready||calendar.busy} onClick={()=>setEditor(fresh())}><Plus size={16}/>Dodaj wydarzenie</button></div></div>
    <p className="evidence-note">Notatki współdzielone · bez wpływu na stawki i ochronę cen.</p>
    {calendar.error&&<div className="alert error" role="alert">{calendar.error}</div>}
    {!calendar.ready&&!calendar.error&&<p role="status">Odczytywanie wydarzeń…</p>}
    {editor&&<form className="event-form" onSubmit={async e=>{e.preventDefault();if(await calendar.save(editor))setEditor(null);}}>
      <label className="event-wide">Nazwa wydarzenia<input required minLength={2} maxLength={120} value={editor.title} onChange={e=>patch('title',e.target.value)}/></label>
      <label>Rodzaj<select value={editor.kind} onChange={e=>patch('kind',e.target.value)}><option value="event">Wydarzenie</option><option value="holiday">Święto / okres szczególny</option></select></label>
      <label>Lokalizacja wydarzenia<select value={editor.zones[0]} onChange={e=>patch('zones',[e.target.value])}><option value="*">Wszystkie lokalizacje</option>{zones.map(z=><option key={z.value} value={z.value}>{z.label}</option>)}</select></label>
      <label>Początek wydarzenia<input type="date" required value={editor.start} onChange={e=>patch('start',e.target.value)}/></label>
      <label>Koniec wydarzenia<input type="date" required min={editor.start} value={editor.end} onChange={e=>patch('end',e.target.value)}/></label>
      <label className="event-wide">Notatka<textarea maxLength={500} rows={3} value={editor.notes} onChange={e=>patch('notes',e.target.value)}/></label>
      <div className="event-actions event-wide"><button className="button primary" disabled={calendar.busy}><Save size={16}/>Zapisz wydarzenie</button><button type="button" className="button" disabled={calendar.busy} onClick={()=>setEditor(null)}><X size={16}/>Anuluj</button></div>
    </form>}
    <label className="check-label"><input type="checkbox" checked={archived} onChange={e=>setArchived(e.target.checked)}/>Pokaż zarchiwizowane</label>
    {calendar.ready&&!calendar.items.some(e=>archived||e.active)&&<p>Brak zapisanych wydarzeń.</p>}
    {[...calendar.items].filter(e=>archived||e.active).sort((a,b)=>a.start.localeCompare(b.start)).map(event=><div className="event-record" key={event.id}>
      <CalendarDays size={18}/><div><strong>{event.title}</strong><small>{event.start} – {event.end} · {event.zones.includes('*')?'Wszystkie lokalizacje':event.zones.join(', ')} · {event.kind==='holiday'?'Święto / okres szczególny':'Wydarzenie'}{!event.active?' · Zarchiwizowane':''}</small>{event.notes&&<p>{event.notes}</p>}<small>{timestamp(event.updatedAt)} · {event.updatedBy}</small></div>
      <div className="event-actions"><button className="icon-button" aria-label={`Edytuj ${event.title}`} title="Edytuj wydarzenie" disabled={calendar.busy} onClick={()=>setEditor({...event})}><Pencil size={16}/></button><button className="icon-button" aria-label={`${event.active?'Archiwizuj':'Przywróć'} ${event.title}`} title={event.active?'Archiwizuj':'Przywróć'} disabled={calendar.busy} onClick={()=>calendar.save({...event,active:!event.active})}>{event.active?<Archive size={16}/>:<ArchiveRestore size={16}/>}</button></div>
    </div>)}
  </section>;
}
