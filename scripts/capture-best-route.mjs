/** Real built-app screenshots and offline downloads. Run Vite preview on port 4337 first. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium, firefox } from "@playwright/test";

const output = process.argv[2] ?? "docs/assets/sum-of-best";
await mkdir(output, { recursive: true });
const evidence = process.argv[3] ?? "studies/sum-of-best/results/browser";
await mkdir(evidence, { recursive: true });
for (const [name, engine] of [
  ["chromium", chromium],
  ["firefox", firefox],
]) {
  const browser = await engine.launch({ headless: true });
  for (const width of [1440, 375]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.goto("http://127.0.0.1:4337/splitscope/");
    await page.getByRole("button", { name: "Open combined-split example (Destrega)" }).click();
    await page.locator("#best-total").waitFor();
    await page.evaluate(() => document.fonts.ready);
    const height = await page
      .locator("#best-route")
      .evaluate((node) => node.getBoundingClientRect().height);
    await page.setViewportSize({ width, height: Math.max(1000, Math.ceil(height) + 250) });
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      await page
        .locator("#best-route")
        .screenshot({ path: `${output}/${name}-${width}-${theme}.png` });
    }
    if (width === 1440 && name === "chromium") {
      await page.context().setOffline(true);
      for (const [button, file] of [
        ["#export-best", "calculation.json"],
        ["#export-markdown", "summary.md"],
        ["#export-png", "share.png"],
      ]) {
        const pending = page.waitForEvent("download");
        await page.locator(button).click();
        const download = await pending;
        const path = await download.path();
        if (!path) throw Error("No download");
        await writeFile(
          `${file.endsWith(".png") ? output : evidence}/${file}`,
          await readFile(path),
        );
      }
    }
    if (errors.length) throw Error(errors.join("\n"));
    console.log(`${name} ${width}: screenshot and browser checks complete`);
    await page.close();
  }
  await browser.close();
}
