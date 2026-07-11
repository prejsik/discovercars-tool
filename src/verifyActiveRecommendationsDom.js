const fs = require("fs");
const path = require("path");
const { DiscoverCarsScraper } = require("./discovercars/scraper");

const VERIFIED_SOURCE_STATUSES = new Set([
  "dom_confirmed",
  "api_dom_conflict_dom_used",
  "dom_fallback",
  "dom_only",
  "dom_recommendation_verified"
]);

function keyOf(item) {
  return `${String(item?.location || "").toLowerCase()}|${String(item?.start_date || item?.pickup_date || "").slice(0, 10)}|${Number(item?.rental_days) || ""}`;
}

function addDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function toLegacyOffers(item) {
  const days = Number(item.rental_days) || 1;
  const currency = item.currency || "PLN";
  return [1, 2, 3].map((rank) => {
    const provider = item[`top${rank}_provider`];
    const rate = Number(item[`top${rank}_rate_pln_day`]);
    return provider && Number.isFinite(rate) ? { provider, totalPrice: rate * days, currency } : null;
  }).concat([item.mm_provider && Number.isFinite(Number(item.mm_rate_pln_day))
    ? { provider: item.mm_provider, totalPrice: Number(item.mm_rate_pln_day) * days, currency }
    : null]).filter(Boolean);
}

function blockRecommendation(item, status, reasons) {
  return {
    ...item,
    action: "hold",
    suggested_rate_pln_day: null,
    maximum_import_rate_pln_day: null,
    change_pln_day: 0,
    data_quality_status: status,
    dom_verification_status: status,
    dom_verification_reasons: reasons,
    reason: `Rekomendacja zablokowana przez kontrole DOM: ${reasons.join(", ") || status}.`
  };
}

async function verifyGroup(group, options) {
  const first = group[0];
  const startDate = String(first.start_date || first.pickup_date).slice(0, 10);
  const rentalDays = Number(first.rental_days) || 1;
  const locations = [...new Set(group.map((item) => item.location))];
  const scraper = new DiscoverCarsScraper({
    baseUrl: "https://www.discovercars.com",
    locations,
    pickupDate: startDate,
    pickupTime: "11:00",
    dropoffDate: addDays(startDate, rentalDays),
    dropoffTime: "11:00",
    residenceCountry: "Poland",
    currency: "PLN",
    driverAge: 30,
    timeoutMs: options.timeoutMs,
    headless: true,
    locationConcurrency: Math.min(3, locations.length),
    directCandidateLimit: 2,
    directOffersWaitMs: 1000,
    apiFirst: false,
    speedMode: options.speedMode,
    transmissionFilter: "automatic",
    maxProvidersPerLocation: 30,
    artifactsDir: path.join(options.workDir, `date-${startDate}-${rentalDays}d`)
  });
  const output = await scraper.run();
  const resultsByLocation = new Map();
  for (const result of output.results || []) {
    const key = String(result.location || "").toLowerCase();
    if (!resultsByLocation.has(key)) resultsByLocation.set(key, []);
    resultsByLocation.get(key).push(result);
  }
  for (const location of locations) {
    const exact = (output.offerViewsByLocation?.[location]?.automatic || []);
    if (exact.length) resultsByLocation.set(String(location).toLowerCase(), exact);
  }

  return group.map((item) => {
    const domOffers = resultsByLocation.get(String(item.location).toLowerCase()) || [];
    if (!domOffers.length) return blockRecommendation(item, "dom_recommendation_failed", ["no_dom_offers"]);
    const comparison = scraper.compareApiAndBrowserOutcomes(toLegacyOffers(item), domOffers);
    if (comparison.reasons.length) return blockRecommendation(item, "api_dom_conflict", comparison.reasons);
    return {
      ...item,
      source_validation_status: "dom_recommendation_verified",
      dom_verification_status: "confirmed",
      dom_verification_reasons: []
    };
  });
}

async function verifyActiveRecommendations(payload, options = {}) {
  const decisions = Array.isArray(payload?.decisions) ? payload.decisions : (payload?.recommendations || []);
  const active = decisions.filter((item) => item?.action !== "hold");
  const alreadyVerified = new Map();
  const pending = [];
  for (const item of active) {
    if (VERIFIED_SOURCE_STATUSES.has(item.source_validation_status)) {
      alreadyVerified.set(keyOf(item), { ...item, dom_verification_status: "confirmed_existing_dom" });
    } else {
      pending.push(item);
    }
  }

  const groups = new Map();
  for (const item of pending) {
    const groupKey = `${String(item.start_date || item.pickup_date).slice(0, 10)}|${Number(item.rental_days) || 1}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(item);
  }
  const groupItems = [...groups.values()];
  const verified = new Map(alreadyVerified);
  let next = 0;
  const workerCount = Math.max(1, Math.min(Number(options.concurrency) || 2, groupItems.length || 1));
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (next < groupItems.length) {
      const group = groupItems[next++];
      let output;
      try {
        output = await verifyGroup(group, options);
      } catch (error) {
        output = group.map((item) => blockRecommendation(item, "dom_recommendation_failed", [error.message || String(error)]));
      }
      for (const item of output) verified.set(keyOf(item), item);
    }
  }));

  const finalDecisions = decisions.map((item) => verified.get(keyOf(item)) || item);
  const recommendations = finalDecisions.filter((item) => item?.action !== "hold");
  return {
    ...payload,
    generated_at: new Date().toISOString(),
    decisions: finalDecisions,
    recommendations,
    recommendation_count: recommendations.length,
    dom_verification: {
      active_input_count: active.length,
      reused_existing_dom_count: alreadyVerified.size,
      live_dom_check_count: pending.length,
      confirmed_count: [...verified.values()].filter((item) => String(item.dom_verification_status).startsWith("confirmed")).length,
      blocked_count: [...verified.values()].filter((item) => item.action === "hold").length
    }
  };
}

async function runCli(argv) {
  const args = Object.fromEntries(argv.filter((arg) => arg.startsWith("--")).map((arg) => {
    const [key, ...rest] = arg.slice(2).split("=");
    return [key, rest.join("=")];
  }));
  if (!args.input || !args.output) throw new Error("Use --input=... --output=...");
  const payload = JSON.parse(fs.readFileSync(path.resolve(args.input), "utf8"));
  const output = await verifyActiveRecommendations(payload, {
    concurrency: Number(args.concurrency) || 2,
    timeoutMs: Number(args.timeout) || 45_000,
    speedMode: args["speed-mode"] || "fast",
    workDir: path.resolve(args["work-dir"] || "output/dom-recommendation-verification")
  });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(output.dom_verification)}\n`);
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = { verifyActiveRecommendations };
