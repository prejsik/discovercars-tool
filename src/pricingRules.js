const fs = require("fs");
const path = require("path");

const DEFAULT_PRICING_RULES = Object.freeze({
  top1GapThresholdPlnDay: 5,
  top1RaiseBufferPlnDay: 1,
  top1UndercutThresholdPlnDay: 10,
  undercutBufferPlnDay: 1,
  top3SmallDecreaseThresholdPlnDay: 10,
  minChangePlnDay: 0.5,
  roundingIncrementPlnDay: 0.01,
  top1HighRateThresholdPlnDay: 150
});

function loadPricingRules(configPath = process.env.PRICING_RULES_CONFIG) {
  const resolvedPath = path.resolve(configPath || "pricing-rules.config.example.json");
  if (!fs.existsSync(resolvedPath)) {
    return { ...DEFAULT_PRICING_RULES };
  }

  const payload = JSON.parse(fs.readFileSync(resolvedPath, "utf8"));
  return {
    ...DEFAULT_PRICING_RULES,
    ...(payload?.pricing || payload || {})
  };
}

module.exports = {
  DEFAULT_PRICING_RULES,
  loadPricingRules
};
