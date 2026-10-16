export const DURATION_BANDS = Object.freeze([
  [1, 1], [2, 2], [3, 4], [5, 7], [8, 20], [21, 35],
].map(Object.freeze));

const POLICY_PRECEDENCE = [
  'protected_dates', 'class_allowlist', 'required_evidence', 'priority_top1',
  'scoped_floor', 'zone_floor', 'seasonal_floor', 'city_airport_cap', 'ranking_target', 'premium_parity',
];

const clone = (value) => structuredClone(value);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const array = (value) => Array.isArray(value) ? value : [];
const entries = (value) => object(value) ? Object.entries(value) : [];
const pricingOf = (model) => model.pricing?.pricing ?? model.pricing ?? {};
const pricingPath = (model) => object(model.pricing?.pricing) ? 'pricing.pricing' : 'pricing';
const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;
const code = (value) => typeof value === 'string' && /^[A-Z0-9]{4}$/.test(value);
const unique = (values) => [...new Set(values)];
const same = (a, b) => {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a).sort();
  return sameKeys(keys, Object.keys(b).sort()) && keys.every((key) => same(a[key], b[key]));
};
const sameKeys = (a, b) => a.length === b.length && a.every((key, index) => key === b[index]);
const overlap = (a, b) => a.minDays <= b.maxDays && b.minDays <= a.maxDays;
const dateOverlap = (a, b) => (!a.startDate || !b.endDate || a.startDate <= b.endDate)
  && (!b.startDate || !a.endDate || b.startDate <= a.endDate);
const inDates = (row, date) => (!row.startDate || row.startDate <= date) && (!row.endDate || date <= row.endDate);
const includes = (values, value) => values.includes('*') || values.includes(value);

function realDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000')) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === value;
}

export function createModel({ pricing, excel, locations }) {
  return clone({ pricing, excel, locations });
}

export function toDocuments(model) {
  return clone({ pricing: model.pricing, excel: model.excel });
}

export function knownGroups(model) {
  const pricing = pricingOf(model);
  const excel = model.excel ?? {};
  return unique([
    ...array(excel.apply_groups), ...array(excel.excluded_groups),
    ...array(pricing.locationTypeFloorsPlnDay?.groups),
    ...entries(pricing.mandatoryGroupFloorsPlnDay).map(([group]) => group),
    ...array(pricing.priorityTop1Rules).flatMap((rule) => array(rule?.groups)),
    ...array(excel.minimum_rates?.scoped_overrides).flatMap((rule) => array(rule?.groups)),
    ...array(excel.group_price_parity?.base_groups),
    ...entries(excel.group_price_parity?.premium_adjustments_pln_day).map(([group]) => group),
    ...entries(excel.group_rate_adjustments_pln_day).map(([group]) => group),
    ...entries(excel.excluded_group_highlights).map(([group]) => group),
    ...entries(excel.omitted_group_zones).flatMap(([, groups]) => array(groups)),
  ].filter(code)).sort();
}

export function knownZones(model) {
  return unique(array(model.locations?.locations).flatMap((location) => array(location?.zones))).sort();
}

