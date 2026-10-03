import { mkdir } from "node:fs/promises";
import { chromium } from "@playwright/test";

// Run against a local production preview after npm run build.
const url = process.argv[2] ?? "http://127.0.0.1:4331/splitscope/";
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1,
  reducedMotion: "reduce",
});
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await mkdir("docs/assets", { recursive: true });
  await page.goto(url);
  await page.getByRole("button", { name: "Load sample (450 attempts)", exact: true }).click();
  await page.locator(".hero-clock").waitFor();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: "docs/assets/hero.png" });
  await page.locator("#pb-odds").screenshot({ path: "docs/assets/pb-odds.png" });
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG card" }).click();
  await (await download).saveAs("docs/assets/share-card.png");
  await page
    .locator("#file-input")
    .setInputFiles({ name: "broken.lss", mimeType: "text/xml", buffer: Buffer.from("<Run>") });
  await page.locator("#import-error").waitFor();
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "docs/assets/import-recovery.png" });
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await page.setViewportSize({ width: 375, height: 1000 });
  await page.evaluate(() => scrollTo(0, 0));
  await page.screenshot({ path: "docs/assets/mobile-light.png" });
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("Captured desktop, mobile, PB odds, import recovery and the downloaded PNG card.");
} finally {
  await browser.close();
}
