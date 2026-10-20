# Recorded attempt time, from original records to downloaded evidence

This feature partitions saved timestamp durations by cohort, outcome and
inferred reset location. The previous practice review exposed reset counts and
a whole-history elapsed subtotal, without this breakdown. It did not supply
false per-segment duration totals; this is an added review capability.

The unchanged MIT-licensed Re-Loaded history has ten recent resets inferred at
Desert totaling 236 seconds and four at Monestary totaling 2,898 seconds. Its
original file and source receipt are in `examples/recorded/`. The counts and
durations are saved observations, not a practice recommendation or a statement
about time spent at one segment.

## Independent checks

[`verify.py`](verify.py) hash-checks all 436 files in the existing
[public corpus manifest](../pb-odds-backtest/manifest.json). It parses their
original XML with Python ElementTree and computes timestamp differences with
the standard library's UTC calendar implementation. It reuses only the existing
independent Python reader's version gates and outcome rules, not TypeScript
code or its results as expectations.

The accepted corpus has 85,512 attempts, including older histories without
timestamps. One explicitly authored file adds eight native-writer controls.
The full replay checks 1,302 cohort pairs, each also calculated with both
timing methods to require identical elapsed-time results. Outcome partitions,
reset-location partitions, unavailable reasons, whole-second zeros and every
overlap witness are checked against original records. The three known malformed
or empty files remain explicit rejections in [`results/summary.json`](results/summary.json).

Compiled upstream code independently parses the same accepted files.
[`oracle.rs`](oracle.rs) calls the original parser and `Attempt::duration`, pinned
to LiveSplit/livesplit-core
[`fb62dd42505b16e813d2779468d81bbad7f01b5e`](https://github.com/LiveSplit/livesplit-core/tree/fb62dd42505b16e813d2779468d81bbad7f01b5e).
All **85,192 available nonnegative timestamp durations** agree exactly.
This count includes six authored available durations. The original corpus
contains eight reversed pairs; the native control adds one. They remain
unavailable here even when their sync flags are true.

This comparison intentionally selects timestamp pairs. Upstream `duration`
can fall back to RTA when a timestamp is absent. Its separate total-playtime
analysis subtracts known pauses and can sum old segment history. Splitscope's
new budget does neither: a mixture of those measures would not be a consistent
timestamp-duration partition. Its existing numerical whole-history subtotal is
unchanged and is now labelled **Elapsed attempts**.

Upstream's
[`Attempt` contract](https://github.com/LiveSplit/livesplit-core/blob/fb62dd42505b16e813d2779468d81bbad7f01b5e/src/run/attempt.rs)
and [native saver](https://github.com/LiveSplit/livesplit-core/blob/fb62dd42505b16e813d2779468d81bbad7f01b5e/src/run/saver/livesplit.rs)
document pauses, unavailable pause fields, UTC timestamps and whole-second
serialization. Those semantics determine the labels and boundaries here.

## Native producer controls

The compiled upstream saver writes [`controls/native-clocks.lss`](controls/native-clocks.lss).
These are **authored API inputs, not recorded gameplay**. They include a timer
offset, a recorded pause, absent pause time, a GameTime-only completion, a saved
zero duration, an unknown final-segment outcome, a missing end with an available
RTA, a reversed clock pair and an overlapping interval. A one-attempt review
requires its overlap witness to remain available outside both selected groups.
`controls/source.json` identifies the producer and exact file bytes.

Overlap detection is checked independently with ordered start/end events.
The implementation uses a sorted sweep with a longest-ending witness. The
corpus contains no overlapping positive intervals; the authored control checks
that boundary. Calendar errors and safe integer limits also have focused unit
checks. This corpus is a collection of public files, fixtures and backups,
including duplicate observations; it is not a representative runner sample.

## Browser workflow

[`browser.mjs`](browser.mjs) uses actual Chromium and Firefox pages at 1440 and
375 pixels. It checks real downloaded JSON against independently verified native
results, rather than calling a UI helper. The retained local receipt covers 32
downloads, count/time ordering, exact reset membership, raw clocks, saved zero,
historical ranges, retained reports after an invalid range, method/theme changes,
unknown upload provenance and native clock controls. Offline interactions and
downloads operate on loaded inputs. Both themes are used; each profile has zero
runtime/CSP/unhandled-rejection errors, off-origin requests and Axe violations.

The screenshots in `docs/assets/time-budget/` are actual unedited local views.
[`results/expected.json`](results/expected.json) retains only the two browser
inputs' checked configurations. Full implementation and upstream JSONL outputs
stay outside the tracked tree and can be regenerated below.

## Cost of indexing

On the largest accepted public history (20,266 attempts), rebuilding the whole
clock index and partitioning two 30-attempt groups took a 94.56 ms median over
21 measured passes. Reusing that index took 0.018 ms median over 100 passes.
Parsing and the prior count comparison are excluded. These measurements use
Node 26.7.0 on a shared 14-vCPU WSL2 Linux host with 47.05 GiB reported RAM;
they are not a general latency guarantee. Exact input identity, ranges and
measurements are in [`results/performance.json`](results/performance.json).
Run `node --import tsx studies/time-budget/benchmark.ts` to reproduce.

## Reproduce

Run from the repository root. Python 3.12+, Rust 1.97.1, Node 24+ and the
existing Playwright browser binaries are needed for the complete study.

```sh
npm ci
# Only if the pinned corpus cache is absent:
python3 studies/pb-odds-backtest/fetch.py
bash studies/time-budget/build-oracle.sh
python3 studies/time-budget/verify.py --out studies/time-budget/cache/verification
npm run ci
npm run test:browser
npm run preview -- --host 127.0.0.1 --port 7894 --strictPort
# In another terminal:
node studies/time-budget/browser.mjs http://127.0.0.1:7894/splitscope/ studies/time-budget/cache/browser
```

The source archive's SHA-256 and Cargo lock are checked by the build script.
The browser checker accepts a public base URL and a `before` mode for the
original UI. Input hashes and the retained native source remain the authority;
neither a matching version number nor a successful build establishes which
bytes a hosted page serves. No registry release or tag is created by this study.
