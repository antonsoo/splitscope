import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { longHistory } from "../fixtures/long-history.js";

const normal = readFileSync(new URL("../fixtures/modern-full.lss", import.meta.url), "utf8");
const large = Buffer.from(longHistory());

async function workerFault(page: Page, startup: boolean): Promise<void> {
  await page.evaluate((failStartup) => {
    const Original = window.Worker;
    Object.assign(window, {
      restoreParserWorker: () => {
        window.Worker = Original;
      },
    });
    window.Worker = class extends Original {
      constructor(url: string | URL, options?: WorkerOptions) {
        if (failStartup) throw new Error("Controlled worker startup failure");
        super(url, options);
      }
      override postMessage(): void {
        // The real worker starts but never receives input, so cannot answer it.
      }
    };
  }, startup);
}

async function restoreWorker(page: Page): Promise<void> {
  await page.evaluate(() =>
    (window as unknown as { restoreParserWorker: () => void }).restoreParserWorker(),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto("./");
});

test("accepted long histories load and use all timings without unbounded chart nodes", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  expect(large.length).toBeLessThan(25 * 1024 * 1024);
  await page
    .locator("#file-input")
    .setInputFiles({ name: "long.lss", mimeType: "text/xml", buffer: large });
  await expect(page.locator(".hero-clock")).toHaveText("0:01.00", { timeout: 20_000 });
  await expect(page.locator(".chart-summary")).toContainText("140,000 finished attempts");
  await page.getByRole("spinbutton", { name: "Window", exact: true }).fill("140000");
  await page.getByRole("spinbutton", { name: "Window", exact: true }).press("Tab");
  await expect(page.locator(".dist-grid")).toContainText("140,000 timings in 64 bins");
  expect(
    await page
      .locator(".dist-grid rect[data-count]")
      .evaluateAll((nodes) =>
        nodes.reduce((sum, node) => sum + Number(node.getAttribute("data-count")), 0),
      ),
  ).toBe(140_000);
  expect(await page.locator("svg circle").count()).toBeLessThan(4000);
  await expect(page.locator(".seg-table tbody tr")).toContainText("140000");
  expect(errors).toEqual([]);
});

test("cancelling actual worker parsing preserves the previous run and allows a replacement", async ({
  page,
}) => {
  await page
    .locator("#file-input")
    .setInputFiles({ name: "previous.lss", mimeType: "text/xml", buffer: Buffer.from(normal) });
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
  await page
    .locator("#file-input")
    .setInputFiles({ name: "long.lss", mimeType: "text/xml", buffer: large });
  await expect(page.getByRole("status").filter({ hasText: "Parsing long.lss" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel loading", exact: true }).click();
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
  await page.locator("#file-input").setInputFiles({
    name: "replacement.lss",
    mimeType: "text/xml",
    buffer: Buffer.from(normal.replace("Crystal Caverns", "Replacement")),
  });
  await expect(page.locator(".run-id-text")).toContainText("Replacement");
  await expect(page.getByRole("button", { name: "Cancel loading", exact: true })).toHaveCount(0);
});

test("a render failure reports an error and restores the previous workspace", async ({ page }) => {
  await page
    .locator("#file-input")
    .setInputFiles({ name: "previous.lss", mimeType: "text/xml", buffer: Buffer.from(normal) });
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
  await page.getByRole("button", { name: "IGT", exact: true }).click();
  await page.evaluate(() => {
    const original = document.createElementNS.bind(document);
    document.createElementNS = ((...args: Parameters<typeof original>) => {
      const preparingReplacement = [...document.querySelectorAll('[role="status"]')].some((node) =>
        node.textContent?.startsWith("Parsing replacement.lss"),
      );
      if (preparingReplacement) {
        document.createElementNS = original;
        throw new Error(`Controlled chart failure: ${args[1]}`);
      }
      return original(...args);
    }) as typeof original;
  });
  await page.locator("#file-input").setInputFiles({
    name: "replacement.lss",
    mimeType: "text/xml",
    buffer: Buffer.from(normal.replace("Crystal Caverns", "Failed replacement")),
  });
  await expect(page.getByRole("alert")).toContainText("Controlled chart failure");
  await expect(page.locator(".hero-clock")).toHaveText("3:50.00");
  await expect(page.locator(".run-id-text")).not.toContainText("Failed replacement");
  await page.getByRole("button", { name: "Retry import", exact: true }).click();
  await expect(page.locator(".run-id-text")).toContainText("Failed replacement");
});

test("worker startup failures remain recoverable", async ({ page }) => {
  await workerFault(page, true);
  await page
    .locator("#file-input")
    .setInputFiles({ name: "normal.lss", mimeType: "text/xml", buffer: Buffer.from(normal) });
  await expect(page.getByRole("alert")).toContainText("Controlled worker startup failure");
  await restoreWorker(page);
  await page.getByRole("button", { name: "Retry import", exact: true }).click();
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
});

test("a parser that never responds times out and can be retried", async ({ page }) => {
  await page.clock.install();
  await workerFault(page, false);
  await page
    .locator("#file-input")
    .setInputFiles({ name: "normal.lss", mimeType: "text/xml", buffer: Buffer.from(normal) });
  await expect(page.getByRole("status").filter({ hasText: "Parsing normal.lss" })).toBeVisible();
  await page.clock.fastForward(15_001);
  await expect(page.getByRole("alert")).toContainText("longer than 15 seconds");
  await restoreWorker(page);
  await page.getByRole("button", { name: "Retry import", exact: true }).click();
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
});

test("every-attempt records retain endpoints and a bounded, labelled gold plot", async ({
  page,
}) => {
  await page.locator("#file-input").setInputFiles({
    name: "records.lss",
    mimeType: "text/xml",
    buffer: Buffer.from(longHistory(140_000, true)),
  });
  await expect(page.locator(".hero-clock")).toHaveText("0:01.00", { timeout: 20_000 });
  await expect(page.locator(".dist-grid")).toContainText("gold history: 140000 records");
  await expect(page.locator(".dist-grid")).toContainText("for 140,000 records");
  expect(await page.locator(".dist-grid svg circle").count()).toBeLessThan(1200);
  await expect(page.locator(".dist-grid")).toContainText("23:20.99 → 0:01.00");
});