function ruleEntries(model) {
  const pricing = pricingOf(model);
  const output = [];
  const append = (id, category, title, target, path, fields = {}, extra = {}) => {
    output.push({ target, path, ...extra, row: {
      id, title, category, groups: ['*'], zones: ['*'], kind: 'all',
      minDays: 1, maxDays: 35, amount: null, startDate: '', endDate: '',
      overrideProtected: false, editable: category !== 'legacy', ...fields,
    } });
  };
  const root = pricingPath(model);
  const location = pricing.locationTypeFloorsPlnDay;
  if (object(location)) {
    for (const kind of ['city', 'airport']) {
      append(`location:${kind}`, 'location', kind === 'city' ? 'Miasto: stawka minimalna' : 'Lotnisko: stawka minimalna', location,
        `${root}.locationTypeFloorsPlnDay`, {
          groups: clone(array(location.groups)), kind, minDays: location.minDays, maxDays: location.maxDays,
          amount: location.minimumRatesByKind?.[kind] ?? null,
        }, { type: 'location', kind });
    }
  }
  for (const [type, field] of [['group', 'mandatoryGroupFloorsPlnDay'], ['zone', 'mandatoryZoneFloorsPlnDay']]) {
    for (const [key, bands] of entries(pricing[field])) {
      array(bands).forEach((band, index) => {
        if (!object(band)) return;
        append(`${type}:${key}:${index}`, 'mandatory', `${key === '*' ? 'Wszystkie klasy' : key}: obowiązkowa stawka minimalna`, band, `${root}.${field}.${key}[${index}]`, {
          groups: type === 'group' ? [key] : ['*'], zones: type === 'zone' ? [key] : ['*'],
          minDays: band.minDays, maxDays: band.maxDays, amount: band.minimumRatePlnDay ?? null,
          startDate: band.start_date ?? '', endDate: band.end_date ?? '', overrideProtected: band.override_protected_dates ?? false,
        }, { type, key, index, field });
      });
    }
  }
  array(pricing.mandatoryScopedFloorsPlnDay).forEach((rule, index) => {
    if (!object(rule)) return;
    append(`scoped:${index}`, 'mandatory', 'Wybrane klasy i strefy: obowiazkowa stawka minimalna', rule,
      `${root}.mandatoryScopedFloorsPlnDay[${index}]`, {
        groups: clone(array(rule.groups)), zones: clone(array(rule.zones)),
        minDays: rule.minDays, maxDays: rule.maxDays, amount: rule.minimumRatePlnDay,
        startDate: rule.startDate, endDate: rule.endDate, overrideProtected: rule.overrideProtected,
      }, { type: 'scoped', index });
  });
  array(model.excel?.protected_rate_periods).forEach((period, index) => {
    if (!object(period)) return;
    append(`protected:${index}`, 'protected', 'Chronione daty odbioru', period, `excel.protected_rate_periods[${index}]`, {
      startDate: period.start_date ?? '', endDate: period.end_date ?? '',
    }, { type: 'protected', index });
  });
  array(pricing.priorityTop1Rules).forEach((rule, index) => {
    if (!object(rule)) return;
    array(rule.durationBands).forEach((band, bandIndex) => {
      append(`priority:${index}${bandIndex ? `:${bandIndex}` : ''}`, 'priority', `Priorytet Top 1 · ${band?.[0]}–${band?.[1]} dni`, rule,
        `${root}.priorityTop1Rules[${index}]`, {
          groups: clone(array(rule.groups)), zones: clone(array(rule.zones)),
          minDays: band?.[0], maxDays: band?.[1], amount: rule.minimumRatePlnDay ?? null,
          startDate: rule.startDate ?? '', endDate: rule.endDate ?? '',
        }, { type: 'priority', index, bandIndex });
    });
  });
  const legacy = model.excel?.minimum_rates;
  if (object(legacy)) {
    if (Object.hasOwn(legacy, 'global_min_pln_day')) {
      append('legacy:global', 'legacy', 'Starsza reguła: minimum globalne', legacy, 'excel.minimum_rates', { amount: legacy.global_min_pln_day });
    }
    for (const [zone, amount] of entries(legacy.zone_overrides_pln_day)) {
      append(`legacy:zone:${zone}`, 'legacy', `${zone}: starsze minimum strefy`, legacy, `excel.minimum_rates.zone_overrides_pln_day.${zone}`, { zones: [zone], amount });
    }
    for (const field of ['scoped_overrides', 'bands']) {
      array(legacy[field]).forEach((rule, index) => {
        if (!object(rule)) return;
        append(`legacy:${field}:${index}`, 'legacy', field === 'bands' ? 'Starsza reguła: minimum w okresie' : 'Starsza reguła: minimum wybranych klas i stref', rule,
          `excel.minimum_rates.${field}[${index}]`, {
            groups: clone(array(rule.groups).length ? rule.groups : ['*']),
            zones: clone(array(rule.zones).length ? rule.zones : ['*']),
            minDays: rule.min_days, maxDays: rule.max_days, amount: rule.min_pln_day ?? null,
            startDate: rule.start_date ?? '', endDate: rule.end_date ?? '',
          });
      });
    }
    if (Object.hasOwn(legacy, 'long_duration_min_pln_day')) {
      append('legacy:long', 'legacy', 'Starsza reguła: minimum najmu długoterminowego', legacy, 'excel.minimum_rates', {
        minDays: legacy.long_duration_min_days || 21, amount: legacy.long_duration_min_pln_day,
      });
    }
    if (Object.hasOwn(legacy, 'season_min_pln_day')) {
      append('legacy:season', 'legacy', 'Starsza reguła: minimum sezonowe', legacy, 'excel.minimum_rates', {
        minDays: legacy.season_duration_column_min_days || 8, amount: legacy.season_min_pln_day,
        startDate: legacy.season_start ?? '', endDate: legacy.season_end ?? '',
      });
    }
  }
  return output;
}

export function buildRules(model) {
  return ruleEntries(model).map(({ row }) => row);
}

function findRule(model, id) {
  const entry = ruleEntries(model).find(({ row }) => row.id === id);
  if (!entry) throw new Error(`Nieznana reguła: ${id}`);
  return entry;
}

