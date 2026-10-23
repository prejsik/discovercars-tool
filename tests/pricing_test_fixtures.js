// Synthetic scenarios must not inherit policies edited in the director panel.
const path = require('node:path');
const directory = path.join(__dirname, 'fixtures/excel-policy-0939d46');
const pricingPath = path.join(directory, 'pricing-rules.config.example.json');
const excelPolicy = require(path.join(directory, 'excel-rate-update.config.example.json'));
const pricing = { ...require(pricingPath).pricing, excelPolicy };

module.exports = { pricing, excelPolicy, pricingPath };
