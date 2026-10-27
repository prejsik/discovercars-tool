import { decodeBaseline, inspectBaseline, compareBaselineCoverage } from './baseline.mjs';
import { prepareLocationAdditions, MAX_LOCATION_ADDITIONS } from './location-onboarding.mjs';
import { searchDiscovercarsLocations } from './location-search.mjs';
import { hashJson, PanelError } from './workspace-service.mjs';

const bands = ['1', '2', '3-4', '5-7', '8-20', '21-35'];
const reject = (status, message) => { throw new PanelError(status, message); };

function options(documents, frozen) {
  const locations = documents.locations.locations;
  const daily = documents.locations.profiles?.daily ?? [];
  const calibration = frozen?.brokerMarkupCalibration;
  if (!calibration || calibration.enabled !== true || calibration.manualOnly !== true || calibration.model !== 'fixed_amount') {
    reject(422, 'Brak zatwierdzonej tabeli stalego narzutu. Dotychczasowa konfiguracja pozostaje aktywna.');
  }
  return {
    locations: locations.map(location => ({ id: location.id, scraper_label: location.scraper_label,
      city: location.city, kind: location.kind, zones: location.zones, daily: daily.includes(location.id) })),
    markupSources: locations.flatMap(location => location.zones.flatMap(zone => {
      const label = calibration.zoneLocations?.[zone];
      const amounts = calibration.locationDurationAmounts?.[label];
      return amounts && bands.every(band => Number.isFinite(amounts[band]) && amounts[band] >= 0)
        ? [{ zone, label: location.scraper_label, amounts }] : [];
    })),
  };
}