export function updateRule(model, id, patch) {
  const next = createModel(model);
  const entry = findRule(next, id);
  if (!entry.row.editable) throw new Error('Reguła tylko do odczytu');
  const allowed = entry.type === 'scoped' ? ['groups', 'zones', 'amount', 'minDays', 'maxDays', 'startDate', 'endDate', 'overrideProtected']
    : entry.type === 'protected' ? ['startDate', 'endDate']
    : entry.type === 'location' || entry.type === 'zone' ? ['amount', 'minDays', 'maxDays']
      : ['amount', 'minDays', 'maxDays', 'startDate', 'endDate', ...(entry.type === 'group' ? ['overrideProtected'] : [])];
  for (const [key, value] of entries(patch)) {
    if (Object.hasOwn(entry.row, key) && same(value, entry.row[key])) continue;
    if (!allowed.includes(key)) throw new Error(`Niedozwolona zmiana pola strukturalnego lub zakresu: ${key}`);
    const target = entry.target;
    if (entry.type === 'scoped') {
      target[key === 'amount' ? 'minimumRatePlnDay' : key] = clone(value);
    } else if (entry.type === 'location') {
      if (key === 'amount') target.minimumRatesByKind[entry.kind] = value;
      else target[key] = value;
    } else if (entry.type === 'priority') {
      if (key === 'minDays' || key === 'maxDays') target.durationBands[entry.bandIndex][key === 'minDays' ? 0 : 1] = value;
      else target[{ amount: 'minimumRatePlnDay', startDate: 'startDate', endDate: 'endDate' }[key]] = value;
    } else {
      const mapped = { amount: 'minimumRatePlnDay', minDays: 'minDays', maxDays: 'maxDays', startDate: 'start_date', endDate: 'end_date', overrideProtected: 'override_protected_dates' }[key];
      if ((key === 'startDate' || key === 'endDate') && value === '') delete target[mapped];
      else if (key === 'overrideProtected' && value === false && !target.start_date && !target.end_date) delete target[mapped];
      else target[mapped] = value;
    }
  }
  if (entry.type === 'group' && !entry.target.start_date && !entry.target.end_date
    && entry.target.override_protected_dates === false) delete entry.target.override_protected_dates;
  return next;
}

export function addRule(model, fields) {
  const next = createModel(model);
  if (fields.category === 'protected') {
    if ((fields.groups && !same(fields.groups, ['*'])) || (fields.zones && !same(fields.zones, ['*']))
      || (fields.kind && fields.kind !== 'all') || fields.overrideProtected || fields.amount != null) {
      throw new Error('Okres ochrony obsługuje tylko daty, bez ograniczenia do klasy lub strefy');
    }
    (next.excel.protected_rate_periods ??= []).push({ start_date: fields.startDate ?? '', end_date: fields.endDate ?? '' });
    return next;
  }
  if (fields.category !== 'mandatory') throw new Error('Można dodać tylko obowiązkową stawkę minimalną lub okres ochrony');
  const groups = fields.groups ?? ['*'];
  const zones = fields.zones ?? ['*'];
  if (!Array.isArray(groups) || groups.length !== 1 || (groups[0] !== '*' && !knownGroups(model).includes(groups[0]))) {
    throw new Error('Wybierz jedną znaną klasę lub * dla wszystkich klas');
  }
  if (!Array.isArray(zones) || zones.length !== 1 || (zones[0] !== '*' && !knownZones(model).includes(zones[0]))) {
    throw new Error('Wybierz jedną znaną strefę lub * dla wszystkich stref');
  }
  const zoneOnly = zones[0] !== '*';
  if ((fields.kind && fields.kind !== 'all') || (zoneOnly && (groups[0] !== '*' || fields.startDate || fields.endDate || fields.overrideProtected))) {
    throw new Error('Minimum strefy musi obejmować wszystkie klasy, bez dat i wyjątku od ochrony');
  }
  const field = zoneOnly ? 'mandatoryZoneFloorsPlnDay' : 'mandatoryGroupFloorsPlnDay';
  const rules = pricingOf(next)[field] ??= {};
  const key = zoneOnly ? zones[0] : groups[0];
  const band = { minDays: fields.minDays ?? 1, maxDays: fields.maxDays ?? (zoneOnly ? 35 : 1), minimumRatePlnDay: fields.amount ?? null };
  if (!zoneOnly) {
    if (fields.startDate) band.start_date = fields.startDate;
    if (fields.endDate) band.end_date = fields.endDate;
    if (fields.overrideProtected || fields.startDate || fields.endDate) band.override_protected_dates = fields.overrideProtected ?? false;
  }
  (rules[key] ??= []).push(band);
  return next;
}

