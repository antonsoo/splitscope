import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const fixture = readFileSync(new URL("../fixtures/combined-best.lss", import.meta.url));
const real = readFileSync(new URL("../../examples/recorded/destrega.lss", import.meta.url));

async function load(page: Page, buffer = fixture) {
  await page
    .locator("#file-input")
    .setInputFiles({ name: "combined.lss", mimeType: "application/xml", buffer });
  await expect(page.locator("#best-title")).toBeVisible();
}

async function download(page: Page, id: string) {
  const pending = page.waitForEvent("download");
  await page.locator(id).click();
  const path = await (await pending).path();
  if (!path) throw new Error("Missing download");
  return readFileSync(path, "utf8");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const issues: string[] = [];
    Object.assign(window, { bestIssues: issues });
    addEventListener("error", (event) => issues.push(event.message));
    addEventListener("unhandledrejection", (event) => issues.push(String(event.reason)));
    addEventListener("securitypolicyviolation", (event) => issues.push(event.violatedDirective));
  });
  await page.route("**/*", async (route) => {
    expect(new URL(route.request().url()).origin).toBe("http://127.0.0.1:4330");
    await route.continue();
  });
  await page.goto("./");
});

test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(() => (window as unknown as { bestIssues: string[] }).bestIssues),
  ).toEqual([]);
});

test("public skipped-split evidence changes the total and exports the original records offline", async ({
  page,
  context,
}) => {
  await page.getByRole("button", { name: "Open combined-split example (Destrega)" }).click();
  await expect(page.locator("#best-total")).toHaveText("25:11.017");
  await expect(page.locator("#best-golds")).toHaveText("26:49.806");
  await expect(page.locator(".best-detail")).toContainText("History #58");
  await expect(
    page.getByRole("region", { name: "Selected source records", exact: true }),
  ).toContainText("83.691");
  await context.setOffline(true);
  const out = JSON.parse(await download(page, "#export-best"));
  expect(out.source.sha256).toBe(createHash("sha256").update(real).digest("hex"));
  expect(out.source.synthetic).toBe(false);
  expect(out.route.totalSeconds).toBeCloseTo(1511.017, 7);
  const history = out.evidence.find(
    (row: { leg: { source: { kind: string } } }) => row.leg.source.kind === "history",
  );
  expect(history.leg).toMatchObject({
    from: 14,
    to: 16,
    seconds: 83.691,
    source: { attemptId: 58 },
  });
  expect(
    history.records.map((row: { time: { realTime: number | null } }) => row.time.realTime),
  ).toEqual([null, 83.691]);
  expect(out.segments).toHaveLength(24);
  const markdown = await download(page, "#export-markdown");
  expect(markdown).toContain("Sum of best:** 25:11.02");
  expect(markdown).toContain("15–16 | 1:23.69 | History #58");
});

test("source controls keep keyboard focus, then recalculate for game time", async ({ page }) => {
  await load(page);
  await expect(page.locator("#best-total")).toHaveText("1:10.000");
  await expect(page.locator("#best-golds")).toHaveText("1:40.000");
  await page.locator("#best-leg-0").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#best-detail-title")).toBeFocused();
  await expect(page.locator(".best-detail")).toContainText("does not identify which attempt");
  await page.getByRole("button", { name: "Back to selected span" }).click();
  await expect(page.locator("#best-leg-0")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#best-leg-1")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator(".best-detail")).toContainText("History #2");
  await expect(page.locator("#best-detail-title")).toBeFocused();
  await page.locator("#method-igt").click();
  await expect(page.locator("#best-total")).toHaveText("1:32.000");
  await expect(page.locator(".best-detail")).not.toContainText("History #2");
  const out = JSON.parse(await download(page, "#export-best"));
  expect(out.route.method).toBe("GameTime");
  expect(out.route.legs).toHaveLength(4);
});

test("an absent gold can use PB evidence; a missing path stays unavailable", async ({ page }) => {
  const xml = fixture
    .toString("utf8")
    .replaceAll(/<BestSegmentTime>[\s\S]*?<\/BestSegmentTime>/g, "<BestSegmentTime/>")
    .replaceAll(/<SegmentHistory>[\s\S]*?<\/SegmentHistory>/g, "<SegmentHistory/>");
  await load(page, Buffer.from(xml));
  await expect(page.locator("#best-total")).toHaveText("1:55.000");
  await expect(page.locator("#best-golds")).toHaveText("Incomplete");
  await expect(page.locator(".best-detail")).toContainText("PB splits");
  await load(page, Buffer.from(xml.replaceAll('name="Personal Best"', 'name="Other"')));
  await expect(page.locator("#best-total")).toHaveText("Unavailable");
  await expect(page.locator(".best-detail")).toHaveCount(0);
  expect(JSON.parse(await download(page, "#export-best")).route.totalSeconds).toBeNull();
});

test("a failed replacement preserves evidence; New file clears it", async ({ page }) => {
  await load(page);
  await page
    .locator("#file-input")
    .setInputFiles({ name: "bad.lss", mimeType: "application/xml", buffer: Buffer.from("bad") });
  await expect(page.locator("#import-error")).toBeVisible();
  await expect(page.locator("#best-total")).toHaveText("1:10.000");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.locator("#best-route")).toHaveCount(0);
});

for (const width of [375, 1440]) {
  test(`source evidence is accessible without page overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 950 });
    await load(page);
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const audit = await new AxeBuilder({ page })
        .include("#best-route")
        .withTags(["wcag2a", "wcag2aa"])
        .analyze();
      expect(audit.violations).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  });
}
