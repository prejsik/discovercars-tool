import test from "node:test";
import assert from "node:assert/strict";
import { dateRanges, durationScope, timestamp } from "../src/display.mjs";

test("continuous pickup dates become ranges, never hide a gap or year boundary", () => {
  assert.deepEqual(dateRanges(["2026-10-17", "2026-10-16", "2026-10-18", "2026-10-18", "2026-10-20"]), ["16.10–18.10.2026", "20.10.2026"]);
  const dates = Array.from({ length: 45 }, (_, index) => new Date(Date.UTC(2026, 9, 16 + index)).toISOString().slice(0, 10));
  assert.deepEqual(dateRanges(dates), ["16.10–29.11.2026"]);
  assert.deepEqual(dateRanges(["2026-12-31", "2027-01-01"]), ["31.12.2026–01.01.2027"]);
});

test("continuous durations compact but missing durations are not implied", () => {
  assert.equal(durationScope(Array.from({ length: 13 }, (_, index) => index + 2)), "2–14 dni");
  assert.equal(durationScope([2, 3, 7, 14]), "2–3, 7, 14 dni");
  assert.equal(durationScope([]), "Brak danych");
});

test("date-only approval never invents a time", () => {
  assert.equal(timestamp("2026-10-13"), "13.10.2026");
  assert.match(timestamp("2026-10-13T08:00:00Z"), /13\.10\.2026.*10:00:00/);
  assert.equal(timestamp(null), "Brak danych");
});
