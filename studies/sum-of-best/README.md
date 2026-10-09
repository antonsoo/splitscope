# Sum of best checked against compiled LiveSplit

The old source checkout (`fc4193a`) added `BestSegmentTime` values. It omitted
combined skipped-split histories and personal-best spans used by LiveSplit's
normal sum-of-best calculation. This study checks the replacement against
**compiled upstream code**, then independently checks the selected records in
the original XML with Python's ElementTree.

## Inputs and results

All 436 files in the existing
[public-input manifest](../pb-odds-backtest/manifest.json) are verified against
their SHA-256 before use. Three known empty/malformed inputs remain explicit
exclusions: two upstream malformed XML fixtures and the blank Super Metroid
file that Splitscope rejects for missing required content. The exact errors
are retained, including LiveSplit accepting that blank file.

The controls are **constructed**, not recorded gameplay: one inspectable
four-segment case and 1,000 seeded cases with overlapping spans, missing golds,
PB gaps, absent/empty history entries, imported IDs, independent timing methods,
zero durations and 100 ns differences. They establish arithmetic and format
behavior, not real-world forecasting quality.

| Check | Result |
| --- | ---: |
| Hash-checked public files | 436 |
| Accepted public files | 433 |
| Constructed files | 1,001 |
| Calculations, both timing methods | 2,868 |
| Intermediate boundaries, including unavailable values | 28,308 |
| Selected source spans checked against XML | 14,240 |
| Disagreements with upstream total/boundary values | 0 |

The public results change in **53 file/timing-method combinations across 50
files**: 15 gain a complete total, 36 lower an existing total by more than a
millisecond, and two Celeste fixture results differ by one microsecond. A
combined-history span contributes to 39 changed results. These are overlapping
files, backups, fixtures and several categories per runner, not independent
samples or a representative survey. [Every changed result](results/summary.json)
includes its exact file identity and selected combined-history spans.

The included, unchanged Destrega Story Normal file moves from **1609.806** to
**1511.017 seconds**. Its 83.691-second history span covers segments 15-16, whose
golds sum to 182.480 seconds. This discrepancy motivates source inspection;
a recorded combined time can also be a mistaken split. No claim is made about
the runner's ability to achieve the hypothetical total.

## Reproduce

Run from the repository root after `npm ci`. Rust 1.97.1 is used for the oracle;
its upstream source requires at least 1.96. Existing browser binaries are used
for browser verification.

```sh
# Only needed if the pinned input cache is absent:
python3 -I studies/pb-odds-backtest/fetch.py

# Downloads pinned upstream source into the ignored study cache and compiles it:
bash studies/sum-of-best/build-oracle.sh
python3 studies/sum-of-best/verify.py \
  --oracle studies/sum-of-best/cache/livesplit-core/target/release/examples/splitscope_oracle \
  --out studies/sum-of-best/cache/verification
node --import tsx studies/sum-of-best/benchmark.ts

npm run ci
npm run test:browser
```

The oracle source is pinned to
[`fb62dd42505b16e813d2779468d81bbad7f01b5e`](https://github.com/LiveSplit/livesplit-core/tree/fb62dd42505b16e813d2779468d81bbad7f01b5e).
`oracle.rs` calls its parser and `best::calculate` directly, with no copied
algorithm and no `fix_splits` repair. `oracle.Cargo.lock` pins build dependencies.
`verify.py` requires every expected output ID in order, both timing methods and
every boundary; unexpected parser errors or subprocess failures stop the check.
Numeric comparison uses 1e-7 seconds absolute / 1e-12 relative tolerance.
It verifies that each selected source exists, preserves absent/empty values,
contributes its stated duration, and joins the other spans without gaps or
overlap. Tied predecessor identities need not match upstream.

## Runtime and browser evidence

On this 14-vCPU WSL2 Linux machine with 48 GB RAM, fresh calculations for both
methods over 433 parsed files took a median **11.56 ms** over seven passes
(parsing excluded, cache bypassed). The largest history has 17,586 entries;
one method took **0.386 ms** median over 21 passes. Its full evidence download
was 1,138,408 bytes and took 3.40 ms to calculate/serialize in Node.
[Individual timings](results/benchmark.json). These are local measurements,
not a browser or cross-machine performance guarantee.

```sh
npm run build
npm run preview -- --host 127.0.0.1 --port 4337 --strictPort
# In another terminal:
node scripts/capture-best-route.mjs
```

The capture script opens the built application, loads the actual public file,
and saves screenshots in Chromium and Firefox at widths 375 and 1440 in both
themes. Element screenshots use a taller viewport to include the whole section
without a sticky-header overlay; interaction/overflow checks use phone-height
viewports. The actual offline [JSON calculation](results/browser/calculation.json),
[Markdown summary](results/browser/summary.md), and
[PNG share card](../../docs/assets/sum-of-best/share.png) are retained unedited.
The new browser scenarios also check timing-method changes, source keyboard
navigation, failed replacement, reset, missing-path output, local-only requests,
CSP/runtime errors and accessibility. The existing practice/import workflows
are included in the full browser suite.

The [workflow documentation](../../docs/sum-of-best.md) states the calculation's
limits. The feature and evidence are local source work; nothing was deployed.
