const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  mergeBrokerMarkupCalibration,
  resolveBrokerMarkupCalibration
} = require("../src/brokerMarkupCalibration");
const {
  buildCalibrationUpdate,
  loadCalibrationInputForUpdate
} = require("../src/updateBrokerMarkupCalibration");
const { mergePricingRecommendations } = require("../src/mergePricingRecommendations");

function runTest(name, fn) {
  try {
    fn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  }
}

runTest("merged older decisions cannot carry a different markup into a frozen report", () => {
  const old = { location: "Warsaw", start_date: "2026-10-10", rental_days: 2,
    action: "decrease", broker_markup_multiplier: 1.16, suggested_rate_pln_day: 35,
    maximum_import_rate_pln_day: 35, site_cap_rate_pln_day: 40.6 };
  const update = { decisions: [], options: { brokerMarkupCalibration: {
    enabled: true, manualOnly: true, defaultMultiplier: 1.1
  } } };
  const merged = mergePricingRecommendations({ decisions: [old] }, update);
  assert.equal(merged.decisions[0].action, "hold");
  assert.equal(merged.decisions[0].maximum_import_rate_pln_day, null);
  assert.equal(merged.decisions[0].site_cap_rate_pln_day, null);
  assert.equal(merged.decisions[0].broker_markup_multiplier, 1.1);
  assert.equal(merged.recommendation_count, 0);
  assert.equal(merged.merge.frozen_calibration_blocked_count, 1);
  assert.equal(old.action, "decrease");
  const same = { ...old, broker_markup_multiplier: 1.1 };
  assert.equal(mergePricingRecommendations({ decisions: [same] }, update).recommendation_count, 1);
  assert.equal(mergePricingRecommendations({ decisions: [{ ...old, broker_markup_multiplier: 'invalid' }] }, update).recommendation_count, 0);
  assert.equal(mergePricingRecommendations({ decisions: [old] }, { decisions: [] }).recommendation_count, 1);
});

function observations() {
  return {
    enabled: true,
    source: "current-exact-scenario",
    count: 4,
    average_multiplier: 1.18,
    median_multiplier: 1.18,
    average_markup_percent: 18,
    by_location: {
      Warsaw: {
        count: 4,
        average_multiplier: 1.19,
        median_multiplier: 1.19,
        average_markup_percent: 19
      }
    },
    by_duration: {
      7: {
        count: 4,
        average_multiplier: 1.17,
        median_multiplier: 1.17,
        average_markup_percent: 17
      }
    },
    by_location_duration: {
      Warsaw: {
        7: {
          count: 4,
          average_multiplier: 1.2,
          median_multiplier: 1.2
        }
      }
    }
  };
}

runTest("manual-only calibration keeps the existing merged model unchanged", () => {
  const baseCalibration = {
    enabled: true,
    manualOnly: true,
    defaultMultiplier: 1.075,
    minMultiplier: 1,
    maxMultiplier: 1.2,
    locationMultipliers: { Warsaw: 1.06, Krakow: 1.08 },
    durationMultipliers: { 7: 1.07 },
    locationDurationMultipliers: { Warsaw: { 7: 1.065 } }
  };
  const previousCalibration = {
    brokerMarkupCalibration: {
      defaultMultiplier: 1.08,
      locationMultipliers: { Warsaw: 1.0623 },
      durationMultipliers: { 5: 1.0786 },
      locationDurationMultipliers: { Krakow: { 7: 1.081 } }
    }
  };
  const expected = mergeBrokerMarkupCalibration(baseCalibration, previousCalibration);

  const output = buildCalibrationUpdate({
    baseConfig: { pricing: { brokerMarkupCalibration: baseCalibration } },
    previousCalibration,
    excelSummary: {
      input_workbook_sha256: "diagnostic-input",
      broker_markup_observations: observations()
    },
    alpha: 1,
    minSamples: 1
  });

  assert.deepEqual(output.brokerMarkupCalibration, expected);
  assert.equal(output.learning.observation_count, 4);
  assert.equal(output.learning.source, "current-exact-scenario");
  assert.equal(output.learning.observed_robust_multiplier, 1.18);
  assert.deepEqual(output.learning.by_location, observations().by_location);
});

