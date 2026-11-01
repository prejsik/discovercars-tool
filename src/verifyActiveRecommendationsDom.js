const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DiscoverCarsScraper, createSharedBrowserProvider } = require("./discovercars/scraper");
const { buildPricingRecommendations, hasApiOnlyConstraintRepairMarker: hasPricingRepairMarker,
  isCanonicalApiOnlyConstraintRepairPending, isMmCarsProvider, priceTop1Target, isRecommendedDateInScope } = require("./pricingRecommendations");
const { resolveBrokerMarkupCalibration } = require('./brokerMarkupCalibration');

const MAX_VERIFICATION_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CURRENT_RUN_AGE_MS = 12 * 60 * 60 * 1000;
const CHECKPOINT_VERSION = 1;
const MAX_GROUP_TIMINGS = 5000;

function groupTimingMetadata(groupTimings, extractorHash, truncatedCount = 0) {
  const timings = [...groupTimings].sort((left, right) => left.group_key.localeCompare(right.group_key));
  const retained = timings.slice(0, MAX_GROUP_TIMINGS);
  return {
    group_timing_version: 1,
    group_timings: retained,
    group_timings_hash: inputFingerprint({ version: 1, extractor_hash: extractorHash, group_timings: retained }),
    group_timing_truncated_count: truncatedCount + Math.max(0, timings.length - retained.length)
  };
}

function readGroupTimings(summary, extractorHash = extractorCodeHash()) {
  const timings = summary?.group_timings;
  if (summary?.group_timing_version !== 1 || summary.extractor_hash !== extractorHash
    || !Array.isArray(timings) || timings.length > MAX_GROUP_TIMINGS
    || summary.group_timings_hash !== inputFingerprint({ version: 1, extractor_hash: extractorHash, group_timings: timings })) return null;
  const keys = new Set();
  for (const timing of timings) {
    if (!timing || typeof timing.group_key !== "string" || !/^\d{4}-\d{2}-\d{2}\|\d+$/.test(timing.group_key)
      || !Number.isSafeInteger(timing.location_count) || timing.location_count < 1
      || !Number.isSafeInteger(timing.elapsed_ms) || timing.elapsed_ms < 1 || timing.elapsed_ms > MAX_CURRENT_RUN_AGE_MS
      || keys.has(timing.group_key)) return null;
    keys.add(timing.group_key);
  }
  return timings;
}

const VERIFIED_SOURCE_STATUSES = new Set([
  "dom_confirmed",
  "api_dom_conflict_dom_used",
  "dom_fallback",
  "dom_only",
  "dom_recommendation_verified"
]);

