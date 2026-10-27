import { SignJWT, importPKCS8 } from 'jose';
import { unzipSync, strFromU8 } from 'fflate';
import { hashJson, PanelError } from '../server/workspace-service.mjs';
import { encryptEnvelope, decryptEnvelope } from '../server/preview-crypto.mjs';
import { readLimited } from '../server/http.mjs';
export { readLimited } from '../server/http.mjs';
export { readOperationalStatus } from '../server/reports.mjs';

export const REPOSITORY = 'prejsik/discovercars-tool';
const API = `https://api.github.com/repos/${REPOSITORY}`;
const WORKFLOW = 'rules-panel-preview.yml';
const PATHS = { pricing: 'pricing-rules.config.example.json', excel: 'excel-rate-update.config.example.json', locations: 'locations.config.json' };

export const githubConfigured = env => Boolean(env.GITHUB_APP_ID && env.GITHUB_INSTALLATION_ID && env.GITHUB_APP_PRIVATE_KEY && env.PANEL_PREVIEW_KEY);

export class GitHubRepository {
  constructor(env, { api, fetcher = fetch } = {}) {
    this.env = env;
    // Workers fetch must not receive the repository object as its receiver.
    this.fetcher = (...args) => fetcher(...args);
    this.api = api ?? this.request.bind(this);
    this.reads = new Map();
  }

