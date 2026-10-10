# Large histories must finish loading or explain why they cannot

At `f017c10`, an accepted 140,000-attempt file stayed on **Reading** indefinitely.
No analysis or error appeared. The file was below the 25 MiB input limit.
The delta chart passed every completed time as a separate argument to
`Math.min`/`Math.max`, exceeding the browser's call-stack limit. The import
handler had already cleared ownership of the load, so it swallowed the
rendering failure as if it came from an obsolete import.

The [controlled fixture generator](../tests/fixtures/long-history.ts) writes
two synthetic histories: repeated durations and a new record on every
attempt. Attempt totals and segment durations agree. Neither is a real
speedrun or evidence about player behavior.

## What changes

- Reading still enforces 25 MiB. Hashing and XML parsing run in a dedicated
  local worker. Cancel, New file and a replacement import terminate it.
  Its code is included in the initial app bundle, so it needs no later network
  fetch when importing offline. The built CSP permits this local blob worker;
  external connections remain disallowed.
  A worker that cannot start or return its result gives a recoverable error;
  parsing is stopped after 15 seconds, with retry available.
- An import remains owned until the new workspace renders successfully.
  A preparation failure restores the previous run, timing method and caches
  and offers retry. A failed first import returns to the intake controls.
- Chart extrema use a traversal rather than file-sized argument lists.
  Delta plots retain the first, last, fastest and slowest observation in
  each horizontal display column. They keep original attempt positions,
  including gaps. Gold-history plots use the same reduction in record order;
  their horizontal axis does not represent elapsed attempts or wall time.
- Above 1,024 segment timings, the distribution becomes a 64-bin histogram.
  Every observation contributes to exactly one bin. Bar height is count;
  bin bounds and counts are available in SVG titles. Gold and median markers
  still use the complete distribution. Captions identify every reduction.

These are display changes. Calculations, PB modeling and evidence exports
retain all observations. There is no random display sample, and an isolated
extreme cannot disappear inside a display column. Intermediate points and
record markers may be omitted from the reduced line plots; the original
records remain available in the practice inspector and its downloads.

## Reproduce

After the usual development install and browser setup:

```sh
npm run build
npx playwright test tests/browser/large-history.spec.ts
```

These workflows feed the actual generated files into the production UI,
select all 140,000 timings, sum the displayed bin counts, check the bounded
chart marks, cancel real parsing and replace the input. Controlled failures
exercise worker startup, a nonresponding worker and a failure while preparing
the replacement. The timeout check advances the browser clock; it is not a
measurement of a 15-second workload.

The new worker was also compared with the previous synchronous parser on all
436 files in the pinned [public-history corpus](../studies/pb-odds-backtest/manifest.json).
Every file matched its byte count and SHA-256. All complete parsed values and
comparison maps matched for 433 files; the same three files were rejected
with the same errors. This is a transport/parsing regression comparison,
not a new independent validation of every statistic or forecast.

## Limits

The timeout bounds worker parsing, not total page memory or every operation
in the workspace. Structured-clone transfer, statistics, DOM construction and
Monte Carlo calculations still require work on the main thread. A file with
an extreme number of segments can remain expensive. Small-data layouts and
calculations keep their existing behavior; there is no claim that forecasting
became better calibrated. File contents remain local, with no upload or
browser-storage persistence.
