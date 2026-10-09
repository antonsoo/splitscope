import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const fixture = readFileSync(new URL("../fixtures/practice-evidence.lss", import.meta.url));
const real = readFileSync(new URL("../../examples/recorded/zero-divide-2.lss", import.meta.url));

async function load(page: Page, buffer = fixture) {
  await page
    .locator("#file-input")
    .setInputFiles({ name: "review.lss", mimeType: "application/xml", buffer });
  await expect(page.locator("#practice-window")).toBeVisible();
}

async function range(page: Page, size: number, end: number) {
  await page.locator("#practice-window").fill(String(size));
  await page.locator("#practice-end").fill(String(end));
  await page.getByRole("button", { name: "Apply range", exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const errors: string[] = [];
    Object.assign(window, { reviewErrors: errors });
    addEventListener("error", (event) => errors.push(event.message));
    addEventListener("unhandledrejection", (event) => errors.push(String(event.reason)));
    addEventListener("securitypolicyviolation", (event) => errors.push(event.violatedDirective));
  });
  await page.route("**/*", async (route) => {
    expect(new URL(route.request().url()).origin).toBe("http://127.0.0.1:4330");
    await route.continue();
  });
  await page.goto("./");
});

test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(() => (window as unknown as { reviewErrors: string[] }).reviewErrors),
  ).toEqual([]);
});

test("a recorded example opens its exact reset members, raw records and full export", async ({
  page,
}) => {
  await page.getByRole("button", { name: "Open recorded practice (124 attempts)" }).click();
  await expect(page.locator(".sample-badge")).toHaveCount(0);
  await expect(page.locator(".review-previous.review-summary")).toContainText("#65–#94");
  await expect(page.locator(".review-recent.review-summary")).toContainText("#95–#124");
  await page
    .getByRole("button", {
      name: "Inspect 4 inferred resets at Pixel in recent group",
      exact: true,
    })
    .click();
  const list = page.getByRole("region", { name: "Practice attempts", exact: true });
  await expect(list.getByRole("button")).toHaveText(["#120", "#118", "#117", "#114"]);
  await page.getByRole("button", { name: "Inspect attempt 120", exact: true }).click();
  await expect(page.locator("#practice-attempt-title")).toBeFocused();
  await expect(page.locator(".review-detail")).toContainText('Time id="120" · segment 5');
  await expect(page.locator("#practice-review .review-source-file")).toContainText(
    createHash("sha256").update(real).digest("hex"),
  );
  const download = page.waitForEvent("download");
  await page.locator("#export-practice").click();
  const downloadedPath = await (await download).path();
  if (!downloadedPath) throw new Error("The review download was not saved.");
  const payload = JSON.parse(readFileSync(downloadedPath, "utf8"));
  expect(payload.source.synthetic).toBe(false);
  expect(payload.source.bytes).toBe(real.length);
  expect(
    payload.comparison.previous.attempts.map((row: { attempt: { id: number } }) => row.attempt.id),
  ).toEqual(Array.from({ length: 30 }, (_, index) => index + 65));
  expect(payload.comparison.recent.attempts).toHaveLength(30);
  expect(payload.comparison.recent.segments[5]).toEqual({
    started: 13,
    resets: 4,
    resetRate: 4 / 13,
  });
  expect(
    payload.segments[0].history.some((entry: { attemptId: number }) => entry.attemptId === 124),
  ).toBe(true);
});

