/** Run with tsx; see docs/large-histories.md for the baseline and corpus setup. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";

const { values } = parseArgs({
  options: {
    baseline: { type: "string" },
    url: { type: "string", default: "http://127.0.0.1:4330/splitscope/" },
    out: { type: "string" },
  },
});
if (!values.baseline || !values.out) throw new Error("Pass --baseline DIRECTORY and --out FILE.");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const baseline = resolve(values.baseline);
const { parseRun } = await import(pathToFileURL(resolve(baseline, "src/core/parser.ts")).href);
const { decodeText } = await import(pathToFileURL(resolve(baseline, "src/core/decode.ts")).href);
const study = resolve(root, "studies/pb-odds-backtest");
const manifestBytes = readFileSync(resolve(study, "manifest.json"));
const manifest = JSON.parse(manifestBytes.toString());
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const canonical = (run) =>
  JSON.stringify(run, (_, value) => (value instanceof Map ? Object.fromEntries(value) : value));
const records = [];
const browser = await chromium.launch();
let workerSource;
try {
  const page = await browser.newPage();
  // Capture the actual blob passed by the built app, not a separately rebuilt worker.
  await page.addInitScript(() => {
    const original = URL.createObjectURL;
    URL.createObjectURL = (blob) => {
      if (blob.type?.startsWith("text/javascript")) window.parserSource = blob.text();
      return original(blob);
    };
  });
  await page.goto(values.url);
  await page.locator("#file-input").setInputFiles(resolve(root, "tests/fixtures/modern-full.lss"));
  await page.locator(".hero-clock").waitFor();
  workerSource = await page.evaluate(() => window.parserSource);
  assert.equal(typeof workerSource, "string", "The app did not start a bundled blob worker");
  for (const repo of manifest.repos) {
    for (const file of repo.files) {
      const bytes = readFileSync(resolve(study, "cache", repo.repo.replace("/", "_"), file.path));
      assert.equal(bytes.length, file.bytes, `Byte count changed: ${file.path}`);
      assert.equal(hash(bytes), file.sha256, `Hash changed: ${file.path}`);
      let expected = "";
      let error;
      try {
        expected = canonical(parseRun(decodeText(bytes)));
      } catch (cause) {
        error = cause.message;
      }
      const actual = await page.evaluate(
        ({ base64, source }) =>
          new Promise((accept, reject) => {
            const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
            const worker = new Worker(url);
            URL.revokeObjectURL(url);
            const stop = () => {
              clearTimeout(timer);
              worker.terminate();
            };
            const timer = setTimeout(() => {
              stop();
              reject(new Error("Corpus worker did not respond within 15 seconds"));
            }, 15_000);
            worker.onerror = (event) => {
              stop();
              reject(new Error(event.message));
            };
            worker.onmessage = (event) => {
              stop();
              accept(
                event.data.error
                  ? event.data
                  : {
                      sha256: event.data.sha256,
                      canonical: JSON.stringify(event.data.run, (_, value) =>
                        value instanceof Map ? Object.fromEntries(value) : value,
                      ),
                    },
              );
            };
            const input = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
            worker.postMessage(input, [input.buffer]);
          }),
        { base64: bytes.toString("base64"), source: workerSource },
      );
      if (error) {
        assert.equal(actual.error, error, `${repo.repo}/${file.path}`);
        assert.equal(actual.parseError, true);
      } else {
        assert.equal(actual.sha256, file.sha256);
        assert.equal(actual.canonical, expected, `${repo.repo}/${file.path}`);
      }
      records.push({
        repo: repo.repo,
        path: file.path,
        bytes: bytes.length,
        sha256: file.sha256,
        outcome: error ? "rejected" : "parsed",
        ...(error ? { error } : { parsed_sha256: hash(expected) }),
      });
    }
  }
} finally {
  await browser.close();
}
const result = {
  baseline: "f017c100d6df4e60f87c0a48f09f5a5b8fa3623d",
  scope:
    "Same pinned bytes through the baseline synchronous parser and the actual bundled browser worker. Complete values and comparison maps must match.",
  cases: records.length,
  parsed: records.filter((record) => record.outcome === "parsed").length,
  rejected: records.filter((record) => record.outcome === "rejected").length,
  disagreements: 0,
  sourceManifestSha256: hash(manifestBytes),
  workerSha256: hash(workerSource),
  baselineFiles: Object.fromEntries(
    ["src/core/parser.ts", "src/core/decode.ts"].map((path) => [
      path,
      hash(readFileSync(resolve(baseline, path))),
    ]),
  ),
  records,
};
writeFileSync(values.out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ ...result, records: undefined }, null, 2));