runTest("manual-only resolver ignores observed evidence and uses configured values", () => {
  const result = resolveBrokerMarkupCalibration({
    location: "Warsaw Airport",
    rental_days: 7,
    markup_evidence: {
      status: "supported",
      observed_multiplier: 1.19
    }
  }, {
    enabled: true,
    manualOnly: true,
    defaultMultiplier: 1.075,
    minMultiplier: 1,
    maxMultiplier: 1.2,
    locationDurationMultipliers: {
      Warsaw: { 7: 1.065 }
    }
  });

  assert.deepEqual(result, {
    enabled: true,
    multiplier: 1.065,
    percent: 6.5,
    source: "location-duration:Warsaw/7"
  });
});

runTest("unlocked resolver keeps using supported current evidence", () => {
  const result = resolveBrokerMarkupCalibration({
    location: "Warsaw",
    rental_days: 7,
    markup_evidence: {
      status: "supported",
      observed_multiplier: 1.19
    }
  }, {
    enabled: true,
    defaultMultiplier: 1.075,
    minMultiplier: 1,
    maxMultiplier: 1.2,
    locationMultipliers: { Warsaw: 1.06 }
  });

  assert.deepEqual(result, {
    enabled: true,
    multiplier: 1.19,
    percent: 19,
    source: "current-exact-scenario"
  });
});

runTest("unlocked calibration keeps learning from observations", () => {
  const output = buildCalibrationUpdate({
    baseConfig: {
      pricing: {
        brokerMarkupCalibration: {
          enabled: true,
          defaultMultiplier: 1.08,
          minMultiplier: 1,
          maxMultiplier: 1.2,
          locationMultipliers: { Warsaw: 1.06 }
        }
      }
    },
    excelSummary: { broker_markup_observations: observations() },
    alpha: 0.5,
    minSamples: 1
  });

  assert.equal(output.brokerMarkupCalibration.defaultMultiplier, 1.13);
  assert.equal(output.brokerMarkupCalibration.locationMultipliers.Warsaw, 1.125);
  assert.equal(output.brokerMarkupCalibration.durationMultipliers["7"], 1.17);
  assert.equal(output.brokerMarkupCalibration.locationDurationMultipliers.Warsaw["7"], 1.2);
});

runTest("external learned calibration cannot unlock a manual-only base", () => {
  const merged = mergeBrokerMarkupCalibration({
    enabled: true,
    manualOnly: true,
    defaultMultiplier: 1.075
  }, {
    brokerMarkupCalibration: {
      manualOnly: false,
      defaultMultiplier: 1.19
    }
  });

  assert.equal(merged.manualOnly, true);
});

runTest("manual-only updater input defaults to the frozen calibration pin", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "frozen-calibration-"));
  const externalPath = path.join(tempDir, "external.json");
  fs.writeFileSync(externalPath, JSON.stringify({
    brokerMarkupCalibration: {
      enabled: true,
      manualOnly: false,
      defaultMultiplier: 1.19
    }
  }));

  try {
    const selected = loadCalibrationInputForUpdate({
      baseConfig: {
        pricing: {
          brokerMarkupCalibration: {
            enabled: true,
            manualOnly: true
          }
        }
      },
      previousPath: externalPath
    });
    const frozen = JSON.parse(fs.readFileSync(
      path.join(__dirname, "..", "input", "broker-markup-frozen.json"),
      "utf8"
    ));

    assert.deepEqual(selected, frozen);
  } finally {
    fs.unlinkSync(externalPath);
    fs.rmdirSync(tempDir);
  }
});

runTest("manual-only updater fails when the frozen calibration pin is missing", () => {
  assert.throws(() => loadCalibrationInputForUpdate({
    baseConfig: {
      pricing: {
        brokerMarkupCalibration: {
          enabled: true,
          manualOnly: true
        }
      }
    },
    previousPath: "unused-external-calibration.json",
    frozenPath: path.join(os.tmpdir(), "missing-broker-markup-frozen.json")
  }), /Frozen broker markup calibration is required in manual-only mode/);
});