function inputFingerprint(input) {
  return crypto.createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function extractorCodeHash() {
  const hash = crypto.createHash("sha256");
  for (const file of ["verifyActiveRecommendationsDom.js", "discovercars/scraper.js", "discovercars/utils.js", "extractors.js", "locationRegistry.js",
    "pricingRecommendations.js", "pricingRules.js", "brokerMarkupCalibration.js", "top1RateSignals.js", "currentBrokerMarkup.js"]) {
    hash.update(file).update(fs.readFileSync(path.join(__dirname, file)));
  }
  return hash.digest("hex");
}

function isFreshVerification(timestamp, now = Date.now(), maximumAgeMs = MAX_VERIFICATION_AGE_MS) {
  const completedAt = Date.parse(timestamp);
  return Number.isFinite(completedAt) && completedAt <= now && now - completedAt <= maximumAgeMs;
}

function groupKeyOf(item) {
  return `${String(item.start_date || item.pickup_date).slice(0, 10)}|${Number(item.rental_days) || 1}`;
}

function isSourceVerified(item, sourceGeneratedAt, now = Date.now(), pricingOptions) {
  if (item?.requires_popularity_verification
    || (item?.recommendation_type === 'minimum_fallback' && !item.dom_repricing)) return false;
  if (pricingOptions !== undefined || item?.dom_repricing) {
    const record = item?.dom_repricing;
    const rebuilt = record?.input && rebuildDomRecommendation(record.input, record, pricingOptions);
    if (!rebuilt || inputFingerprint({ ...item, dom_verification_status: "confirmed" }) !== inputFingerprint(rebuilt)) return false;
  }
  const status = String(item?.dom_verification_status || "");
  const verifiedAt = item?.dom_verified_at ?? item?.source_generated_at ?? sourceGeneratedAt;
  const explicitVerdict = Boolean(status) || item?.source_validation_status === "dom_recommendation_verified";
  return VERIFIED_SOURCE_STATUSES.has(item?.source_validation_status)
    && (!status || status === "confirmed" || status === "confirmed_existing_dom")
    && (item?.dom_verification_reasons === undefined
      || (Array.isArray(item.dom_verification_reasons) && item.dom_verification_reasons.length === 0))
    && (!explicitVerdict || (Array.isArray(item?.dom_verification_reasons)
      && isFreshVerification(item?.dom_verified_at, now, MAX_CURRENT_RUN_AGE_MS)))
    && isFreshVerification(verifiedAt, now, MAX_CURRENT_RUN_AGE_MS);
}

function repricingInput(item) {
  const { dom_repricing, ...input } = item;
  return input;
}

function checkpointDigest(checkpoint) {
  const { integrity_hash, ...content } = checkpoint;
  return inputFingerprint(content);
}

function loadCheckpoint(checkpointPath, fingerprint, extractorHash) {
  const empty = { version: CHECKPOINT_VERSION, input_fingerprint: fingerprint, extractor_hash: extractorHash, entries: {} };
  try {
    const checkpoint = JSON.parse(fs.readFileSync(checkpointPath, "utf8"));
    if (checkpoint.version !== CHECKPOINT_VERSION || checkpoint.input_fingerprint !== fingerprint
      || checkpoint.extractor_hash !== extractorHash || !checkpoint.entries || Array.isArray(checkpoint.entries)
      || typeof checkpoint.entries !== "object" || checkpoint.integrity_hash !== checkpointDigest(checkpoint)) return empty;
    return checkpoint;
  } catch { return empty; }
}

function createRepairAttemptProof(checkpoint, fingerprint, extractorHash, index, item) {
  if (!checkpoint || checkpoint.version !== CHECKPOINT_VERSION || checkpoint.input_fingerprint !== fingerprint
    || checkpoint.extractor_hash !== extractorHash || checkpoint.integrity_hash !== checkpointDigest(checkpoint)
    || !Number.isSafeInteger(index) || index < 0) return null;
  const entry = checkpoint.entries[index];
  if (!entry || entry.input_fingerprint !== inputFingerprint(item) || entry.repair_attempted !== true
    || !["repair_attempted", "repair_failed", "confirmed"].includes(entry.status)
    || typeof entry.attempted_at !== "string" || !Number.isFinite(Date.parse(entry.attempted_at))) return null;
  return {
    version: 1,
    checkpoint_version: CHECKPOINT_VERSION,
    checkpoint_input_fingerprint: fingerprint,
    checkpoint_extractor_hash: extractorHash,
    checkpoint_integrity_hash: checkpoint.integrity_hash,
    decision_index: index,
    item_input_fingerprint: entry.input_fingerprint,
    source_run_id: item.source_run_id,
    attempted_at: entry.attempted_at,
    checkpoint_status: entry.status
  };
}

function writeCheckpoint(checkpointPath, checkpoint) {
  const integrityHash = checkpointDigest(checkpoint);
  const content = { ...checkpoint, integrity_hash: integrityHash };
  fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
  const temporary = `${checkpointPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, "wx");
    try {
      fs.writeFileSync(fd, `${JSON.stringify(content, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, checkpointPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return integrityHash;
}

function applyVerdict(item, verdict, pricingOptions) {
  if (verdict.repricing) {
    const rebuilt = rebuildDomRecommendation(item, verdict.repricing, pricingOptions);
    if (!rebuilt) return blockRecommendation(item, "dom_recommendation_failed", ["invalid_dom_repricing_evidence"]);
    return rebuilt;
  }
  const output = verdict.status === "confirmed"
    ? { ...item, source_validation_status: "dom_recommendation_verified", dom_verification_status: "confirmed", dom_verification_reasons: [] }
    : blockRecommendation(item, verdict.status, verdict.reasons);
  return { ...output, dom_verified_at: verdict.verified_at };
}

// Rebuild with the same policy, never by editing a stale target or learning a new markup.
function rebuildDomRecommendation(item, record, pricingOptions) {
  const repairInput = hasApiOnlyConstraintRepairMarker(item);
  const canonicalRepair = repairInput && isCanonicalApiOnlyConstraintRepair(item, pricingOptions);
  if (repairInput && !canonicalRepair) return null;
  const rebuildOptions = canonicalRepair
    ? { ...pricingOptions, apiOnlyConstraintRentalDays: [] }
    : pricingOptions;
  if (!pricingOptions || pricingOptions.brokerMarkupCalibration?.manualOnly !== true
    || record?.version !== 1 || record.input_fingerprint !== inputFingerprint(repricingInput(item))
    || !record.input || record.input_fingerprint !== inputFingerprint(record.input)
    || record.policy_fingerprint !== inputFingerprint(pricingOptions)
    || !isFreshVerification(record.verified_at, Date.now(), MAX_CURRENT_RUN_AGE_MS)
    || !Array.isArray(record.offers) || !record.offers.length) return null;
  const evidence = record.evidence;
  if (evidence?.automatic_filter_confirmed !== true || evidence.price_sort_confirmed !== true
    || evidence.ranking_complete !== true) return null;
  const offers = record.offers;
  if (offers.some((offer) => !offer || typeof offer !== "object" || offer.source !== "dom" || offer.transmission !== "automatic"
    || typeof offer.provider !== "string" || !offer.provider.trim()
    || offer.location !== item.location || offer.currency !== "PLN"
    || !Number.isFinite(offer.totalPrice) || offer.totalPrice <= 0)) return null;
  const byProvider = new Map();
  for (const offer of offers) {
    const key = offer.provider.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!byProvider.has(key) || offer.totalPrice < byProvider.get(key).totalPrice) byProvider.set(key, offer);
  }
  const sorted = [...byProvider.values()].sort((left, right) => left.totalPrice - right.totalPrice);
  const completeSmallMarket = evidence.listing_complete === true
    && Number.isSafeInteger(evidence.expected_offer_count) && evidence.expected_offer_count > 0
    && evidence.observed_offer_count === evidence.expected_offer_count;
  const completePriceTop1 = pricingOptions.recommendedFallbackToMinimum === true
    && evidence.ranking_goal === 'price_top1'
    && sorted.some(offer => isMmCarsProvider(offer.provider))
    && sorted.some(offer => !isMmCarsProvider(offer.provider));
  if (sorted.length < 3 && ((!completeSmallMarket && !completePriceTop1) || sorted.length < 2)) return null;
  const days = Number(item.rental_days);
  if (!Number.isSafeInteger(days) || days < 1 || days > 14) return null;
  const formatted = sorted.map((offer) => ({ provider_name: offer.provider, total_price: offer.totalPrice,
    rental_days: days, currency: "PLN", transmission: "automatic", source: "dom" }));
  const view = { top_3: formatted.slice(0, 3), mm_cars_rental: formatted.find((offer) => isMmCarsProvider(offer.provider_name)) || null };
  const scenario = { scenario_id: item.scenario_id, start_date: item.start_date,
    pickup_date: item.pickup_date, dropoff_date: item.dropoff_date, rental_days: days,
    ...(item.group === undefined ? {} : { group: item.group }),
    generated_at: record.verified_at, source_run_id: item.source_run_id,
    top_3_plus_mm_by_location: { [item.location]: view },
    offer_views_by_location: { [item.location]: { automatic: view } },
    recommended_ranking_by_location: { [item.location]: record.recommended_ranking },
    source_validation_by_location: { [item.location]: { status: "dom_recommendation_verified", reasons: [] } } };
  let decision;
  try {
    decision = buildPricingRecommendations({ generated_at: record.verified_at, run_id: item.source_run_id,
      locations: [item.location], scenarios: [scenario] }, rebuildOptions).decisions[0];
  } catch { return null; }
  if (!decision || decision.requires_popularity_verification || decision.data_quality_status === 'popularity_unavailable'
    || (sorted.length < 3 && decision.action !== "hold" && decision.target_rank !== 1
      && decision.recommendation_type !== 'minimum_fallback')) return null;
  const rebuilt = { ...item, benchmark_provider: null, benchmark_rate_pln_day: null, target_rank: null,
    recommendation_type: null, site_target_rate_pln_day: null, predicted_site_rate_pln_day: null,
    requires_popularity_verification: false,
    ...decision, dom_verification_status: "confirmed", dom_verification_reasons: [],
    dom_verified_at: record.verified_at, dom_repricing: record };
  if (!canonicalRepair) return rebuilt;

  delete rebuilt.requires_dom_constraint_repair;
  delete rebuilt.verification_scope;
  delete rebuilt.api_recommendation_type;
  delete rebuilt.api_requires_popularity_verification;
  rebuilt.api_constraint_repair = {
    ...item.api_constraint_repair,
    status: "confirmed",
    source_validation_status: item.source_validation_status,
    source_run_id: item.source_run_id,
    original_recommendation_type: item.api_recommendation_type,
    verified_at: record.verified_at,
    input_fingerprint: record.input_fingerprint
  };
  return rebuilt;
}

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
    return provider && Number.isFinite(rate) && rate > 0 ? { provider, totalPrice: rate * days, currency, transmission: "automatic" } : null;
  }).concat([item.mm_provider && Number.isFinite(Number(item.mm_rate_pln_day))
    ? { provider: item.mm_provider, totalPrice: Number(item.mm_rate_pln_day) * days, currency, transmission: "automatic" }
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

function hasApiOnlyConstraintRepairMarker(item) {
  return hasPricingRepairMarker(item);
}

function isCanonicalApiOnlyConstraintRepair(item, pricingOptions, now = Date.now()) {
  return isCanonicalApiOnlyConstraintRepairPending(item, pricingOptions, now);
}

function finishApiOnlyConstraintRepair(item, { attempted = false, attemptedAt = null, attemptProof = null, reason }) {
  const status = attempted ? "api_constraint_repair_failed" : "api_constraint_repair_unavailable";
  const repairReason = String(reason || status).slice(0, 500);
  const portableProof = attemptProof ? {
    version: attemptProof.version,
    checkpoint_version: attemptProof.checkpoint_version,
    checkpoint_input_fingerprint: attemptProof.checkpoint_input_fingerprint,
    checkpoint_extractor_hash: attemptProof.checkpoint_extractor_hash,
    checkpoint_integrity_hash: attemptProof.checkpoint_integrity_hash,
    decision_index: attemptProof.decision_index,
    item_input_fingerprint: attemptProof.item_input_fingerprint,
    source_run_id: attemptProof.source_run_id,
    attempted_at: attemptProof.attempted_at,
    checkpoint_status: attemptProof.checkpoint_status
  } : null;
  const blocked = blockRecommendation(item, status, [repairReason]);
  const output = {
    ...blocked,
    recommendation_type: status,
    data_quality_status: status,
    requires_popularity_verification: false,
    api_constraint_repair: {
      ...(item.api_constraint_repair || {}),
      status: attempted ? "failed" : "unavailable",
      attempted,
      ...(attemptedAt ? { attempted_at: attemptedAt } : {}),
      ...(portableProof ? { attempt_proof: portableProof } : {}),
      reason: repairReason
    },
    suggested_rate_pln_day: null,
    maximum_import_rate_pln_day: null,
    site_target_rate_pln_day: null,
    site_cap_rate_pln_day: null,
    predicted_site_rate_pln_day: null,
    change_pln_day: 0
  };
  delete output.requires_dom_constraint_repair;
  delete output.verification_scope;
  delete output.api_recommendation_type;
  delete output.api_requires_popularity_verification;
  return output;
}

async function verifyGroup(group, options) {
  const first = group[0];
  const startDate = String(first.start_date || first.pickup_date).slice(0, 10);
  const rentalDays = Number(first.rental_days) || 1;
  const locations = [...new Set(group.map((item) => item.location))];
  const priceTop1Only = options.pricingOptions?.recommendedFallbackToMinimum === true;
  const recommendedInScope = priceTop1Only && isRecommendedDateInScope(startDate, options.pricingOptions);
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
    domOnly: true,
    browserProvider: options.browserProvider,
    domRankingGoal: priceTop1Only ? 'price_top1' : undefined,
    requiredDomProvidersByLocation: Object.fromEntries(locations.map((location) => [location,
      priceTop1Only ? [] : [...new Set(group.filter((item) => item.location === location)
        .flatMap((item) => [item.top1_provider, item.top2_provider, item.top3_provider, item.mm_provider]).filter(Boolean))]
    ])),
    speedMode: options.speedMode,
    transmissionFilter: "automatic",
    recommendedRankingLocations: recommendedInScope ? locations : [],
    recommendedRankingNeeded: (location, offers) => {
      const items = group.filter(item => item.location === location);
      const policy = options.pricingOptions;
      if (!recommendedInScope || !items.length) return false;
      // Dated priority rules can carry their own floor/reserve; never skip their observation.
      if (policy.priorityTop1Rules?.length) return true;
      const automatic = offers.filter(offer => offer.currency === 'PLN' && offer.transmission === 'automatic');
      if (!automatic.some(offer => isMmCarsProvider(offer.provider))) return false;
      const competitor = automatic.filter(offer => !isMmCarsProvider(offer.provider))
        .sort((a, b) => a.totalPrice - b.totalPrice)[0];
      if (!competitor) return false;
      const reserve = Math.max(0, ...Object.values(policy.excelPolicy?.group_price_parity?.premium_adjustments_pln_day || {}));
      return items.some(item => priceTop1Target({ total_price: competitor.totalPrice, rental_days: rentalDays },
        Number(item.mandatory_minimum_rate_pln_day || 0) + reserve,
        resolveBrokerMarkupCalibration(item, policy.brokerMarkupCalibration), policy) == null);
    },
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
    if (domOffers.some((offer) => offer.source !== "dom" || offer.transmission !== "automatic"
      || !offer.provider || !Number.isFinite(offer.totalPrice) || offer.totalPrice <= 0 || !offer.currency)) {
      return blockRecommendation(item, "dom_recommendation_failed", ["invalid_independent_dom_evidence"]);
    }
    const comparison = scraper.compareApiAndBrowserOutcomes(toLegacyOffers(item), domOffers);
    const evidence = output.domEvidenceByLocation?.[item.location];
    const input = repricingInput(item);
    const record = { version: 1, input, input_fingerprint: inputFingerprint(input),
      policy_fingerprint: inputFingerprint(options.pricingOptions || null), verified_at: new Date().toISOString(),
      offers: domOffers, evidence, previous_comparison_reasons: comparison.reasons };
    if (options.pricingOptions?.recommendedFallbackToMinimum) {
      record.recommended_ranking = output.recommendedRankingByLocation?.[item.location] || { status: 'failed', reason: 'missing_recommended_observation' };
    }
    const rebuilt = rebuildDomRecommendation(item, record, options.pricingOptions);
    if (rebuilt) return rebuilt;
    if (options.pricingOptions !== undefined) {
      return blockRecommendation(item, "dom_recommendation_failed", ["incomplete_independent_dom_ranking"]);
    }
    if (evidence && (evidence.automatic_filter_confirmed !== true || evidence.price_sort_confirmed !== true
      || evidence.ranking_complete !== true)) {
      return blockRecommendation(item, "dom_recommendation_failed", ["incomplete_independent_dom_ranking"]);
    }
    if (comparison.confirmed !== true || comparison.reasons.length) {
      return blockRecommendation(item, "api_dom_conflict", comparison.reasons.length ? comparison.reasons : ["dom_comparison_unconfirmed"]);
    }
    return applyVerdict(item, { status: "confirmed", verified_at: new Date().toISOString() });
  });
}

