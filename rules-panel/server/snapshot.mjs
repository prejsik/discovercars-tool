import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const readJson = async (file) =>
  JSON.parse(await readFile(new URL(`../../${file}`, import.meta.url), "utf8"));

export async function readSnapshot({ mode = "local" } = {}) {
  const [pricing, excel, locations, manifest, git] = await Promise.all([
    readJson("pricing-rules.config.example.json"),
    readJson("excel-rate-update.config.example.json"),
    readJson("locations.config.json"),
    readJson("input/baseline-manifest.json"),
    exec("git", ["rev-parse", "HEAD"], { cwd: root, windowsHide: true }),
  ]);
  const documents = { pricing, excel, locations };
  return {
    schemaVersion: 1,
    source: {
      revision: git.stdout.trim(),
      policyHash: createHash("sha256")
        .update(JSON.stringify(documents))
        .digest("hex"),
      loadedAt: new Date().toISOString(),
    },
    baseline: {
      filename: manifest.source_filename,
      approvedAt: manifest.approved_at,
      sha256: manifest.workbook_sha256,
    },
    capabilities: {
      mode,
      ...(mode === "hosted-preview"
        ? { authentication: "cloudflare-access" }
        : {}),
      publish: false,
    },
    documents,
  };
}