  async token() {
    if (!githubConfigured(this.env)) throw new PanelError(503, 'Integracja GitHub nie jest skonfigurowana.');
    if (this.accessToken) return this.accessToken;
    if (!/^\d+$/.test(String(this.env.GITHUB_APP_ID)) || !/^\d+$/.test(String(this.env.GITHUB_INSTALLATION_ID))) throw new PanelError(503, 'Nieprawidlowa konfiguracja GitHub App.');
    const key = await importPKCS8(this.env.GITHUB_APP_PRIVATE_KEY.replace(/\\n/g, '\n'), 'RS256');
    const now = Math.floor(Date.now() / 1000);
    const jwt = await new SignJWT({}).setProtectedHeader({ alg: 'RS256' }).setIssuer(String(this.env.GITHUB_APP_ID))
      .setIssuedAt(now - 30).setExpirationTime(now + 540).sign(key);
    const response = await this.fetcher(`https://api.github.com/app/installations/${this.env.GITHUB_INSTALLATION_ID}/access_tokens`, {
      method: 'POST', headers: this.headers(jwt), signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ repositories: ['discovercars-tool'], permissions: { contents: 'write', actions: 'write' } }),
    });
    if (!response.ok) throw new PanelError(503, 'Nie mozna uzyskac dostepu do wskazanego repozytorium GitHub.');
    const result = JSON.parse(new TextDecoder().decode(await readLimited(response, 65536)));
    if (!result.token) throw new PanelError(503, 'Brak tokena instalacji GitHub.');
    this.accessToken = result.token;
    return result.token;
  }

  headers(token) { return { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'discovercars-rules-panel', 'X-GitHub-Api-Version': '2022-11-28' }; }

  async request(path, { method = 'GET', body, optional = false, binary = false, maximum = 2 * 1024 * 1024 } = {}) {
    if (!path.startsWith('/') || path.includes('..')) throw new PanelError(500, 'Niedozwolona sciezka GitHub.');
    const response = await this.fetcher(`${API}${path}`, { method, headers: this.headers(await this.token()),
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(20000), redirect: 'manual' });
    if (optional && response.status === 404) return null;
    if (binary && response.status === 302) {
      const url = new URL(response.headers.get('location'));
      if (url.protocol !== 'https:' || !/(?:\.blob\.core\.windows\.net|\.actions\.githubusercontent\.com|^objects\.githubusercontent\.com)$/.test(url.hostname)) throw new PanelError(502, 'Nieprawidlowy adres artefaktu.');
      const artifact = await this.fetcher(url, { signal: AbortSignal.timeout(20000), redirect: 'error' });
      if (!artifact.ok) throw new PanelError(502, 'Nie mozna odczytac wyniku testu.');
      return readLimited(artifact, maximum);
    }
    if ([409, 422].includes(response.status)) throw new PanelError(409, 'GitHub odrzucil zapis lub wystapil konflikt. Odswiez dane.');
    if (!response.ok) throw new PanelError(502, `GitHub nie odpowiedzial poprawnie (HTTP ${response.status}).`);
    if (response.status === 204) return null;
    if (binary) return readLimited(response, maximum);
    return JSON.parse(new TextDecoder().decode(await readLimited(response, path.startsWith('/git/blobs/') || path.startsWith('/contents/input/') ? 16 * 1024 * 1024 : 2 * 1024 * 1024)));
  }

  async json(path, revision, optional = false) {
    const result = await this.api(`/contents/${path}?ref=${revision}`, { optional });
    if (!result) return null;
    if (result.encoding !== 'base64' || result.type !== 'file') throw new PanelError(502, 'Nieprawidlowy dokument GitHub.');
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(result.content.replace(/\s/g, '')), c => c.charCodeAt(0))));
  }

  async baselineBytes(revision) {
    const file = await this.api(`/contents/input/mm-cars-rental-rates-inclusive-fp.xlsx?ref=${revision}`);
    const blob = file.content ? file : await this.api(`/git/blobs/${file.sha}`);
    if (blob.encoding !== 'base64' || !blob.content) throw new PanelError(502, 'Nie mozna odczytac obecnej bazy.');
    return Uint8Array.from(atob(blob.content.replace(/\s/g, '')), character => character.charCodeAt(0));
  }

  frozenMarkup(revision) { return this.json('input/broker-markup-frozen.json', revision); }

  async latestRuns() {
    const { workflow_runs = [] } = await this.api('/actions/workflows/discovercars-daily.yml/runs?per_page=30');
    const runs = workflow_runs.filter(run => /^\d+$/.test(String(run.id))).map(run => ({
      runId: String(run.id), status: run.status, conclusion: run.conclusion, title: run.display_title,
      startedAt: run.run_started_at ?? run.created_at, createdAt: run.created_at,
      url: `https://github.com/${REPOSITORY}/actions/runs/${run.id}`,
    }));
    if (runs[0]?.status === 'completed') {
      const { jobs = [] } = await this.api(`/actions/runs/${runs[0].runId}/jobs?per_page=100`);
      runs[0].skipped = runs[0].conclusion === 'success' && jobs.some(job => job.name === 'Freeze scope and collection plan' && job.conclusion === 'skipped');
      const failed = jobs.find(job => job.conclusion === 'failure');
      runs[0].failureStage = failed?.steps?.find(step => step.conclusion === 'failure')?.name ?? failed?.name ?? null;
    }
    return { latest: runs[0] ?? null, active: runs.filter(run => !['completed'].includes(run.status)) };
  }

  async reportEvidence(record, kind) {
    const prefix = kind === 'excel' ? 'discovercars-excel-import-' : 'discovercars-results-';
    const { artifacts = [] } = await this.api(`/actions/runs/${record.runId}/artifacts?per_page=100`);
    const matches = artifacts.filter(item => new RegExp(`^${prefix}\\d+$`).test(item.name) && !item.expired);
    const maximum = (kind === 'excel' ? 16 : 32) * 1024 * 1024;
    if (matches.length !== 1 || matches[0].size_in_bytes > maximum) throw new PanelError(502, 'Brak dostepnego artefaktu dla tego uruchomienia.');
    const archive = await this.api(`/actions/artifacts/${matches[0].id}/zip`, { binary: true, maximum });
    const wanted = kind === 'excel' ? ['run-manifest.json', 'excel-rate-update-summary.json'] : ['run-manifest.json', 'report.html'];
    const files = unzipSync(archive, { filter: file => wanted.includes(file.name) && file.originalSize <= 12 * 1024 * 1024 });
    if (wanted.some(name => !files[name])) throw new PanelError(502, 'Niekompletny artefakt uruchomienia.');
    const manifest = JSON.parse(strFromU8(files['run-manifest.json']));
    if (String(manifest.run_id) !== record.runId || manifest.git_sha !== record.revision || manifest.baseline?.workbook_sha256 !== record.baselineSha256 ||
      manifest.excel_files?.['rates-import-ready.xlsx'] !== record.files?.['rates-import-ready.xlsx'] || manifest.excel_files?.['rates-updated.xlsx'] !== record.files?.['rates-updated.xlsx']) throw new PanelError(409, 'Artefakt nie odpowiada wybranemu raportowi.');
    return files;
  }

  async publishedStatistics(record) {
    const files = await this.reportEvidence(record, 'excel');
    const summary = JSON.parse(strFromU8(files['excel-rate-update-summary.json']));
    if (summary.input_workbook_sha256 !== record.baselineSha256) throw new PanelError(409, 'Podsumowanie dotyczy innej bazy.');
    return { runId: record.runId, importSha256: record.files['rates-import-ready.xlsx'], baselineSha256: record.baselineSha256, statistics: summary.change_statistics };
  }

  async reportHtml(record) {
    return (await this.reportEvidence(record, 'report'))['report.html'];
  }

  async publishBaseline({ input, summary, snapshot, approvedAt, onboarding }) {
    const parent = await this.api(`/git/commits/${snapshot.source.revision}`);
    const blob = await this.api('/git/blobs', { method: 'POST', body: { content: input.content, encoding: 'base64' } });
    const manifest = { schema_version: 1, status: 'user_approved_baseline', approved_by: 'user', approved_at: approvedAt,
      workbook_sha256: summary.sha256, source_filename: input.filename, confirmed: input.importConfirmed === true,
      previous_baseline_sha256: snapshot.baseline.sha256,
      source_baseline: { status: 'user_supplied', workbook_sha256: summary.sha256, source_filename: input.filename },
      coverage: summary,
      ...(onboarding ? { location_onboarding: onboarding.additions.map(item => Object.fromEntries(
        ['zone', 'existingLocationId', 'placeId', 'markupSourceZone', 'daily'].filter(key => Object.hasOwn(item, key)).map(key => [key, item[key]]))), onboarding_hash: onboarding.hash,
        onboarding_request_hash: onboarding.requestHash } : {}),
      note: 'Baseline selected and approved in the authenticated director panel. Original workbook bytes preserved. Shared by both scheduled runs. Broker markup is not recalibrated.' };
    const tree = await this.api('/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree: [
      { path: 'input/mm-cars-rental-rates-inclusive-fp.xlsx', mode: '100644', type: 'blob', sha: blob.sha },
      { path: 'input/baseline-manifest.json', mode: '100644', type: 'blob', content: `${JSON.stringify(manifest, null, 2)}\n` },
      ...(onboarding ? [
        { path: 'locations.config.json', mode: '100644', type: 'blob', content: `${JSON.stringify(onboarding.documents.locations, null, 2)}\n` },
        { path: 'input/broker-markup-frozen.json', mode: '100644', type: 'blob', content: `${JSON.stringify(onboarding.frozen, null, 2)}\n` },
      ] : []),
    ] } });
    const commit = await this.api('/git/commits', { method: 'POST', body: { message: 'Update director-approved pricing baseline', tree: tree.sha, parents: [snapshot.source.revision] } });
    await this.api('/git/refs/heads/main', { method: 'PATCH', body: { sha: commit.sha, force: false } });
    return { revision: commit.sha, sha256: summary.sha256, url: `https://github.com/${REPOSITORY}/commit/${commit.sha}` };
  }

  async snapshot() {
    if (!this.snapshotPromise) this.snapshotPromise = (async () => {
      const ref = await this.api('/git/ref/heads/main');
      const revision = ref.object.sha;
      const documents = {};
      for (const [name, path] of Object.entries(PATHS)) documents[name] = await this.json(path, revision);
      const manifest = await this.json('input/baseline-manifest.json', revision);
      return { schemaVersion: 1, source: { revision, policyHash: await hashJson(documents), loadedAt: new Date().toISOString() },
        baseline: { filename: manifest.source_filename, approvedAt: manifest.approved_at, sha256: manifest.workbook_sha256,
          importConfirmed: manifest.confirmed === true || manifest.status === 'confirmed_imported',
          ...(manifest.onboarding_hash ? { onboardingHash: manifest.onboarding_hash } : {}),
          ...(manifest.onboarding_request_hash ? { onboardingRequestHash: manifest.onboarding_request_hash } : {}) },
        capabilities: { mode: 'github', authentication: 'cloudflare-access', publish: true }, documents };
    })();
    return this.snapshotPromise;
  }

  async publication() {
    const snapshot = await this.snapshot();
    const receipt = await this.json('rules-panel-publication.json', snapshot.source.revision, true);
    if (!receipt) return null;
    const commits = await this.api(`/commits?path=rules-panel-publication.json&sha=${snapshot.source.revision}&per_page=1`);
    const revision = commits[0]?.sha;
    if (!/^[a-f0-9]{40}$/.test(revision ?? '')) throw new PanelError(502, 'Nie mozna potwierdzic historii publikacji.');
    return { ...receipt, revision, currentRevision: snapshot.source.revision,
      policyMatchesCurrent: receipt.policyHash === snapshot.source.policyHash,
      url: `https://github.com/${REPOSITORY}/commit/${revision}` };
  }

  async publish({ draft, preview, approvedAt, approvalId }) {
    const parent = await this.api(`/git/commits/${draft.sourceRevision}`);
    const receipt = { schemaVersion: 1, approvalId, draftRevision: draft.revision, approvedAt, sourceRevision: draft.sourceRevision,
      policyHash: await hashJson(draft.model), validation: 'policy-and-source' };
    const tree = [{ path: PATHS.pricing, value: draft.model.pricing }, { path: PATHS.excel, value: draft.model.excel },
      { path: 'rules-panel-publication.json', value: receipt }].map(({ path, value }) => ({ path, mode: '100644', type: 'blob', content: `${JSON.stringify(value, null, 2)}\n` }));
    const newTree = await this.api('/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree } });
    const commit = await this.api('/git/commits', { method: 'POST', body: { message: 'Apply director-approved pricing rules', tree: newTree.sha, parents: [draft.sourceRevision] } });
    await this.api('/git/refs/heads/main', { method: 'PATCH', body: { sha: commit.sha, force: false } });
    return { ...receipt, revision: commit.sha, url: `https://github.com/${REPOSITORY}/commit/${commit.sha}` };
  }

  async requestPreview(draft, previewId) {
    const request = await encryptEnvelope({ schemaVersion: 1, previewId, draftRevision: draft.revision,
      sourceRevision: draft.sourceRevision, sourceHash: draft.sourceHash, modelHash: draft.modelHash,
      baselineSha256: draft.baselineSha256, model: draft.model, requestedAt: new Date().toISOString() }, this.env.PANEL_PREVIEW_KEY, 45000);
    await this.api(`/actions/workflows/${WORKFLOW}/dispatches`, { method: 'POST', body: { ref: 'main', inputs: { preview_id: previewId, request } } });
    return { queued: true, previewId, draftRevision: draft.revision, sourceRevision: draft.sourceRevision, requestedAt: new Date().toISOString(), status: 'queued' };
  }

  async verifyPreview(preview) {
    if (!/^\d+$/.test(String(preview.runId))) return false;
    const run = await this.api(`/actions/runs/${preview.runId}`);
    return run.status === 'completed' && run.conclusion === 'success' && run.event === 'workflow_dispatch'
      && run.head_sha === preview.sourceRevision && run.path === `.github/workflows/${WORKFLOW}`
      && run.display_title === `Rules preview ${preview.previewId}`;
  }

  async pollPreview(pending) {
    const { workflow_runs: runs = [] } = await this.api(`/actions/workflows/${WORKFLOW}/runs?event=workflow_dispatch&per_page=30`);
    const run = runs.find(item => item.display_title === `Rules preview ${pending.previewId}` && item.head_sha === pending.sourceRevision);
    if (!run) return pending;
    const state = { ...pending, runId: String(run.id), runUrl: `https://github.com/${REPOSITORY}/actions/runs/${run.id}` };
    if (run.status !== 'completed') return { ...state, status: 'running' };
    if (run.conclusion !== 'success') return { ...state, status: 'failure', error: 'Test GitHub Actions nie zakonczyl sie poprawnie. Publikacja zablokowana.' };
    const { artifacts = [] } = await this.api(`/actions/runs/${run.id}/artifacts`);
    const artifact = artifacts.find(item => item.name === `rules-panel-preview-${pending.previewId}` && !item.expired);
    if (!artifact || artifact.size_in_bytes > 2 * 1024 * 1024) throw new PanelError(502, 'Brak bezpiecznego artefaktu podgladu.');
    const zip = await this.api(`/actions/artifacts/${artifact.id}/zip`, { binary: true });
    const files = unzipSync(zip, { filter: file => file.name === 'preview.enc' && file.originalSize <= 1500000 });
    if (!files['preview.enc']) throw new PanelError(502, 'Nieprawidlowy artefakt podgladu.');
    const result = await decryptEnvelope(strFromU8(files['preview.enc']).trim(), this.env.PANEL_PREVIEW_KEY);
    if (result.previewId !== pending.previewId || result.draftRevision !== pending.draftRevision || result.sourceRevision !== pending.sourceRevision
      || String(result.runId) !== String(run.id)) throw new PanelError(502, 'Wynik podgladu dotyczy innej wersji.');
    return { ...result, revision: pending.previewId, runUrl: state.runUrl };
  }
}
