import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";

const xml = readFileSync(new URL("../fixtures/modern-full.lss", import.meta.url), "utf8");
const empty = readFileSync(new URL("../fixtures/empty-history.lss", import.meta.url), "utf8");

async function load(page: Page, data = xml) {
  await page.locator("#file-input").setInputFiles({
    name: "private-splits.lss",
    mimeType: "application/xml",
    buffer: Buffer.from(data),
  });
  await expect(page.locator(".hero-clock")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Reading" })).toHaveCount(0);
}

async function scan(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  expect(
    result.violations.map(({ id, nodes }) => ({ id, targets: nodes.map((n) => n.target) })),
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const audit = { errors: [] as string[], csp: [] as string[] };
    Object.assign(window, { splitscopeAudit: audit });
    addEventListener("error", (e) => audit.errors.push(e.message));
    addEventListener("unhandledrejection", (e) => audit.errors.push(String(e.reason)));
    addEventListener("securitypolicyviolation", (e) => audit.csp.push(e.violatedDirective));
  });
  await page.route("**/*", async (route) => {
    expect(new URL(route.request().url()).origin).toBe("http://127.0.0.1:4330");
    await route.continue();
  });
  await page.goto("./");
});

test.afterEach(async ({ page }) => {
  expect(
    await page.evaluate(() => (window as unknown as { splitscopeAudit: unknown }).splitscopeAudit),
  ).toEqual({ errors: [], csp: [] });
});

test("intake and both sample workspaces are accessible in both themes and widths", async ({
  page,
}) => {
  await scan(page);
  for (const label of ["Load sample (450 attempts)", "Load sample (fresh splits, 10 attempts)"]) {
    await page.getByRole("button", { name: label, exact: true }).click();
    await expect(page.locator(".sample-badge")).toBeVisible();
    for (const width of [1440, 375]) {
      await page.setViewportSize({ width, height: 900 });
      for (const theme of ["dark", "light"]) {
        await page.evaluate((value) => {
          document.documentElement.dataset.theme = value;
        }, theme);
        await scan(page);
        expect(
          await page.locator(".hero-stat-value").evaluateAll((nodes) =>
            nodes.every((node) => {
              const range = document.createRange();
              range.selectNodeContents(node);
              return range.getClientRects().length === 1;
            }),
          ),
        ).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
      }
    }
    await page.getByRole("button", { name: "New file", exact: true }).click();
  }
});

test("bad first input retains controls and the same file can be loaded again", async ({ page }) => {
  const invalid = { name: "bad.lss", mimeType: "application/xml", buffer: Buffer.from("not xml") };
  await page.locator("#file-input").setInputFiles(invalid);
  await expect(page.getByRole("alert")).toContainText("Could not load this file");
  await expect(page.getByRole("button", { name: "Choose a .lss file" })).toBeVisible();
  await scan(page);
  await page.getByRole("button", { name: "Retry import" }).click();
  await expect(page.getByRole("alert")).toContainText("Could not load this file");
  await load(page);
  await load(page);
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
});

test("failed replacements keep the run and settings intact", async ({ page }) => {
  await load(page);
  await page.getByRole("button", { name: "IGT", exact: true }).click();
  await page
    .locator("#file-input")
    .setInputFiles({ name: "broken.lss", mimeType: "text/xml", buffer: Buffer.from("<Run>") });
  await expect(page.getByRole("alert")).toContainText("previous analysis");
  await expect(page.locator(".hero-clock")).toHaveText("3:50.00");
  await expect(page.getByRole("button", { name: "IGT", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.getByRole("button", { name: "Dismiss error" }).click();
  await expect(page.locator("h1")).toBeFocused();
});

test("a slow sample cannot replace a newer file", async ({ page }) => {
  let release!: () => void;
  let requested!: () => void;
  const ready = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/crystal-caverns-any.lss", async (route) => {
    requested();
    await gate;
    await route.fulfill({ body: xml.replace("Crystal Caverns", "Obsolete sample") });
  });
  await page.getByRole("button", { name: "Load sample (450 attempts)", exact: true }).click();
  await ready;
  await load(page, xml.replace("Crystal Caverns", "Latest file"));
  release();
  await expect(page.locator(".run-id-text")).toContainText("Latest file");
  await expect(page.locator(".sample-badge")).toHaveCount(0);
});

test("cancel and reset prevent a pending load from reopening private data", async ({ page }) => {
  await page.route("**/crystal-caverns-any.lss", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.fulfill({ body: xml });
  });
  await page.getByRole("button", { name: "Load sample (450 attempts)", exact: true }).click();
  await page.getByRole("button", { name: "Cancel loading" }).click();
  await expect(page.locator(".empty")).toBeVisible();
  await page.getByRole("button", { name: "Load sample (450 attempts)", exact: true }).click();
  await page.getByRole("button", { name: "New file", exact: true }).click();
  await expect(page.getByRole("button", { name: "Choose a .lss file" })).toBeFocused();
  await page.waitForTimeout(500);
  await expect(page.locator(".hero")).toHaveCount(0);
  await load(page, xml.replace("Crystal Caverns", "private-marker"));
  await page.getByRole("button", { name: "New file", exact: true }).click();
  expect(await page.locator("body").innerText()).not.toContain("private-marker");
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain("private-marker");
  expect(await page.locator("#file-input").inputValue()).toBe("");
});