export async function processBaseline({ repository, storage, input, actor, publish = false,
  search = searchDiscovercarsLocations, clock = () => new Date() }) {
  const snapshot = await repository.snapshot();
  const bytes = decodeBaseline(input);
  const discovered = await inspectBaseline(bytes, snapshot.documents, { allowUnknownZones: true });
  const unknownZones = discovered.unknownZones ?? [];
  const additions = input.locationAdditions ?? [];
  if (!Array.isArray(additions) || additions.length > MAX_LOCATION_ADDITIONS || unknownZones.length > MAX_LOCATION_ADDITIONS) {
    reject(422, `Jednorazowo mozna skonfigurowac do ${MAX_LOCATION_ADDITIONS} nowych symboli lokalizacji.`);
  }
  const requestHash = await hashJson(additions);
  let onboardingHash = requestHash;
  if (publish && typeof input.importConfirmed !== 'boolean') reject(422, 'Potwierdz status importu pliku.');
  if (publish && discovered.sha256 === snapshot.baseline.sha256 && snapshot.baseline.filename === input.filename
    && snapshot.baseline.importConfirmed === input.importConfirmed
    && (!additions.length || snapshot.baseline.onboardingRequestHash === requestHash)) {
    return { revision: snapshot.source.revision, sha256: discovered.sha256, alreadyCurrent: true };
  }
  if (publish && unknownZones.length && !additions.length) reject(422, 'Uzupelnij konfiguracje nowych lokalizacji przed publikacja. Dotychczasowa baza pozostaje aktywna.');
  if (publish && (input.sourceRevision !== snapshot.source.revision || input.previousSha256 !== snapshot.baseline.sha256
    || input.checkedSha256 !== discovered.sha256)) {
    reject(409, 'Konfiguracja lub wybrany plik zmienily sie. Sprawdz plik ponownie.');
  }
  if (!unknownZones.length && additions.length) reject(422, 'Ten plik nie zawiera nowych symboli do skonfigurowania. Odswiez dane.');
  for (const item of additions) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || !unknownZones.includes(item.zone)
      || typeof item.daily !== 'boolean' || (item.existingLocationId
        ? typeof item.existingLocationId !== 'string'
        : !Number.isSafeInteger(item.placeId) || item.placeId <= 0 || typeof item.query !== 'string'
          || item.query.trim().length < 2 || item.query.length > 100)) {
      reject(422, 'Uzupelnij poprawnie kazda nowa lokalizacje przed sprawdzeniem konfiguracji.');
    }
  }
  let onboarding;
  let onboardingInfo;
  let proposedDocuments = snapshot.documents;
  if (unknownZones.length) {
    const frozen = await repository.frozenMarkup(snapshot.source.revision);
    onboardingInfo = { ...options(snapshot.documents, frozen), unknownZones, ready: false, addedLocations: [] };
    if (additions.length) {
      const queries = [...new Set(additions.filter(item => !item?.existingLocationId).map(item => item?.query))];
      const results = new Map();
      // At most four bounded provider reads run concurrently; none can write configuration.
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(4, queries.length) }, async () => {
        while (next < queries.length) { const query = queries[next++]; results.set(query, await search(query)); }
      }));
      const candidates = Object.fromEntries(additions.filter(item => !item?.existingLocationId).map(item => {
        const matches = results.get(item.query)?.filter(candidate => candidate.placeId === item.placeId) ?? [];
        if (matches.length !== 1) reject(422, `Wybierz ponownie konkretny punkt DiscoverCars dla ${item.zone}.`);
        return [item.zone, matches[0]];
      }));
      onboarding = prepareLocationAdditions({ documents: snapshot.documents, frozen, additions, unknownZones, candidates });
      onboardingHash = await hashJson({ requestHash, registry: onboarding.documents.locations, frozen: onboarding.frozen });
      if (publish && input.checkedOnboardingHash !== onboardingHash) {
        reject(409, 'Dane punktu lub narzuty zmienily sie od sprawdzenia. Sprawdz konfiguracje ponownie.');
      }
      onboarding.hash = onboardingHash;
      onboarding.requestHash = requestHash;
      proposedDocuments = onboarding.documents;
      const registry = proposedDocuments.locations;
      onboardingInfo.ready = true;
      onboardingInfo.addedLocations = additions.map(item => {
        const location = registry.locations.find(entry => entry.zones.includes(item.zone));
        return { zone: item.zone, label: location.scraper_label, city: location.city, kind: location.kind,
          daily: registry.profiles?.daily?.includes(location.id) ?? false,
          markupSourceZone: item.markupSourceZone || snapshot.documents.locations.locations.find(entry => entry.id === item.existingLocationId)?.zones[0],
          airportLabels: location.kind === 'city' ? registry.locations.filter(entry => entry.kind === 'airport' && entry.city === location.city).map(entry => entry.scraper_label) : [] };
      });
    }
  }
  const { unknownZones: ignored, ...discoverySummary } = discovered;
  const summary = onboarding ? await inspectBaseline(bytes, proposedDocuments) : discoverySummary;
  const cacheKey = `baseline-coverage:${snapshot.baseline.sha256}`;
  let previous = await storage.get(cacheKey);
  if (!previous) {
    previous = await inspectBaseline(await repository.baselineBytes(snapshot.source.revision), snapshot.documents);
    if (previous.sha256 !== snapshot.baseline.sha256) reject(409, 'Obecna baza nie zgadza sie z manifestem.');
    await storage.put(cacheKey, previous);
  }
  compareBaselineCoverage(summary, previous);
  if (!publish) return { summary, sourceRevision: snapshot.source.revision, previousSha256: snapshot.baseline.sha256,
    ...(onboardingInfo ? { onboarding: onboardingInfo, onboardingHash } : {}) };
  if (onboardingInfo && !onboardingInfo.ready) reject(422, 'Uzupelnij nowe lokalizacje. Dotychczasowa konfiguracja pozostaje aktywna.');
  const approvedAt = clock().toISOString();
  const receipt = await repository.publishBaseline({ input, summary, snapshot, approvedAt, onboarding });
  try {
    await storage.put(`baseline-coverage:${summary.sha256}`, summary);
    await storage.put(`baseline-audit:${receipt.revision}`, { ...receipt, actor, approvedAt, filename: input.filename,
      ...(onboardingInfo ? { locations: onboardingInfo.addedLocations } : {}) });
  } catch { console.warn(JSON.stringify({ event: 'baseline_audit_storage_failed', revision: receipt.revision })); }
  return receipt;
}
