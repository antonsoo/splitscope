/** Exercise built uploads/downloads offline and retain before/after evidence. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { chromium, expect, firefox } from "@playwright/test";

const [url, output, mode = "after"] = process.argv.slice(2);
if (!url || !output || !["before", "after"].includes(mode)) {
  throw new Error("Usage: node scripts/capture-xml-evidence.mjs URL OUTPUT [before|after]");
}
await mkdir(output, { recursive: true });
const original = await readFile("tests/fixtures/combined-best.lss", "utf8");
const attributed = original.replaceAll(/<(RealTime|GameTime)>/g, '<$1 xml:space="preserve">');
const duplicate = original.replace(/<BestSegmentTime>[\s\S]*?<\/BestSegmentTime>/, "$&$&");
const hash = (value) => createHash("sha256").update(value).digest("hex");
const observations = [];
for (const [name, engine] of [
  ["chromium", chromium],
  ["firefox", firefox],
]) {
  const browser = await engine.launch();
  for (const width of [1440, 375]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    console.log(`${mode}: ${name} ${width}`);
    const problems = [];
    page.on("pageerror", (error) => problems.push(String(error)));
    await page.addInitScript(() => {
      Object.assign(window, { xmlIssues: [] });
      addEventListener("securitypolicyviolation", (event) =>
        window.xmlIssues.push(event.violatedDirective),
      );
      addEventListener("unhandledrejection", (event) =>
        window.xmlIssues.push(String(event.reason)),
      );
    });
    await page.route("**/*", async (route) => {
      assert.equal(new URL(route.request().url()).origin, new URL(url).origin);
      await route.continue();
    });
    await page.goto(url);
    await page.evaluate(() => document.fonts.ready);
    if (width === 375) await page.locator("#theme-toggle").click();
    await page.context().setOffline(true);
    async function upload(xml, fileName) {
      await page
        .locator("#file-input")
        .setInputFiles({ name: fileName, mimeType: "application/xml", buffer: Buffer.from(xml) });
    }
    async function download() {
      const pending = page.waitForEvent("download");
      await page.locator("#export-best").click();
      const path = await (await pending).path();
      assert(path);
      return JSON.parse(await readFile(path, "utf8"));
    }
    await upload(attributed, "attributed-control.lss");
    await expect(page.locator("#best-total")).toHaveText(
      mode === "before" ? "Unavailable" : "1:10.000",
    );
    const realTime = await download();
    assert.equal(realTime.source.sha256, hash(attributed));
    assert.equal(realTime.route.totalSeconds, mode === "before" ? null : 70);
    const screenshot = `${mode}-${name}-${width}.png`;
    if (
      (mode === "before" && name === "chromium" && width === 1440) ||
      (mode === "after" && name === "chromium")
    ) {
      const height = await page
        .locator("#best-route")
        .evaluate((node) => node.getBoundingClientRect().height);
      await page.setViewportSize({ width, height: Math.max(1000, Math.ceil(height) + 200) });
      await page.locator("#best-route").screenshot({ path: `${output}/${screenshot}` });
      await page.setViewportSize({ width, height: 1000 });
    }
    await page.locator("#method-igt").click();
    await expect(page.locator("#best-total")).toHaveText(
      mode === "before" ? "Unavailable" : "1:32.000",
    );
    const gameTime = await download();
    assert.equal(gameTime.route.totalSeconds, mode === "before" ? null : 92);
    await upload(duplicate, "duplicate-gold-control.lss");
    if (mode === "after") {
      await expect(page.locator("#import-error")).toContainText("Duplicate <BestSegmentTime>");
      await expect(page.locator("#best-total")).toHaveText("1:32.000");
      assert.deepEqual(await download(), gameTime);
      const audit = await new AxeBuilder({ page })
        .include("#import-error")
        .include("#best-route")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      assert.deepEqual(audit.violations, []);
      if (name === "firefox") {
        await page.locator("#import-error").scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${screenshot}` });
      }
    } else {
      await expect(page.locator("#import-error")).not.toBeVisible();
      await expect(page.locator("#best-total")).not.toHaveText("Unavailable");
    }
    const replacement = await download();
    if (mode === "before") assert.equal(replacement.source.sha256, hash(duplicate));
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    assert.deepEqual(problems, []);
    assert.deepEqual(await page.evaluate(() => window.xmlIssues), []);
    observations.push({
      browser: name,
      version: browser.version(),
      width,
      mode,
      attributed: {
        source: realTime.source,
        realTime: realTime.route.totalSeconds,
        gameTime: gameTime.route.totalSeconds,
      },
      inputKind: "constructed control, uploaded through the file picker",
      duplicate: {
        rejected: mode === "after",
        source: replacement.source,
        total: replacement.route.totalSeconds,
        method: replacement.route.method,
      },
      offline: true,
      errors: problems,
    });
    await context.close();
  }
  await browser.close();
}
await writeFile(`${output}/${mode}.json`, `${JSON.stringify(observations, null, 2)}\n`);
console.log(`${mode}: four offline import/export workflows passed`);