test("rejects oversized local files before reading and retains the prior run", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    const file = new File(["tiny"], "oversized.lss");
    Object.defineProperty(file, "size", { value: 26 * 1024 * 1024 });
    file.stream = () => {
      throw new Error("Oversized file must not be read");
    };
    const input = document.querySelector<HTMLInputElement>("#file-input")!;
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change"));
  });
  await expect(page.getByRole("alert")).toContainText("25 MiB");
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
});

test("sample HTTP failures can be retried", async ({ page }) => {
  let first = true;
  await page.route("**/crystal-caverns-any.lss", async (route) => {
    if (first) {
      first = false;
      await route.fulfill({ status: 503, body: "Unavailable" });
    } else await route.fulfill({ body: xml });
  });
  await page.getByRole("button", { name: "Load sample (450 attempts)", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("503");
  await page.getByRole("button", { name: "Retry import" }).click();
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
});

test("slider drags survive intermediate events and keyboard edits keep focus and details", async ({
  page,
}) => {
  await load(page);
  await page.locator("#odds-assumptions summary").click();
  const slider = page.locator("#odds-look-ahead");
  await slider.scrollIntoViewIfNeeded();
  await slider.evaluate((node) => Object.assign(window, { originalSlider: node }));
  const box = (await slider.boundingBox())!;
  await page.mouse.move(box.x + 10, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2, { steps: 8 });
  expect(
    await page.evaluate(
      () =>
        document.querySelector("#odds-look-ahead") ===
        (window as unknown as { originalSlider: Element }).originalSlider,
    ),
  ).toBe(true);
  await page.mouse.up();
  expect(Number(await slider.inputValue())).toBeGreaterThan(300);
  await slider.focus();
  const before = Number(await slider.inputValue());
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toBeFocused();
  expect(Number(await slider.inputValue())).toBe(before + 2);
  await expect(page.locator("#odds-assumptions")).toHaveAttribute("open", "");
  await expect(page.locator("#pb-odds")).toContainText(`next ${before + 2} attempts`);
});

test("invalid numeric settings do not alter the analysis", async ({ page }) => {
  await load(page);
  const table = await page.locator(".seg-table").innerText();
  const window = page.getByRole("spinbutton", { name: "Window", exact: true });
  for (const invalid of ["", "0", "-1", "1.5", "100"]) {
    await window.fill(invalid);
    await window.press("Tab");
    await expect(window).toHaveAttribute("aria-invalid", "true");
    expect(await page.locator(".seg-table").innerText()).toBe(table);
  }
  await window.fill("1");
  await window.press("Tab");
  await expect(window).not.toHaveAttribute("aria-invalid");
  await expect(page.locator("#tolerance")).toBeFocused();
  await expect(page.locator(".seg-table")).toContainText("n/a");
  const tolerance = page.locator("#tolerance");
  await tolerance.fill("-2");
  await tolerance.press("Tab");
  await expect(tolerance).toHaveAttribute("aria-invalid", "true");
  await tolerance.fill("");
  await tolerance.press("Tab");
  await expect(page.locator(".section-controls").first()).toContainText("auto (8%, at least 1s)");
});

test("missing PBs and golds remain unavailable on screen and in Markdown", async ({ page }) => {
  await load(
    page,
    xml
      .replaceAll('name="Personal Best"', 'name="Other"')
      .replace("<RealTime>00:00:55.0000000</RealTime>", "<RealTime/>"),
  );
  await expect(page.locator(".hero-stats")).toContainText("Unavailable");
  await expect(page.locator("#pb-odds")).toContainText("No PB recorded");
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Markdown summary" }).click();
  const file = await download;
  const content = readFileSync((await file.path())!, "utf8");
  expect(content).toContain("PB odds are unavailable");
  expect(content).not.toContain("95% CI");
});

test("exports include sample provenance and PNG has the intended dimensions", async ({ page }) => {
  await page
    .getByRole("button", { name: "Load sample (fresh splits, 10 attempts)", exact: true })
    .click();
  await expect(page.locator(".hero")).toBeVisible();
  const mdEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download Markdown summary" }).click();
  expect(readFileSync((await (await mdEvent).path())!, "utf8")).toContain("Synthetic sample");
  const pngEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download PNG card" }).click();
  const bytes = readFileSync((await (await pngEvent).path())!);
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1200, 630]);
});

