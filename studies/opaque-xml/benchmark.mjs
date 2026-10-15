/** Record the cost of validating original XML before skipping opaque payloads. */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [baseline, output] = process.argv.slice(2);
assert(baseline && output, "BASELINE OUTPUT required");
const before = (await import(pathToFileURL(resolve(baseline, "src/core/parser.ts")).href)).parseRun;
const after = (await import(pathToFileURL(resolve("src/core/parser.ts")).href)).parseRun;
const sample = await readFile("tests/fixtures/modern-full.lss", "utf8");
const workloads = [
  ["recorded-destrega", await readFile("examples/recorded/destrega.lss", "utf8"), false, false],
  ["bundled-history", await readFile("examples/crystal-caverns-any.lss", "utf8"), true, false],
  [
    "opaque-icon-1MiB",
    sample.replace("<GameIcon />", `<GameIcon>${"A".repeat(2 ** 20)}</GameIcon>`),
    true,
    false,
  ],
  [
    "opaque-icon-10MiB",
    sample.replace("<GameIcon />", `<GameIcon>${"A".repeat(10 * 2 ** 20)}</GameIcon>`),
    true,
    false,
  ],
  [
    "opaque-settings-25000",
    sample.replace(
      "</Run>",
      `<AutoSplitterSettings>${"<Value>1</Value>".repeat(25000)}</AutoSplitterSettings></Run>`,
    ),
    true,
    false,
  ],
  ["unclosed-settings-32000", `<Run>${"<AutoSplitterSettings>".repeat(32000)}</Run>`, true, true],
];
const sha = (value) => createHash("sha256").update(value).digest("hex");
const rows = [];
for (const [name, xml, synthetic, reject] of workloads) {
  const observations = { before: [], after: [] };
  let expected;
  for (let iteration = -2; iteration < 5; iteration++) {
    for (const [version, parser] of iteration % 2
      ? [
          ["before", before],
          ["after", after],
        ]
      : [
          ["after", after],
          ["before", before],
        ]) {
      global.gc?.();
      let status = "parsed",
        run;
      const started = performance.now();
      try {
        run = parser(xml);
      } catch {
        status = "rejected";
      }
      const milliseconds = performance.now() - started;
      assert.equal(status, reject ? "rejected" : "parsed");
      const hash = sha(
        JSON.stringify(run, (_, value) => (value instanceof Map ? [...value] : value)) ?? status,
      );
      expected ??= hash;
      assert.equal(hash, expected);
      if (iteration >= 0) observations[version].push(milliseconds);
    }
  }
  const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const row = {
    name,
    bytes: Buffer.byteLength(xml),
    inputSha256: sha(xml),
    synthetic,
    status: reject ? "rejected" : "parsed",
    runHash: expected,
    beforeMilliseconds: observations.before,
    afterMilliseconds: observations.after,
    beforeMedianMs: median(observations.before),
    afterMedianMs: median(observations.after),
  };
  rows.push(row);
  console.log(name, row.beforeMedianMs.toFixed(2), "->", row.afterMedianMs.toFixed(2), "ms");
}
await writeFile(
  output,
  `${JSON.stringify(
    {
      node: process.version,
      platform: `${os.platform()} ${os.release()}`,
      logicalCpus: os.cpus().length,
      memoryGiB: os.totalmem() / 2 ** 30,
      twoWarmupsFiveAlternatingSamples: true,
      cpuAffinity: false,
      rows,
    },
    null,
    2,
  )}\n`,
);
