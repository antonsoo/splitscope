import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, firefox } from "@playwright/test";
import { parseRun } from "../src/core/parser.ts";
import { buildPracticeExport, comparePractice } from "../src/core/review.ts";

// npm run build; serve dist, then node --import tsx scripts/verify-practice.mjs [URL].
const url = process.argv[2] ?? "http://127.0.0.1:4331/splitscope/";
const bytes = await readFile("examples/recorded/zero-divide-2.lss");
const source = {
  name: "recorded/zero-divide-2.lss",
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
  synthetic: false,
};
const run = parseRun(bytes.toString("utf8"));
const expected = buildPracticeExport(run, comparePractice(run, "RealTime", 30), source);
const results = [];
await mkdir("docs/assets", { recursive: true });

for (const [name, engine] of Object.entries({ chromium, firefox })) {
  const browser = await engine.launch();
  try {
    for (const width of [1440, 375]) {
      const context = await browser.newContext({
        viewport: { width, height: width === 1440 ? 1040 : 1000 },
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      const errors = [];
      const external = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (new URL(request.url()).origin !== new URL(url).origin) external.push(request.url());
      });
      await page.goto(url);
      const start = performance.now();
      await page.getByRole("button", { name: "Open recorded practice (124 attempts)" }).click();
      await page.locator("#practice-window").waitFor();
      const importMs = performance.now() - start;
      await page.evaluate(() => document.fonts.ready);
      if (width === 375) await page.locator("#theme-toggle").click();
      await page.locator("#practice-review").evaluate((node) => {
        const header = document.querySelector(".topbar")?.getBoundingClientRect().height ?? 0;
        scrollTo(0, node.getBoundingClientRect().top + scrollY - header - 24);
      });
      const comparisonImage = `docs/assets/practice-${name}-${width}.png`;
      await page.screenshot({ path: comparisonImage });
      const scan = await new AxeBuilder({ page }).include("#practice-review").analyze();
      assert.deepEqual(
        scan.violations.map(({ id }) => id),
        [],
      );
      await context.setOffline(true);
      await page
        .getByRole("button", {
          name: "Inspect 4 inferred resets at Pixel in recent group",
          exact: true,
        })
        .click();
      assert.deepEqual(
        await page
          .getByRole("region", { name: "Practice attempts", exact: true })
          .getByRole("button")
          .allTextContents(),
        ["#120", "#118", "#117", "#114"],
      );
      // #114 has no first-segment entry. Show that absence instead of a zero or invented split.
      await page.getByRole("button", { name: "Inspect attempt 114", exact: true }).click();
      const detailImage = `docs/assets/practice-evidence-${name}-${width}.png`;
      if (width === 1440) await page.locator(".review-detail").screenshot({ path: detailImage });
      else await page.screenshot({ path: detailImage });
      assert.match(await page.locator(".review-detail").innerText(), /No history entry/);
      const detailScan = await new AxeBuilder({ page }).include("#practice-review").analyze();
      assert.deepEqual(
        detailScan.violations.map(({ id }) => id),
        [],
      );
      const downloadEvent = page.waitForEvent("download");
      await page.locator("#export-practice").click();
      const path = await (await downloadEvent).path();
      if (!path) throw new Error("Review download failed");
      const downloaded = await readFile(path, "utf8");
      assert.deepEqual(JSON.parse(downloaded), expected);
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      results.push({
        browser: name,
        version: browser.version(),
        width,
        importMs: Math.round(importMs),
        axeScans: 2,
        axeViolations: 0,
        pageErrors: 0,
        externalRequests: 0,
        offlineReview: true,
        downloadMatchesNative: true,
        downloadSha256: createHash("sha256").update(downloaded).digest("hex"),
        screenshots: [comparisonImage, detailImage],
      });
      await context.close();
    }
  } finally {
    await browser.close();
  }
}
await writeFile(
  "docs/verification-practice-browser.json",
  `${JSON.stringify({ source, results }, null, 2)}\n`,
);
console.log(JSON.stringify(results, null, 2));
