/** Run against an already-built artifact. Owns and closes its server and browsers. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { chromium, firefox } from "playwright";

const [dist, fixtureRoot, output, revision] = process.argv.slice(2);
assert(dist && fixtureRoot && output && ["before", "after"].includes(revision));
await mkdir(output, { recursive: true });
const hash = (b) => createHash("sha256").update(b).digest("hex");
const mime = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
};
const server = http.createServer(async (req, res) => {
  try {
    const name = decodeURIComponent(new URL(req.url, "http://localhost").pathname).replace(
      /^\/splitscope\//,
      "",
    );
    assert(!name.includes(".."));
    const file = path.join(dist, name || "index.html");
    const bytes = await readFile(file);
    res.writeHead(200, { "content-type": mime[path.extname(file)] || "application/octet-stream" });
    res.end(bytes);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}/splitscope/`;
const rows = [];
try {
  for (const [name, engine] of Object.entries({ chromium, firefox })) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({
        viewport: { width: 1440, height: 950 },
        acceptDownloads: true,
      });
      const page = await context.newPage();
      const errors = [],
        offlineRequests = [],
        assets = [],
        pending = [];
      let offline = false;
      page.on("pageerror", (e) => errors.push(String(e)));
      page.on("request", (req) => {
        if (offline && /^https?:/.test(req.url())) offlineRequests.push(req.url());
      });
      page.on("response", (response) => {
        if (!/^https?:/.test(response.url())) return;
        pending.push(
          (async () => {
            assert.equal(response.status(), 200);
            const url = new URL(response.url());
            const relative =
              decodeURIComponent(url.pathname).replace(/^\/splitscope\//, "") || "index.html";
            const served = await response.body();
            assert.equal(hash(served), hash(await readFile(path.join(dist, relative))));
            assets.push({ file: relative, sha256: hash(served), bytes: served.length });
          })(),
        );
      });
      await page.goto(base, { waitUntil: "networkidle" });
      await page.evaluate(async () => {
        for (const family of ["Hanken Grotesk", "Martian Mono"]) {
          for (const weight of [400, 500, 600, 700, 800])
            await document.fonts.load(`${weight} 16px "${family}"`, "0123456789 ABCabc");
        }
        await document.fonts.ready;
      });
      await Promise.all(pending);
      await context.setOffline(true);
      offline = true;
      for (const id of [
        "exact-tie",
        "one-tick-faster",
        "one-nanosecond-faster",
        "one-nanosecond-slower",
        "mixed-ties",
        "precision-unavailable",
        "recorded-psychic-force",
      ]) {
        const recorded = id === "recorded-psychic-force";
        const buffer = await readFile(
          recorded
            ? path.join(fixtureRoot, "../recorded/psychic-force.lss")
            : path.join(fixtureRoot, `${id}.lss`),
        );
        await page
          .locator("#file-input")
          .setInputFiles({ name: `${id}.lss`, mimeType: "application/xml", buffer });
        await page.waitForFunction(
          (label) => document.querySelector(".hero-title strong")?.textContent === label,
          recorded ? "Arcade Mode - Easiest (Regina)" : id,
        );
        const methods = [];
        for (const method of ["rta", "igt"]) {
          await page.locator(`#method-${method}`).click();
          const text = await page.locator("#pb-odds").innerText();
          const values = await page.locator(".odds-metric-value").allTextContents();
          if (id === "exact-tie" || (recorded && method === "rta"))
            assert.equal(values[1], revision === "before" ? "100.00%" : "0.00%");
          if (id === "one-tick-faster" || id === "one-nanosecond-faster")
            assert.equal(values[1], "100.00%");
          if (id === "one-nanosecond-slower") assert.equal(values[1], "0.00%");
          if (revision === "after" && id === "precision-unavailable")
            assert.match(text, /precision/i);
          const wait = page.waitForEvent("download");
          await page.locator("#export-markdown").click();
          const download = await wait;
          const target = path.join(output, `${name}-${id}-${method}.md`);
          await download.saveAs(target);
          const markdown = await readFile(target, "utf8");
          if (values.length) assert(markdown.includes(`P(next attempt beats PB):** ${values[1]}`));
          methods.push({ method, text, values, markdownSha256: hash(markdown) });
        }
        if (id === "exact-tie" || recorded) {
          await page.locator("#method-rta").click();
          for (const width of [1440, 375]) {
            await page.setViewportSize({ width, height: width === 375 ? 1600 : 950 });
            await page.locator("#pb-odds").scrollIntoViewIfNeeded();
            assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
            await page
              .locator("#pb-odds")
              .screenshot({ path: path.join(output, `${name}-${id}-${width}.png`) });
          }
          await page.setViewportSize({ width: 1440, height: 950 });
          const wait = page.waitForEvent("download");
          await page.locator("#export-png").click();
          await (await wait).saveAs(path.join(output, `${name}-${id}-card.png`));
        }
        rows.push({ browser: name, id, inputSha256: hash(buffer), methods });
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(offlineRequests, []);
      rows.push({ browser: name, errors, offlineRequests, assets });
      await context.close();
    } finally {
      await browser.close();
    }
  }
} finally {
  await new Promise((r) => server.close(r));
}
await writeFile(
  path.join(output, "browser.json"),
  `${JSON.stringify({ revision, rows }, null, 2)}\n`,
);
console.log(
  JSON.stringify({
    revision,
    imports: 14,
    markdownDownloads: 28,
    pngDownloads: 4,
    screenshots: 8,
    errors: 0,
    offlineRequests: 0,
  }),
);
