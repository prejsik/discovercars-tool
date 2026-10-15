import { createModel, toDocuments, validateModel } from '../src/policy.mjs';
import { diffDocuments } from '../src/draft.mjs';

export class PanelError extends Error {
  constructor(status, message, details) { super(message); this.status = status; this.details = details; }
}

export async function hashJson(value) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

const conflict = message => { throw new PanelError(409, message); };
const validActor = actor => {
  if (typeof actor !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(actor)) throw new PanelError(403, 'Brak potwierdzonej tozsamosci.');
};

// All storage adapters use this same validation and approval boundary.
export class WorkspaceService {
  constructor(store, { clock = () => new Date() } = {}) { this.store = store; this.clock = clock; }

  async workspace() {
    const [snapshot, draft, preview, history, status, publication] = await Promise.all([
      this.store.snapshot(), this.store.draft(), this.store.preview(), this.store.history(),
      this.store.status(), this.store.publication(),
    ]);
    return { snapshot, draft, preview, history, status, publication,
      capabilities: this.store.capabilities ?? { sharedDraft: true, preview: true, publish: true } };
  }

  checkSource(snapshot, source) {
    if (snapshot.source.revision !== source.sourceRevision || snapshot.source.policyHash !== source.sourceHash
      || (source.baselineSha256 && snapshot.baseline.sha256 !== source.baselineSha256)) {
      conflict('Zmienila sie konfiguracja lub baza. Odswiez dane i przygotuj nowy podglad.');
    }
  }

  validate(model, original) {
    let validation;
    try { validation = validateModel(model, createModel(original)); }
    catch { throw new PanelError(422, 'Nieprawidlowa struktura zasad.'); }
    if (validation.errors.length) throw new PanelError(422, 'Popraw bledy zasad przed zapisem.', validation.errors);
    return validation;
  }

  async save(input, actor, action = 'save', revertedFrom = null) {
    validActor(actor);
    const snapshot = await this.store.snapshot();
    this.checkSource(snapshot, input);
    const previous = await this.store.draft();
    if ((previous?.revision ?? null) !== (input.expectedRevision ?? null)) conflict('Inna osoba zapisala nowszy szkic. Twoje zmiany nie zostaly nadpisane.');
    if (typeof input.reason !== 'string' || input.reason.trim().length < 3 || input.reason.length > 500) {
      throw new PanelError(422, 'Podaj powod zmiany (3-500 znakow).');
    }
    const validation = this.validate(input.model, snapshot.documents);
    const changes = diffDocuments(toDocuments(snapshot.documents), toDocuments(input.model));
    if (!changes.length) throw new PanelError(422, 'Szkic nie zmienia aktualnych zasad.');
    const model = createModel(input.model);
    const record = { schemaVersion: 1, sourceRevision: snapshot.source.revision, sourceHash: snapshot.source.policyHash,
      baselineSha256: snapshot.baseline.sha256, model, modelHash: await hashJson(model),
      reason: input.reason.trim(), savedBy: actor, savedAt: this.clock().toISOString(), action, revertedFrom,
      changes, warnings: validation.warnings };
    await this.store.saveDraft(record, input.expectedRevision ?? null);
    return this.workspace();
  }

  async currentDraft(revision) {
    const draft = await this.store.draft();
    if (!draft || draft.revision !== revision) conflict('Szkic ma nowsza wersje. Odswiez podglad.');
    const snapshot = await this.store.snapshot();
    this.checkSource(snapshot, draft);
    this.validate(draft.model, snapshot.documents);
    if (draft.modelHash !== await hashJson(draft.model)) conflict('Niespojny odcisk szkicu.');
    return { draft, snapshot };
  }

  async requestPreview(input, actor) {
    validActor(actor);
    const { draft } = await this.currentDraft(input.draftRevision);
    return this.store.requestPreview({ draftRevision: draft.revision, sourceRevision: draft.sourceRevision });
  }

  async publish(input, actor) {
    validActor(actor);
    if (this.store.capabilities?.publish === false) throw new PanelError(503, 'Publikacja na GitHub nie jest podlaczona.');
    const published = await this.store.publication();
    if (published?.draftRevision === input.draftRevision && published.policyMatchesCurrent !== false) {
      await this.store.reconcilePublication?.(published);
      return published;
    }
    const { draft, snapshot } = await this.currentDraft(input.draftRevision);
    const preview = await this.store.preview();
    const age = value => this.clock().getTime() - Date.parse(value);
    if (!preview || preview.revision !== input.previewRevision || preview.draftRevision !== draft.revision
      || preview.sourceRevision !== draft.sourceRevision || preview.sourceHash !== draft.sourceHash
      || preview.modelHash !== draft.modelHash || preview.baselineSha256 !== snapshot.baseline.sha256
      || preview.testsSucceeded !== true || preview.status !== 'success'
      || !(age(preview.completedAt) >= 0 && age(preview.completedAt) <= 60 * 60 * 1000)
      || !(age(preview.dataCollectedAt) >= 0 && age(preview.dataCollectedAt) <= 24 * 60 * 60 * 1000)) {
      conflict('Wymagany jest aktualny, poprawny podglad tej wersji szkicu: testy, baza i dane cenowe z ostatnich 24 godzin.');
    }
    if (!await this.store.verifyPreview(preview)) conflict('Nie potwierdzono udanego testu GitHub Actions.');
    // Adapter must update main by fast-forward only, from the verified source commit.
    return this.store.publish({ draft, preview, actor, approvedAt: this.clock().toISOString() });
  }

  async rollback(input, actor) {
    validActor(actor);
    if (!/^(?:[a-f0-9]{40}|[a-f0-9-]{36})$/.test(input.revision ?? '')) throw new PanelError(422, 'Nieprawidlowa wersja historii.');
    const record = await this.store.getRevision(input.revision);
    if (!record?.model) throw new PanelError(404, 'Nie znaleziono wersji szkicu.');
    const snapshot = await this.store.snapshot();
    return this.save({ sourceRevision: snapshot.source.revision, sourceHash: snapshot.source.policyHash,
      expectedRevision: input.expectedRevision, model: record.model, reason: `Przywrocenie szkicu ${input.revision.slice(0, 8)}: ${record.reason}`.slice(0, 500) }, actor, 'rollback', input.revision);
  }
}
