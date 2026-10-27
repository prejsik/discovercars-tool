import React, { useEffect, useRef, useState } from 'react';
import { MapPin, Search, ShieldCheck } from 'lucide-react';

const bands = ['1', '2', '3-4', '5-7', '8-20', '21-35'];
const kindLabel = kind => kind === 'airport' ? 'Lotnisko' : kind === 'city' ? 'Miasto' : kind;
const inheritedSource = (location, sources) => location?.zones.map(zone => sources.find(source => source.zone === zone)).find(Boolean);

function MarkupBands({ source }) {
  return <dl className="location-markup-bands" aria-label={`Narzuty ${source.zone}`}>
    {bands.map(band => <div key={band}><dt>{band} dni</dt><dd>{source.amounts[band].toLocaleString('pl-PL')} PLN</dd></div>)}
  </dl>;
}

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
    onChange(zone, assignment);
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
          <optgroup label="Istniejące punkty">{locations.map(item => <option key={item.id} value={`existing:${item.id}`}>{item.scraper_label} · {item.city} · {kindLabel(item.kind)}</option>)}</optgroup>
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
    {source && <MarkupBands source={source} />}
  </fieldset>;
}

export function LocationOnboarding({ onboarding, service, disabled, onChange }) {
  return <section className="location-onboarding" aria-labelledby="location-onboarding-heading">
    <h2 id="location-onboarding-heading">Nowe lokalizacje</h2>
    <p className="muted" role="status">Obecna baza pozostaje aktywna.</p>
    {onboarding.unknownZones.map(zone => <LocationAssignment key={zone} zone={zone} locations={onboarding.locations} markupSources={onboarding.markupSources} service={service} disabled={disabled} onChange={onChange} />)}
  </section>;
}

export function VerifiedLocations({ onboarding }) {
  return <section className="location-verified" aria-labelledby="location-verified-heading">
    <h3 id="location-verified-heading"><ShieldCheck size={18} aria-hidden="true" />Zweryfikowane lokalizacje</h3>
    {onboarding.addedLocations.map(location => {
      const source = onboarding.markupSources.find(item => item.zone === location.markupSourceZone);
      return <article className="location-verified-row" key={location.zone} aria-label={`Zweryfikowana strefa ${location.zone}`}>
        <h4>{location.zone} · {location.label}</h4>
        <dl className="source-list">
          <div><dt>Miasto / typ</dt><dd>{location.city} · {kindLabel(location.kind)}</dd></div>
          <div><dt>Codzienny scraper</dt><dd>{location.daily ? 'Tak' : 'Nie'}</dd></div>
          <div><dt>Narzuty skopiowane z</dt><dd>{source ? `${source.zone} · ${source.label}` : location.markupSourceZone}</dd></div>
          <div><dt>Lotnisko referencyjne</dt><dd>{location.airportLabels.length ? location.airportLabels.map(label => <span className="location-airport-label" key={label}>{label}</span>) : location.kind === 'airport' ? 'Nie dotyczy punktu lotniskowego' : 'Brak lotniska referencyjnego w tym mieście'}</dd></div>
        </dl>
        {source && <MarkupBands source={source} />}
      </article>;
    })}
    <p className="location-policy-note">Nowe lokalizacje stosują ogólne zasady dla klas, z rozróżnieniem lotnisko/miasto, oraz chronione terminy. Wybór źródła narzutów nie kopiuje lokalnych minimów ani wyjątków. Baza i konfiguracja lokalizacji zostaną zapisane razem.</p>
  </section>;
}
