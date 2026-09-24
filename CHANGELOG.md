# Changelog

All notable changes to this project are documented in this file.

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
