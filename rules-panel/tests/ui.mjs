import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { chromium } from "../../node_modules/playwright/index.mjs";

const origin = process.env.PANEL_URL ?? "http://127.0.0.1:4317";
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
await mkdir(new URL("../.impeccable/review/", import.meta.url), {
  recursive: true,
});
try {
  await context.route("**/api/workspace", route => route.fulfill({ status: 404, json: {} }));
  await page.goto(origin);
  await page
    .getByRole("heading", { name: "Zasady cenowe", exact: true })
    .waitFor();
  await page.locator('[data-rule-id="location:city"]').waitFor();
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: new URL(
      "../.impeccable/review/desktop-viewport.png",
      import.meta.url,
    ).pathname.replace(/^\/(.:)/, "$1"),
  });
  await page.screenshot({
    path: new URL(
      "../.impeccable/review/desktop.png",
      import.meta.url,
    ).pathname.replace(/^\/(.:)/, "$1"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page.getByRole('button', { name: 'Podgląd zmian', exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "Opublikuj", exact: true })
      .isDisabled(),
    true,
  );
  await page.getByRole('button', { name: 'Zasady cenowe', exact: true }).click();
  await page
    .locator('[data-rule-id="location:city"]')
    .getByRole("button")
    .click();
  await page
    .getByLabel("Stawka minimalna (PLN / dobę)", { exact: true })
    .fill("75");
  await page.getByRole("button", { name: "Zapisz w szkicu" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  assert.match(
    await page.locator('[data-rule-id="location:city"]').innerText(),
    /75/,
  );
  await page.reload();
  await page.locator('[data-rule-id="location:city"]').waitFor();
  assert.match(
    await page.locator('[data-rule-id="location:city"]').innerText(),
    /75/,
  );
  await page
    .getByRole("button", { name: "Sprawdź reguły", exact: true })
    .click();
  await page.getByLabel("Lokalizacja", { exact: true }).selectOption("WR1");
  assert.match(await page.locator(".result-primary").innerText(), /75 PLN/);
  await page.getByLabel("Lokalizacja", { exact: true }).selectOption("SZLO");
  assert.match(await page.locator(".result-primary").innerText(), /130 PLN/);
  await page.getByRole("button", { name: /Podgląd zmian/ }).click();
  await page.getByText('Eksport i przywracanie szkicu', { exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Pobierz propozycję JSON" }).click(),
  ]);
  assert.match(download.suggestedFilename(), /^discovercars-zasady-szkic-/);
  const proposal = JSON.parse(await readFile(await download.path(), "utf8"));
  assert.equal(
    proposal.files["pricing-rules.config.example.json"].pricing
      .locationTypeFloorsPlnDay.minimumRatesByKind.city,
    75,
  );
  assert.equal(proposal.status, "draft");
  const intercepted = await (
    await context.request.get(`${origin}/policy-snapshot.json`)
  ).json();
  await page.route("**/policy-snapshot.json", (route) =>
    route.fulfill({
      json: {
        ...intercepted,
        source: { ...intercepted.source, policyHash: "0".repeat(64) },
      },
    }),
  );
  await page.getByRole("button", { name: "Pobierz propozycję JSON" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Zmieniona wersja zasad" })
    .waitFor();
  await page.unroute("**/policy-snapshot.json");
  await page
    .getByRole("button", { name: "Klasy pojazdów", exact: true })
    .click();
  const toggle = page.getByRole("switch", { name: "Rekomendacje dla CDMV" });
  await toggle.click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Rekomendacje dla CDMV"]').checked === false);
  assert.equal(await toggle.isChecked(), false);
  await page
    .getByRole("button", { name: "Historia szkicu", exact: true })
    .click();
  assert.ok((await page.locator(".history-list li").count()) >= 2);
  await page
    .getByRole("button", { name: "Zasady cenowe", exact: true })
    .click();
  await page.getByRole("button", { name: "Dodaj regułę" }).click();
  await page
    .getByLabel("Rodzaj nowej reguły", { exact: true })
    .selectOption("protected");
  await page.getByLabel("Data startu od").fill("2027-02-01");
  await page.getByLabel("Data startu do").fill("2027-02-07");
  await page.getByRole("button", { name: "Zapisz w szkicu" }).click();
  await page.getByRole("dialog").waitFor({ state: "hidden" });
  await page
    .getByRole("button", { name: "Podgląd zmian", exact: false })
    .click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByText('Eksport i przywracanie szkicu', { exact: true }).click();
  await page.getByRole("button", { name: "Przywróć zasady źródłowe" }).click();
  await page
    .getByRole("button", { name: "Zasady cenowe", exact: true })
    .click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: new URL(
      "../.impeccable/review/mobile-viewport.png",
      import.meta.url,
    ).pathname.replace(/^\/(.:)/, "$1"),
  });
  await page.screenshot({
    path: new URL(
      "../.impeccable/review/mobile.png",
      import.meta.url,
    ).pathname.replace(/^\/(.:)/, "$1"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await page
    .getByRole("button", { name: "Sprawdź reguły", exact: true })
    .click();
  await page.getByLabel("Stawka z bazy (PLN / dobę)").fill("30");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: new URL(
      "../.impeccable/review/mobile-preview.png",
      import.meta.url,
    ).pathname.replace(/^\/(.:)/, "$1"),
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  for (const width of [320, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `preview overflow at ${width}`,
    );
    await page
      .getByRole("button", { name: "Zasady cenowe", exact: true })
      .click();
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `rules overflow at ${width}`,
    );
    await page
      .getByRole("button", { name: "Sprawdź reguły", exact: true })
      .click();
  }
  const badWrite = await context.request.post(
    `${origin}/policy-snapshot.json`,
    { data: { apply: true } },
  );
  assert.equal(badWrite.status(), 405);
  await page.getByRole('button',{name:'Zasady cenowe',exact:true}).click();
  await page.setViewportSize({width:390,height:844});
  const editorButton=page.locator('[data-rule-id="location:city"]').getByRole('button');
  await editorButton.click();
  await page.getByLabel('Stawka minimalna (PLN / dobę)',{exact:true}).fill('-5');
  await page.getByRole('button',{name:'Zapisz w szkicu'}).click();
  assert.equal(await page.getByRole('dialog').isVisible(),true);
  assert.equal(await page.getByLabel('Stawka minimalna (PLN / dobę)',{exact:true}).evaluate(element=>element.validity.valid),false);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({state:'hidden'});
  assert.equal(await editorButton.evaluate(element=>element===document.activeElement),true);
  console.log(
    "UI PASS: rules, edit, persistence, preview, export, class toggle, history, protected dates, reset, mobile, no page errors.",
  );
} catch (error) {
  console.error("Browser errors:", errors);
  console.error(
    "Page excerpt:",
    (await page.locator("body").innerText()).slice(0, 2500),
  );
  throw error;
} finally {
  await browser.close();
}
