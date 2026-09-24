# The LiveSplit `.lss` format

splitscope's parser (`src/core/parser.ts`) is verified against LiveSplit's own
parser, not against sample files or third-party writeups. The reference is:

> LiveSplit/livesplit-core, `src/run/parser/livesplit.rs`, function `parse`
> (and its helpers `parse_segment`, `parse_attempt_history`,
> `parse_run_history`, `parse_metadata`, `parse_time_span`).
> <https://github.com/LiveSplit/livesplit-core/blob/master/src/run/parser/livesplit.rs>
> (LiveSplit organization, MIT-licensed; fetched 2026-09-24.)

`livesplit-core` is the Rust core LiveSplit itself is built on today, and its
`.lss` reader is the authoritative implementation — the original C#
`LiveSplit.Core` parser (`XMLRunFactory.cs`) has been superseded by it. Every
element name, attribute, and version gate below is taken directly from that
file, not reconstructed from memory.

## Document shape

```xml
<Run version="1.8.1">
  <GameName>Crystal Caverns</GameName>
  <CategoryName>Any%</CategoryName>
  <Offset>00:00:00</Offset>
  <AttemptCount>220</AttemptCount>
  <AttemptHistory>
    <Attempt id="1" started="1/5/2026 18:00:43" isStartedSynced="True"
             ended="1/5/2026 18:05:13" isEndedSynced="True">
      <RealTime>00:04:30.3577888</RealTime>
      <GameTime>00:04:25.1000000</GameTime>
    </Attempt>
    ...
  </AttemptHistory>
  <Segments>
    <Segment>
      <Name>Cave Entrance</Name>
      <SplitTimes>
        <SplitTime name="Personal Best">
          <RealTime>00:00:42.1000000</RealTime>
          <GameTime>00:00:40.8000000</GameTime>
        </SplitTime>
      </SplitTimes>
      <BestSegmentTime>
        <RealTime>00:00:38.2000000</RealTime>
        <GameTime>00:00:37.0000000</GameTime>
      </BestSegmentTime>
      <SegmentHistory>
        <Time id="1">
          <RealTime>00:00:44.9000000</RealTime>
          <GameTime>00:00:43.1000000</GameTime>
        </Time>
        ...
      </SegmentHistory>
    </Segment>
    ...
  </Segments>
</Run>
```

splitscope reads: `GameName`, `CategoryName`, `Offset`, `AttemptCount`,
`AttemptHistory`/`RunHistory` (attempts), and per-segment `Name`,
`SplitTimes`/`PersonalBestSplitTime`, `BestSegmentTime`, and
`SegmentHistory`. It ignores `GameIcon`, per-segment `Icon`,
`AutoSplitterSettings`, `LayoutPath`, `SegmentGroups`, and most of
`Metadata` — none of it is needed for analysis, and `GameIcon`/`Icon`/
`AutoSplitterSettings` are stripped from the text before parsing (see
"Performance" below) because they can be large and are never read.

## Time format

Every duration is a serialized .NET `TimeSpan`:

