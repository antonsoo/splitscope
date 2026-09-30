# Changelog

All notable changes to this project are documented in this file.

## [0.2.0] - 2026-09-30

### Fixed

- The segment after a skipped split was analysed as that segment's own time.
  LiveSplit records it as the time since the last split taken, which covers
  both segments (livesplit-core `Run::update_segment_history`), so it entered
  consistency statistics, strip plots, gold history, and the Monte Carlo
  sample as an outlier-slow run. It is now left out by the rule livesplit-core's
  own average and median comparisons use.
- Reset analysis and the PB-odds hazard model rescanned every segment's history
  once per attempt: about 4 s for a 5,000-attempt, 30-segment file, run several
  times per render and again on every PB-odds slider move. Each attempt's
  furthest segment is now indexed in one pass (35 ms for the same file).

### Added

- 95% intervals on "chance of a PB in the next K attempts" and "expected
  attempts to next PB", carried through from the per-attempt interval, in the
  app and the Markdown export. The model's assumptions now say that all three
  intervals cover simulation noise only.

## [0.1.0] - 2026-09-24

Initial release.

### Added

- Parser for LiveSplit `.lss` files, verified against the `livesplit-core`
  reference implementation, including version-gated support back to format
  `1.0.0.0`.
- Core analyses: PB / sum of best / possible time save per segment, segment
  consistency (median, IQR, standard deviation, near-gold %), improvement
  trend, reset/survival analysis, playtime and gold history.
- Monte Carlo PB-odds simulation (bootstrap resampling + empirical reset
  hazard), with closed-form test oracles.
- In-browser UI: segment heatmap table, cumulative delta-vs-PB chart,
  survival curve with reset histogram, per-segment distribution strips, and
  a PB-odds panel with live controls.
- Markdown and PNG export.
- Two synthetic sample `.lss` files with a reproducible generator script.
