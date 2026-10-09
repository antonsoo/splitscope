# Checking practice review against saved XML

This study checks the source checkout's practice comparison and attempt
inspection. It reuses the pinned files from
[`pb-odds-backtest`](../pb-odds-backtest/README.md), without changing that study's
forecasting algorithm or results. It is a format and arithmetic check, not a
measurement of skill, training benefit, or forecast accuracy.

## Independent check

`analyze.ts` runs the implementation. `verify.py` reads the original XML with
Python's standard-library ElementTree and computes its own groups, outcomes,
reset denominators, completion medians and split record interpretations. It
does not import the implementation or call its existing reset analysis.

Every cached input must match the existing manifest's SHA-256. The verifier
requires exactly the expected files, comparison configurations and inspections;
it fails on omitted output, unexpected parser failures, a failed child process,
or a disagreement. The three known empty/malformed fixtures are an explicit
exclusion list. Integers, identities, outcomes and missingness must agree
exactly. Floating-point seconds use 1e-9 absolute / 1e-12 relative tolerance to
allow arithmetic in the two languages.

For each accepted file it checks both timing methods at two positions: a
30-record group ending at the latest attempt, and a 17-record group ending
halfway through the history. Each configuration checks both recent and previous
groups. It also inspects every segment of the last 60 recorded attempts in both
timing methods.

| Check | Result |
| --- | ---: |
| Input files verified against pinned hashes | 436 |
| Files accepted by the parser | 433 |
| Recorded attempts in those files | 85,512 |
| Groups checked | 3,464 |
| Attempt inspections checked | 26,352 |
| Individual segment records checked | 398,606 |
| Timed / combined records | 47,353 / 451 |
| Untimed / missing records | 36,704 / 314,098 |
| Disagreements | 0 |

The files include upstream fixtures, sparse histories, backups and multiple
categories from the same runners. Repeated or overlapping data must not be
counted as independent evidence. The same interpretation is used on both sides
of the check; it cannot prove that an edited history records where a reset
actually occurred. The controlled fixture separately exercises known sparse-ID,
other-method completion, absent history, skipped/combined and unknown-outcome
cases.

## Reproduce

From the repository root, after `npm ci`:

```sh
# Fetch only if the corpus cache is absent. Input revisions are pinned.
python3 -I studies/pb-odds-backtest/fetch.py
python3 studies/practice-review/verify.py --out /tmp/splitscope-practice-check
node --import tsx studies/practice-review/benchmark.ts

npm run build
npm run preview -- --host 127.0.0.1 --port 4331
# In a second terminal, against that production preview:
node --import tsx scripts/verify-practice.mjs
```

The verifier retains `native.jsonl` and `verification.json` in the requested
output directory. Only the compact result is committed here as
[`results.json`](results.json), including source and manifest hashes. The
browser verification retains screenshots and its report under `docs/`.

## Performance

[`performance.json`](performance.json) records twelve iterations on three
unchanged inputs, including the corpus's largest file and its largest recorded
attempt count (20,266). Parsing, cold practice comparison, a cached whole-history
comparison, and single-attempt inspection are timed separately. These are local
CPU measurements, not a browser latency claim. The machine and Node version are
recorded in the artifact. The core indexes each attempt once and accumulates
reached counts without an attempts-by-segments matrix; individual inspection
uses binary search in sorted segment histories.

The app still parses XML and renders the other analyses on the main thread.
Pagination bounds the new review's rendered rows; it does not make all existing
charts asynchronous.