export function addFloorMatrix(model, fields) {
  const allowed = ['groups', 'zones', 'startDate', 'endDate', 'bands', 'overrideProtected'];
  if (!object(fields) || Object.keys(fields).some((key) => !allowed.includes(key))
    || !Array.isArray(fields.bands) || fields.bands.length !== DURATION_BANDS.length
    || DURATION_BANDS.some(([low, high]) => fields.bands.filter((band) => band?.minDays === low && band?.maxDays === high).length !== 1)
    || fields.bands.some((band) => !object(band) || !sameKeys(Object.keys(band).sort(), ['amount', 'maxDays', 'minDays']))) {
    throw new Error('Podaj jawne minima dla wszystkich szesciu obslugiwanych pasm czasu najmu, bez dodatkowych pol');
  }
  const next = createModel(model);
  const rules = pricingOf(next).mandatoryScopedFloorsPlnDay ??= [];
  if (!Array.isArray(rules)) throw new Error('Minima wybranych klas i stref musza byc lista');
  for (const band of fields.bands) rules.push(clone({
    groups: fields.groups, zones: fields.zones, startDate: fields.startDate, endDate: fields.endDate,
    minDays: band.minDays, maxDays: band.maxDays, minimumRatePlnDay: band.amount,
    overrideProtected: fields.overrideProtected === undefined ? false : fields.overrideProtected,
  }));
  const { errors } = validateModel(next, model);
  if (errors.length) throw new Error(errors.map(({ message }) => message).join('; '));
  return next;
}

export function removeRule(model, id) {
  const next = createModel(model);
  const entry = findRule(next, id);
  if (entry.type === 'scoped') {
    const pricing = pricingOf(next);
    pricing.mandatoryScopedFloorsPlnDay.splice(entry.index, 1);
    if (!pricing.mandatoryScopedFloorsPlnDay.length) delete pricing.mandatoryScopedFloorsPlnDay;
  } else if (entry.type === 'protected') next.excel.protected_rate_periods.splice(entry.index, 1);
  else if (entry.type === 'group' || entry.type === 'zone') {
    const table = pricingOf(next)[entry.field];
    table[entry.key].splice(entry.index, 1);
    if (!table[entry.key].length) delete table[entry.key];
  } else throw new Error('Tej reguły nie można usunąć');
  return next;
}

export function setGroupEnabled(model, group, enabled) {
  if (!knownGroups(model).includes(group)) throw new Error('Nieznana klasa; * nie może nadawać uprawnień do zmian rynkowych');
  if (typeof enabled !== 'boolean') throw new Error('Włączenie klasy wymaga wartości logicznej');
  const next = createModel(model);
  const allowed = array(next.excel.apply_groups).filter((item) => enabled || item !== group);
  const excluded = array(next.excel.excluded_groups).filter((item) => !enabled || item !== group);
  if (enabled && !allowed.includes(group)) allowed.push(group);
  if (!enabled && !excluded.includes(group)) excluded.push(group);
  next.excel.apply_groups = unique(allowed);
  next.excel.excluded_groups = unique(excluded);
  return next;
}

function lockedParts(model) {
  const value = createModel(model);
  const pricing = pricingOf(value);
  delete value.excel.apply_groups;
  delete value.excel.excluded_groups;
  delete value.excel.protected_rate_periods;
  delete pricing.mandatoryGroupFloorsPlnDay;
  delete pricing.mandatoryZoneFloorsPlnDay;
  delete pricing.mandatoryScopedFloorsPlnDay;
  const location = pricing.locationTypeFloorsPlnDay;
  if (object(location)) {
    delete location.minDays;
    delete location.maxDays;
    delete location.minimumRatesByKind;
  }
  for (const rule of array(pricing.priorityTop1Rules)) {
    if (!object(rule)) continue;
    for (const key of ['minimumRatePlnDay', 'durationBands', 'startDate', 'endDate']) delete rule[key];
  }
  return value;
}

