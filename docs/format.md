# The LiveSplit `.lss` format

splitscope's parser (`src/core/parser.ts`) follows the version gates in the
LiveSplit organization's `livesplit-core` parser. The compiled reference for
the XML evidence study is:

> LiveSplit/livesplit-core, `src/run/parser/livesplit.rs`, function `parse`
> (and its helpers `parse_segment`, `parse_attempt_history`,
> `parse_run_history`, `parse_metadata`, `parse_time_span`).
> <https://github.com/LiveSplit/livesplit-core/blob/fb62dd42505b16e813d2779468d81bbad7f01b5e/src/run/parser/livesplit.rs>
> (LiveSplit organization, MIT-licensed; checked 2026-10-11.)

`livesplit-core` is a Rust timer library used by LiveSplit One and other timers.
Splitscope has its own parser and deliberately rejects some inputs the reference
accepts, including duplicate timing fields. The [XML evidence study](../studies/xml-evidence/README.md)
records the acceptance boundaries and before/after checks; it does not establish
interchangeability with every LiveSplit reader.

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

- Standard: `[-]H:MM:SS[.fffffff]` — hours may be unpadded and exceed 23 (`"12:34:56"`
  or `"120:34:56"` are both valid), minutes/seconds are always 2 digits, and the
  optional fraction is up to 7 digits (100ns "ticks", .NET's native resolution).
  The brief's example, `00:01:23.4560000`, is this shape.
- Extended (multi-day): `[-]D.HH:MM:SS[.fffffff]`, e.g. `1.23:34:56.7890000` for
  47h34m56.789s. `parse_time_span` in the reference detects this by splitting on
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
| `>= 1.8.1` | Segment grouping becomes native (`<SegmentGroups>`); older files that used a `-`/`{Group}` prefix convention in segment names are reinterpreted by LiveSplit on load. splitscope's numbers don't depend on grouping, but it reads the name convention for display (`src/core/names.ts`): a `-` name is a step inside a section, the next name without it ends the section, and `{Section}Split` names the section. The raw name stays in `Segment.name`. |

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
(`src/core/stats.ts`, `pbSegmentDuration`). "Individual golds added" sums every
segment's own `BestSegmentTime`. The source checkout's **sum of best** also
considers complete PB spans and combined skipped-split history, matching
LiveSplit's normal calculation. It is a hypothetical combination, not a real
attempt. [Source inspection and exact rules](sum-of-best.md).

## What counts as a "reset"

Skipping a split records an empty `<Time id="N">` entry in `SegmentHistory`
for the segment that was skipped over (present, but with no time) — the
runner still passed through it, just without a clean split. splitscope
treats that as "reached, not timed" and excludes it from consistency
statistics, but still counts it toward "furthest segment reached" for reset
analysis (`furthestSegmentIndex` in `src/core/stats.ts`).

The segment *after* a skipped split is recorded differently from a normal
one: LiveSplit writes each segment's history entry as its split time minus
the last split time that was actually recorded (livesplit-core
[`Run::update_segment_history`](https://github.com/LiveSplit/livesplit-core/blob/master/src/run/mod.rs)),
so that entry is the duration of the skipped segment and this one together.
livesplit-core's average and median comparisons skip an entry whenever the
previous segment has an entry for the same attempt with no time
([`comparison/average_segments.rs`](https://github.com/LiveSplit/livesplit-core/blob/master/src/comparison/average_segments.rs)).
splitscope applies the same rule (`segmentTimes` in `src/core/stats.ts`)
before any per-segment statistic, strip plot, gold history, or Monte Carlo
sample; it only counts for "furthest segment reached."

An overall `RealTime` **or** `GameTime` is treated as completion evidence.
Such attempts reached all segments even if per-segment history was deleted.
Without an overall time, the highest recorded segment determines the inferred
reset at the next segment. If that highest record is the final segment, the
outcome is ambiguous: the histogram assigns no reset location and PB odds are
withheld when the selected window includes it. This is an analysis rule, not
an explicit finish flag in the format. Selectively deleted reset histories
can still make inferred reset locations unreliable.

## Record validation and recent windows

Attempt IDs and segment-history IDs must be complete signed 32-bit integers.
Zero and negative IDs remain valid for imported history; they are not invented
attempts. Repeated IDs within an attempt history or within one segment's history
are rejected, as are missing IDs. Silently discarding or combining those records
would alter counts or pair unrelated durations. Comparison names must be unique
within each segment. AttemptCount is an unsigned 32-bit integer, versions have
one to four unsigned 16-bit components, and durations must fit safe millisecond
arithmetic (`abs(seconds) <= Number.MAX_SAFE_INTEGER / 1000`). Numeric XML
character references are decoded once along with named entities.

Text is retained when an element carries attributes, including `xml:space`.
An attributed empty time remains unrecorded; an attributed zero remains zero.
Repeated fields expected to occur once in a given parent (times, metadata and
history containers) are rejected even when their values agree. This is stricter
than the reference's last-value behavior for repeated time elements. Splitscope
also rejects nested elements inside scalar fields it reads, empty individual
records, and comparisons without a name, rather than dropping them. Optional
absent or empty containers remain supported. This validates the fields used by
the analysis, not every ignored extension or opaque payload in an `.lss` file.

Consistency and Monte Carlo pools use IDs from the last N entries in the sorted
attempt history. A segment with no measurements in that window has no recent
samples; older completions and imported history are not substituted. Full gold
history still includes imported records, whose IDs do not establish dates.

The reference source was rechecked on 2026-10-03, including
[`Run::update_segment_history` and imported histories](https://github.com/LiveSplit/livesplit-core/blob/master/src/run/mod.rs)
and [timestamp parsing](https://github.com/LiveSplit/livesplit-core/blob/master/src/run/parser/livesplit.rs).
The first segment's stored duration already includes the timer offset, as the
reference starts the previous split at zero; the simulator does not add it twice.

## Performance

`GameIcon`, per-segment `Icon`, and `AutoSplitterSettings` can be the bulk of
a real `.lss` file's bytes (base64 images, serialized autosplitter state) and
are never read by this app, so `parser.ts` strips them with a linear string scan
before the general XML parse (`stripOpaqueBlobs`). This is a real, measured
win, not a guess — see the "Accuracy and limitations" section of the README
for the number on this repository's own sample file.
