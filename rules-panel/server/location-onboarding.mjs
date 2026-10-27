import { PanelError } from './workspace-service.mjs';

export const MAX_LOCATION_ADDITIONS = 12;
const BANDS = ['1', '2', '3-4', '5-7', '8-20', '21-35'];
const FIELDS = new Set(['zone', 'existingLocationId', 'query', 'placeId', 'markupSourceZone', 'daily']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const zoneSymbol = value => typeof value === 'string' && /^[A-Z0-9]{2,12}$/.test(value);
const placeId = value => Number.isSafeInteger(value) && value > 0;
const text = (value, maximum = 240) => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\x00-\x1f\x7f]/.test(value);
const own = (value, key) => Object.hasOwn(value, key) ? value[key] : undefined;
const fail = message => { throw new PanelError(422, message); };
// NFKD removes accents except the Polish stroked l, which needs an explicit fold.
const normalized = value => value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\u0142/g, 'l').replace(/\s+/g, ' ').trim();
const labelKey = value => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const sameLabel = (left, right) => labelKey(normalized(left)) === labelKey(normalized(right)) || labelKey(left) === labelKey(right);
const equalAmounts = (left, right) => BANDS.every(band => left[band] === right[band]);

export function prepareLocationAdditions({ documents, frozen, additions, unknownZones, candidates = {} } = {}) {
  const registry = documents?.locations;
  if (!object(documents) || !object(documents.pricing) || !object(documents.excel) || !object(registry)
    || !Array.isArray(registry.locations) || registry.locations.some(location => !object(location) || !text(location.id)
      || !text(location.scraper_label) || !text(location.city) || !['airport', 'city'].includes(location.kind)
      || !Array.isArray(location.zones) || !location.zones.length || !location.zones.every(zoneSymbol))) fail('Nieprawidlowy rejestr lokalizacji.');
  if ((registry.profiles !== undefined && !object(registry.profiles))
    || (registry.profiles?.daily !== undefined && !Array.isArray(registry.profiles.daily))) fail('Nieprawidlowy profil dzienny.');
  const knownZones = new Set(registry.locations.flatMap(location => location.zones));
  if (!Array.isArray(unknownZones) || !Array.isArray(additions) || unknownZones.length > MAX_LOCATION_ADDITIONS
    || additions.length > MAX_LOCATION_ADDITIONS || additions.length !== unknownZones.length) fail(`Przypisz wszystkie nowe strefy (maksymalnie ${MAX_LOCATION_ADDITIONS}).`);
  const unknown = new Set();
  for (const zone of unknownZones) {
    if (!zoneSymbol(zone) || knownZones.has(zone) || unknown.has(zone)) fail('Lista nowych stref zawiera bledna, istniejaca lub powtorzona strefe.');
    unknown.add(zone);
  }
  const mapped = new Set();
  for (const addition of additions) {
    if (!object(addition) || Object.keys(addition).some(key => !FIELDS.has(key)) || !zoneSymbol(addition.zone)
      || !unknown.has(addition.zone) || mapped.has(addition.zone) || typeof addition.daily !== 'boolean') fail('Nieprawidlowe lub powtorzone przypisanie nowej strefy.');
    if (Object.hasOwn(addition, 'query') && !text(addition.query, 200)) fail('Podaj prawidlowa fraze wyszukiwania (do 200 znakow).');
    const existing = Object.hasOwn(addition, 'existingLocationId');
    if (existing ? !text(addition.existingLocationId) || Object.hasOwn(addition, 'placeId') || Object.hasOwn(addition, 'query')
      : !placeId(addition.placeId)) fail('Wybierz istniejaca lokalizacje albo potwierdzony nowy punkt.');
    if (Object.hasOwn(addition, 'markupSourceZone') && (!zoneSymbol(addition.markupSourceZone) || !knownZones.has(addition.markupSourceZone))) fail('Zrodlo narzutu musi byc istniejaca strefa.');
    if (!existing && !addition.markupSourceZone) fail('Nowy punkt wymaga istniejacej strefy zrodlowej narzutu.');
    mapped.add(addition.zone);
  }
  if (!object(candidates) || Object.keys(candidates).length > MAX_LOCATION_ADDITIONS
    || Object.keys(candidates).some(zone => !unknown.has(zone))) fail('Nieprawidlowa lista potwierdzonych punktow.');

  const next = structuredClone({ documents, frozen, additions });
  if (!additions.length) return next;
  const calibration = frozen?.brokerMarkupCalibration;
  if (!object(calibration) || calibration.manualOnly !== true || calibration.model !== 'fixed_amount'
    || !object(calibration.zoneLocations) || !object(calibration.locationDurationAmounts)) fail('Wymagana jest zamrozona tabela narzutu fixed_amount z manualOnly=true.');
  const tableForLabel = label => {
    const table = typeof label === 'string' ? own(calibration.locationDurationAmounts, label) : undefined;
    if (!object(table) || Object.keys(table).length !== BANDS.length
      || BANDS.some(band => !Object.hasOwn(table, band) || typeof table[band] !== 'number' || !Number.isFinite(table[band]) || table[band] < 0)) fail('Zrodlo narzutu musi zawierac szesc prawidlowych przedzialow najmu.');
    return table;
  };
  const sourceForZone = zone => {
    const label = own(calibration.zoneLocations, zone);
    return { label, table: tableForLabel(label) };
  };
  const nextRegistry = next.documents.locations;
  const nextCalibration = next.frozen.brokerMarkupCalibration;
  const newPlaces = new Map();
  for (const addition of additions) {
    if (Object.hasOwn(calibration.zoneLocations, addition.zone)) fail('Nie mozna nadpisac istniejacego przypisania zamrozonego narzutu.');
    let location;
    let source;
    if (Object.hasOwn(addition, 'existingLocationId')) {
      location = nextRegistry.locations.find(entry => entry.id === addition.existingLocationId);
      if (!location) fail('Nie znaleziono istniejacej lokalizacji.');
      const original = registry.locations.find(entry => entry.id === addition.existingLocationId);
      source = sourceForZone(original.zones[0]);
      // Zone and label scenarios for one point must retain the same fixed amounts.
      const labelTable = tableForLabel(own(calibration.zoneLocations, original.scraper_label) ?? original.scraper_label);
      if (!equalAmounts(source.table, labelTable) || original.zones.some(zone => !equalAmounts(source.table, sourceForZone(zone).table))
        || (addition.markupSourceZone && !equalAmounts(source.table, sourceForZone(addition.markupSourceZone).table))) fail('Zrodlo narzutu rozni sie od istniejacej kalibracji punktu.');
      location.zones.push(addition.zone);
    } else {
      const candidate = own(candidates, addition.zone);
      if (!object(candidate) || !placeId(candidate.placeId) || candidate.placeId !== addition.placeId || !text(candidate.label)
        || !text(candidate.city) || !['airport', 'city'].includes(candidate.kind)) fail('Wybrany punkt nie zostal potwierdzony przez serwer.');
      const city = nextRegistry.locations.find(entry => normalized(entry.city) === normalized(candidate.city))?.city ?? candidate.city;
      if (registry.locations.some(entry => String(entry.discovercars?.place_id) === String(candidate.placeId)
        || sameLabel(entry.scraper_label, candidate.label))) fail('Ten punkt juz istnieje. Wybierz go z rejestru.');
      source = sourceForZone(addition.markupSourceZone);
      const previous = newPlaces.get(candidate.placeId);
      if (previous) {
        location = previous.location;
        if (previous.daily !== addition.daily || previous.markupSourceZone !== addition.markupSourceZone
          || location.scraper_label !== candidate.label || location.city !== city || location.kind !== candidate.kind) fail('Strefy tego samego nowego punktu musza miec identyczny punkt, profil dzienny i zrodlo narzutu.');
        location.zones.push(addition.zone);
      } else {
        const id = `location_${candidate.placeId}`;
        if (nextRegistry.locations.some(entry => entry.id === id || sameLabel(entry.scraper_label, candidate.label))
          || Object.keys(calibration.locationDurationAmounts).some(label => sameLabel(label, candidate.label))
          || Object.entries(calibration.zoneLocations).some(([alias, label]) => sameLabel(alias, candidate.label)
            || (typeof label === 'string' && sameLabel(label, candidate.label)))) fail('Identyfikator lub nazwa nowego punktu juz istnieje.');
        location = { id, scraper_label: candidate.label, city, kind: candidate.kind, zones: [addition.zone],
          discovercars: { place_id: candidate.placeId, require_place_id: true } };
        nextRegistry.locations.push(location);
        nextCalibration.locationDurationAmounts = { ...nextCalibration.locationDurationAmounts, [candidate.label]: structuredClone(source.table) };
        newPlaces.set(candidate.placeId, { location, daily: addition.daily, markupSourceZone: addition.markupSourceZone });
      }
      source = { label: location.scraper_label };
    }
    nextCalibration.zoneLocations[addition.zone] = source.label;
    if (addition.daily) {
      nextRegistry.profiles ??= {};
      nextRegistry.profiles.daily ??= [];
      if (!nextRegistry.profiles.daily.includes(location.id)) nextRegistry.profiles.daily.push(location.id);
    }
  }
  return next;
}