export function validateModel(model, originalModel = model) {
  const errors = [];
  const warnings = [];
  const error = (path, message) => errors.push({ path, message });
  const warn = (path, message) => warnings.push({ path, message });
  if (!object(model) || !object(model.pricing) || !object(model.excel) || !object(model.locations)) {
    error('model', 'Wymagane są dokumenty reguł cenowych, konfiguracji Excel i lokalizacji');
    return { errors, warnings };
  }
  if (!sameKeys(Object.keys(model).sort(), ['excel', 'locations', 'pricing'])) error('model', 'Model nie może zawierać dodatkowych metadanych');
  const known = knownGroups(originalModel);
  const zones = knownZones(originalModel);
  const pricing = pricingOf(model);
  const root = pricingPath(model);
  if (!object(pricing)) {
    error('pricing', 'Reguły cenowe muszą być obiektem');
    return { errors, warnings };
  }
  const policy = pricing.pricingPolicy;
  if (policy != null && (!object(policy) || !same(policy.precedence ?? POLICY_PRECEDENCE, POLICY_PRECEDENCE)
    || (policy.normalFloorCapConflict ?? 'ignore_cap') !== 'ignore_cap')) {
    error(`${root}.pricingPolicy`, 'Kolejność reguł musi zachować zatwierdzoną hierarchię; konflikt minimum z limitem wymaga pominięcia limitu');
  }
  const scope = (list, path, available, wildcard = false, nonempty = true) => {
    if (!Array.isArray(list) || (nonempty && !list.length) || new Set(list).size !== list.length
      || list.some((item) => !(wildcard && item === '*') && !available.includes(item))) {
      error(path, 'Wybierz jawną listę znanych klas lub stref; nie można rozszerzyć uprawnień na nieznany zakres');
    }
  };
  scope(model.excel.apply_groups, 'excel.apply_groups', known);
  scope(model.excel.excluded_groups ?? [], 'excel.excluded_groups', known, false, false);
  if (object(originalModel?.excel) && !same(lockedParts(model), lockedParts(originalModel))) {
    error('model', 'Niedozwolona zmiana struktury lub innych ustawień, w tym rejestru lokalizacji, parytetu i kolejności reguł');
  }
  const duration = (low, high, path, maximum = 35) => {
    if (!Number.isSafeInteger(low) || !Number.isSafeInteger(high) || low < 1 || high < low || high > maximum) {
      error(path, `Czas najmu musi zawierać uporządkowane pełne dni od 1 do ${maximum}`);
    }
  };
  const dates = (start, end, path, required = false) => {
    if (required || start != null || end != null) {
      if (!realDate(start) || !realDate(end) || start > end) error(path, 'Podaj rzeczywiste daty odbioru w formacie RRRR-MM-DD, w kolejności chronologicznej');
    }
  };
  const location = pricing.locationTypeFloorsPlnDay;
  if (location !== undefined) {
    if (!object(location)) error(`${root}.locationTypeFloorsPlnDay`, 'Minimum typu lokalizacji musi być obiektem');
    else {
      scope(location.groups, `${root}.locationTypeFloorsPlnDay.groups`, known);
      duration(location.minDays, location.maxDays, `${root}.locationTypeFloorsPlnDay`, 20);
      if (!sameKeys(Object.keys(location.minimumRatesByKind ?? {}).sort(), ['airport', 'city'])) {
        error(`${root}.locationTypeFloorsPlnDay.minimumRatesByKind`, 'Wymagane są obie stawki minimalne: miasta i lotniska');
      }
      for (const kind of ['city', 'airport']) {
        if (!positive(location.minimumRatesByKind?.[kind])) error(`${root}.locationTypeFloorsPlnDay.minimumRatesByKind.${kind}`, 'Kwota musi być skończoną liczbą większą od zera');
      }
    }
  }
  for (const [field, zoneTable] of [['mandatoryGroupFloorsPlnDay', false], ['mandatoryZoneFloorsPlnDay', true]]) {
    const table = pricing[field];
    if (table === undefined) continue;
    if (!object(table)) { error(`${root}.${field}`, 'Obowiązkowe minima muszą być tabelą kodów i pasm czasu najmu'); continue; }
    for (const [key, bands] of entries(table)) {
      const path = `${root}.${field}.${key}`;
      if (!(zoneTable ? zones.includes(key) : key === '*' || known.includes(key))) error(path, 'Nieznana klasa lub strefa nie może rozszerzać zakresu');
      if (!Array.isArray(bands) || !bands.length) { error(path, 'Wymagane jest co najmniej jedno pasmo czasu najmu'); continue; }
      const coverage = new Set();
      for (const [index, band] of bands.entries()) {
        const bandPath = `${path}[${index}]`;
        if (!object(band)) { error(bandPath, 'Pasmo czasu najmu musi być obiektem'); continue; }
        duration(band.minDays, band.maxDays, bandPath);
        if (!positive(band.minimumRatePlnDay)) error(`${bandPath}.minimumRatePlnDay`, 'Kwota musi być skończoną liczbą większą od zera');
        const scoped = ['start_date', 'end_date', 'override_protected_dates'].some((key) => Object.hasOwn(band, key));
        if (zoneTable && scoped) error(bandPath, 'Minima strefy nie obsługują dat ani wyjątków od ochrony');
        else if (scoped) {
          dates(band.start_date, band.end_date, bandPath, true);
          if (Object.hasOwn(band, 'override_protected_dates') && typeof band.override_protected_dates !== 'boolean') error(bandPath, 'Wyjątek od ochrony wymaga wartości logicznej');
        }
        if (Number.isSafeInteger(band.minDays) && Number.isSafeInteger(band.maxDays) && band.minDays >= 1 && band.maxDays <= 35) {
          for (let day = band.minDays; day <= band.maxDays; day++) {
            if (coverage.has(day)) { error(path, 'Nakładające się pasma pod jednym kodem są odrzucane przez silnik Python, również przy różnych datach'); break; }
          }
          for (let day = band.minDays; day <= band.maxDays; day++) coverage.add(day);
          if (DURATION_BANDS.some(([low, high]) => low <= band.maxDays && high >= band.minDays && (band.minDays > low || band.maxDays < high))) {
            warn(bandPath, 'Niepełne pasmo czasu najmu obejmie całą przecinającą się z nim kolumnę Excel');
          }
        }
      }
      if (zoneTable && coverage.size !== 35) error(path, 'Tabela strefy musi pokrywać wszystkie dni 1-35, bez luk');
    }
  }
  const protectedPeriods = model.excel.protected_rate_periods ?? [];
  const scopedFloors = pricing.mandatoryScopedFloorsPlnDay;
  if (scopedFloors !== undefined && !Array.isArray(scopedFloors)) error(`${root}.mandatoryScopedFloorsPlnDay`, 'Minima wybranych klas i stref musza byc lista');
  array(scopedFloors).forEach((rule, index) => {
    const path = `${root}.mandatoryScopedFloorsPlnDay[${index}]`;
    if (!object(rule)) { error(path, 'Minimum wybranych klas i stref musi byc obiektem'); return; }
    if (!sameKeys(Object.keys(rule).sort(), ['endDate', 'groups', 'maxDays', 'minDays', 'minimumRatePlnDay', 'overrideProtected', 'startDate', 'zones'])) {
      error(path, 'Wymagane sa tylko jawne klasy, strefy, daty, pasmo, kwota i decyzja o ochronie');
    }
    scope(rule.groups, `${path}.groups`, known);
    scope(rule.zones, `${path}.zones`, zones);
    dates(rule.startDate, rule.endDate, path, true);
    if (!DURATION_BANDS.some(([low, high]) => rule.minDays === low && rule.maxDays === high)) error(path, 'Wybierz jedno z szesciu obslugiwanych pasm czasu najmu');
    if (!positive(rule.minimumRatePlnDay)) error(path, 'Kwota musi byc skonczona liczba wieksza od zera');
    if (typeof rule.overrideProtected !== 'boolean') error(path, 'Wyjatek od ochrony wymaga jawnej wartosci logicznej');
  });
  if (!Array.isArray(protectedPeriods)) error('excel.protected_rate_periods', 'Okresy ochrony muszą być listą');
  array(protectedPeriods).forEach((period, index) => dates(period?.start_date, period?.end_date, `excel.protected_rate_periods[${index}]`, true));
  const priorities = pricing.priorityTop1Rules ?? [];
  if (!Array.isArray(priorities)) error(`${root}.priorityTop1Rules`, 'Reguły priorytetowe muszą być listą');
  array(priorities).forEach((rule, index) => {
    const path = `${root}.priorityTop1Rules[${index}]`;
    if (!object(rule)) { error(path, 'Reguła priorytetowa musi być obiektem'); return; }
    if (!positive(rule.minimumRatePlnDay)) error(`${path}.minimumRatePlnDay`, 'Kwota musi być skończoną liczbą większą od zera');
    scope(rule.groups, `${path}.groups`, known);
    scope(rule.zones, `${path}.zones`, zones, true);
    dates(rule.startDate, rule.endDate, path, true);
    if (!Array.isArray(rule.durationBands) || !rule.durationBands.length) error(`${path}.durationBands`, 'Wymagane są pasma czasu najmu dla priorytetu');
    array(rule.durationBands).forEach((band, index) => {
      duration(band?.[0], band?.[1], `${path}.durationBands[${index}]`, 20);
      if (!Array.isArray(band) || band.length !== 2) error(`${path}.durationBands[${index}]`, 'Pasmo czasu najmu musi mieć dokładnie dwie granice');
      else if (!DURATION_BANDS.some((supported) => same(supported, band))) warn(`${path}.durationBands[${index}]`, 'Niestandardowe pasmo priorytetu może nie odpowiadać dokładnie kolumnie Excel');
    });
  });
  const rows = buildRules(model);
  const mandatory = rows.filter((row) => row.category === 'mandatory');
  for (let index = 0; index < mandatory.length; index++) {
    for (const other of mandatory.slice(index + 1)) {
      const row = mandatory[index];
      if (!row.id.startsWith('scoped:') && row.id.split(':').slice(0, 2).join(':') === other.id.split(':').slice(0, 2).join(':')) continue;
      if (overlap(row, other) && dateOverlap(row, other)
        && row.groups.some((group) => includes(other.groups, group) || group === '*')
        && row.zones.some((zone) => includes(other.zones, zone) || zone === '*')) {
        warn(row.id, `Nakładające się minima (${other.title}): obowiązuje najwyższa pasująca stawka, nie suma`);
      }
    }
  }
  for (const category of ['protected', 'priority']) {
    const candidates = rows.filter((row) => row.category === category);
    for (let index = 0; index < candidates.length; index++) {
      for (const other of candidates.slice(index + 1)) {
        const row = candidates[index];
        if (dateOverlap(row, other) && (category === 'protected' || (overlap(row, other)
          && row.groups.some((group) => includes(other.groups, group)) && row.zones.some((zone) => includes(other.zones, zone) || zone === '*')))) {
          warn(row.id, category === 'protected' ? 'Okresy ochrony dat odbioru nakładają się; ochronie podlega ich łączny zakres' : 'Reguły priorytetowe nakładają się; obowiązuje pierwsza pasująca reguła rekomendacji');
        }
      }
    }
  }
  return { errors, warnings };
}

