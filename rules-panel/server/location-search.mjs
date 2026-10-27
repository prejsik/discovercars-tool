import { PanelError } from './workspace-service.mjs';
import { readLimited } from './http.mjs';

export async function searchDiscovercarsLocations(query, fetcher = fetch) {
  if (typeof query !== 'string' || query.trim().length < 2 || query.length > 100 || /[\x00-\x1f]/.test(query)) {
    throw new PanelError(422, 'Podaj nazwe miasta lub punktu (2-100 znakow).');
  }
  try {
    const response = await fetcher(`https://www.discovercars.com/api/v2/autocomplete?location=${encodeURIComponent(query.trim())}`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(6000), redirect: 'error',
    });
    if (!response.ok) throw new Error('Lookup unavailable');
    const payload = JSON.parse(new TextDecoder().decode(await readLimited(response, 512 * 1024)));
    if (payload.success !== true || !Array.isArray(payload.result) || payload.result.length > 1000) throw new Error('Invalid lookup');
    const points = new Map();
    for (const item of payload.result) {
      const placeId = Number(item.placeID);
      const label = typeof item.place === 'string' ? item.place.trim() : '';
      const city = typeof item.city === 'string' ? item.city.trim() : '';
      if (Number(item.countryID) !== 75 || item.country !== 'Poland' || !Number.isSafeInteger(placeId) || placeId <= 0
        || !['airport', 'downtown', 'railway'].includes(item.location) || !label || label.length > 180
        || !city || city.length > 100 || /[<>\x00-\x1f]/.test(label + city)
        || /\(all locations\)|\(wszystkie lokalizacje\)/i.test(label)) continue;
      const candidate = { placeId, label, city, kind: item.location === 'airport' ? 'airport' : 'city' };
      if (points.has(placeId) && JSON.stringify(points.get(placeId)) !== JSON.stringify(candidate)) throw new Error('Ambiguous lookup');
      points.set(placeId, candidate);
    }
    return [...points.values()];
  } catch {
    throw new PanelError(502, 'Nie mozna potwierdzic punktu DiscoverCars. Sprobuj ponownie; dotychczasowa konfiguracja pozostaje aktywna.');
  }
}
