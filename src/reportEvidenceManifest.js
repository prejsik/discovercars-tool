const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function bindReportEvidence(directory = 'output') {
  const manifestPath = path.join(directory, 'run-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.excel_change_statistics;
  delete manifest.excel_summary_sha256;
  delete manifest.report_html_sha256;
  const summaryPath = path.join(directory, 'excel-rate-update-summary.json');
  if (fs.existsSync(summaryPath)) {
    const bytes = fs.readFileSync(summaryPath);
    let summary;
    try { summary = JSON.parse(bytes); } catch { summary = null; }
    manifest.excel_change_statistics = /^[a-f0-9]{64}$/.test(summary?.input_workbook_sha256 ?? '') && summary.input_workbook_sha256 === manifest.baseline?.workbook_sha256 ? summary.change_statistics ?? null : null;
    manifest.excel_summary_sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  }
  const reportPath = path.join(directory, 'report.html');
  if (fs.existsSync(reportPath)) manifest.report_html_sha256 = crypto.createHash('sha256').update(fs.readFileSync(reportPath)).digest('hex');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
module.exports = { bindReportEvidence };
if (require.main === module) bindReportEvidence(process.argv[2]);
