const dateLabel = value => value.split("-").reverse().join(".");
const realDate = value => typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;

export const modeLabel = mode => mode === "github" ? "GitHub" : mode === "hosted-preview" ? "Podgląd online" : "Tryb lokalny";

export function timestamp(value) {
  if (realDate(value)) return dateLabel(value);
  return value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("pl-PL", { timeZone: "Europe/Warsaw" }) : "Brak danych";
}

export function dateRanges(values = []) {
  const dates = [...new Set(values.filter(realDate))].sort();
  const ranges = [];
  for (const value of dates) {
    const last = ranges.at(-1);
    if (last && Date.parse(value) - Date.parse(last[1]) === 86400000) last[1] = value;
    else ranges.push([value, value]);
  }
  return ranges.map(([first, last]) => first === last ? dateLabel(first) : `${first.slice(0, 4) === last.slice(0, 4) ? dateLabel(first).slice(0, -5) : dateLabel(first)}–${dateLabel(last)}`);
}

export function durationScope(values = []) {
  const numbers = [...new Set(values.filter(value => Number.isInteger(value) && value > 0))].sort((a, b) => a - b);
  const ranges = [];
  for (const value of numbers) {
    const last = ranges.at(-1);
    if (last && value === last[1] + 1) last[1] = value;
    else ranges.push([value, value]);
  }
  return ranges.length ? `${ranges.map(([first, last]) => first === last ? first : `${first}–${last}`).join(", ")} dni` : "Brak danych";
}
