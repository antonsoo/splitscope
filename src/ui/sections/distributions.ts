/**
 * Per-segment strip plot (every recent time as a dot, gold marked, median
 * ticked) plus a gold-history sparkline: the step-down record of when each
 * new segment gold was actually set, across the run's full history.
 */

import { mulberry32 } from "../../core/rng.js";
import { goldHistory, recentSegmentSeconds, segmentConsistency } from "../../core/stats.js";
import type { Run, TimingMethod } from "../../core/types.js";
import { pick } from "../../core/types.js";
import { displayPoints, extent, histogram } from "../charts/large-series.js";
import { niceDomain, scaleLinear } from "../charts/scale.js";
import { el, svgEl } from "../dom.js";
import { formatCount, formatSeconds } from "../format.js";

const WIDTH = 280;
const HEIGHT = 86;
const PAD_X = 12;
const STRIP_Y = 46;

const SPARK_HEIGHT = 40;
const SPARK_PAD = 8;
const MAX_STRIP_POINTS = 1024;
const DISTRIBUTION_BINS = 64;

export interface DistributionsOptions {
  readonly method: TimingMethod;
  readonly window: number;
}

function stripPlot(
  run: Run,
  index: number,
  options: DistributionsOptions,
): SVGSVGElement | HTMLElement {
  const segment = run.segments[index];
  if (!segment) return svgEl("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}` });

  const gold = pick(segment.bestSegmentTime, options.method);
  const values = recentSegmentSeconds(run, index, options.method, options.window);
  const stats = segmentConsistency(run, index, options.method, options.window, 1);

  if (values.length === 0) {
    return svgEl("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}`, class: "chart-svg" }, [
      svgEl(
        "text",
        { x: WIDTH / 2, y: HEIGHT / 2, class: "chart-axis-label", "text-anchor": "middle" },
        ["no data"],
      ),
    ]);
  }

  const [minimum, hi] = extent(values);
  const lo = Math.min(gold ?? Number.POSITIVE_INFINITY, minimum);
  const [dMin, dMax] = niceDomain(lo, hi, 0.14);
  const x = scaleLinear([dMin, dMax], [PAD_X, WIDTH - PAD_X]);

  // Deterministic per-point jitter so re-renders (e.g. re-running Monte Carlo) don't shuffle dots.
  const rng = mulberry32(index * 7919 + 13);
  const binned = values.length > MAX_STRIP_POINTS;
  const counts = binned ? histogram(values, dMin, dMax, DISTRIBUTION_BINS) : [];
  const largestBin = counts.reduce((max, count) => Math.max(max, count), 1);
  const dots = binned
    ? counts.map((count, bin) => {
        const left = dMin + ((dMax - dMin) * bin) / DISTRIBUTION_BINS;
        const right = dMin + ((dMax - dMin) * (bin + 1)) / DISTRIBUTION_BINS;
        const height = (count / largestBin) * 46;
        return svgEl(
          "rect",
          {
            x: x(left),
            y: 66 - height,
            width: Math.max(0.5, x(right) - x(left) - 0.4),
            height,
            fill: "var(--text-faint)",
            "data-count": count,
          },
          [
            svgEl("title", {}, [
              `${formatCount(count)} timings from ${formatSeconds(left, 4)} to ${formatSeconds(right, 4)}${bin === DISTRIBUTION_BINS - 1 ? " (inclusive)" : " (upper bound excluded)"}`,
            ]),
          ],
        );
      })
    : values.map((v) =>
        svgEl("circle", {
          cx: x(v),
          cy: STRIP_Y + (rng() - 0.5) * 26,
          r: 3,
          fill: gold !== null && v <= gold + 1e-9 ? "var(--gold)" : "var(--text-faint)",
          opacity: "0.85",
        }),
      );

  const children: (SVGElement | null)[] = [
    svgEl("line", {
      x1: PAD_X,
      x2: WIDTH - PAD_X,
      y1: binned ? 66 : STRIP_Y,
      y2: binned ? 66 : STRIP_Y,
      class: "chart-gridline",
    }),
    ...dots,
  ];
  if (binned) {
    children.push(
      svgEl("text", { x: x(lo), y: 82, class: "distribution-axis-label" }, [formatSeconds(lo)]),
      lo !== hi
        ? svgEl(
            "text",
            { x: x(hi), y: 82, class: "distribution-axis-label", "text-anchor": "end" },
            [formatSeconds(hi)],
          )
        : null,
    );
  }

  if (gold !== null) {
    children.push(
      svgEl("line", {
        x1: x(gold),
        x2: x(gold),
        y1: 14,
        y2: HEIGHT - 14,
        stroke: "var(--gold)",
        "stroke-width": "1.5",
        "stroke-dasharray": "3,2",
      }),
    );
  }
  if (stats.median !== null) {
    children.push(
      svgEl("line", {
        x1: x(stats.median),
        x2: x(stats.median),
        y1: 30,
        y2: 62,
        stroke: "var(--blue)",
        "stroke-width": "2",
      }),
    );
  }

  const svg = svgEl(
    "svg",
    {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: "chart-svg",
      role: "img",
      "aria-label": `${segment.label} time distribution${binned ? `: all ${formatCount(values.length)} timings in ${DISTRIBUTION_BINS} equal-width bins` : ""}`,
    },
    children.filter((c): c is SVGElement => c !== null),
  );
  return binned
    ? el("div", {}, [
        svg,
        el("p", { class: "dist-cell-sub" }, [
          `${formatCount(values.length)} timings in ${DISTRIBUTION_BINS} bins; tallest bin: ${formatCount(largestBin)}. Bar height is count. Statistics use every timing.`,
        ]),
      ])
    : svg;
}