- Standard: `[-]H:MM:SS[.fffffff]` — hours are unpadded and unbounded (`"12:34:56"`
  or `"120:34:56"` are both valid), minutes/seconds are always 2 digits, and the
  optional fraction is up to 7 digits (100ns "ticks", .NET's native resolution).
  The brief's example, `00:01:23.4560000`, is this shape.
- Extended (multi-day): `[-]D.HH:MM:SS[.fffffff]`, e.g. `1.23:34:56.7890000` for
  25h34m56.789s. `parse_time_span` in the reference detects this by splitting on
  the *first* `.` and checking whether what follows contains a `:`; a negative
  day count negates the whole duration (`"-1.23:34:56.789"` is
  `-(1 day + 23:34:56.789)`, not "-1 day + 23:34:56.789"). splitscope's
  `parseTimeSpan` (`src/core/timespan.ts`) ports this exactly, including its
  rejection cases (`tests/timespan.test.ts` includes the reference's own unit
  test values for both, taken from `livesplit.rs`'s `time_span_parsing` test).
- Empty text (`<RealTime></RealTime>` or self-closing `<RealTime/>`) means "not
  recorded" — `null` in splitscope's model, never `0`. This is the difference
  between "this attempt didn't finish" and "this attempt finished in zero
  seconds."

## Version gates

LiveSplit's `.lss` format has grown several incompatible shapes over its
`version` attribute (`Run version="..."`, defaulting to `1.0.0.0` if absent).
splitscope reproduces every gate the reference parser checks:

| Version | What changes |
| --- | --- |
| `< 1.3.0` | No `<SplitTimes>` wrapper — a segment has one comparison, `<PersonalBestSplitTime>`, as a direct time value. |
| `>= 1.3.0` | `<SplitTimes>` holds one `<SplitTime name="...">` per comparison (splitscope only uses `"Personal Best"`). |
| `< 1.4.1` | `<BestSegmentTime>`, each `<SplitTime>`, and each `<SegmentHistory><Time id="N">` hold their value as **direct text mixed with the `id`/other attributes** (e.g. `<Time id="3">00:01:00.0000000</Time>`), and represent RealTime only — GameTime does not exist in this shape. |
| `>= 1.4.1` | Those same elements instead wrap `<RealTime>`/`<GameTime>` children, so both timing methods can be recorded per entry. |
| `< 1.5.0` | Attempts live in `<RunHistory><Time id="N">...</Time></RunHistory>` — just an id and an overall time, no timestamps, no pause time. |
| `>= 1.5.0` | Attempts live in `<AttemptHistory><Attempt id="N" started="..." ended="...">` with full timestamps, sync flags, and `<PauseTime>`. |
| `>= 1.6.0` | `<Metadata>` gains structured platform/region/variable data (splitscope doesn't read it). |
| `>= 1.8.1` | Segment grouping becomes native (`<SegmentGroups>`); older files that used a `-`/`{Group}` prefix convention in segment names are reinterpreted by LiveSplit on load. splitscope doesn't need segment grouping and doesn't reproduce this step. |

`tests/parser.test.ts` includes a fixture at `1.0.0.0` (the oldest shape: no
`SplitTimes`, `RunHistory` instead of `AttemptHistory`, direct-value times
throughout) alongside a modern `1.8.1` fixture, so both code paths run in CI,
not just the current format.

## Segment time vs. split time — a semantic note

LiveSplit's own vocabulary is easy to mix up, and getting it backwards would
silently corrupt every statistic in this app:

- **Split time** (`<SplitTimes>`, i.e. a comparison like "Personal Best") is
  **cumulative**: how much total time had elapsed when that segment ended.
- **Segment time** (`<BestSegmentTime>`, `<SegmentHistory>`) is the duration
  of **that segment alone**.

So a segment's *own* PB duration isn't stored directly — it's the difference
between consecutive cumulative PB split times
(`pbSegmentDuration(i) = pbCumulative(i) − pbCumulative(i − 1)`), which is
exactly how splitscope computes "possible time save"
(`src/core/stats.ts`, `pbSegmentDuration`). "Sum of best" is the sum of every
segment's *own* gold (`BestSegmentTime`) — a hypothetical run that never
happened, not a real attempt.

## What counts as a "reset"

Skipping a split records an empty `<Time id="N">` entry in `SegmentHistory`
for the segment that was skipped over (present, but with no time) — the
runner still passed through it, just without a clean split. splitscope
treats that as "reached, not timed" and excludes it from consistency
statistics, but still counts it toward "furthest segment reached" for reset
analysis (`furthestSegmentIndex` in `src/core/stats.ts`).

An attempt that resets, by contrast, has **no `SegmentHistory` entry at all**
for the segments it never reached, and no overall `<RealTime>` on its
`<AttemptHistory><Attempt>` entry (`readTime`/`readNestedTime` parse that
empty element to `null`). splitscope uses the presence of an attempt's
overall `RealTime` as the finish/reset signal — a design decision, not
something the format states explicitly — and the highest segment index with
*any* `SegmentHistory` entry (timed or skipped) as where a non-finishing
attempt died. This is documented in code at
`furthestSegmentIndex`/`attemptFinished` in `src/core/stats.ts`.

## Performance

`GameIcon`, per-segment `Icon`, and `AutoSplitterSettings` can be the bulk of
a real `.lss` file's bytes (base64 images, serialized autosplitter state) and
are never read by this app, so `parser.ts` strips them with a targeted regex
before the general XML parse (`stripOpaqueBlobs`). This is a real, measured
win, not a guess — see the "Accuracy and limitations" section of the README
for the number on this repository's own sample file.
