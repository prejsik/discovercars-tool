import {locationLabel} from './operations.mjs';
import {locationOptions} from './editor.mjs';
import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Search, ShieldCheck } from 'lucide-react';

const bands = ['1', '2', '3-4', '5-7', '8-20', '21-35'];
const kindLabel = kind => kind === 'airport' ? 'Lotnisko' : kind === 'city' ? 'Miasto' : kind;
const inheritedSource = (location, sources) => location?.zones.map(zone => sources.find(source => source.zone === zone)).find(Boolean);

const pointLabel=item=>locationOptions({locations:{locations:[item]}})[0]?.label??locationLabel(item.scraper_label);

function LocationAssignment({ zone, locations, markupSources, service, disabled, onChange }) {
  const [draft, setDraft] = useState({ target: '', query: '', selectedQuery: '', candidates: [], placeId: '', markupSourceZone: '', daily: true, searching: false, searched: false, searchError: '' });
  const searchVersion = useRef(0);
  useEffect(() => () => { searchVersion.current++; }, []);
  const location = locations.find(item => `existing:${item.id}` === draft.target);
  const source = location ? inheritedSource(location, markupSources) : markupSources.find(item => item.zone === draft.markupSourceZone);

  const update = patch => {
    searchVersion.current++;
    const next = { ...draft, searching: false, ...patch };
    setDraft(next);
    const existing = locations.find(item => `existing:${item.id}` === next.target);
    const candidate = next.candidates.find(item => String(item.placeId) === next.placeId);
    let assignment = null;
    if (existing && inheritedSource(existing, markupSources)) {
      assignment = { zone, existingLocationId: existing.id, daily: existing.daily || next.daily };
    } else if (next.target === 'new' && candidate && next.query === next.selectedQuery && markupSources.some(item => item.zone === next.markupSourceZone)) {
      assignment = { zone, placeId: candidate.placeId, query: next.selectedQuery, markupSourceZone: next.markupSourceZone, daily: next.daily };
    }
    const donor=existing?inheritedSource(existing,markupSources):markupSources.find(s=>s.zone===next.markupSourceZone);
    onChange(zone, assignment, {source:donor,label:existing?pointLabel(existing):candidate?.label??'',placeId:candidate?.placeId,binding:existing?'Istniejący punkt':'Nowy punkt',daily:assignment?.daily});
    return searchVersion.current;
  };
  const search = async () => {
    const query = draft.query.trim();
    if (!query || draft.searching || disabled) return;
    const version = update({ query, placeId: '', selectedQuery: '', candidates: [], searching: true, searched: false, searchError: '' });
    try {
      const result = await service.searchLocations(query);
      if (version !== searchVersion.current) return;
      setDraft(current => ({ ...current, candidates: result.candidates, selectedQuery: query, searching: false, searched: true }));
    } catch (error) {
      if (version === searchVersion.current) setDraft(current => ({ ...current, searching: false, searchError: error.message }));
    }
  };
  return <fieldset className="location-assignment" disabled={disabled}>
    <legend><MapPin size={18} aria-hidden="true" />Strefa {zone}</legend>
    <div className="location-assignment-fields">
      <label className="location-field">Powiązanie
        <select aria-label={`Powiązanie ${zone}`} value={draft.target} onChange={event => {
          const target = event.target.value;
          const existing = locations.find(item => `existing:${item.id}` === target);
          update({ target, query: '', selectedQuery: '', candidates: [], placeId: '', markupSourceZone: '', daily: existing?.daily ?? true, searched: false, searchError: '' });
        }}>
          <option value="">Wybierz punkt</option>
          <optgroup label="Istniejące punkty">{locations.map(item => <option key={item.id} value={`existing:${item.id}`}>{pointLabel(item)}</option>)}</optgroup>
          <option value="new">Nowy punkt</option>
        </select>
      </label>
      {draft.target && <div className="location-daily">
        <label><input type="checkbox" aria-label={`Codzienny scraper ${zone}`} checked={draft.daily} disabled={disabled || location?.daily === true} onChange={event => update({ daily: event.target.checked })} />Codzienny scraper</label>
        {location?.daily && <small className="muted">Punkt jest już w codziennym scraperze.</small>}
      </div>}
      {draft.target === 'new' && <>
        <div className="location-search">
          <label className="location-field">Szukana lokalizacja
            <input type="search" aria-label={`Szukana lokalizacja ${zone}`} value={draft.query} onChange={event => update({ query: event.target.value, selectedQuery: '', candidates: [], placeId: '', searched: false, searchError: '' })} />
          </label>
          <button type="button" className="button" aria-label={`Szukaj lokalizacji ${zone}`} disabled={disabled || draft.searching || !draft.query.trim()} onClick={search}><Search size={18} aria-hidden="true" />{draft.searching ? 'Wyszukiwanie…' : 'Szukaj'}</button>
        </div>
        {draft.searchError && <p className="alert error location-search-message" role="alert">{draft.searchError}</p>}
        {draft.searched && !draft.candidates.length && <p className="muted location-search-message" role="status">Brak wyników dla „{draft.selectedQuery}”.</p>}
        {draft.candidates.length > 0 && <label className="location-field">Wynik wyszukiwania
          <select aria-label={`Wynik wyszukiwania ${zone}`} value={draft.placeId} onChange={event => update({ placeId: event.target.value })}>
            <option value="">Wybierz znaleziony punkt</option>
            {draft.candidates.map(item => <option key={item.placeId} value={item.placeId}>{item.label} · {item.city} · {kindLabel(item.kind)}</option>)}
          </select>
        </label>}
        <label className="location-field">Źródło narzutów
          <select aria-label={`Źródło narzutów ${zone}`} value={draft.markupSourceZone} onChange={event => update({ markupSourceZone: event.target.value })}>
            <option value="">Wybierz tabelę narzutów</option>
            {markupSources.map(item => <option key={item.zone} value={item.zone}>{item.zone} · {item.label}</option>)}
          </select>
        </label>
      </>}
      {location && <label className="location-field location-inherited">Źródło narzutów · odziedziczone
        <input aria-label={`Źródło narzutów ${zone}`} readOnly value={source ? `${source.zone} · ${source.label}` : 'Brak tabeli narzutów dla tego punktu'} />
      </label>}
    </div>
  </fieldset>;
}

