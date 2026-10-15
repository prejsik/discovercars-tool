import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const YAML = require("yaml");
const source = await readFile(new URL("../.github/workflows/rules-panel-preview.yml", import.meta.url), "utf8").catch(() => "");
const workflow = YAML.parse(source);

test("preview workflow has a read-only token and no plaintext dispatch fields", () => {
  assert.ok(workflow, "an isolated encrypted preview workflow is required");
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.deepEqual(Object.keys(workflow.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(workflow.on.workflow_dispatch.inputs).sort(), ["preview_id", "request"]);
  assert.equal(workflow["run-name"], "Rules preview ${{ inputs.preview_id }}");
});

test("only an encrypted fixed-name file is uploaded and checkout cannot push", () => {
  assert.ok(workflow);
  const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);
  const uploads = steps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].with.path, "${{ runner.temp }}/rules-panel-preview/preview.enc");
  assert.equal(uploads[0].with.name, "rules-panel-preview-${{ inputs.preview_id }}");
  const checkouts = steps.filter((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkouts.length, 2);
  assert.ok(checkouts.every((step) => step.with["persist-credentials"] === false));
  assert.equal(checkouts[0].with.ref, "${{ github.sha }}");
  assert.equal(checkouts[1].with.ref, "${{ steps.validate.outputs.source_revision }}");
  assert.ok(steps.findIndex((step) => step.id === "validate") < steps.indexOf(checkouts[1]));
  assert.ok(steps.filter((step) => step.run).every((step) => !step.run.includes("${{ inputs.")),
    "untrusted dispatch text must be passed through environment variables, not shell source");
});
