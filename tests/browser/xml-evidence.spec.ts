import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";

const original = readFileSync(new URL("../fixtures/combined-best.lss", import.meta.url), "utf8");
const attributed = original.replaceAll(/<(RealTime|GameTime)>/g, '<$1 xml:space="preserve">');
const hash = createHash("sha256").update(attributed).digest("hex");
async function upload(page: Page, name: string, xml: string) {
  await page
    .locator("#file-input")
    .setInputFiles({ name, mimeType: "application/xml", buffer: Buffer.from(xml) });
}
async function evidence(page: Page) {
  const pending = page.waitForEvent("download");
  await page.locator("#export-best").click();
  const path = await (await pending).path();
  if (!path) throw new Error("Missing evidence download");
  return JSON.parse(readFileSync(path, "utf8"));
}

for (const width of [375, 1440]) {
  test(`attributed times import offline; ambiguous replacement preserves evidence at ${width}px`, async ({
    page,
    context,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.setViewportSize({ width, height: 950 });
    await page.goto("./");
    await context.setOffline(true);
    await upload(page, "attributed.lss", attributed);
    await expect(page.locator("#best-total")).toHaveText("1:10.000");
    expect((await evidence(page)).source.sha256).toBe(hash);
    await page.locator("#method-igt").click();
    await expect(page.locator("#best-total")).toHaveText("1:32.000");
    const before = await evidence(page);
    expect(before.route.totalSeconds).toBe(92);
    for (const tag of ["RealTime", "BestSegmentTime", "AttemptHistory"]) {
      const bad = original.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`), "$&$&");
      await upload(page, `duplicate-${tag}.lss`, bad);
      await expect(page.locator("#import-error")).toContainText(`Duplicate <${tag}>`);
      await expect(page.locator("#best-total")).toHaveText("1:32.000");
      expect(await evidence(page)).toEqual(before);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    expect(errors).toEqual([]);
  });
}