function legacyFloor(model, rows, zone, group, pickupDate, band, duration) {
  const scoped = rows.filter((row) => row.id.startsWith('legacy:scoped_overrides:') && includes(row.zones, zone)
    && row.groups.includes(group) && row.minDays === band[0] && row.maxDays === band[1]);
  if (scoped.length) return scoped;
  const zoneRow = rows.find((row) => row.id === `legacy:zone:${zone}`);
  if (zoneRow) return [zoneRow];
  const base = rows.find((row) => row.id === 'legacy:global');
  const seasonal = rows.filter((row) => row.id.startsWith('legacy:bands:') && inDates(row, pickupDate)
    && overlap(row, { minDays: band[0], maxDays: band[1] }));
  if (seasonal.length) return [...(base ? [base] : []), ...seasonal];
  const long = rows.find((row) => row.id === 'legacy:long' && duration >= row.minDays);
  const season = rows.find((row) => row.id === 'legacy:season' && band[0] >= row.minDays && inDates(row, pickupDate));
  return [...(base ? [base] : []), ...(long ? [long] : []), ...(season ? [season] : [])];
}

// This is a minima preview, not a recommendation, workbook simulation or market price.
export function previewPolicy(model, { zone, group, pickupDate, duration, baselineRate } = {}) {
  const result = {
    floor: null, protected: false, marketAllowed: false, omitted: false, minimumAfterBaseline: null,
    reasons: [], matchedRuleIds: [], correctionFloor: null, conservativeFloor: null,
    limitations: ['Podgląd obejmuje tylko minima reguł. Nie wylicza celu rynkowego, rzeczywistej ceny, dostępnych dowodów, narzutu brokera, limitów ani parytetu w całym arkuszu.'],
  };
  const pricing = pricingOf(model);
  const excel = model.excel ?? {};
  const bad = validateModel(model).errors;
  if (bad.length) {
    result.reasons.push('Konfiguracja jest nieprawidłowa. Popraw błędy walidacji przed sprawdzeniem reguł.');
    result.limitations.push('Podgląd jest zablokowany z powodu nieprawidłowej konfiguracji.');
    return result;
  }
  if (!knownZones(model).includes(zone) || !knownGroups(model).includes(group) || !realDate(pickupDate)
    || !Number.isSafeInteger(duration) || duration < 1 || duration > 35
    || (baselineRate != null && (typeof baselineRate !== 'number' || !Number.isFinite(baselineRate) || baselineRate < 0))) {
    const message = 'Wybierz znaną strefę i klasę, rzeczywistą datę odbioru RRRR-MM-DD, czas najmu 1-35 dni i skończoną nieujemną stawkę bazową.';
    result.reasons.push(message);
    result.limitations.push(message);
    return result;
  }
  const rows = buildRules(model);
  const matched = new Set();
  const periods = rows.filter((row) => row.category === 'protected' && inDates(row, pickupDate));
  result.protected = periods.length > 0;
  periods.forEach((row) => matched.add(row.id));
  result.omitted = array(excel.omitted_group_zones?.[zone]).includes(group);
  if (result.omitted) {
    result.reasons.push(`${group}/${zone}: pozycja jest pomijana w arkuszu przed zastosowaniem minimów.`);
    result.matchedRuleIds = [...matched];
    return result;
  }
  const enabled = array(excel.apply_groups).includes(group) && !array(excel.excluded_groups).includes(group);
  const maximum = Math.min(20, positive(pricing.maxRecommendationRentalDays) ? pricing.maxRecommendationRentalDays : 20,
    positive(excel.max_recommendation_duration_days) ? excel.max_recommendation_duration_days : 20);
  result.marketAllowed = enabled && !result.protected && duration <= maximum;
  if (!enabled) result.reasons.push('Klasa jest zamrożona lub poza jawną listą klas dopuszczonych do zmian rynkowych. Obowiązkowe korekty minimów są niezależne.');
  if (result.protected) result.reasons.push('Data odbioru jest chroniona. Korygować ją mogą tylko minima klas z jawnym wyjątkiem od ochrony.');
  if (duration > maximum) result.reasons.push(`Najem powyżej ${maximum} dni jest wyłączony ze zmian rynkowych.`);
  const band = DURATION_BANDS.find(([low, high]) => low <= duration && duration <= high);
  const durationScope = { minDays: band[0], maxDays: band[1] };
  result.durationBand = [...band];
  const location = array(model.locations.locations).find((entry) => array(entry.zones).includes(zone));
  const locationRow = rows.find((row) => row.category === 'location' && row.kind === location?.kind
    && row.groups.includes(group) && row.minDays <= band[0] && row.maxDays >= band[1] && enabled && !result.protected);
  const zoneRows = rows.filter((row) => row.id.startsWith(`zone:${zone}:`) && overlap(row, durationScope));
  const groupRows = rows.filter((row) => row.id.startsWith('group:') && includes(row.groups, group)
    && overlap(row, durationScope) && inDates(row, pickupDate) && (!result.protected || row.overrideProtected === true));
  const scopedRows = rows.filter((row) => row.id.startsWith('scoped:') && row.groups.includes(group) && row.zones.includes(zone)
    && row.minDays === band[0] && row.maxDays === band[1] && inDates(row, pickupDate)
    && (!result.protected || row.overrideProtected === true));
  if (result.protected && zoneRows.length) {
    result.limitations.push('Rozbieżność ochrony SZLO i innych stref: silnik rekomendacji JS uwzględnia minimum strefy także w chronionych datach, lecz silnik Excel w Pythonie blokuje wtedy korekty minimum strefy. Obowiązujące minimum odzwierciedla Python; ostrożnościowy podgląd uwzględnia również minimum strefy.');
  }
  const mandatory = [...(!result.protected ? zoneRows : []), ...groupRows, ...scopedRows, ...(locationRow ? [locationRow] : [])];
  let applicable = mandatory;
  if (!applicable.length && result.marketAllowed) {
    // JS selects the first location/date/duration rule; Python then checks its group/zone and exact column.
    const first = array(pricing.priorityTop1Rules).findIndex((rule) => includes(array(rule.locations), location?.scraper_label)
      && rule.startDate <= pickupDate && pickupDate <= rule.endDate
      && array(rule.durationBands).some(([low, high]) => low <= duration && duration <= high));
    const priority = rows.find((row) => row.id.split(':')[1] === String(first) && row.category === 'priority'
      && includes(row.zones, zone) && row.groups.includes(group) && row.minDays === band[0] && row.maxDays === band[1]);
    if (priority) applicable = [priority];
    else applicable = legacyFloor(model, rows, zone, group, pickupDate, band, duration);
    result.limitations.push('Minima priorytetowe i starsze reguły ograniczają rekomendację rynkową; same nie podnoszą stawki bazowej.');
  }
  const maximumAmount = (list) => list.length ? Math.max(...list.map((row) => row.amount)) : null;
  result.floor = maximumAmount(applicable);
  result.conservativeFloor = maximumAmount([...applicable, ...zoneRows]);
  result.correctionFloor = maximumAmount(mandatory);
  if (locationRow
    && maximumAmount(zoneRows) < locationRow.amount && maximumAmount(groupRows) < locationRow.amount
    && excel.group_price_parity?.enabled !== false && array(excel.group_price_parity?.base_groups).length) {
    const premium = excel.group_price_parity?.premium_adjustments_pln_day?.[group];
    if (typeof premium === 'number' && Number.isFinite(premium)) result.correctionFloor = Math.max(result.correctionFloor, locationRow.amount + Math.max(0, premium));
  }
  applicable.forEach((row) => matched.add(row.id));
  if (result.floor != null) result.reasons.push(`Obowiązująca stawka minimalna: ${result.floor} PLN za dobę. Wyższa stawka bazowa nie jest obniżana przez minimum.`);
  else result.reasons.push('Brak samodzielnie obowiązującego minimum. Stawka bazowa pozostaje bez zmian.');
  if (locationRow) result.reasons.push('Obowiązkowe minimum miasta lub lotniska ma pierwszeństwo przed priorytetem i wszystkimi starszymi minimami.');
  result.minimumAfterBaseline = baselineRate == null ? null : Math.max(baselineRate, result.correctionFloor ?? 0);
  result.matchedRuleIds = [...matched];
  return result;
}
