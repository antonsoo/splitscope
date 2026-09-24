/**
 * "Where do my runs die?" — a survival curve (share of attempts that reached
 * each segment) with a death histogram underneath (how many attempts reset
 * during that specific segment). Read together they answer both "how far do
 * I usually get" and "which segment is actually the wall."
 */
import { resetAnalysis } from "../../core/stats.js";
import type { Run } from "../../core/types.js";
import { scaleLinear } from "../charts/scale.js";
import { el, svgEl } from "../dom.js";
import { formatCount, formatPercent } from "../format.js";

const WIDTH = 900;
const HEIGHT = 340;
const PAD_L = 46;
const PAD_R = 16;
const PAD_T = 16;
// Segment counts range from a handful to 15+ in the wild, and there's no fixed width per
// label that reads cleanly horizontal at every count — so labels are rotated (see `labels`
// below), which needs vertical room instead. PAD_B accounts for that.
const PAD_B = 100;
const BAR_ZONE = 64;
const CURVE_BOTTOM = HEIGHT - PAD_B - BAR_ZONE;

export function renderSurvivalChart(run: Run): HTMLElement {
  const analysis = resetAnalysis(run);

  if (analysis.totalAttempts === 0 || analysis.points.length === 0) {
    return el("div", { class: "panel chart-wrap" }, [
      el("p", { class: "odds-insufficient" }, ["No attempts recorded yet."]),
    ]);
  }

  const n = analysis.points.length;
  const x = scaleLinear([0, Math.max(1, n - 1)], [PAD_L, WIDTH - PAD_R]);
  const y = scaleLinear([0, 1], [CURVE_BOTTOM, PAD_T]);
  const maxDeaths = Math.max(1, ...analysis.points.map((p) => p.deaths));
  const barMaxHeight = BAR_ZONE - 18;

  const linePath = analysis.points
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(i)},${y(p.survivalRate)}`)
    .join(" ");
  const areaPath = `${linePath} L${x(n - 1)},${CURVE_BOTTOM} L${x(0)},${CURVE_BOTTOM} Z`;

  const gridlines: SVGElement[] = [];
  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const yPos = y(frac);
    gridlines.push(
      svgEl("line", { x1: PAD_L, x2: WIDTH - PAD_R, y1: yPos, y2: yPos, class: "chart-gridline" }),
      svgEl(
        "text",
        { x: PAD_L - 8, y: yPos + 3, class: "chart-axis-label", "text-anchor": "end" },
        [formatPercent(frac, 0)],
      ),
    );
  }

  const barTop = CURVE_BOTTOM + 14;
  const bars = analysis.points.map((p, i) => {
    const h = (p.deaths / maxDeaths) * barMaxHeight;
    return svgEl("g", {}, [
      svgEl("rect", {
        x: x(i) - 10,
        y: barTop + (barMaxHeight - h),
        width: 20,
        height: Math.max(1, h),
        fill: "var(--red)",
        opacity: "0.8",
        rx: "1",
      }),
      svgEl(
        "text",
        { x: x(i), y: barTop - 4, class: "chart-axis-label", "text-anchor": "middle" },
        [p.deaths > 0 ? String(p.deaths) : ""],
      ),
    ]);
  });

  // Rotated rather than horizontal: at a dozen-plus segments (a typical full-category split
  // count), horizontal labels this close together overlap into an unreadable mess. Rotated
  // and right-aligned to its own tick, each label reads as a normal diagonal axis label
  // regardless of segment count.
  const labelY = HEIGHT - PAD_B + 16;
  const labels = analysis.points.map((p, i) =>
    svgEl(
      "text",
      {
        x: x(i),
        y: labelY,
        class: "chart-axis-label",
        "text-anchor": "end",
        transform: `rotate(-40 ${x(i)} ${labelY})`,
      },
      [p.segmentName.length > 16 ? `${p.segmentName.slice(0, 15)}…` : p.segmentName],
    ),
  );

  const svg = svgEl(
    "svg",
    {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: "chart-svg",
      role: "img",
      "aria-label": "Survival curve and reset histogram by segment",
    },
    [
      ...gridlines,
      svgEl("path", { d: areaPath, fill: "var(--blue-dim)" }),
      svgEl("path", { d: linePath, fill: "none", stroke: "var(--blue)", "stroke-width": "2" }),
      ...analysis.points.map((p, i) =>
        svgEl("circle", { cx: x(i), cy: y(p.survivalRate), r: 3, fill: "var(--blue)" }),
      ),
      svgEl("line", {
        x1: PAD_L,
        x2: WIDTH - PAD_R,
        y1: barTop + barMaxHeight,
        y2: barTop + barMaxHeight,
        class: "chart-gridline",
      }),
      ...bars,
      ...labels,
    ],
  );

  return el("div", { class: "panel" }, [
    el("div", { class: "chart-wrap" }, [svg]),
    el("div", { class: "legend" }, [
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", style: "background:var(--blue)" }),
        "% of attempts that reached this segment",
      ]),
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", style: "background:var(--red)" }),
        "resets during this segment",
      ]),
      el("span", { class: "legend-item" }, [
        `${formatCount(analysis.finishedAttempts)} / ${formatCount(analysis.totalAttempts)} attempts finished`,
      ]),
    ]),
  ]);
}
