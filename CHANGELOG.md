# Changelog

All notable changes to this project are documented in this file.

## Unreleased

- Preserve text on attributed XML fields, including modern and legacy durations.
  Reject repeated singleton fields, nested scalar content, empty records, and
  unnamed comparisons rather than turning them into absent timing evidence.
  Check 45 controls against compiled LiveSplit and retain unchanged results for
  436 pinned public files, including copies with 153,680 added leaf attributes.

- Keep large-history imports recoverable: parse and hash in a cancellable
  worker, report parser failures/timeouts, and restore the previous workspace
  when preparing its replacement fails. Fix an accepted 140,000-attempt
  file silently stranded on "Reading" by chart argument overflow.
- Bound chart marks for long histories: retain first/last/extrema per display
  column and use count histograms above 1,024 segment timings. Label summarized
  displays; retain all observations for statistics and evidence exports.
- Calculate sum of best from complete stored gold, PB and combined-history
  spans, matching LiveSplit's normal calculation. Keep the gold-only sum visible;
  return unavailable for missing paths, not a partial total.
- Inspect each contributing source record and download full calculation inputs
  with the source hash. Keep combined times indivisible and update Markdown/PNG
  totals. Include an unchanged, licensed Destrega history demonstrating the gap.
- Check 2,868 calculations and all intermediate boundaries against compiled,
  pinned LiveSplit, plus 14,240 source spans against original XML. Retain public
  changes, generated controls, offline downloads and browser captures.

- Compare recent and preceding practice groups at any recorded attempt. Inspect
  reset membership, individual split records and current-PB deltas, and export
  both full groups with original evidence and the input SHA-256. Keep completed,
  inferred-reset and unknown outcomes distinct, including other-method totals.
- Add an unchanged, attributed Zero Divide 2 history as an interactive recorded
  example. Independently check practice arithmetic and split interpretation on
  433 parsed public files, including 398,606 inspected segment records.
- Paginate the practice tables, preserve keyboard focus and selections, and show
  readable split records on phones. Keep the sticky header opaque so scrolled
  text does not overlap its controls in Firefox.
- PB odds widen the recent-form window until every segment has at least three timed
  durations in it (`minSegmentSamples`, default 3; 0 keeps the window exactly as asked).
  Backtested on 51 real histories, this lets 61% of stopping points be forecast instead of 39%
  and lowers the 50-attempt Brier score on the points that were forecast before from 0.237
  to 0.223, which nine runners cannot tell from no change. The panel and exports show the window actually used.
- Add `studies/pb-odds-backtest`: a walk-forward backtest of the PB odds on real `.lss`
  histories. The mean 50-attempt forecast was 14.3%, versus a PB in 30.9% of
  evaluated windows; the stated assumptions report that result and its limits.
- Reject ambiguous or malformed history IDs, invalid counts/versions, duplicate
  comparisons, and oversized durations. Decode numeric XML references correctly.
- Use the same recent attempt window across segments, display usable sample
  counts, and leave single-observation standard deviation unknown.
- Count GameTime-only completions and completed attempts with deleted segment
  histories correctly. Withhold PB odds for ambiguous final-segment outcomes.
- Preserve unavailable PB odds, incomplete golds and playtime coverage in the
  interface and exports. Label sample exports, escape Markdown labels, and include
  intervals on PNG cards. Carry rounded seconds into minutes/hours correctly.
- Bound imports to 25 MiB; cancel superseded reads, retain the current analysis
  on failure, and provide retry/reset controls. Preserve keyboard focus, disclosures
  and table scroll; commit slider drags on release and reject invalid settings.
- Add production browser coverage in Chromium and Firefox, including mobile,
  accessibility, offline analysis, local-only requests and CSP assertions.

## [0.2.4] - 2026-10-03

### Accessibility

- A file that could not be read replaced the page with "Couldn't read that file" and the
  reason, but a screen reader was not told. The message is an alert now.

## [0.2.3] - 2026-10-02

### Fixed

- A splits file saved as UTF-16 was refused as "Could not parse this file as
  XML". LiveSplit writes UTF-8 with a byte-order mark, but a file opened in
  Notepad and saved as "Unicode" (or redirected with `>` in Windows
  PowerShell) is UTF-16 with a mark, which the page read as UTF-8. The mark
  decides the encoding now, and a UTF-16 copy of the sample gives the same
  analysis as the original, in Chromium and Firefox.

### Changed

- The page's fonts are served by the page itself. They came from Google Fonts,
  the one request the page made to another origin; the same font files (every
  subset, as Google serves them to a current browser) are now in
  `src/fonts/`, with their SIL Open Font License texts. Nothing looks
  different: screenshots before and after match. The page now loads with
  every other host blocked.

### Security

- The built page carries a Content-Security-Policy. Scripts, styles, fonts and
  images load from the page's own origin only, and `connect-src 'self'` has
  the browser refuse to send your splits to any other host, even for a script
  injected through a bug in how the page renders a file. Inline event handlers
  and `eval` are not allowed. With the sample loaded, every button (both
  exports included) was pressed in Chromium, Firefox and WebKit with a listener
  for policy violations: none.

### Accessibility

- Checked with axe-core (WCAG 2.1 A and AA, and its best-practice rules) in the
  dark and light themes, at desktop and phone widths, with the sample loaded:
  no findings now. In the light theme the "PB odds" teaser's label (4.4:1 on
  its tint, 4.0:1 when hovered) and the green consistency chip (4.46:1) were
  below 4.5:1. The light theme's blue, green, gold and red are a little
  darker, and each clears 5:1 on its own tint (the hovered teaser 4.6:1). On a
  phone the segment table scrolls sideways inside its panel, and the
  panel can now be focused and scrolled with the keyboard.

## [0.2.2] - 2026-10-01

### Fixed

- A run laid out with LiveSplit's subsplits showed its segment names with
  the layout's prefixes: `-Cave Entrance`, `{Upper Caverns}Crystal Lake`.
  The prefixes are read the way LiveSplit's Subsplits component reads them
  and taken off for display, in the tables, the charts' labels and the
  Markdown summary. Steps are indented under the split that ends their
  section, which carries the section's name. Times and statistics are
  untouched; `Segment.name` keeps the name as written.

## [0.2.1] - 2026-10-01

### Fixed

- A file with thousands of unclosed `<Icon>`, `<GameIcon>` or
  `<AutoSplitterSettings>` tags froze the page: the pattern that drops those
  blobs before parsing rescanned to the end of the file from each opening tag
  (2.8 s for 690 KB, four times that for each doubling). It is a single pass
  now, 20 ms for the same file, and removes exactly what it removed before.

### Added

- A fuzz test: 1,500 mutated copies of the fixtures and examples (junk times
  and ids, dropped and repeated elements, truncated files) are each either
  rejected with a parse error or analyzed without a NaN in any statistic.

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
