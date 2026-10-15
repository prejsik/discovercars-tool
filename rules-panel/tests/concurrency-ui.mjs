import assert from "node:assert/strict";
import { chromium } from "../../node_modules/playwright/index.mjs";

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const a = await context.newPage();
const b = await context.newPage();
const origin = process.env.PANEL_URL ?? "http://127.0.0.1:4317";
const errors = [];
for (const page of [a, b])
  page.on("pageerror", (error) => errors.push(error.message));
try {
  await context.route("**/api/workspace", route => route.fulfill({ status: 404, json: {} }));
  await a.goto(origin);
  await b.goto(origin);
  await b
    .locator('[data-rule-id="location:airport"]')
    .getByRole("button")
    .click();
  await b
    .getByLabel("Stawka minimalna (PLN / dobę)", { exact: true })
    .fill("40");
  await a.locator('[data-rule-id="location:city"]').getByRole("button").click();
  await a
    .getByLabel("Stawka minimalna (PLN / dobę)", { exact: true })
    .fill("75");
  await a.getByRole("button", { name: "Zapisz w szkicu" }).click();
  await a.getByRole("dialog").waitFor({ state: "hidden" });
  await b.getByRole("button", { name: "Zapisz w szkicu" }).click();
  await b.getByRole("dialog").getByRole("alert").waitFor();
  const first = await b.evaluate(() =>
    JSON.parse(localStorage.getItem("discovercars-rules-draft-v1")),
  );
  assert.deepEqual(
    first.model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind,
    { city: 75, airport: 30 },
  );
  await b.getByRole("button", { name: "Zamknij edycję" }).click();
  assert.equal(
    await b
      .locator('[data-rule-id="location:airport"]')
      .getByRole("button")
      .isDisabled(),
    true,
  );
  b.once("dialog", (dialog) => dialog.accept());
  await b.getByRole("button", { name: "Wczytaj nowszy szkic" }).click();
  await b
    .getByRole("alert")
    .filter({ hasText: "Szkic zmieniono w innej karcie" })
    .waitFor({ state: "hidden" });
  await b
    .locator('[data-rule-id="location:airport"]')
    .getByRole("button")
    .click();
  await b
    .getByLabel("Stawka minimalna (PLN / dobę)", { exact: true })
    .fill("40");
  await b.getByRole("button", { name: "Zapisz w szkicu" }).click();
  await b.getByRole("dialog").waitFor({ state: "hidden" });
  const second = await a.evaluate(() =>
    JSON.parse(localStorage.getItem("discovercars-rules-draft-v1")),
  );
  assert.deepEqual(
    second.model.pricing.pricing.locationTypeFloorsPlnDay.minimumRatesByKind,
    { city: 75, airport: 40 },
  );
  assert.notEqual(first.revision, second.revision);
  await a
    .getByRole("alert")
    .filter({ hasText: "Szkic zmieniono w innej karcie" })
    .waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS two-tab draft conflict: no lost updates, explicit reload, valid later save preserves both edits.",
  );
} finally {
  await browser.close();
}