/** Step-down sparkline of every new segment record, across the run's entire history. */
function goldSparkline(run: Run, index: number, method: TimingMethod): HTMLElement {
  const segment = run.segments[index];
  const points = segment ? goldHistory(run, index, method) : [];

  if (points.length === 0) {
    return el("p", { class: "dist-cell-sub" }, ["no gold history yet"]);
  }

  const values = points.map((p) => p.seconds);
  const [lo, hi] = extent(values);
  const [dMin, dMax] = niceDomain(lo, hi, 0.2);
  const x = scaleLinear([0, Math.max(1, points.length - 1)], [SPARK_PAD, WIDTH - SPARK_PAD]);
  const y = scaleLinear([dMin, dMax], [SPARK_PAD, SPARK_HEIGHT - SPARK_PAD]);

  // A step-after path: hold each record's time flat until the attempt that beat it.
  const marks = displayPoints(
    points.map((p, ordinal) => ({ ...p, ordinal })),
    (p) => p.ordinal,
    (p) => p.seconds,
    WIDTH - 2 * SPARK_PAD,
  );
  let path = `M${x(0)},${y(values[0] as number)}`;
  for (const mark of marks.slice(1)) {
    path += ` H${x(mark.ordinal)} V${y(mark.seconds)}`;
  }
  path += ` H${WIDTH - SPARK_PAD}`;

  const svg = svgEl(
    "svg",
    {
      viewBox: `0 0 ${WIDTH} ${SPARK_HEIGHT}`,
      class: "chart-svg",
      role: "img",
      "aria-label": `${segment?.label ?? "segment"} gold history: ${points.length} record${points.length === 1 ? "" : "s"}, most recently ${formatSeconds(values[values.length - 1] ?? null)}`,
    },
    [
      svgEl("path", { d: path, fill: "none", stroke: "var(--gold)", "stroke-width": "1.5" }),
      ...marks.map((p) =>
        svgEl("circle", { cx: x(p.ordinal), cy: y(p.seconds), r: 2, fill: "var(--gold)" }),
      ),
    ],
  );

  const first = formatSeconds(values[0] ?? null);
  const latest = formatSeconds(values[values.length - 1] ?? null);
  return el("div", {}, [
    el("p", { class: "dist-cell-sub" }, [
      `gold history: ${points.length} record${points.length === 1 ? "" : "s"}${points.length > 1 ? ` · ${first} → ${latest}` : ""}`,
    ]),
    svg,
    marks.length < points.length
      ? el("p", { class: "dist-cell-sub" }, [
          `Display: ${formatCount(marks.length)} marks for ${formatCount(points.length)} records; first, last and range retained per column. Horizontal position is record order, not elapsed attempts.`,
        ])
      : null,
  ]);
}

export function renderDistributions(run: Run, options: DistributionsOptions): HTMLElement {
  const cells = run.segments.map((segment, i) => {
    const gold = pick(segment.bestSegmentTime, options.method);
    return el("div", { class: "dist-cell" }, [
      el(
        "p",
        {
          class: "dist-cell-name",
          ...(segment.group ? { title: `${segment.group}: ${segment.label}` } : {}),
        },
        [segment.label],
      ),
      el("p", { class: "dist-cell-sub" }, [`gold ${formatSeconds(gold)} · last ${options.window}`]),
      stripPlot(run, i, options),
      goldSparkline(run, i, options.method),
    ]);
  });

  return el("div", {}, [
    el("div", { class: "dist-grid" }, cells),
    el("div", { class: "legend" }, [
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", style: "background:var(--gold)" }),
        "at or under gold",
      ]),
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", style: "background:var(--blue)" }),
        "median (blue tick)",
      ]),
    ]),
  ]);
}
