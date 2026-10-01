const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { DiscoverCarsScraper, createSharedBrowserProvider } = require("./discovercars/scraper");

const MAX_VERIFICATION_AGE_MS = 2 * 60 * 60 * 1000;
const MAX_CURRENT_RUN_AGE_MS = 12 * 60 * 60 * 1000;
const CHECKPOINT_VERSION = 1;

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
  for (const file of ["verifyActiveRecommendationsDom.js", "discovercars/scraper.js", "discovercars/utils.js", "extractors.js", "locationRegistry.js"]) {
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

function isSourceVerified(item, sourceGeneratedAt, now = Date.now()) {
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

function writeCheckpoint(checkpointPath, checkpoint) {
  const content = { ...checkpoint, integrity_hash: checkpointDigest(checkpoint) };
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
}

function applyVerdict(item, verdict) {
  const output = verdict.status === "confirmed"
    ? { ...item, source_validation_status: "dom_recommendation_verified", dom_verification_status: "confirmed", dom_verification_reasons: [] }
    : blockRecommendation(item, verdict.status, verdict.reasons);
  return { ...output, dom_verified_at: verdict.verified_at };
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
    domOnly: true,
    browserProvider: options.browserProvider,
    requiredDomProvidersByLocation: Object.fromEntries(locations.map((location) => [location,
      [...new Set(group.filter((item) => item.location === location)
        .flatMap((item) => [item.top1_provider, item.top2_provider, item.top3_provider, item.mm_provider]).filter(Boolean))]
    ])),
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
    if (domOffers.some((offer) => offer.source !== "dom" || offer.transmission !== "automatic"
      || !offer.provider || !Number.isFinite(offer.totalPrice) || offer.totalPrice <= 0 || !offer.currency)) {
      return blockRecommendation(item, "dom_recommendation_failed", ["invalid_independent_dom_evidence"]);
    }
    const comparison = scraper.compareApiAndBrowserOutcomes(toLegacyOffers(item), domOffers);
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
  const pending = [];
  for (const [index, item] of decisions.entries()) {
    if (item?.action === "hold") continue;
    if (isSourceVerified(item, payload?.source_generated_at)) {
      const output = { ...item, dom_verification_status: "confirmed_existing_dom", dom_verification_reasons: [],
        dom_verified_at: item.dom_verified_at ?? item.source_generated_at ?? payload?.source_generated_at };
      alreadyVerified.set(index, output);
      verified.set(index, output);
    } else {
      const entry = checkpoint.entries[index];
      if (entry?.input_fingerprint === inputFingerprint(item) && isFreshVerification(entry.verified_at)
        && entry.status === "confirmed" && Array.isArray(entry.reasons) && entry.reasons.length === 0) {
        verified.set(index, applyVerdict(item, entry));
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
  const groupItems = [...groups.values()];
  let next = 0;
  let processedLiveGroupCount = 0;
  let budgetExhausted = false;
  const workerCount = Math.max(1, Math.min(Number(options.concurrency) || 2, groupItems.length || 1));
  const browserProvider = createSharedBrowserProvider();
  try {
    const workers = await Promise.allSettled(Array.from({ length: workerCount }, async () => {
      while (next < groupItems.length) {
        if (Date.now() >= verificationDeadline) {
          budgetExhausted = true;
          break;
        }
        const group = groupItems[next++];
        let output;
        try {
          output = await verifyGroup(group.map(({ item }) => item), { ...options, workDir, browserProvider });
        } catch (error) {
          output = group.map(({ item }) => blockRecommendation(item, "dom_recommendation_failed", [error.message || String(error)]));
        }
        processedLiveGroupCount += 1;
        let checkpointChanged = false;
        output.forEach((item, offset) => {
          const { index, item: input } = group[offset];
          const status = item.dom_verification_status;
          verified.set(index, item);
          // Only completed comparisons are resumable; scrape errors and budget blocks retry.
          if (status === "confirmed") {
            const verdict = {
              input_fingerprint: inputFingerprint(input), status,
              reasons: item.dom_verification_reasons || [],
              verified_at: item.dom_verified_at || new Date().toISOString()
            };
            checkpoint.entries[index] = verdict;
            verified.set(index, applyVerdict(input, verdict));
            checkpointChanged = true;
          }
        });
        if (checkpointChanged) writeCheckpoint(checkpointPath, checkpoint);
      }
    }));
    const failedWorker = workers.find((worker) => worker.status === "rejected");
    if (failedWorker) throw failedWorker.reason;
  } finally {
    await browserProvider.close();
  }

  let budgetExhaustedCount = 0;
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
    if (item.action !== "hold" && !isSourceVerified(item, payload?.source_generated_at)) {
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
      started_at: new Date(verificationStartedAt).toISOString(),
      completed_at: new Date().toISOString(),
      live_dom_check_count: pending.length,
      live_dom_group_count: groupItems.length,
      processed_live_dom_group_count: processedLiveGroupCount,
      skipped_live_dom_group_count: groupItems.length - processedLiveGroupCount,
      confirmed_count: [...verified.values()].filter((item) => String(item.dom_verification_status).startsWith("confirmed")).length,
      blocked_count: [...verified.values()].filter((item) => item.action === "hold").length,
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
  blockRecommendation,
  extractorCodeHash,
  inputFingerprint,
  isFreshVerification,
  isSourceVerified,
  keyOf,
  verifyActiveRecommendations
};
