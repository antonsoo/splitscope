/** Real UI interactions and downloads, checked against independently verified native results. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, firefox } from "@playwright/test";

const study = dirname(fileURLToPath(import.meta.url));
const root = resolve(study, "../..");
const [
  base = "http://127.0.0.1:7894/splitscope/",
  output = resolve(study, "cache/browser"),
  mode = "after",
] = process.argv.slice(2);
const expected = JSON.parse(readFileSync(resolve(study, "results/expected.json"), "utf8"));
const original = readFileSync(resolve(root, "examples/recorded/re-loaded.lss"));
const controls = readFileSync(resolve(study, "controls/native-clocks.lss"));
const profiles =
  mode === "before"
    ? [["chromium", chromium, 1440, "dark"]]
    : [
        ["chromium", chromium, 1440, "dark"],
        ["chromium", chromium, 375, "light"],
        ["firefox", firefox, 1440, "light"],
        ["firefox", firefox, 375, "dark"],
      ];
mkdirSync(output, { recursive: true });
const receipts = [];
const sha = (data) => createHash("sha256").update(data).digest("hex");

for (const [name, engine, width, theme] of profiles) {
  const browser = await engine.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width, height: 1100 },
    deviceScaleFactor: 1,
    colorScheme: theme,
  });
  const page = await context.newPage();
  const problems = [];
  const external = [];
  const start = performance.now();
  page.on("pageerror", (error) => problems.push(error.message));
  page.on("request", (request) => {
    if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(base).origin)
      external.push(request.url());
  });
  await page.addInitScript(() => {
    window.studyErrors = [];
    addEventListener("unhandledrejection", (event) =>
      window.studyErrors.push(String(event.reason)),
    );
    addEventListener("securitypolicyviolation", (event) =>
      window.studyErrors.push(event.violatedDirective),
    );
  });
  const receipt = { engine: name, width, theme, url: base, mode, downloads: [], interactions: [] };
  try {
    await page.goto(base);
    if (mode !== "before") {
      await expect(page).toHaveTitle("splitscope · inspect your LiveSplit attempt history");
      await expect(page.locator("main h1")).toHaveText("Open the history behind your splits.");
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
    }
    if (theme === "light") await page.getByRole("button", { name: "Light", exact: true }).click();
    async function upload(bytes, filename) {
      await page
        .locator("#file-input")
        .setInputFiles({ name: filename, mimeType: "application/xml", buffer: bytes });
      await expect(page.locator("#practice-end")).toHaveValue(bytes === original ? "158" : "8");
    }
    async function download(label) {
      const promise = page.waitForEvent("download");
      await page.locator("#export-practice").click();
      const file = await promise;
      const bytes = readFileSync(await file.path());
      const data = JSON.parse(bytes);
      const path = `${name}-${width}-${label}.json`;
      writeFileSync(resolve(output, path), bytes);
      receipt.downloads.push({ label, file: path, sha256: sha(bytes), bytes: bytes.length });
      return data;
    }
    async function applyRange(window, endId) {
      await page.locator("#practice-window").fill(String(window));
      await page.locator("#practice-end").fill(String(endId));
      await page.locator("#practice-apply").click();
    }
    function check(data, source, config, synthetic) {
      assert.equal(data.schemaVersion, 2);
      assert.equal(data.source.sha256, source.sha256);
      assert.equal(data.source.synthetic, synthetic);
      assert.deepEqual(data.timeBudget, { previous: config.previous, recent: config.recent });
      assert.equal(data.comparison.window, config.window);
      assert.equal(data.comparison.endOrdinal, config.end);
      for (const side of ["previous", "recent"]) {
        assert.deepEqual(
          data.comparison[side].attempts.map((r) => r.attempt.id),
          config[side].clocks.map((r) => r.attemptId),
        );
      }
    }
    async function screenshot(target, filename) {
      await target.evaluate((element) => {
        const header = document.querySelector("header")?.getBoundingClientRect().height ?? 140;
        scrollTo(0, scrollY + element.getBoundingClientRect().top - header - 16);
      });
      await page.screenshot({ path: resolve(output, filename) });
      receipt.screenshot = filename;
    }
    if (mode === "before") {
      await upload(original, "re-loaded.lss");
      await expect(page.locator("#practice-time-budget")).toHaveCount(0);
      await expect(page.locator("#practice-reset-measure")).toHaveCount(0);
      const data = await download("before");
      assert.equal(data.schemaVersion, 1);
      assert.equal(data.source.sha256, expected.reloaded.sha256);
      assert.equal(data.comparison.recent.segments[0].resets, 10);
      assert.equal(data.comparison.recent.segments[5].resets, 4);
      assert.equal(data.timeBudget, undefined);
      await screenshot(page.locator("#practice-review"), "before-chromium-1440.png");
    } else {
      await page
        .getByRole("button", { name: "Open time-budget example (Re-Loaded)", exact: true })
        .click();
      await expect(page.locator("#practice-end")).toHaveValue("158");
      await page.evaluate(() => document.fonts.ready);
      const first = await download("recorded");
      check(first, expected.reloaded, expected.reloaded.groups[0], false);
      assert.equal(first.source.bytes, original.length);
      await context.setOffline(true);
      await page.locator("#practice-reset-measure").selectOption("elapsed");
      await page.locator("#practice-reset-order").selectOption("elapsed");
      const resetTable = page.getByRole("region", {
        name: "Practice reset comparison",
        exact: true,
      });
      const firstRow = resetTable.locator("tbody tr").first();
      await expect(firstRow).toContainText("Monestary");
      await expect(firstRow.locator("#resets-recent-5")).toContainText("48:18");
      await expect(firstRow.locator("#resets-recent-5")).toHaveAttribute(
        "aria-label",
        /48:18 elapsed, 4 of 4 timed/,
      );
      await expect(firstRow.locator("#resets-recent-5")).toContainText("4 / 4 timed");
      if (name === "chromium" && width === 1440)
        await screenshot(page.locator("#practice-time-budget"), "recorded-desktop.png");
      if (name === "firefox" && width === 375)
        await screenshot(resetTable.locator("..").locator("h3"), "recorded-phone.png");
      await page.locator("#resets-recent-5").click();
      await expect(
        page.getByRole("region", { name: "Practice attempts", exact: true }).getByRole("button"),
      ).toHaveText(["#154", "#140", "#138", "#132"]);
      await page.getByRole("button", { name: "Inspect attempt 132", exact: true }).click();
      await expect(page.locator("#practice-attempt-elapsed")).toContainText(
        "11:18 (includes pauses)",
      );
      await expect(page.locator(".review-detail")).toContainText("11/02/2021 14:22:56");
      await expect(page.locator(".review-detail")).toContainText("pause —");
      await page.locator("#resets-recent-0").click();
      await page.getByRole("button", { name: "Inspect attempt 139", exact: true }).click();
      await expect(page.locator("#practice-attempt-elapsed")).toContainText(
        "0:00 (includes pauses)",
      );
      await expect(page.locator("#practice-attempt-title")).toContainText("Reset inferred: Desert");
      await page.getByRole("button", { name: "IGT", exact: true }).click();
      await expect(page.locator("#practice-attempt-elapsed")).toContainText(
        "0:00 (includes pauses)",
      );
      await expect(page.locator("#practice-reset-measure")).toHaveValue("elapsed");
      await page
        .getByRole("button", { name: theme === "dark" ? "Light" : "Dark", exact: true })
        .click();
      await expect(page.locator("#practice-reset-order")).toHaveValue("elapsed");
      assert.deepEqual((await download("filtered-offline")).timeBudget, first.timeBudget);
      await page.locator("#elapsed-recent-total").click();
      await expect(page.locator("#practice-outcome")).toHaveValue("all");
      await expect(page.locator(".review-list-status")).toContainText("30 matching attempts");
      await applyRange(17, 79);
      check(
        await download("historical-offline"),
        expected.reloaded,
        expected.reloaded.groups[1],
        false,
      );
      await applyRange(0, 79);
      await expect(page.locator("#practice-range-error")).toContainText(
        "applied comparison is unchanged",
      );
      check(
        await download("invalid-range-retained"),
        expected.reloaded,
        expected.reloaded.groups[1],
        false,
      );
      await applyRange(158, 158);
      check(
        await download("whole-history-offline"),
        expected.reloaded,
        expected.reloaded.groups[2],
        false,
      );
      receipt.interactions.push(
        "real native example",
        "time order",
        "exact reset members",
        "raw timestamp and absent pause",
        "saved zero duration",
        "timing-method and theme preservation",
        "offline filtered and complete exports",
        "historical cohorts",
        "invalid range retains report",
      );
      await context.setOffline(false);
      await upload(controls, "native-clocks.lss");
      const control = await download("native-controls");
      check(control, expected.controls, expected.controls.groups[2], null);
      await expect(page.locator("#practice-time-budget")).toContainText("1 missing timestamp pair");
      await expect(page.locator("#practice-time-budget")).toContainText("1 end-before-start pair");
      await expect(page.locator("#practice-time-budget")).toContainText("2 timed attempts overlap");
      await page.locator("#elapsed-recent-completed").click();
      await page.getByRole("button", { name: "Inspect attempt 1", exact: true }).click();
      await expect(page.locator("#practice-attempt-elapsed")).toContainText(
        "2:00 (includes pauses)",
      );
      await expect(page.locator(".review-detail")).toContainText("pause 0:30.75");
      await page.getByRole("button", { name: "Inspect attempt 6", exact: true }).click();
      await expect(page.locator("#practice-attempt-elapsed")).toContainText(
        "— (missing timestamp pair)",
      );
      await expect(page.locator(".review-detail")).toContainText("RTA 0:50.00");
      await applyRange(1, 8);
      const witness = await download("overlap-outside-groups");
      assert.equal(witness.timeBudget.recent.clocks[0].overlap.attemptId, 5);
      assert.equal(witness.timeBudget.recent.total.overlappingAttempts, 1);
      assert.deepEqual(
        witness.comparison.previous.attempts.map((r) => r.attempt.id),
        [7],
      );
      await page.locator("#elapsed-recent-total").click();
      await page.getByRole("button", { name: "Inspect attempt 8", exact: true }).click();
      await expect(page.locator(".review-detail")).toContainText("Overlaps attempt #5");
      await context.setOffline(true);
      assert.deepEqual((await download("controls-offline")).timeBudget, witness.timeBudget);
      receipt.interactions.push(
        "native writer pauses, missing end and reversed clocks",
        "overlap witness outside both groups",
        "upload provenance unknown",
      );
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
        false,
      );
      const axe = await new AxeBuilder({ page }).analyze();
      assert.deepEqual(axe.violations, []);
      receipt.axeViolations = 0;
    }
    assert.deepEqual(problems, []);
    assert.deepEqual(external, []);
    assert.deepEqual(await page.evaluate(() => window.studyErrors), []);
    receipt.externalRequests = 0;
    receipt.runtimeErrors = 0;
    receipt.elapsedMilliseconds = Math.round(performance.now() - start);
    receipts.push(receipt);
    writeFileSync(resolve(output, "browser.json"), `${JSON.stringify(receipts, null, 2)}\n`);
    console.log(`${name} ${width}: ${receipt.downloads.length} real JSON downloads checked`);
  } finally {
    await browser.close();
  }
}
