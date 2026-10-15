import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { chromium } from "../../node_modules/playwright/index.mjs";
import { readSnapshot } from "../server/snapshot.mjs";

let server;
let browser;
let origin;
let snapshot;
const loadedAt = "2026-10-15T09:30:00.000Z";

before(async () => {
  snapshot = await readSnapshot();
  server = await createServer({
    root: fileURLToPath(new URL("../", import.meta.url)),
    logLevel: "silent",
    server: { port: 0, strictPort: false, open: false },
  });
  await server.listen();
  origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

for (const mode of ["local", "hosted-preview"]) {
  for (const width of [1440, 320]) {
    test(`${mode} labels remain truthful at ${width}px after saving a browser draft`, async (t) => {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
      });
      t.after(() => context.close());
      const page = await context.newPage();
      await page.route("**/api/workspace", route => route.fulfill({ status: 404, json: {} }));
      page.setDefaultTimeout(5000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const hosted = mode === "hosted-preview";
      await page.route("**/policy-snapshot.json", (route) =>
        route.fulfill({
          json: {
            ...snapshot,
            source: { ...snapshot.source, loadedAt },
            capabilities: hosted
              ? {
                  mode,
                  authentication: "cloudflare-access",
                  publish: false,
                }
              : { mode, publish: false },
          },
        }),
      );
      await page.goto(origin);
      await page.locator('[data-rule-id="location:city"]').waitFor();
      const modeLabel = page.locator("main > .context-line");
      assert.match(
        await modeLabel.innerText(),
        hosted ? /Podgląd online.*Stan na/ : /Tryb lokalny.*Stan na/,
      );
      const timestamp = modeLabel.locator("time");
      assert.equal(await timestamp.isVisible(), true);
      assert.equal(await timestamp.getAttribute("datetime"), loadedAt);
      assert.match(await timestamp.innerText(), /15\.10\.2026.*11:30/);
      await page.getByRole('button', { name: 'Podgląd zmian', exact: true }).click();
      assert.match(await page.locator('main').innerText(), /Publikacja niepodłączona.*Zmiany pozostają w szkicu tej przeglądarki/);
      assert.equal(
        await page.getByRole("button", { name: "Opublikuj", exact: true }).isDisabled(),
        true,
      );
      if (hosted) {
        assert.doesNotMatch(
          await page.locator("body").innerText(),
          /Wersja lokalna|Tryb lokalny|Lokalny odczyt konfiguracji|dane pozostają lokalnie/,
        );
        assert.doesNotMatch(
          await page.locator(".disabled-wrapper").getAttribute("title"),
          /panel jest lokalny|wymaga.*logowania/i,
        );
      }
      await page.getByRole('button', { name: 'Zasady cenowe', exact: true }).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );

      await page.locator('[data-rule-id="location:city"]').getByRole("button").click();
      await page.getByLabel("Stawka minimalna (PLN / dobę)", { exact: true }).fill("75");
      await page.getByRole("button", { name: "Zapisz w szkicu" }).click();
      await page.getByRole("dialog").waitFor({ state: "hidden" });
      assert.equal(await timestamp.getAttribute("datetime"), loadedAt);
      assert.equal(await timestamp.isVisible(), true);
      assert.match(await page.locator('.draft-status').innerText(), /szkic tylko w tej przeglądarce.*nieopublikowane/);
      assert.match(await page.locator('.draft-status').getAttribute('title'), /Zapisano:/);

      await page.getByRole("button", { name: "Źródła i publikacja", exact: true }).click();
      await page.getByText('Konfiguracja techniczna', { exact: true }).click();
      const sources = await page.locator("main").innerText();
      assert.match(sources, hosted ? /Podgląd online/ : /Tryb lokalny/);
      assert.match(
        sources,
        hosted ? /Migawka konfiguracji.*wersja/ : /Lokalny odczyt konfiguracji.*wersja/,
      );
      assert.match(sources, /Publikacja do GitHub[\s\S]*Niepodłączona/);
      if (hosted) {
        assert.match(sources, /Cloudflare Access/);
        assert.doesNotMatch(sources, /Lokalny odczyt|Tryb lokalny|Docelowo:|Do uruchomienia/);
      }
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
    });
  }
}
