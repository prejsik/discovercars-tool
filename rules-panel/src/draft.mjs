export const DRAFT_KEY = "discovercars-rules-draft-v1";
const KEY = DRAFT_KEY;

export function diffDocuments(before, after, path = "") {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (
    before &&
    after &&
    typeof before === "object" &&
    typeof after === "object" &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    return [
      ...new Set([...Object.keys(before), ...Object.keys(after)]),
    ].flatMap((key) =>
      diffDocuments(before[key], after[key], path ? `${path}.${key}` : key),
    );
  }
  return [{ path, before: before ?? null, after: after ?? null }];
}

export function persistDraft(
  storage,
  { sourceHash, model, history, expectedRevision = null },
) {
  const previous = storage.getItem(KEY);
  let actualRevision = null;
  try {
    actualRevision = JSON.parse(previous)?.revision ?? null;
  } catch {
    /* Invalid drafts may be explicitly replaced. */
  }
  if (actualRevision !== expectedRevision) {
    const conflict = new Error(
      "Szkic został zmieniony w innej karcie. Wczytaj nowszą wersję przed zapisem.",
    );
    conflict.code = "DRAFT_CONFLICT";
    throw conflict;
  }
  const record = {
    schemaVersion: 1,
    revision: crypto.randomUUID(),
    sourceHash,
    model,
    history: history.slice(-50),
    savedAt: new Date().toISOString(),
  };
  storage.setItem(KEY, JSON.stringify(record));
  return record;
}

export function withDraftLock(task) {
  if (!globalThis.navigator?.locks)
    throw new Error(
      "Ta przeglądarka nie udostępnia bezpiecznej blokady zapisu szkicu.",
    );
  return navigator.locks.request(KEY, task);
}

export function readDraft(storage, sourceHash) {
  try {
    const raw = storage.getItem(KEY);
    if (!raw) return { state: "empty" };
    const draft = JSON.parse(raw);
    if (
      draft.schemaVersion !== 1 ||
      !draft.model ||
      !Array.isArray(draft.history) ||
      !draft.history.every(
        (entry) =>
          entry &&
          typeof entry.id === "string" &&
          typeof entry.label === "string" &&
          Number.isFinite(Date.parse(entry.at)) &&
          Array.isArray(entry.changes),
      ) ||
      typeof draft.sourceHash !== "string"
    )
      return {
        state: "invalid",
        revision: typeof draft.revision === "string" ? draft.revision : null,
      };
    return {
      state: draft.sourceHash === sourceHash ? "restored" : "stale",
      draft,
    };
  } catch {
    return { state: "invalid" };
  }
}

export function createProposal({
  source,
  currentHash,
  documents,
  originalDocuments,
  errors,
}) {
  if (source.policyHash !== currentHash)
    throw new Error("Zmieniona wersja zasad. Odśwież źródło przed eksportem.");
  if (errors.length)
    throw new Error("Szkic zawiera błędy. Popraw je przed eksportem.");
  const changes = diffDocuments(originalDocuments, documents);
  if (!changes.length) throw new Error("Szkic nie zawiera zmian.");
  return {
    schemaVersion: 1,
    status: "draft",
    targetRepository: "prejsik/discovercars-tool",
    createdAt: new Date().toISOString(),
    baseRevision: source.revision,
    basePolicyHash: source.policyHash,
    changes,
    files: {
      "pricing-rules.config.example.json": documents.pricing,
      "excel-rate-update.config.example.json": documents.excel,
    },
  };
}

export function downloadJson(value, filename) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
