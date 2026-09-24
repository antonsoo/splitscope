/**
 * Cumulative delta-vs-PB, over attempts: for every finished attempt, how far
 * its total time was from the *current* PB — in LiveSplit's own delta
 * language (negative/green = ahead, positive/red = behind). The zero
 * baseline is drawn with the page's signature red-gold-green "delta rule"
 * gradient, and any point that was a new best-so-far is marked gold, so the
 * run's whole PB history reads as a sequence of gold dots dropping toward
 * the line.
 */
import { pbTotal as computePbTotal, improvementTrend } from "../../core/stats.js";
import type { Run, TimingMethod } from "../../core/types.js";
import { niceDomain, scaleLinear } from "../charts/scale.js";
import { el, svgEl } from "../dom.js";
import { formatDelta, formatSeconds } from "../format.js";

const WIDTH = 900;
const HEIGHT = 260;
const PAD_L = 54;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 30;

export function renderDeltaChart(run: Run, method: TimingMethod): HTMLElement {
  const pb = computePbTotal(run, method);
  const trend = improvementTrend(run, method);

  if (pb === null || trend.points.length < 2) {
    return el("div", { class: "panel chart-wrap" }, [
      el("p", { class: "odds-insufficient" }, [
        "Not enough finished attempts yet to chart a delta trend (need at least 2, plus a PB).",
      ]),
    ]);
  }

  const points = trend.points.map((p) => ({ ...p, delta: p.totalSeconds - pb }));
  const deltas = points.map((p) => p.delta);
  const [yMin, yMax] = niceDomain(Math.min(0, ...deltas), Math.max(0, ...deltas));
  const xs = points.map((p) => p.attemptIndex);
  const x = scaleLinear([Math.min(...xs), Math.max(...xs)], [PAD_L, WIDTH - PAD_R]);
  const y = scaleLinear([yMin, yMax], [PAD_T, HEIGHT - PAD_B]);
  const zeroY = y(0);

  let runningBest = Number.POSITIVE_INFINITY;
  const withRecord = points.map((p) => {
    const isRecord = p.delta < runningBest - 1e-9;
    if (isRecord) runningBest = p.delta;
    return { ...p, isRecord };
  });

  const linePath = withRecord
    .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.attemptIndex)},${y(p.delta)}`)
    .join(" ");

  const gridlines: SVGElement[] = [];
  const yTicks = 4;
  for (let i = 0; i <= yTicks; i++) {
    const value = yMin + ((yMax - yMin) * i) / yTicks;
    const yPos = y(value);
    gridlines.push(
      svgEl("line", {
        x1: PAD_L,
        x2: WIDTH - PAD_R,
        y1: yPos,
        y2: yPos,
        class: "chart-gridline",
      }),
      svgEl(
        "text",
        { x: PAD_L - 8, y: yPos + 3, class: "chart-axis-label", "text-anchor": "end" },
        [formatDelta(value)],
      ),
    );
  }

  const gradientId = "delta-zero-gradient";

  const svg = svgEl(
    "svg",
    {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: "chart-svg",
      role: "img",
      "aria-label": "Cumulative delta versus personal best, over attempts",
    },
    [
      svgEl("defs", {}, [
        svgEl("linearGradient", { id: gradientId, x1: "0", x2: "1", y1: "0", y2: "0" }, [
          svgEl("stop", { offset: "0%", "stop-color": "var(--red)" }),
          svgEl("stop", { offset: "50%", "stop-color": "var(--gold)" }),
          svgEl("stop", { offset: "100%", "stop-color": "var(--green)" }),
        ]),
      ]),
      ...gridlines,
      svgEl("line", {
        x1: PAD_L,
        x2: WIDTH - PAD_R,
        y1: zeroY,
        y2: zeroY,
        stroke: `url(#${gradientId})`,
        class: "chart-zero-line",
      }),
      svgEl("path", {
        d: linePath,
        fill: "none",
        stroke: "var(--text-faint)",
        "stroke-width": "1.5",
      }),
      ...withRecord.map((p) =>
        svgEl("circle", {
          cx: x(p.attemptIndex),
          cy: y(p.delta),
          r: p.isRecord ? 4 : 2.5,
          fill: p.isRecord ? "var(--gold)" : p.delta <= 0 ? "var(--green)" : "var(--red)",
          stroke: p.isRecord ? "var(--surface)" : "none",
          "stroke-width": p.isRecord ? 1.5 : 0,
        }),
      ),
      svgEl("text", { x: PAD_L, y: HEIGHT - 8, class: "chart-axis-label" }, [
        `attempt ${withRecord[0]?.attemptId ?? ""}`,
      ]),
      svgEl(
        "text",
        { x: WIDTH - PAD_R, y: HEIGHT - 8, class: "chart-axis-label", "text-anchor": "end" },
        [`attempt ${withRecord[withRecord.length - 1]?.attemptId ?? ""}`],
      ),
    ],
  );

  return el("div", { class: "panel" }, [
    el("div", { class: "chart-wrap" }, [svg]),
    el("div", { class: "legend" }, [
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", style: "background:var(--green)" }),
        "ahead of PB",
      ]),
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", style: "background:var(--red)" }),
        "behind PB",
      ]),
      el("span", { class: "legend-item" }, [
        el("span", { class: "legend-swatch", style: "background:var(--gold)" }),
        "new best-so-far",
      ]),
      el("span", { class: "legend-item" }, [`PB: ${formatSeconds(pb)}`]),
    ]),
  ]);
}