test("PNG failure is announced without losing the run", async ({ page }) => {
  await load(page);
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = (callback) => callback(null);
  });
  await page.getByRole("button", { name: "Download PNG card" }).click();
  await expect(page.locator(".export-status")).toContainText("Could not generate the PNG");
  await expect(page.getByRole("button", { name: "Download PNG card" })).toBeFocused();
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
});

test("empty and GameTime-only histories remain usable and accessible", async ({ page }) => {
  await load(page, empty);
  await expect(page.locator("#pb-odds")).toContainText("No PB recorded");
  await scan(page);
  await load(page, xml.replace(/<RealTime>[\s\S]*?<\/RealTime>/g, "<RealTime/>"));
  await expect(page.getByRole("button", { name: "IGT", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".hero-clock")).toHaveText("3:50.00");
  await scan(page);
});

test("imported labels render as text and analysis works offline", async ({ page, context }) => {
  await context.setOffline(true);
  await load(page, xml.replace("Crystal Caverns", "&lt;img src=x onerror=alert(1)&gt;"));
  await expect(page.locator(".run-id-text")).toContainText("<img src=x onerror=alert(1)>");
  await expect(page.locator(".run-id img")).toHaveCount(0);
  await page.getByRole("button", { name: "IGT", exact: true }).click();
  await expect(page.locator(".hero-clock")).toHaveText("3:50.00");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
});

test("a delayed file read is cancelled when a newer file is selected", async ({ page }) => {
  await page.evaluate(() => {
    const original = File.prototype.stream;
    File.prototype.stream = function () {
      if (this.name !== "slow.lss") return original.call(this);
      return new ReadableStream<Uint8Array<ArrayBuffer>>({
        cancel() {
          Object.assign(window, { cancelledRead: true });
        },
      });
    };
  });
  await page
    .locator("#file-input")
    .setInputFiles({ name: "slow.lss", mimeType: "text/xml", buffer: Buffer.from(xml) });
  await expect(page.getByRole("status").filter({ hasText: "Reading slow.lss" })).toBeVisible();
  await load(page, xml.replace("Crystal Caverns", "Replacement file"));
  expect(
    await page.evaluate(() => (window as unknown as { cancelledRead: boolean }).cancelledRead),
  ).toBe(true);
  await expect(page.locator(".run-id-text")).toContainText("Replacement file");
});

test("sample streams cannot exceed the byte budget even without a declared size", async ({
  page,
}) => {
  await page.evaluate(() => {
    window.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array<ArrayBuffer>>({
          start(controller) {
            controller.enqueue(new Uint8Array(26 * 1024 * 1024));
            controller.close();
          },
        }),
      );
  });
  await page.getByRole("button", { name: "Load sample (450 attempts)", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("25 MiB");
  await expect(page.locator(".empty")).toBeVisible();
  await load(page);
});

test("malformed and ambiguous records retain the old analysis or show unknown outcomes", async ({
  page,
}) => {
  await load(page);
  await page.locator("#file-input").setInputFiles({
    name: "duplicate.lss",
    mimeType: "text/xml",
    buffer: Buffer.from(xml.replace('id="1"', 'id="2"')),
  });
  await expect(page.getByRole("alert")).toContainText("Duplicate attempt id");
  await expect(page.locator(".hero-clock")).toHaveText("4:00.00");
  await load(page, xml.replace("<RealTime>00:04:10.0000000</RealTime>", "<RealTime/>"));
  await expect(page.locator("#pb-odds")).toContainText("outcome is unknown");
  await expect(page.locator(".odds-metric-value")).toHaveCount(0);
});
