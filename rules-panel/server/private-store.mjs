import { PanelError } from './workspace-service.mjs';
import { readOperationalStatus } from '../worker/github.mjs';

const auditKey = (time, id) => `audit:${String(9999999999999 - Date.parse(time)).padStart(13, '0')}:${id}`;

export class PrivateWorkspaceStore {
  constructor(storage, repository, { capabilities } = {}) {
    this.storage = storage; this.repository = repository;
    this.capabilities = capabilities ?? { sharedDraft: true, preview: true, publish: true };
  }
  snapshot() { return this.repository.snapshot(); }
  async draft() { return await this.storage.get('draft') ?? null; }
  async getRevision(revision) { return await this.storage.get(`version:${revision}`) ?? null; }
  async history() { return [...(await this.storage.list({ prefix: 'audit:', limit: 50 })).values()]; }
  publication() { return this.repository.publication(); }
  async status() {
    const baseline = (await this.snapshot()).baseline;
    const cached = await this.storage.get('operational-status');
    if (cached?.schemaVersion === 2 && cached.baseline?.sha256 === baseline.sha256 && cached.checkedAt && Date.now() - Date.parse(cached.checkedAt) < 60000) return { ...cached, baseline };
    const status = await readOperationalStatus(baseline, this.repository.fetcher, this.repository.latestRuns ? () => this.repository.latestRuns() : undefined,
      this.repository.publishedStatistics ? async record => {
        const old = await this.storage.get('report-statistics');
        if (old?.runId === record.runId && old.importSha256 === record.files?.['rates-import-ready.xlsx']) return old;
        const proof = await this.repository.publishedStatistics(record);
        await this.storage.put('report-statistics', proof);
        return proof;
      } : undefined);
    status.schemaVersion = 2;
    for (const record of [status.report, status.excel].filter(Boolean)) {
      record.baselineMatchesCurrent = record.baselineSha256 === baseline.sha256;
      if (record.baselineMatchesCurrent) record.baselineFilename = baseline.filename;
      else {
        try { record.baselineFilename = (await this.repository.json('input/baseline-manifest.json', record.revision)).source_filename; }
        catch { record.baselineFilename = null; }
      }
    }
    if (status.available) await this.storage.put('operational-status', status);
    return status;
  }

  async saveDraft(record, expectedRevision) {
    const draft = { ...record, revision: crypto.randomUUID() };
    const entry = { revision: draft.revision, at: record.savedAt, actor: record.savedBy, reason: record.reason,
      action: record.action ?? 'save', revertedFrom: record.revertedFrom ?? null, sourceRevision: record.sourceRevision, changes: record.changes };
    await this.storage.transaction(async transaction => {
      const current = await transaction.get('draft');
      if ((current?.revision ?? null) !== expectedRevision) throw new PanelError(409, 'Nowszy szkic zostal juz zapisany.');
      await transaction.put({ draft, [`version:${draft.revision}`]: draft, [auditKey(record.savedAt, draft.revision)]: entry });
    });
    return draft;
  }

  async preview() {
    let preview = await this.storage.get('preview') ?? null;
    if (preview && ['queued', 'running', 'requesting'].includes(preview.status)
      && Date.now() - Date.parse(preview.polledAt ?? preview.requestedAt) > 15000) {
      const observed = JSON.stringify(preview);
      try {
        preview = { ...await this.repository.pollPreview(preview), polledAt: new Date().toISOString() };
        if (['queued', 'requesting'].includes(preview.status) && Date.now() - Date.parse(preview.requestedAt) > 60 * 60 * 1000) {
          preview = { ...preview, status: 'failure', error: 'Nie potwierdzono uruchomienia testu w ciagu godziny.' };
        }
      } catch {
        preview = { ...preview, polledAt: new Date().toISOString(), error: 'Nie mozna teraz odczytac testu. Odswiez stan; publikacja pozostaje zablokowana.' };
      }
      preview = await this.storage.transaction(async transaction => {
        const current = await transaction.get('preview') ?? null;
        if (JSON.stringify(current) !== observed) return current;
        await transaction.put('preview', preview);
        return preview;
      });
    }
    return preview;
  }

  async requestPreview({ draftRevision }) {
    const draft = await this.draft();
    if (draft?.revision !== draftRevision) throw new PanelError(409, 'Szkic zmienil sie przed testem.');
    const old = await this.preview();
    if (old?.draftRevision === draftRevision && ['queued', 'running', 'requesting'].includes(old.status)) return { queued: true, ...old };
    const pending = { previewId: crypto.randomUUID(), draftRevision, sourceRevision: draft.sourceRevision,
      requestedAt: new Date().toISOString(), status: 'requesting' };
    await this.storage.put('preview', pending);
    try {
      const result = await this.repository.requestPreview(draft, pending.previewId);
      await this.storage.put('preview', result);
      return result;
    } catch (error) {
      // A network timeout may happen after GitHub accepted the request. Poll this ID;
      // do not blindly create a second paid run.
      await this.storage.put('preview', { ...pending, error: 'Nie potwierdzono wyslania testu. Odswiez status przed ponowieniem.' });
      throw error;
    }
  }

  verifyPreview(preview) { return this.repository.verifyPreview(preview); }
  async publish(record) {
    const approvalId = crypto.randomUUID();
    const entry = { revision: record.draft.revision, at: record.approvedAt, actor: record.actor,
      action: 'approval_pending', approvalId, reason: record.draft.reason, sourceRevision: record.draft.sourceRevision,
      changes: record.draft.changes };
    // Persist the identity before an external commit that may succeed despite a lost response.
    await this.storage.put({ [`approval:${approvalId}`]: entry, [auditKey(entry.at, approvalId)]: entry });
    const result = await this.repository.publish({ ...record, approvalId });
    await this.reconcilePublication(result);
    return result;
  }

  async reconcilePublication(receipt) {
    const pending = receipt.approvalId ? await this.storage.get(`approval:${receipt.approvalId}`) : null;
    if (!pending || pending.revision !== receipt.draftRevision || pending.at !== receipt.approvedAt) {
      throw new PanelError(503, 'GitHub zawiera publikacje, ale nie mozna potwierdzic jej prywatnego audytu.');
    }
    const completed = { ...pending, action: 'publish', publishedRevision: receipt.revision };
    await this.storage.put({ [`approval:${receipt.approvalId}`]: completed,
      [auditKey(pending.at, `${receipt.approvalId}:published`)]: completed });
  }
}
