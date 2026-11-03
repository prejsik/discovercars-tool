const bands = { I:'1-1', J:'2-2', K:'3-4', L:'5-7', M:'8-20', N:'21-35' };
const origins = new Set(['baseline','market','group_parity','mandatory_floor','unknown']);
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

export function describeIncident(manifest) {
  if (manifest?.status !== 'failure') return null;
  const error = manifest.excel_generation_error;
  const messages = (Array.isArray(manifest.quality?.blocking_alerts) ? manifest.quality.blocking_alerts : []).filter(item => typeof item === 'string');
  const technicalDetails = [...new Set([error?.message, ...messages].filter(item => typeof item === 'string'))].join('\n').slice(0, 16000);
  const diagnostic = error?.diagnostics;
  let positions = [];
  let complete = false;
  let total = null;
  if (diagnostic?.code === 'city_airport_cap' && Array.isArray(diagnostic.positions)) {
    positions = diagnostic.positions.slice(0, 1000).filter(row => row && /^[A-Z0-9]{2,8}$/.test(row.group)
      && /^[A-Z0-9]{1,12}$/.test(row.zone) && /^\d{4}-\d{2}-\d{2}$/.test(row.pickupDate)
      && Object.hasOwn(bands,row.column) && finite(row.rate) && finite(row.limit)).map(row => ({
        group:row.group,zone:row.zone,pickupDate:row.pickupDate,column:row.column,duration:bands[row.column],
        rate:row.rate,limit:row.limit,rateOrigin:origins.has(row.rateOrigin) ? row.rateOrigin : 'unknown',
        ...(typeof row.location === 'string' ? {location:row.location.slice(0,150)} : {}),
        ...(typeof row.airportZone === 'string' && /^[A-Z0-9]{1,12}$/.test(row.airportZone) ? {airportZone:row.airportZone} : {}),
        ...(finite(row.airportRate) ? {airportRate:row.airportRate} : {}),
        ...(finite(row.multiplier) ? {multiplier:row.multiplier} : {}),
      }));
    total = Number.isSafeInteger(diagnostic.total) && diagnostic.total >= positions.length ? diagnostic.total : null;
    complete = total !== null && total === positions.length && diagnostic.positions.length === positions.length;
  }
  if (!positions.length) {
    const pattern = /\b([A-Z0-9]{2,8})\/([A-Z0-9]{1,12})\/(\d{4}-\d{2}-\d{2}) ([I-N]): (\d+(?:\.\d+)?) > (\d+(?:\.\d+)?)/g;
    positions = [...technicalDetails.matchAll(pattern)].slice(0,1000).map(([,group,zone,pickupDate,column,rate,limit]) => ({
      group,zone,pickupDate,column,duration:bands[column],rate:Number(rate),limit:Number(limit),rateOrigin:'unknown',
    }));
    positions = [...new Map(positions.map(row => [JSON.stringify(row),row])).values()];
  }
  if (diagnostic?.code === 'city_airport_cap' || /Final rates violate the city Top1 airport cap/.test(technicalDetails)) {
    return { code:'city_airport_cap', owner:'technical', title:'Excel zablokowany przez kontrolę limitu miasto–lotnisko',
      explanation:'Kontrola końcowa wykryła stawki miejskie powyżej dopuszczalnego limitu względem lotniska. Pliki Excel z tego uruchomienia nie zostały opublikowane.',
      nextStep:'Wymagana jest kontrola programu i kolejności stosowania zasad. Nie obniżaj minimów na podstawie samego tego komunikatu.',
      positions,complete,total,technicalDetails };
  }
  const preparation = /przed scrapowaniem|Scraper nie zostal uruchomiony|Scraper nie został uruchomiony|Brak pliku results-latest/.test(technicalDetails);
  return { code:preparation ? 'preparation' : 'unknown', owner:'technical',
    title:preparation ? 'Nie rozpoczęto zbierania cen' : 'Nie udało się opublikować nowych plików',
    explanation:preparation ? 'Proces zatrzymał się na przygotowaniu lub nie dostarczył danych cenowych.' : 'Uruchomienie nie przeszło kontroli publikacji. Nie potwierdzono nowych plików Excel.',
    nextStep:'Sprawdź szczegóły techniczne. Nie potwierdzono, że przyczyną są ustawienia cenowe w panelu.',
    positions:[],complete:false,total:null,technicalDetails };
}
