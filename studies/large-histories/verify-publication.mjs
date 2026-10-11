/** Run with npx tsx; exercises a served production app without importing its parser. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { chromium, expect, firefox } from "@playwright/test";
import { longHistory } from "../../tests/fixtures/long-history.ts";

const { values } = parseArgs({
  options: {
    url: { type: "string", default: "https://antonsoo.github.io/splitscope/" },
    out: { type: "string" },
    screenshots: { type: "string" },
  },
});
assert(values.out, "--out is required");
const input = Buffer.from(longHistory());
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const observations = [];
for (const [name, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    const offOrigin = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== new URL(values.url).origin)
        offOrigin.push(request.url());
    });
    await page.goto(values.url);
    // A local import and its bundled worker must still work after disconnecting.
    await context.setOffline(true);
    await page.locator("#file-input").setInputFiles({
      name: "synthetic-long-history.lss",
      mimeType: "text/xml",
      buffer: input,
    });
    await expect(page.locator(".hero-clock")).toHaveText("0:01.00", { timeout: 25_000 });
    await page.getByRole("spinbutton", { name: "Window", exact: true }).fill("140000");
    await page.getByRole("spinbutton", { name: "Window", exact: true }).press("Tab");
    await expect(page.locator(".dist-grid")).toContainText("140,000 timings in 64 bins");
    const binCount = await page
      .locator(".dist-grid rect[data-count]")
      .evaluateAll((nodes) =>
        nodes.reduce((sum, node) => sum + Number(node.getAttribute("data-count")), 0),
      );
    assert.equal(binCount, 140_000);
    const circles = await page.locator("svg circle").count();
    assert(circles < 4000);
    await page.locator("#odds-assumptions > summary").click();
    await expect(page.locator("#odds-assumptions")).toContainText(
      "a PB occurred in 30.9% of evaluated windows",
    );
    await expect(page.locator("#odds-assumptions")).toContainText(
      "not a per-runner calibration guarantee",
    );
    if (values.screenshots) {
      mkdirSync(values.screenshots, { recursive: true });
      for (const width of [1440, 375]) {
        await page.setViewportSize({ width, height: 900 });
        // Keep the target below the sticky header in both screenshot engines.
        await page
          .locator(".dist-grid")
          .evaluate((node) => node.scrollIntoView({ block: "center" }));
        await page.locator(".dist-grid").screenshot({
          path: join(values.screenshots, `hosted-${name}-${width}.png`),
        });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    await page.locator("#practice-window").fill("70000");
    await page.getByRole("button", { name: "Apply range", exact: true }).click();
    await expect(page.locator(".review-previous.review-summary")).toContainText("#1–#70000");
    await expect(page.locator(".review-recent.review-summary")).toContainText("#70001–#140000");
    const download = page.waitForEvent("download", { timeout: 90_000 });
    await page.locator("#export-practice").click();
    const file = await (await download).path();
    assert(file);
    const bytes = readFileSync(file);
    const payload = JSON.parse(bytes);
    assert.equal(payload.source.sha256, sha256(input));
    assert.equal(payload.source.bytes, input.length);
    assert.equal(payload.run.recordedAttempts, 140_000);
    assert.equal(payload.segments.length, 1);
    const records = payload.segments[0].history;
    const attempts = [
      ...payload.comparison.previous.attempts,
      ...payload.comparison.recent.attempts,
    ];
    assert.equal(records.length, 140_000);
    assert.equal(attempts.length, 140_000);
    for (let index = 0; index < 140_000; index++) {
      const id = index + 1;
      const time = { realTime: 10 + (id % 10), gameTime: null };
      assert.deepEqual(records[index], { attemptId: id, time });
      assert.equal(attempts[index].attempt.id, id);
      assert.deepEqual(attempts[index].attempt.time, time);
      assert.equal(attempts[index].outcome, "completed");
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(offOrigin, []);
    observations.push({
      browser: name,
      offlineImportAndExport: true,
      binCount,
      circles,
      exportedAttempts: attempts.length,
      exportedSegmentRecords: records.length,
      allRecordMismatches: 0,
      exportBytes: bytes.length,
      exportSha256: sha256(bytes),
      forecastLimitVisible: true,
      errors,
      offOrigin,
    });
  } finally {
    await browser.close();
  }
}
mkdirSync(dirname(values.out), { recursive: true });
writeFileSync(
  values.out,
  `${JSON.stringify(
    {
      checkedAt: new Date().toISOString(),
      url: values.url,
      input: { bytes: input.length, sha256: sha256(input), synthetic: true },
      observations,
    },
    null,
    2,
  )}\n`,
);
console.log(`Verified complete offline imports and exports in ${observations.length} browsers.`);
