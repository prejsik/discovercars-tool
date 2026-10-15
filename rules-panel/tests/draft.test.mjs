import test from "node:test";
import assert from "node:assert/strict";
import {
  diffDocuments,
  readDraft,
  persistDraft,
  createProposal,
} from "../src/draft.mjs";

const base = { pricing: { minimum: 35 }, excel: { groups: ["A"] } };
const edited = { pricing: { minimum: 40 }, excel: { groups: ["A"] } };
const storage = () => {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
};

test("diff identifies only changed policy values", () => {
  assert.deepEqual(diffDocuments(base, edited), [
    { path: "pricing.minimum", before: 35, after: 40 },
  ]);
  assert.deepEqual(diffDocuments(base, base), []);
});

test("a saved draft is bound to the current source version", () => {
  const store = storage();
  persistDraft(store, { sourceHash: "a", model: edited, history: [] });
  assert.equal(readDraft(store, "a").state, "restored");
  assert.equal(readDraft(store, "b").state, "stale");
});

test("invalid storage is recoverable and never silently applied", () => {
  const store = { getItem: () => "{invalid" };
  assert.equal(readDraft(store, "a").state, "invalid");
});

test("corrupt history entries cannot crash the history view", () => {
  const store = {
    getItem: () =>
      JSON.stringify({
        schemaVersion: 1,
        sourceHash: "a",
        model: edited,
        history: [null],
      }),
  };
  assert.equal(readDraft(store, "a").state, "invalid");
});

test("an older tab cannot overwrite a newer saved draft", () => {
  const store = storage();
  const first = persistDraft(store, {
    sourceHash: "a",
    model: base,
    history: [],
    expectedRevision: null,
  });
  const newer = persistDraft(store, {
    sourceHash: "a",
    model: edited,
    history: [],
    expectedRevision: first.revision,
  });
  assert.throws(
    () =>
      persistDraft(store, {
        sourceHash: "a",
        model: base,
        history: [],
        expectedRevision: first.revision,
      }),
    /innej karcie/,
  );
  assert.equal(readDraft(store, "a").draft.revision, newer.revision);
  assert.deepEqual(readDraft(store, "a").draft.model, edited);
});

test("proposal cannot be exported with validation errors or stale version", () => {
  const args = {
    source: { policyHash: "a", revision: "abc" },
    currentHash: "a",
    documents: edited,
    originalDocuments: base,
    errors: [],
  };
  const result = createProposal(args);
  assert.equal(result.status, "draft");
  assert.equal(result.targetRepository, "prejsik/discovercars-tool");
  assert.equal(result.changes.length, 1);
  assert.throws(() => createProposal({ ...args, currentHash: "b" }), /wersj/);
  assert.throws(
    () => createProposal({ ...args, errors: [{ message: "error" }] }),
    /błędy/,
  );
});
