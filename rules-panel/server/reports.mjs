import { readLimited } from './http.mjs';
import { PanelError } from './workspace-service.mjs';

const PAGE = 'https://prejsik.github.io/discovercars-tool';
const RUN = 'https://github.com/prejsik/discovercars-tool/actions/runs/';
const FILES = { import: 'rates-import-ready.xlsx', recommendations: 'rates-updated.xlsx' };
const sha = value => /^[a-f0-9]{64}$/.test(value ?? '');
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const signature = value => JSON.stringify([value.run_id, value.generated_at, value.git_sha, value.excel_files, value.report_html_sha256]);

async function published(name, fetcher, maximum = 4 * 1024 * 1024) {
  const response = await fetcher(`${PAGE}/${name}`, { headers: { 'Cache-Control': 'no-cache' }, signal: AbortSignal.timeout(20000), redirect: 'error' });
  if (!response.ok) throw new PanelError(502, `Nie mozna odczytac opublikowanego pliku (HTTP ${response.status}).`);
  return readLimited(response, maximum);
}
async function manifest(folder, fetcher) {
  const value = JSON.parse(new TextDecoder().decode(await published(`${folder}/run-manifest.json`, fetcher)));
  if (!Number.isFinite(Date.parse(value.generated_at)) || !Number.isFinite(Date.parse(value.source_started_at)) || !/^\d+$/.test(String(value.run_id)) || !/^[a-f0-9]{40}$/.test(value.git_sha ?? '')) throw new PanelError(502, 'Nieprawidlowy manifest raportu.');
  return value;
}
export function workbookLink(kind, record) {
  const digest = record?.files?.[FILES[kind]];
  if (!Object.hasOwn(FILES, kind) || !sha(digest)) return null;
  return `/api/report/file?kind=${kind}&runId=${record.runId}&sha256=${digest}`;
}
function normalize(value) {
  const quality = value.quality ?? {};
  const expected = count(quality.expected_location_check_count); const missing = count(quality.missing_top3_count);
  return { generatedAt: value.generated_at, sourceStartedAt: value.source_started_at, revision: value.git_sha, runId: String(value.run_id),
    startDates: Array.isArray(value.start_dates) ? value.start_dates.filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date)).slice(0, 366) : [],
    durations: Array.isArray(value.durations) ? value.durations.filter(days => Number.isInteger(days) && days > 0 && days <= 35) : [],
    quality: value.status, baselineSha256: value.baseline?.workbook_sha256, files: value.excel_files ?? null, reportSha256: value.report_html_sha256 ?? null,
    coverage: expected !== null && missing !== null && missing <= expected ? { found: expected - missing, expected } : null,
    alerts: (Array.isArray(quality.blocking_alerts) ? quality.blocking_alerts : []).filter(text => typeof text === 'string').slice(0, 3).map(text => text.slice(0, 500)),
    runUrl: `${RUN}${value.run_id}` };
}

