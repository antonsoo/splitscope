/** The segment table: PB, gold, possible time save (heat-barred), and a consistency chip. */
import { pbSegmentDuration, possibleTimeSave, segmentConsistency } from "../../core/stats.js";
import type { Run, TimingMethod } from "../../core/types.js";
import { pick } from "../../core/types.js";
import { el } from "../dom.js";
import { formatPercent, formatSeconds } from "../format.js";

export interface SegmentTableOptions {
  readonly method: TimingMethod;
  readonly consistencyWindow: number;
  readonly toleranceSeconds: number;
}

/**
 * Tiers by coefficient of variation (stdDev / median) rather than a fixed
 * number of seconds, so a 12-second segment and a 4-minute segment are
 * judged on the same scale — 3% variance is "tight" whether that's 0.4s or
 * 7s of wobble.
 */
function consistencyTier(
  stdDev: number | null,
  median: number | null,
): "tight" | "mid" | "loose" | "na" {
  if (stdDev === null || median === null || median <= 0) return "na";
  const cv = stdDev / median;
  if (cv <= 0.03) return "tight";
  if (cv <= 0.08) return "mid";
  return "loose";
}

export function renderSegmentTable(run: Run, options: SegmentTableOptions): HTMLElement {
  const saves = possibleTimeSave(run, options.method);
  const maxSave = Math.max(1, ...saves.filter((s): s is number => s !== null && s > 0));

  const rows = run.segments.map((segment, i) => {
    const pbDuration = pbSegmentDuration(run, i, options.method);
    const gold = pick(segment.bestSegmentTime, options.method);
    const save = saves[i] ?? null;
    const stats = segmentConsistency(
      run,
      i,
      options.method,
      options.consistencyWindow,
      options.toleranceSeconds,
    );
    const tier = consistencyTier(stats.stdDev, stats.median);
    const barWidth = save !== null && save > 0 ? Math.max(4, (save / maxSave) * 100) : 0;

    return el("tr", {}, [
      el("td", { class: "seg-name" }, [
        el("span", { class: "idx" }, [String(i + 1).padStart(2, "0")]),
        segment.name,
      ]),
      el("td", {}, [formatSeconds(pbDuration)]),
      el("td", { class: "gold-text" }, [formatSeconds(gold)]),
      el("td", { class: "save-cell" }, [
        el("span", { class: "save-bar", style: `width:${barWidth}%` }),
        el("span", {}, [save === null ? "—" : save <= 0 ? "—" : formatSeconds(save)]),
      ]),
      el("td", {}, [stats.median === null ? "—" : formatSeconds(stats.median)]),
      el("td", {}, [stats.iqr === null ? "—" : `±${formatSeconds(stats.iqr / 2, 1)}`]),
      el("td", {}, [
        el("span", { class: `consistency-chip ${tier}` }, [
          stats.stdDev === null ? "n/a" : `σ ${formatSeconds(stats.stdDev, 1)}`,
        ]),
      ]),
      el("td", {}, [formatPercent(stats.percentWithinGold)]),
    ]);
  });

  return el("div", { class: "panel", style: "overflow-x:auto" }, [
    el("table", { class: "seg-table" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", {}, ["Segment"]),
          el("th", {}, ["PB"]),
          el("th", {}, ["Gold"]),
          el("th", {}, ["Time save"]),
          el("th", {}, ["Median"]),
          el("th", {}, ["± IQR/2"]),
          el("th", {}, ["Consistency"]),
          el("th", { title: "Share of recent attempts within tolerance of gold" }, ["Near-gold %"]),
        ]),
      ]),
      el("tbody", {}, rows),
    ]),
  ]);
}