export function LocationOnboarding({ onboarding, service, disabled, onChange }) {
  const [rows,setRows]=useState({});const [closed,setClosed]=useState({});
  return <section className="location-onboarding" aria-labelledby="location-onboarding-heading">
    <h2 id="location-onboarding-heading">Nowe lokalizacje</h2>
    <p className="muted" role="status">Obecna baza pozostaje aktywna.</p>
    <table className="location-onboarding-table"><thead><tr>{['Kod','Powiązanie','Punkt w DiscoverCars','Narzuty z','Codzienny scraper','Stan','Zmień'].map(text=><th key={text}>{text}</th>)}</tr></thead><tbody>{onboarding.unknownZones.map(zone=><React.Fragment key={zone}><tr><td data-label="Kod">{zone}</td><td data-label="Powiązanie">{rows[zone]?.binding??'Nie wybrano'}</td><td data-label="Punkt w DiscoverCars">{rows[zone]?.label||'Nie wybrano'}{rows[zone]?.placeId?` (ID ${'${rows[zone].placeId}'})`:''}</td><td data-label="Narzuty z">{rows[zone]?.source?.zone??'Nie wybrano'}</td><td data-label="Codzienny scraper">{rows[zone]?.daily===undefined?'Nie wybrano':rows[zone].daily?'Tak':'Nie'}</td><td data-label="Stan">{rows[zone]?.ready?'Skonfigurowano':'Do uzupełnienia'}</td><td><button type="button" className="button" disabled={disabled} onClick={()=>setClosed(current=>({...current,[zone]:!current[zone]}))}>{closed[zone]?'Zmień':'Zwiń formularz'}</button></td></tr><tr hidden={Boolean(closed[zone])}><td colSpan={7}><LocationAssignment zone={zone} locations={onboarding.locations} markupSources={onboarding.markupSources} service={service} disabled={disabled} onChange={(code,assignment,details)=>{setRows(current=>({...current,[code]:{...details,ready:Boolean(assignment)}}));onChange(code,assignment);}}/></td></tr></React.Fragment>)}</tbody></table>
    <h3>Narzuty według kodu strefy</h3><div className="baseline-table-scroll"><table className="markup-table"><thead><tr><th>Kod / źródło</th>{bands.map((band,i)=><th key={band}>{i===0?'1 dzień':`${band.replace('-','–')} dni`}</th>)}</tr></thead><tbody>{onboarding.unknownZones.map(zone=><tr key={zone}><th scope="row">{zone} / {rows[zone]?.source?.zone??'—'}</th>{bands.map(band=><td key={band}>{rows[zone]?.source?`${rows[zone].source.amounts[band].toLocaleString('pl-PL')} PLN`:'—'}</td>)}</tr>)}</tbody></table></div>
  </section>;
}

export function VerifiedLocations({ onboarding }) {
  return <section className="location-verified" aria-labelledby="location-verified-heading">
    <h3 id="location-verified-heading"><ShieldCheck size={18} aria-hidden="true" />Zweryfikowane lokalizacje</h3>
    {onboarding.addedLocations.map(location => {
      return <article className="location-verified-row" key={location.zone} aria-label={`Zweryfikowana strefa ${location.zone}`}>
        <h4>{location.zone} · {location.label}</h4>
        <dl className="source-list">
          <div><dt>Lotnisko referencyjne</dt><dd>{location.airportLabels.length ? location.airportLabels.map(label => <span className="location-airport-label" key={label}>{label}</span>) : location.kind === 'airport' ? 'Nie dotyczy punktu lotniskowego' : 'Brak lotniska referencyjnego w tym mieście'}</dd></div>
        </dl>
      </article>;
    })}
    <p className="location-policy-note">Nowe lokalizacje stosują ogólne zasady dla klas, z rozróżnieniem lotnisko/miasto, oraz chronione terminy. Wybór źródła narzutów nie kopiuje lokalnych minimów ani wyjątków. Baza i konfiguracja lokalizacji zostaną zapisane razem.</p>
  </section>;
}