export async function readOperationalStatus(baseline, fetcher = (...args) => fetch(...args), runsReader, statisticsReader) {
  const warnings = [];
  const read = async folder => {
    try { return await manifest(folder, fetcher); }
    catch (error) { warnings.push(`${folder === 'latest-full' ? 'Raport' : 'Excel'}: ${error instanceof PanelError ? error.message : 'Nie mozna potwierdzic danych.'}`); return null; }
  };
  const [reportManifest, excelManifest, executions] = await Promise.all([
    read('latest-full'), read('latest-excel'), runsReader ? runsReader().catch(() => { warnings.push('Nie mozna odczytac stanu uruchomien.'); return null; }) : null,
  ]);
  const report = reportManifest && normalize(reportManifest); const excel = excelManifest && normalize(excelManifest);
  if (excelManifest && excelManifest.status !== 'failure') {
    try {
      let stats = excelManifest.excel_change_statistics;
      if (!stats) {
        if (!statisticsReader) throw new Error('No run-bound statistics');
        const proof = await statisticsReader(excel);
        if (proof.runId !== excel.runId || proof.importSha256 !== excel.files?.[FILES.import] || proof.baselineSha256 !== excel.baselineSha256) throw new Error('Summary source changed');
        stats = proof.statistics;
      }
      excel.statistics = { increases: count(stats.increase_count), decreases: count(stats.decrease_count),
        averageIncrease: typeof stats.average_increase_pln_day === 'number' && Number.isFinite(stats.average_increase_pln_day) ? Math.abs(stats.average_increase_pln_day) : null,
        averageDecrease: typeof stats.average_decrease_pln_day === 'number' && Number.isFinite(stats.average_decrease_pln_day) ? Math.abs(stats.average_decrease_pln_day) : null };
    } catch { warnings.push('Nie potwierdzono podsumowania zmian dla tego Excela.'); }
  }
  const usableExcel = excel && excel.quality !== 'failure' && sha(excel.files?.[FILES.import]) && sha(excel.files?.[FILES.recommendations]);
  return { available: Boolean(report || excel), checkedAt: new Date().toISOString(), report, excel, executions, warnings,
    baseline: { ...baseline, importConfirmed: baseline.importConfirmed === true },
    links: { report: report ? `/api/report/open?runId=${report.runId}` : null,
      import: usableExcel ? workbookLink('import', excel) : null, recommendations: usableExcel ? workbookLink('recommendations', excel) : null,
      run: report?.runUrl ?? null },
    ...(!report && !excel ? { error: 'Nie mozna potwierdzic stanu opublikowanych raportow. Nie wyswietlamy starych danych jako aktualnych.' } : {}) };
}

export async function loadPublishedReport(runId, repository, fetcher = (...args) => fetch(...args)) {
  if (!/^\d+$/.test(String(runId))) throw new PanelError(422, 'Nieprawidlowy identyfikator raportu.');
  const current = await manifest('latest-full', fetcher);
  if (String(current.run_id) !== String(runId)) throw new PanelError(409, 'Opublikowano nowszy raport. Odswiez wyniki.');
  if (sha(current.report_html_sha256)) {
    const bytes = await published('latest-full/report.html', fetcher, 8 * 1024 * 1024);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
    if (digest !== current.report_html_sha256 || signature(current) !== signature(await manifest('latest-full', fetcher))) throw new PanelError(409, 'Raport zmienil sie podczas pobierania. Odswiez wyniki.');
    return bytes;
  }
  return repository.reportHtml(normalize(current));
}

export async function loadPublishedWorkbook(input, fetcher = (...args) => fetch(...args)) {
  if (!Object.hasOwn(FILES, input.kind) || !/^\d+$/.test(String(input.runId)) || !sha(input.sha256)) throw new PanelError(422, 'Nieprawidlowy identyfikator pliku.');
  const current = await manifest('latest-excel', fetcher);
  if (current.status === 'failure' || String(current.run_id) !== String(input.runId) || current.excel_files?.[FILES[input.kind]] !== input.sha256) throw new PanelError(409, 'Opublikowano inny zestaw plikow. Odswiez wyniki. Starszy pobrany Excel mozesz wybrac w zakladce Plik bazowy.');
  const bytes = await published(`latest-excel/${FILES[input.kind]}`, fetcher, 8 * 1024 * 1024);
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(value => value.toString(16).padStart(2, '0')).join('');
  if (digest !== input.sha256 || signature(current) !== signature(await manifest('latest-excel', fetcher))) throw new PanelError(409, 'Plik zmienil sie w czasie pobierania. Odswiez wyniki i wybierz plik ponownie.');
  const dates = normalize(current).startDates.sort();
  const scope = dates.length ? `${dates[0]}--${dates.at(-1)}` : current.generated_at.slice(0, 10);
  return { bytes, filename: `${FILES[input.kind].replace('.xlsx', '')}-${scope}-run-${input.runId}.xlsx`, runId: String(current.run_id), sha256: digest };
}

export function workbookInput(file) {
  let content = '';
  for (let offset = 0; offset < file.bytes.length; offset += 24576) content += btoa(String.fromCharCode(...file.bytes.subarray(offset, offset + 24576)));
  return { filename: file.filename, content };
}
