# Verification: recorded sum-of-best evidence

The source checkout now computes the same normal sum-of-best totals as pinned
LiveSplit for the checked inputs, and lets a runner inspect the contributing
records. The retained Destrega file changes from 26:49.806 (individual golds)
to 25:11.017 (including a combined span). The JSON download contains enough
source data to replay the entire calculation, not only its selected route.

The source tree was clean before work began at `fc4193a`. After the local checks,
source commit `751d1bf` was pushed to `main` and its verified static build to
`gh-pages` (`247359d`). No package registry release was made.

The [hosted verification](verification-sum-of-best-hosted.json) records real
Chromium and Firefox visits to [the published app](https://antonsoo.github.io/splitscope/).
Both loaded Destrega at 375px, displayed 25:11.017, and downloaded the complete
calculation offline, matching the retained JSON exactly. Neither had page
overflow or runtime errors. The served JS and CSS SHA-256 hashes matched the
fresh production build below.

## Verification performed

A fresh archive of `01e78bb` was extracted into an empty directory and installed
with `npm ci`; dependencies were not borrowed from the working checkout.
The later commit adds this record and byte-preservation attributes only.

| Command / workflow | Result |
| --- | --- |
| `npm ci` | 68 packages installed; lockfile accepted; audit reported zero vulnerabilities |
| `npm run ci` | Passed lint, typecheck, 161 tests in 14 files, and production build |
| Lint details | No errors; 34 warnings in existing code/tests and one deprecated-config informational diagnostic |
| `npm run test:browser` | 58 scenarios passed in Chromium and Firefox, 49.1 seconds |
| Fresh `npm run dev -- --host 127.0.0.1 --port 4338 --strictPort` | Public Destrega example loaded, showed 25:11.017, no browser runtime errors |
| `bash studies/sum-of-best/build-oracle.sh` | Pinned upstream source compiled with the retained Cargo lock and Rust 1.97.1 |
| `python3 studies/sum-of-best/verify.py --oracle studies/sum-of-best/cache/livesplit-core/target/release/examples/splitscope_oracle --out studies/sum-of-best/cache/verification` | 2,868 calculations, 28,308 boundaries and 14,240 source spans checked; zero disagreements |
| `node --import tsx studies/sum-of-best/benchmark.ts` | Fresh calculations measured; every individual timing retained in the study |
| `node scripts/capture-best-route.mjs` against preview port 4337 | Eight browser/theme/width captures and unedited offline JSON, Markdown and PNG downloads |
| Source hash after archive extraction | Destrega bytes still match the pinned input SHA-256 |
| `git diff --check` | Passed |

The clean production build is `npm run build`, output **`dist/`**, base path
**`/splitscope/`**. Its main JS is 137.16 kB / 46.77 kB gzip and CSS is
65.76 kB / 11.47 kB gzip. The recorded example is bundled with its original
license and source manifest. `.gitattributes` preserves recorded `.lss` bytes
and actual downloaded evidence across checkouts.

All eight screenshots under [`assets/sum-of-best`](assets/sum-of-best/) and the
PNG card were opened and inspected. Labels and source records are readable in
both themes. The phone layout places the selected evidence before the route;
the wide route scrolls inside its labelled region, with no page overflow.
Element captures use a taller viewport to avoid covering evidence with the
sticky header; the interaction tests also use ordinary phone-height viewports.
The full browser suite includes the existing practice and import workflows.

## Limits and scope

This repairs the calculation and makes it auditable. It does not establish
whether a saved split is honest, correctly timed, from a compatible route, or
achievable in a complete attempt. The public corpus contains backups and
fixtures, not 433 independent runners. Three known empty/malformed inputs remain
excluded explicitly. Constructed controls are not gameplay. PB-odds forecasts
and their calibration are unchanged. No timer recording, active-run integration,
or file editing was added.

An initial browser check used a nonexistent timing selector; it was corrected
to the actual RTA/IGT controls. The full run then exposed an ambiguous test
locator shared by the two evidence sections and an assertion for the old
“Incomplete” label. Both were updated to check the intended behavior. All 58
scenarios subsequently passed together in the fresh install.

## Review pointers

- [Workflow, algorithm and source semantics](sum-of-best.md)
- [Independent study and per-file differences](../studies/sum-of-best/README.md)
- [Actual offline calculation download](../studies/sum-of-best/results/browser/calculation.json)
- [Desktop screenshot](assets/sum-of-best/chromium-1440-dark.png)
- [Phone screenshot](assets/sum-of-best/firefox-375-light.png)

Suggested repository description:
**Inspect LiveSplit histories, practice cohorts and the source records behind a sum of best.**

Suggested topics: `livesplit`, `speedrunning`, `data-visualization`, `typescript`,
`offline-first`, `statistics`.

Implementation commits:

```text
01e78bb docs: retain public sum of best evidence and explain its limits
40fd92f feat: inspect sum of best sources and export the complete calculation
6ed0ca0 test: verify best routes against compiled LiveSplit and source XML
dca2cdf fix: calculate sum of best from complete recorded spans
```