test("sparse IDs, missing histories, combined times and the other timing method remain distinct", async ({
  page,
}) => {
  await load(page);
  await range(page, 3, 23);
  await expect(page.locator(".review-previous.review-summary")).toContainText("2 / 3");
  await expect(page.locator(".review-recent.review-summary")).toContainText("1 unknown outcomes");
  await page.locator("#practice-side-previous").click();
  await page.getByRole("button", { name: "Inspect attempt 5", exact: true }).click();
  const detail = page.getByRole("region", { name: "Selected attempt split records" });
  await expect(detail).toContainText("Combined: segments 2–3");
  const combined = detail.getByRole("row").filter({ hasText: "3. Tower" });
  await expect(combined).toContainText("0:25.00");
  await expect(combined.getByRole("cell").nth(2)).toHaveText("—");
  await page.getByRole("button", { name: "IGT", exact: true }).click();
  await expect(page.locator(".review-previous.review-summary")).toContainText(
    "GameTime median 0:42.00 · 1 timed completions",
  );
  await expect(page.locator(".review-recent.review-summary")).toContainText(
    "GameTime median — · 0 timed completions",
  );
  await expect(detail).toContainText("No GameTime time (skipped or untimed)");
  await page.locator("#practice-back").click();
  await expect(page.getByRole("button", { name: "Inspect attempt 5", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Inspect attempt 9", exact: true }).click();
  await expect(page.locator("#practice-attempt-title")).toContainText("Completed");
  await expect(detail.getByRole("row").filter({ hasText: "No history entry" })).toHaveCount(4);
});

test("invalid ranges preserve applied evidence and historical ranges have no overlapping IDs", async ({
  page,
}) => {
  await load(page);
  await range(page, 3, 23);
  await range(page, 3, 19);
  await expect(page.locator("#practice-range-error")).toContainText("ending ID present");
  await expect(page.locator(".review-recent.review-summary")).toContainText("#12–#23");
  await range(page, 0, 23);
  await expect(page.locator("#practice-window")).toHaveAttribute("aria-invalid", "true");
  await range(page, 3, 12);
  await expect(page.locator(".review-previous.review-summary")).toContainText("#2–#2");
  await expect(page.locator(".review-previous.review-summary")).toContainText("Only 1 of 3");
  await expect(page.locator(".review-recent.review-summary")).toContainText("#5–#12");
  await page.locator("#practice-latest").click();
  await expect(page.locator("#practice-end")).toHaveValue("23");
});

test("attempt pagination stays bounded and keyboard focus survives the last page", async ({
  page,
}) => {
  await load(page, real);
  const list = page.getByRole("region", { name: "Practice attempts", exact: true });
  await expect(list.getByRole("button")).toHaveCount(10);
  await page.locator("#review-attempts-next").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#review-attempts-page")).toBeFocused();
  await expect(list.getByRole("button").first()).toHaveText("#114");
  await page.keyboard.press("Tab");
  await expect(page.locator("#review-attempts-next")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#review-attempts-page")).toBeFocused();
  await expect(page.locator("#review-attempts-next")).toBeDisabled();
  await expect(list.getByRole("button").last()).toHaveText("#95");
  await page.keyboard.press("Shift+Tab");
  await expect(page.locator("#review-attempts-previous")).toBeFocused();
});

test("keyboard review and filtered exports remain available offline across theme and chart changes", async ({
  page,
  context,
}) => {
  await load(page, real);
  await context.setOffline(true);
  await page.locator("#practice-side-previous").focus();
  await page.keyboard.press("Tab");
  await expect(page.locator("#practice-side-recent")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#practice-outcome")).toBeFocused();
  await page.locator("#practice-outcome").selectOption("completed");
  await page.keyboard.press("Tab");
  // The labelled, horizontally scrollable table is in the tab sequence.
  await expect(page.getByRole("region", { name: "Practice attempts", exact: true })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Inspect attempt 124", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#practice-attempt-title")).toBeFocused();
  await page.locator("#practice-assumptions summary").click();
  await page.locator("#theme-toggle").click();
  await expect(page.locator("#practice-attempt-title")).toContainText("#124");
  await expect(page.locator("#practice-outcome")).toHaveValue("completed");
  await expect(page.locator("#practice-assumptions")).toHaveAttribute("open", "");
  const download = page.waitForEvent("download");
  await page.locator("#export-practice").click();
  expect((await download).suggestedFilename()).toBe("splitscope-practice.json");
  await context.setOffline(false);
  await page
    .locator("#file-input")
    .setInputFiles({ name: "broken.lss", mimeType: "text/xml", buffer: Buffer.from("<Run>") });
  await expect(page.getByRole("alert")).toContainText("previous analysis");
  await expect(page.locator("#practice-attempt-title")).toContainText("#124");
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.locator("#practice-review")).toHaveCount(0);
  await load(page);
  await expect(page.locator(".review-detail")).toHaveCount(0);
});

test("real review and selected records are accessible in both themes at desktop and phone widths", async ({
  page,
}) => {
  await load(page, real);
  await page.getByRole("button", { name: "Inspect attempt 124", exact: true }).click();
  for (const width of [1440, 375]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ["dark", "light"]) {
      await page.evaluate((value) => {
        document.documentElement.dataset.theme = value;
      }, theme);
      const scan = await new AxeBuilder({ page }).include("#practice-review").analyze();
      expect(
        scan.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((node) => node.target) })),
      ).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    }
  }
});
