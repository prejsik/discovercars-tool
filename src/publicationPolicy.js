const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKBOOKS = ['rates-import-ready.xlsx', 'rates-updated.xlsx'];

function workbookDigests(directory) {
  return Object.fromEntries(WORKBOOKS.filter(name => fs.existsSync(path.join(directory, name)))
    .map(name => [name, crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, name))).digest('hex')]));
}

function validatePublicationBundle(directory, kind, required = false) {
  const manifestPath = path.join(directory, 'run-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    if (required || (fs.existsSync(directory) && fs.readdirSync(directory).length)) {
      throw new Error(`Missing publication manifest: ${directory}`);
    }
    return null;
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  sourceTime(manifest);
  const files = kind === 'excel' ? [] : ['report.html', 'results-latest.json', 'quality-alerts.json'];
  if (kind === 'excel' || manifest.status !== 'failure') files.push(...WORKBOOKS);
  for (const name of files) {
    const file = path.join(directory, name);
    if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error(`Missing publication file: ${file}`);
  }
  if (kind === 'excel' || manifest.status !== 'failure') {
    const digests = workbookDigests(directory);
    for (const name of WORKBOOKS) {
      if (manifest.excel_files && manifest.excel_files[name] !== digests[name]) {
        throw new Error(`Workbook checksum mismatch: ${path.join(directory, name)}`);
      }
    }
  }
  return manifest;
}

function sourceTime(manifest) {
  // Completion order does not determine freshness when night/day runs overlap.
  const value = manifest.source_started_at || manifest.generated_at;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error('Missing valid publication source timestamp');
  return time;
}

function publicationDecision(candidate, current) {
  const timestamp = sourceTime(candidate);
  if (!current) return { promote: true, reason: 'first_publication' };
  return timestamp >= sourceTime(current)
    ? { promote: true, reason: 'current_source' }
    : { promote: false, reason: 'newer_source_already_published' };
}

function runCli(argv = process.argv.slice(2), env = process.env) {
  const args = Object.fromEntries(argv.map(value => {
    const index = value.indexOf('=');
    return [value.slice(2, index), value.slice(index + 1)];
  }));
  const validateSite = root => {
    for (const directory of ['latest-full', 'latest-smoke', 'latest-excel']) {
      validatePublicationBundle(path.join(root, directory), directory === 'latest-excel' ? 'excel' : 'report');
    }
  };
  if (args['validate-only']) {
    validateSite(args['validate-only']);
    return { valid: true };
  }
  const read = file => file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
  if (args['preserved-root']) {
    validateSite(args['preserved-root']);
    validatePublicationBundle(path.dirname(args.candidate), 'report', true);
  }
  const candidate = read(args.candidate);
  if (!candidate) throw new Error('Missing candidate manifest');
  if (args['expected-status'] && candidate.status !== args['expected-status']) {
    throw new Error('Candidate quality status does not match the publication status');
  }
  const report = publicationDecision(candidate, read(args['current-report']));
  const excel = publicationDecision(candidate, read(args['current-excel']));
  const result = { promote_report: report.promote, promote_excel: excel.promote, report, excel };
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, `promote_report=${report.promote}\npromote_excel=${excel.promote}\n`);
  }
  console.log(JSON.stringify(result));
  return result;
}

module.exports = { publicationDecision, workbookDigests, validatePublicationBundle, runCli };
if (require.main === module) {
  try { runCli(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