async function verifyActiveRecommendations(payload, options = {}) {
  const verificationStartedAt = Date.now();
  const configuredMaxDuration = Number(options.maxDurationMs);
  const maxDurationMs = options.maxDurationMs === undefined || !Number.isFinite(configuredMaxDuration)
    ? Number.POSITIVE_INFINITY
    : Math.max(0, configuredMaxDuration);
  const verificationDeadline = verificationStartedAt + maxDurationMs;
  const workDir = path.resolve(options.workDir || "output/dom-recommendation-verification");
  const checkpointPath = path.resolve(options.checkpointPath || path.join(workDir, "checkpoint.json"));
  const fingerprint = inputFingerprint(payload);
  const extractorHash = extractorCodeHash();
  const checkpoint = loadCheckpoint(checkpointPath, fingerprint, extractorHash);
  const decisions = Array.isArray(payload?.decisions) ? payload.decisions : (payload?.recommendations || []);
  const active = decisions.filter((item) => item?.action !== "hold");
  const alreadyVerified = new Map();
  const verified = new Map();
  const checkpointReused = new Set();
  const repairAttemptProofs = new Map();
  const pending = [];
  for (const [index, item] of decisions.entries()) {
    if (item?.action === "hold") continue;
    const entry = checkpoint.entries[index];
    const entryMatches = entry?.input_fingerprint === inputFingerprint(item);
    const repairMarked = hasApiOnlyConstraintRepairMarker(item);
    const canonicalRepair = repairMarked && isCanonicalApiOnlyConstraintRepair(item, payload.options);
    if (repairMarked && !canonicalRepair) {
      const attempted = entryMatches && entry.repair_attempted === true;
      verified.set(index, finishApiOnlyConstraintRepair(item, {
        attempted,
        attemptedAt: attempted ? entry.attempted_at : null,
        reason: "repair_source_or_policy_no_longer_eligible"
      }));
      continue;
    }
    if (isSourceVerified(item, payload?.source_generated_at, Date.now(), payload.options)) {
      const output = { ...item, dom_verification_status: "confirmed_existing_dom", dom_verification_reasons: [],
        dom_verified_at: item.dom_verified_at ?? item.source_generated_at ?? payload?.source_generated_at };
      alreadyVerified.set(index, output);
      verified.set(index, output);
    } else {
      if (canonicalRepair && entryMatches && entry.repair_attempted === true) {
        const attemptProof = createRepairAttemptProof(checkpoint, fingerprint, extractorHash, index, item);
        if (entry.status === "confirmed" && isFreshVerification(entry.verified_at)
          && Array.isArray(entry.reasons) && entry.reasons.length === 0) {
          const restored = applyVerdict(item, entry, payload.options);
          if (restored.dom_verification_status === "confirmed" && restored.dom_repricing
            && isSourceVerified(restored, payload?.source_generated_at, Date.now(), payload.options)) {
            verified.set(index, restored);
            checkpointReused.add(index);
            continue;
          }
        }
        verified.set(index, finishApiOnlyConstraintRepair(item, {
          attempted: true,
          attemptedAt: attemptProof?.attempted_at || entry.attempted_at || entry.verified_at || null,
          attemptProof,
          reason: "repair_attempt_already_consumed"
        }));
        continue;
      }
      if (entryMatches && isFreshVerification(entry.verified_at)
        && entry.status === "confirmed" && Array.isArray(entry.reasons) && entry.reasons.length === 0) {
        const restored = applyVerdict(item, entry, payload.options);
        if (restored.dom_verification_status !== "confirmed") {
          delete checkpoint.entries[index];
          pending.push({ item, index });
          continue;
        }
        verified.set(index, restored);
        checkpointReused.add(index);
      } else {
        delete checkpoint.entries[index];
        pending.push({ item, index });
      }
    }
  }

  const groups = new Map();
  for (const entry of pending) {
    const { item } = entry;
    const groupKey = groupKeyOf(item);
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(entry);
  }
  const groupItems = [...groups.values()].sort((left, right) =>
    groupKeyOf(right[0].item).slice(0, 10).localeCompare(groupKeyOf(left[0].item).slice(0, 10))
    || Number(left[0].item.rental_days) - Number(right[0].item.rental_days));
  let next = 0;
  let processedLiveGroupCount = 0;
  const groupTimings = [];
  let truncatedTimingCount = 0;
  let budgetExhausted = false;
  let preCallBudgetBlockedCount = 0;
  const workerCount = Math.max(1, Math.min(Number(options.concurrency) || 2, groupItems.length || 1));
  const browserProvider = createSharedBrowserProvider();
  try {
    const workers = await Promise.allSettled(Array.from({ length: workerCount }, async () => {
      while (next < groupItems.length) {
        if (Date.now() >= verificationDeadline) {
          budgetExhausted = true;
          break;
        }
        const groupIndex = next++;
        const group = groupItems[groupIndex];
        const liveGroup = [];
        for (const entry of group) {
          if (hasApiOnlyConstraintRepairMarker(entry.item)
            && !isCanonicalApiOnlyConstraintRepair(entry.item, payload.options, Date.now())) {
            const saved = checkpoint.entries[entry.index];
            const attempted = saved?.input_fingerprint === inputFingerprint(entry.item) && saved.repair_attempted === true;
            verified.set(entry.index, finishApiOnlyConstraintRepair(entry.item, {
              attempted,
              attemptedAt: attempted ? saved.attempted_at : null,
              reason: "repair_source_or_policy_expired_before_execution"
            }));
          } else {
            liveGroup.push(entry);
          }
        }
        if (!liveGroup.length) continue;
        if (Date.now() >= verificationDeadline) {
          budgetExhausted = true;
          for (const { item, index } of liveGroup) {
            verified.set(index, blockRecommendation(item, "dom_verification_budget_exhausted", ["time_budget_exhausted"]));
            preCallBudgetBlockedCount += 1;
          }
          continue;
        }
        const groupStartedAt = Date.now();
        const repairAttemptAt = new Date(groupStartedAt).toISOString();
        const repairAttempts = new Set(liveGroup
          .filter(({ item }) => isCanonicalApiOnlyConstraintRepair(item, payload.options, groupStartedAt))
          .map(({ index }) => index));
        if (repairAttempts.size) {
          for (const { item, index } of liveGroup) {
            if (!repairAttempts.has(index)) continue;
            checkpoint.entries[index] = {
              input_fingerprint: inputFingerprint(item),
              status: "repair_attempted",
              repair_attempted: true,
              attempted_at: repairAttemptAt
            };
          }
          checkpoint.integrity_hash = writeCheckpoint(checkpointPath, checkpoint);
          for (const { item, index } of liveGroup) {
            if (!repairAttempts.has(index)) continue;
            repairAttemptProofs.set(index, createRepairAttemptProof(checkpoint, fingerprint, extractorHash, index, item));
          }
        }
        let output;
        try {
          output = await verifyGroup(liveGroup.map(({ item }) => item), { ...options, workDir, browserProvider, pricingOptions: payload.options });
        } catch (error) {
          output = liveGroup.map(({ item }) => blockRecommendation(item, "dom_recommendation_failed", [error.message || String(error)]));
        }
        let checkpointChanged = false;
        output.forEach((item, offset) => {
          const { index, item: input } = liveGroup[offset];
          if (!repairAttempts.has(index)) return;
          const status = item.dom_verification_status;
          if (status === "confirmed" && item.dom_repricing
            && isSourceVerified(item, payload?.source_generated_at, Date.now(), payload.options)) return;
          const reason = (item.dom_verification_reasons || []).join(", ") || "dom_repair_not_confirmed";
          output[offset] = finishApiOnlyConstraintRepair(input, {
            attempted: true,
            attemptedAt: repairAttemptAt,
            attemptProof: repairAttemptProofs.get(index),
            reason
          });
        });
        if (groupIndex < MAX_GROUP_TIMINGS) {
          groupTimings.push({ group_key: groupKeyOf(liveGroup[0].item),
            location_count: new Set(liveGroup.map(({ item }) => item.location)).size,
            elapsed_ms: Math.max(1, Date.now() - groupStartedAt) });
        } else truncatedTimingCount += 1;
        processedLiveGroupCount += 1;
        output.forEach((item, offset) => {
          const { index, item: input } = liveGroup[offset];
          const status = item.dom_verification_status;
          verified.set(index, item);
          if (repairAttempts.has(index) && status !== "confirmed") {
            checkpoint.entries[index] = {
              input_fingerprint: inputFingerprint(input),
              status: "repair_failed",
              repair_attempted: true,
              attempted_at: repairAttemptAt,
              verified_at: new Date().toISOString(),
              reasons: item.dom_verification_reasons || []
            };
            checkpointChanged = true;
            return;
          }
          if (status === "confirmed") {
            const verdict = {
              input_fingerprint: inputFingerprint(input), status,
              reasons: item.dom_verification_reasons || [],
              verified_at: item.dom_verified_at || new Date().toISOString(),
              ...(repairAttempts.has(index) ? { repair_attempted: true, attempted_at: repairAttemptAt } : {}),
              ...(item.dom_repricing ? { repricing: item.dom_repricing } : {})
            };
            checkpoint.entries[index] = verdict;
            const restored = applyVerdict(input, verdict, payload.options);
            if (repairAttempts.has(index) && (restored.dom_verification_status !== "confirmed"
              || !restored.dom_repricing
              || !isSourceVerified(restored, payload?.source_generated_at, Date.now(), payload.options))) {
              const reason = (restored.dom_verification_reasons || []).join(", ") || "invalid_rebuilt_repair";
              verified.set(index, finishApiOnlyConstraintRepair(input, {
                attempted: true,
                attemptedAt: repairAttemptAt,
                attemptProof: repairAttemptProofs.get(index),
                reason
              }));
              checkpoint.entries[index] = {
                input_fingerprint: inputFingerprint(input),
                status: "repair_failed",
                repair_attempted: true,
                attempted_at: repairAttemptAt,
                verified_at: new Date().toISOString(),
                reasons: [reason]
              };
            } else {
              verified.set(index, restored);
            }
            checkpointChanged = true;
          }
        });
        if (checkpointChanged) checkpoint.integrity_hash = writeCheckpoint(checkpointPath, checkpoint);
      }
    }));
    const failedWorker = workers.find((worker) => worker.status === "rejected");
    if (failedWorker) throw failedWorker.reason;
  } finally {
    await browserProvider.close();
  }

  let budgetExhaustedCount = preCallBudgetBlockedCount;
  for (const group of groupItems.slice(next)) {
    for (const { item, index } of group) {
      verified.set(
        index,
        blockRecommendation(item, "dom_verification_budget_exhausted", ["time_budget_exhausted"])
      );
      budgetExhaustedCount += 1;
    }
  }

  let checkpointExpiredCount = 0;
  for (const [index, item] of verified) {
    if (item.action !== "hold" && !isSourceVerified(item, payload?.source_generated_at, Date.now(), payload.options)) {
      verified.set(index, blockRecommendation(decisions[index], "dom_recommendation_failed", ["dom_verification_expired"]));
      alreadyVerified.delete(index);
      checkpointReused.delete(index);
      checkpointExpiredCount += 1;
    }
  }
  const finalDecisions = decisions.map((item, index) => verified.get(index) || item);
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
      reused_checkpoint_count: checkpointReused.size,
      reused_checkpoint_group_count: new Set([...checkpointReused].map((index) => groupKeyOf(decisions[index])).filter((key) => !groups.has(key))).size,
      checkpoint_expired_count: checkpointExpiredCount,
      checkpoint_path: checkpointPath,
      input_fingerprint: fingerprint,
      extractor_hash: extractorHash,
      ...groupTimingMetadata(groupTimings, extractorHash, truncatedTimingCount),
      started_at: new Date(verificationStartedAt).toISOString(),
      completed_at: new Date().toISOString(),
      live_dom_check_count: pending.length,
      live_dom_group_count: groupItems.length,
      processed_live_dom_group_count: processedLiveGroupCount,
      skipped_live_dom_group_count: groupItems.length - processedLiveGroupCount,
      confirmed_count: [...verified.values()].filter((item) => item.action !== "hold" && String(item.dom_verification_status).startsWith("confirmed")).length,
      blocked_count: [...verified.values()].filter((item) => item.action === "hold").length,
      recalculated_count: [...verified.values()].filter((item) => item.dom_repricing).length,
      policy_hold_count: [...verified.values()].filter((item) => item.dom_repricing && item.action === "hold").length,
      budget_exhausted: budgetExhausted,
      budget_exhausted_count: budgetExhaustedCount,
      max_duration_ms: Number.isFinite(maxDurationMs) ? maxDurationMs : null,
      elapsed_ms: Date.now() - verificationStartedAt
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
    maxDurationMs: args["max-duration-ms"] === undefined ? undefined : Number(args["max-duration-ms"]),
    speedMode: args["speed-mode"] || "fast",
    checkpointPath: args.checkpoint ? path.resolve(args.checkpoint) : undefined,
    workDir: path.resolve(args["work-dir"] || "output/dom-recommendation-verification")
  });
  fs.mkdirSync(path.dirname(path.resolve(args.output)), { recursive: true });
  fs.writeFileSync(path.resolve(args.output), `${JSON.stringify(output, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(output.dom_verification)}\n`);
}

if (require.main === module) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  VERIFIED_SOURCE_STATUSES,
  MAX_VERIFICATION_AGE_MS,
  MAX_CURRENT_RUN_AGE_MS,
  MAX_GROUP_TIMINGS,
  finishApiOnlyConstraintRepair,
  createRepairAttemptProof,
  hasApiOnlyConstraintRepairMarker,
  isCanonicalApiOnlyConstraintRepair,
  blockRecommendation,
  rebuildDomRecommendation,
  extractorCodeHash,
  inputFingerprint,
  groupTimingMetadata,
  readGroupTimings,
  isFreshVerification,
  isSourceVerified,
  keyOf,
  verifyActiveRecommendations
};
