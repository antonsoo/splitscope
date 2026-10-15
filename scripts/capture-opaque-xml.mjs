/** Import controlled XML annotations offline and inspect complete downloaded calculations. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, expect, firefox } from "@playwright/test";

const [url, output, mode = "after"] = process.argv.slice(2);
assert(url && output && ["before", "after"].includes(mode), "URL OUTPUT before|after required");
await mkdir(output, { recursive: true });
const cases = execFileSync("python3", ["studies/opaque-xml/inputs.py"], { encoding: "utf8" })
  .trim()
  .split("\n")
  .map(JSON.parse);
const input = cases.find((c) => c.id === "destrega-comment-Icon").xml;
const malformed = cases.find((c) => c.id === "malformed-opaque-GameIcon").xml;
const named = cases.find((c) => c.id === "cdata-name-Icon").xml;
const expectedName =
  mode === "before" ? "Cave <Icon/> Entrance" : "Cave <Icon>literal</Icon> Entrance";
const expectedTotal = mode === "before" ? 1609.806 : 1511.017;
const hash = (text) => createHash("sha256").update(text).digest("hex");
const rows = [];
for (const [name, engine] of [
  ["chromium", chromium],
  ["firefox", firefox],
]) {
  const browser = await engine.launch();
  for (const width of [1440, 375]) {
    console.log(mode, name, width);
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.addInitScript(() => {
      window.opaqueIssues = [];
      addEventListener("securitypolicyviolation", (event) =>
        window.opaqueIssues.push(event.violatedDirective),
      );
      addEventListener("unhandledrejection", (event) =>
        window.opaqueIssues.push(String(event.reason)),
      );
    });
    await page.route("**/*", async (route) => {
      assert.equal(new URL(route.request().url()).origin, new URL(url).origin);
      await route.continue();
    });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    if (width === 375) await page.locator("#theme-toggle").click();
    // Disconnect before the first file import: no worker/module warmup.
    await context.setOffline(true);
    async function upload(xml, filename) {
      await page
        .locator("#file-input")
        .setInputFiles({ name: filename, mimeType: "application/xml", buffer: Buffer.from(xml) });
    }
    async function calculation() {
      const pending = page.waitForEvent("download");
      await page.locator("#export-best").click();
      const path = await (await pending).path();
      assert(path);
      return JSON.parse(await readFile(path, "utf8"));
    }
    await upload(input, "destrega-xml-comment-control.lss");
    await expect(page.locator("#best-total")).toHaveText(
      mode === "before" ? "26:49.806" : "25:11.017",
    );
    const result = await calculation();
    assert.equal(result.source.sha256, hash(input));
    assert(Math.abs(result.route.totalSeconds - expectedTotal) < 1e-9);
    const hasRecord = result.segments[15].history.some((entry) => entry.attemptId === 58);
    assert.equal(hasRecord, mode === "after");
    const historyLeg = result.evidence.find((row) => row.leg.source.kind === "history");
    if (mode === "after") {
      assert.equal(historyLeg.leg.source.attemptId, 58);
      assert.deepEqual(
        historyLeg.records.map((r) => r.time.realTime),
        [null, 83.691],
      );
      await expect(page.locator(".best-detail")).toContainText("History #58");
    }
    if (
      (name === "chromium" && width === 1440) ||
      (mode === "after" && width === 375 && name === "firefox")
    ) {
      const height = await page
        .locator("#best-route")
        .evaluate((node) => node.getBoundingClientRect().height);
      const margin = await page
        .locator(".topbar")
        .evaluate((node) => node.getBoundingClientRect().height + 32);
      await page.setViewportSize({ width, height: Math.ceil(height + margin) + 100 });
      await page
        .locator("#best-route")
        .evaluate(
          (node, gap) => scrollTo(0, node.getBoundingClientRect().top + scrollY - gap),
          margin,
        );
      await page
        .locator("#best-route")
        .screenshot({ path: `${output}/${mode}-${name}-${width}.png` });
      await page.setViewportSize({ width, height: 1000 });
    }
    await upload(malformed, "malformed-opaque-control.lss");
    if (mode === "after") {
      await expect(page.locator("#import-error")).toContainText("Could not parse this file as XML");
      await expect(page.locator("#best-total")).toHaveText("25:11.017");
      assert.deepEqual(await calculation(), result);
    } else {
      await expect(page.locator("#best-total")).toHaveText("2:40.000");
      assert.equal((await calculation()).run.gameName, "Crystal Caverns");
    }
    await upload(named, "literal-cdata-name-control.lss");
    await expect(page.getByText(expectedName, { exact: true }).first()).toBeVisible();
    const namedResult = await calculation();
    assert.equal(namedResult.segments[0].name, expectedName);
    assert.equal(namedResult.source.sha256, hash(named));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.opaqueIssues), []);
    rows.push({
      engine: name,
      version: browser.version(),
      width,
      disconnectedBeforeFirstImport: true,
      totalSeconds: result.route.totalSeconds,
      record58Retained: hasRecord,
      malformedReplacementRejected: mode === "after",
      previousCalculationPreserved: mode === "after",
      cdataName: namedResult.segments[0].name,
      inputSha256: hash(input),
      errors,
      calculation: result,
    });
    await context.close();
  }
  await browser.close();
}
await writeFile(
  `${output}/${mode}.json`,
  `${JSON.stringify({ mode, controlledAnnotations: true, rows }, null, 2)}\n`,
);
