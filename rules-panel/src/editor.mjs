import { DURATION_BANDS } from "./policy.mjs";

const cities = { Gdansk: "Gdańsk", Krakow: "Kraków", Lodz: "Łódź", Lubin: "Lubin", Poznan: "Poznań", Torun: "Toruń", Warsaw: "Warszawa", Wroclaw: "Wrocław" };
export function locationOptions(model) {
  return (model.locations.locations ?? model.locations).flatMap(location => {
    const city = cities[location.city] ?? location.city;
    const type = location.id.includes("west_station") ? "Dworzec Zachodni" : location.id.includes("train_station") ? "Dworzec kolejowy" : location.id.includes("galeria") ? "Galeria Krakowska" : location.kind === "airport" ? "Lotnisko" : "Miasto";
    return location.zones.map((value,index) => ({ value, label: index ? `${value} · wg rynku ${city} · ${type}` : `${city} · ${type} (${value})` }));
  });
}

export function filterRules(rules, { today, period = "current" }) {
  return rules.filter(rule => period === "all" || (period === "expired" ? Boolean(rule.endDate && rule.endDate < today) : !rule.endDate || rule.endDate >= today));
}

export function groupRuleBands(rules) {
  const families = new Map();
  for (const rule of rules) {
    const key = JSON.stringify([rule.category, rule.category === "priority" ? "priority" : rule.title,
      rule.kind, rule.groups, rule.zones, rule.startDate, rule.endDate, Boolean(rule.overrideProtected), rule.editable]);
    if (!families.has(key)) families.set(key, []);
    families.get(key).push(rule);
  }
  return [...families.values()];
}

export function familyTitles(families) {
  const used=new Set();
  return families.map(([rule])=>{
    let title=rule.title;
    if(families.filter(([other])=>other.title===rule.title).length>1){
      const date=value=>value?value.split('-').reverse().join('.'):'bezterminowo';
      title+=` · ${date(rule.startDate)}–${date(rule.endDate)} · ${rule.groups.join(', ')}`;
    }
    const base=title;let n=2;while(used.has(title))title=`${base} (${n++})`;
    used.add(title);return title;
  });
}

export function publishBlocker(workspace) {
  if (!workspace?.capabilities.publish) return workspace?.capabilities.reason || "Publikacja konfiguracji nie jest aktywna.";
  const { draft, snapshot } = workspace;
  if (!draft) return "Zapisz zmianę zasad przed publikacją.";
  if (draft.sourceRevision !== snapshot.source.revision || draft.sourceHash !== snapshot.source.policyHash ||
    draft.baselineSha256 !== snapshot.baseline.sha256)
    return "Zmieniono konfigurację lub bazę. Odśwież dane przed publikacją.";
  return "";
}

export function floorRequest({ groups, zones, startDate = "", endDate = "", amounts }) {
  if (!groups.length) throw new Error("Wybierz przynajmniej jedną klasę.");
  if (!zones.length) throw new Error("Wybierz przynajmniej jedną lokalizację.");
  if (startDate && endDate && startDate > endDate) throw new Error("Koniec okresu nie może poprzedzać początku.");
  const bands = DURATION_BANDS.flatMap(([minDays, maxDays], index) => {
    if (amounts[index] === "" || amounts[index] == null) return [];
    const amount = Number(amounts[index]);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 100000) throw new Error("Podaj dodatnią stawkę nie większą niż 100 000 PLN.");
    return [{ minDays, maxDays, amount }];
  });
  if (!bands.length) throw new Error("Podaj stawkę dla przynajmniej jednego przedziału najmu.");
  if (!startDate || !endDate) throw new Error("Podaj obie daty startu: od i do.");
  return { groups, zones, startDate, endDate, bands, overrideProtected: false };
}
