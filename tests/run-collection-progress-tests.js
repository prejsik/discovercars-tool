const FIXTURE_ARG = "--offline-collection-case=";
const fixtureMode = process.argv.find((arg) => arg.startsWith(FIXTURE_ARG))?.slice(FIXTURE_ARG.length);
if (fixtureMode) process.stderr.write("[offline-fixture] ready\n");

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const CLI_PATH = path.resolve(__dirname, "../src/index.js");

// Preload in the real CLI child. Keep run(), scenario scheduling, persistence,
// logging and the watchdog real; replace only each location's external I/O.
if (fixtureMode) {
  const { DiscoverCarsScraper } = require("../src/discovercars/scraper");
  const delayMs = Number(process.argv.find((arg) => arg.startsWith("--offline-location-delay="))?.split("=")[1] || 700);
  const retryFixture = fixtureMode === "retry-partial-retention";
  const attemptPath = path.resolve("offline-attempt.json");
  const attempt = retryFixture && fs.existsSync(attemptPath)
    ? JSON.parse(fs.readFileSync(attemptPath, "utf8")).attempt + 1
    : 1;
  if (retryFixture) fs.writeFileSync(attemptPath, JSON.stringify({ attempt }));
  let firstPeriod = null;
  DiscoverCarsScraper.prototype.runSingleLocation = async function runOfflineLocation(location) {
    const period = `${this.config.pickupDate}|${this.config.dropoffDate}`;
    const rentalDays = (Date.parse(this.config.dropoffDate) - Date.parse(this.config.pickupDate)) / 86400000;
    if (firstPeriod === null) firstPeriod = period;
    fs.appendFileSync(path.resolve("location-starts.jsonl"), `${JSON.stringify({ location, period, attempt, rentalDays })}\n`);
    if (fixtureMode === "fatal-mixed" && period !== firstPeriod) {
      throw new Error("Offline fatal scenario before remaining locations execute");
    }
    if (fixtureMode === "hang" || (fixtureMode === "hang-after-partial" && period !== firstPeriod)
      || (retryFixture && ((attempt === 1 && rentalDays === 4)
        || (attempt > 1 && rentalDays === 3 && this.config.locations.indexOf(location) >= 11)))) {
      // An unresolved promise alone would let Node exit instead of simulating I/O.
      setInterval(() => {}, 1000);
      setTimeout(() => process.exit(99), 20000);
      return await new Promise(() => {});
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    fs.appendFileSync(path.resolve("location-outcomes.jsonl"), `${JSON.stringify({ location, pickup: this.config.pickupDate, dropoff: this.config.dropoffDate, attempt, rentalDays })}\n`);
    if (location === "Gdansk Downtown" && fixtureMode !== "fatal-mixed") {
      return { ok: false, error: new Error("No automatic offers; offline GD1 weekend fixture") };
    }
    const offers = [100, 110, 120].map((price, index) => ({
      location,
      provider: `Offline provider ${index + 1}`,
      providerRating: 8.5,
      totalPrice: price + (retryFixture ? (attempt - 1) * 100 : 0),
      currency: "PLN",
      carName: "Offline automatic car",
      transmission: "automatic",
      source: "dom",
      sourceUrl: "https://example.invalid/offline"
    }));
    return {
      ok: true,
      cheapest: offers[0],
      results: offers,
      offerViews: this.buildOfferViews(offers, location),
      sourceValidation: { status: "dom_only", reasons: [] }
    };
  };
} else {
  const { runCommand } = require("../src/runDiscovercarsChunked");
  const { getDailyLocations } = require("../src/locationRegistry");
  const { createCheckpointController } = require("../src/index");
  const {
    isChunkPayloadAttempted,
    isChunkPayloadComplete,
    isScenarioCheckpointComplete
  } = require("../src/executionPolicy");
  const locations = getDailyLocations();
  const STALL_MS = 10000;
  const testFilter = process.argv.find((arg) => arg.startsWith("--test-filter="))?.slice("--test-filter=".length);

  function cliArgs(dir, mode, extraArgs = []) {
    return [
      "--require", __filename, CLI_PATH,
      `${FIXTURE_ARG}${mode}`,
      `--locations=${locations.join(",")}`,
      "--start-dates=2026-10-03",
      "--durations=2,3",
      "--strategy=legacy-batch",
      "--scenario-concurrency=1",
      "--location-concurrency=2",
      "--retries=0",
      `--checkpoint=${path.join(dir, "state.json")}`,
      `--save=${path.join(dir, "results.json")}`,
      ...extraArgs
    ];
  }

  function readJsonIfPresent(file) {
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  }

  function scenariosOf(payload) {
    return Array.isArray(payload?.scenarios) ? payload.scenarios : payload ? [payload] : [];
  }

  function assertPartialScenario(scenario) {
    assert.equal(scenario.results.length, 21);
    assert.equal(scenario.errors.length, 1);
    assert.equal(scenario.errors[0].location, "Gdansk Downtown");
    assert.ok(scenario.results.every((result) => result.location !== "Gdansk Downtown"));
  }

  async function withWatchedCli(mode, extraArgs, verify) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-offline-progress-"));
    const logPath = path.join(dir, "run.log");
    const startedAt = Date.now();
    try {
      let error = null;
      try {
        await runCommand(process.execPath, cliArgs(dir, mode, extraArgs), {
          cwd: dir,
          label: `offline-${mode}`,
          logPath,
          progressPath: path.join(dir, "state.json"),
          stallTimeoutMs: STALL_MS,
          progressCheckIntervalMs: 25
        });
      } catch (caught) {
        error = caught;
      }
      const log = fs.readFileSync(logPath, "utf8");
      assert.match(log, /\[offline-fixture\] ready/, "CLI fixture must start before the watchdog deadline");
      const outcomesPath = path.join(dir, "location-outcomes.jsonl");
      const outcomes = fs.existsSync(outcomesPath)
        ? fs.readFileSync(outcomesPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
        : [];
      console.log(`EVIDENCE ${mode}: location outcomes=${outcomes.length}, progress records=${(log.match(/\[progress\]/g) || []).length}, snapshot=${fs.existsSync(path.join(dir, "results.json"))}, checkpoint=${fs.existsSync(path.join(dir, "state.json"))}, result=${error?.message || "exit 0"}`);
      await verify({ dir, error, log, outcomes, elapsedMs: Date.now() - startedAt });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  async function main() {
    assert.equal(locations.length, 22, "fixture must cover the actual 22-location collection scope");
    assert.ok(locations.includes("Gdansk Downtown"));
    let failures = 0;
    async function test(name, run) {
      if (testFilter && !name.includes(testFilter)) return;
      try {
        await run();
        console.log(`PASS ${name}`);
      } catch (error) {
        failures += 1;
        console.error(`FAIL ${name}: ${error.message}`);
      }
    }

    await test("attempted scope accepts complete error coverage without making partial scenarios reusable", async () => {
      const scope = {
        locations: ["Fixture Airport", "Gdansk Downtown"],
        startDates: ["2026-10-03", "2026-10-04"],
        durations: [2, 3]
      };
      const scenario = (startDate, days) => ({
        start_date: startDate,
        rental_days: days,
        results: [{ location: "Fixture Airport", total_price: 100 }],
        errors: [{ location: "Gdansk Downtown", error: "No automatic offers" }]
      });
      const payload = {
        locations: ["Fixture Airport", "Gdansk Downtown"],
        run_status: "degraded",
        scenarios: [
          scenario("2026-10-03", 2), scenario("2026-10-03", 3),
          scenario("2026-10-04", 2), scenario("2026-10-04", 3)
        ]
      };
      assert.equal(isChunkPayloadAttempted(payload, scope), true);
      assert.equal(isChunkPayloadComplete(payload, scope), false);
      for (const item of payload.scenarios) {
        assert.equal(isScenarioCheckpointComplete(item, scope.locations), false);
      }
      const missingLocation = structuredClone(payload);
      missingLocation.scenarios[0].errors = [];
      assert.equal(isChunkPayloadAttempted(missingLocation, scope), false, "declared scope is not proof a location was attempted");
      const missingDate = structuredClone(payload);
      missingDate.scenarios = missingDate.scenarios.slice(0, 2);
      assert.equal(isChunkPayloadAttempted(missingDate, scope), false, "every requested start date must be attempted");
      const duplicateScenario = structuredClone(payload);
      duplicateScenario.scenarios.push(structuredClone(duplicateScenario.scenarios[0]));
      assert.equal(isChunkPayloadAttempted(duplicateScenario, scope), false, "duplicate rows cannot count as an attempted scenario grid");
      const missingDeclaredLocation = structuredClone(payload);
      missingDeclaredLocation.locations = ["Fixture Airport"];
      assert.equal(isChunkPayloadAttempted(missingDeclaredLocation, scope), false);
    });

    await test("regression: mixed success and fatal scenario is not a fully attempted chunk", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-offline-fatal-scenario-"));
      try {
        const child = spawnSync(process.execPath, cliArgs(dir, "fatal-mixed", ["--json", "--offline-location-delay=5"]), {
          cwd: dir, encoding: "utf8", timeout: 15000
        });
        assert.ifError(child.error);
        assert.equal(child.status, 2, child.stderr);
        const payload = JSON.parse(child.stdout);
        const scenarios = scenariosOf(payload);
        assert.equal(scenarios.length, 2);
        assert.equal(scenarios[0].results.length, 22);
        assert.equal(scenarios[0].errors.length, 0);
        assert.equal(scenarios[1].results.length, 0);
        assert.equal(scenarios[1].errors.length, 22);
        assert.equal(scenarios[1].execution.fallback_reason, "fatal_scenario_error");
        assert.equal(isChunkPayloadAttempted(payload, {
          startDates: ["2026-10-03"], durations: [2, 3], locations
        }), false, "synthetic fatal-scenario errors must not prove every location was attempted");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test("regression: identical retry preserves earlier partial B while refreshing A", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-offline-partial-retry-"));
      try {
        const args = cliArgs(dir, "retry-partial-retention", ["--durations=2,3,4", "--offline-location-delay=5"]);
        const options = {
          cwd: dir, label: "offline-partial-retry", logPath: path.join(dir, "run.log"),
          progressPath: path.join(dir, "state.json"), stallTimeoutMs: STALL_MS,
          progressCheckIntervalMs: 25
        };
        await assert.rejects(runCommand(process.execPath, args, options), /made no progress/);
        const original = readJsonIfPresent(path.join(dir, "results.json"));
        assert.ok(original, "first attempt must persist A and B before hanging on C");
        const originalScenarios = scenariosOf(original);
        assert.deepEqual(originalScenarios.map((scenario) => scenario.rental_days), [2, 3]);
        originalScenarios.forEach(assertPartialScenario);
        const originalB = originalScenarios[1];
        assert.ok(Number.isFinite(Date.parse(originalB.generated_at)));
        assert.equal(Object.keys(readJsonIfPresent(path.join(dir, "state.json"))?.completed || {}).length, 0);

        // Reuse the exact command arguments, output path and environment; only external I/O changes.
        await assert.rejects(runCommand(process.execPath, args, options), /made no progress/);
        const outcomes = fs.readFileSync(path.join(dir, "location-outcomes.jsonl"), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        const retriedOutcomes = outcomes.filter((outcome) => outcome.attempt === 2);
        assert.equal(retriedOutcomes.filter((outcome) => outcome.rentalDays === 2).length, 22, "partial A must be attempted again, not resumed as complete");
        assert.equal(retriedOutcomes.filter((outcome) => outcome.rentalDays === 3).length, 11, "retry must finish half of B's locations before hanging");
        assert.equal(retriedOutcomes.length, 33);
        const starts = fs.readFileSync(path.join(dir, "location-starts.jsonl"), "utf8")
          .trim().split("\n").map((line) => JSON.parse(line));
        assert.ok(starts.some((start) => start.attempt === 2 && start.rentalDays === 3), "retry must enter B I/O");
        const retained = readJsonIfPresent(path.join(dir, "results.json"));
        const retainedScenarios = scenariosOf(retained);
        console.log(`EVIDENCE partial retry: first=${originalScenarios.length}, retained=${retainedScenarios.length}, retry outcomes=${retriedOutcomes.length}`);
        assert.equal(retained.run_status, "in_progress");
        assert.deepEqual(retainedScenarios.map((scenario) => scenario.rental_days), [2, 3], "unrefreshed partial B must survive retry A's snapshot write");
        retainedScenarios.forEach(assertPartialScenario);
        assert.ok(retainedScenarios[0].results.every((result) => result.total_price === 200), "newly finished A replaces its older evidence");
        assert.deepEqual(retainedScenarios[1], originalB, "preserved B must retain its original data and source timestamp");
        assert.equal(Object.keys(readJsonIfPresent(path.join(dir, "state.json"))?.completed || {}).length, 0, "preserved evidence must never become reusable completions");
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test("runCommand rejects exit 2 by default and returns it only with explicit acceptance", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-offline-exit-codes-"));
      try {
        const options = { cwd: dir, logPath: path.join(dir, "run.log"), label: "offline-exit-2" };
        await assert.rejects(runCommand(process.execPath, ["-e", "process.exit(2)"], options), /failed with exit code 2/);
        const outcome = await runCommand(process.execPath, ["-e", "process.exit(2)"], {
          ...options, acceptExitCodes: [0, 2]
        });
        assert.deepEqual(outcome, { exitCode: 2 });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    await test("quiet real CLI keeps collecting partial scenarios beyond the watchdog deadline", async () => {
      await withWatchedCli("partial", [], async ({ dir, error, log, outcomes, elapsedMs }) => {
        assert.ok(outcomes.length > 0, "fixture must settle locations, not time out during startup");
        assert.ok(!error || /failed with exit code 2$/.test(error.message), `active partial collection must not be classified as stalled: ${error?.message}`);
        assert.ok(elapsedMs > STALL_MS, "fixture must outlive one watchdog deadline");
        assert.match(log, /\[progress\]/, "quiet mode must expose completed-location progress");
        assert.ok((log.match(/\[progress\]/g) || []).length >= 44, "both successful and failed locations must report progress");
        assert.doesNotMatch(log, /terminating process tree/);
        const payload = readJsonIfPresent(path.join(dir, "results.json"));
        assert.ok(payload, "partial results must be saved");
        const scenarios = scenariosOf(payload);
        assert.equal(scenarios.length, 2);
        scenarios.forEach(assertPartialScenario);
        assert.equal(payload.run_status, "degraded");
        assert.match(log, /exited with code 2/);
        const state = readJsonIfPresent(path.join(dir, "state.json"));
        assert.equal(Object.keys(state?.completed || {}).length, 0, "partial scenarios are not reusable completions");
      });
    });

    await test("quiet real CLI watchdog terminates a true per-location I/O hang", async () => {
      await withWatchedCli("hang", ["--durations=2"], async ({ dir, error, log, outcomes, elapsedMs }) => {
        assert.match(error?.message || "", /made no progress/);
        assert.match(log, /terminating process tree/);
        assert.equal(outcomes.length, 0);
        assert.ok(fs.existsSync(path.join(dir, "location-starts.jsonl")), "hang fixture must enter per-location I/O before termination");
        assert.equal(fs.existsSync(path.join(dir, "results.json")), false, "a wholly hung first scenario must not produce a snapshot");
        assert.ok(elapsedMs < STALL_MS + 8000, "termination must remain bounded");
      });
    });

    await test("watchdog retains a finished partial scenario when the next scenario hangs", async () => {
      await withWatchedCli("hang-after-partial", ["--durations=2,3", "--offline-location-delay=50"], async ({ dir, error, log }) => {
        assert.match(error?.message || "", /made no progress/);
        assert.match(log, /terminating process tree/);
        const payload = readJsonIfPresent(path.join(dir, "results.json"));
        assert.ok(payload, "finished partial scenario must survive watchdog termination");
        const scenarios = scenariosOf(payload);
        assert.equal(scenarios.length, 1);
        assert.equal(scenarios[0].rental_days, 2);
        assertPartialScenario(scenarios[0]);
        const state = readJsonIfPresent(path.join(dir, "state.json"));
        assert.equal(Object.keys(state?.completed || {}).length, 0);
        const controller = createCheckpointController({
          enabled: true,
          checkpointPath: path.join(dir, "state.json"),
          runSignature: state?.run_signature || "offline-partial-resume-check",
          cli: { resetState: false, locations },
          scenarios: [{ scenario_id: scenarios[0].scenario_id }],
          writeState: () => { throw new Error("resume inspection must not write state"); }
        });
        assert.equal(controller.resumedCount, 0);
      });
    });

    await test("JSON-only CLI writes progress to stderr without corrupting JSON stdout", async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "discovercars-offline-json-progress-"));
      try {
        const child = spawnSync(process.execPath, cliArgs(dir, "partial", ["--durations=2", "--json", "--offline-location-delay=5"]), {
          cwd: dir, encoding: "utf8", timeout: 10000
        });
        assert.ifError(child.error);
        assert.equal(child.status, 2);
        const payload = JSON.parse(child.stdout);
        assertPartialScenario(payload);
        assert.equal(payload.run_status, "degraded");
        assert.doesNotMatch(child.stdout, /\[progress\]/);
        assert.match(child.stderr, /\[progress\]/);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    if (failures) process.exitCode = 1;
  }

  main().catch((error) => {
    console.error(error.stack || error);
    process.exitCode = 1;
  });
}
