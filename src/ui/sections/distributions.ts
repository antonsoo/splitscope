/** Per-segment strip plot: every recent attempt's time as a dot, gold marked, median ticked. */

import { mulberry32 } from "../../core/rng.js";
import { segmentConsistency } from "../../core/stats.js";
import type { Run, TimingMethod } from "../../core/types.js";
import { pick } from "../../core/types.js";
import { niceDomain, scaleLinear } from "../charts/scale.js";
import { el, svgEl } from "../dom.js";
import { formatSeconds } from "../format.js";

const WIDTH = 280;
const HEIGHT = 86;
const PAD_X = 12;
const STRIP_Y = 46;

export interface DistributionsOptions {
  readonly method: TimingMethod;
  readonly window: number;
}

function stripPlot(run: Run, index: number, options: DistributionsOptions): SVGSVGElement {
  const segment = run.segments[index];
  if (!segment) return svgEl("svg", { viewBox: `0 0 ${WIDTH} ${HEIGHT}` });

  const gold = pick(segment.bestSegmentTime, options.method);
  const recent = segment.history.slice(-options.window);
  const values = recent
    .map((h) => pick(h.time, options.method))
    .filter((v): v is number => v !== null);
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

  const lo = Math.min(gold ?? Number.POSITIVE_INFINITY, ...values);
  const hi = Math.max(...values);
  const [dMin, dMax] = niceDomain(lo, hi, 0.14);
  const x = scaleLinear([dMin, dMax], [PAD_X, WIDTH - PAD_X]);

  // Deterministic per-point jitter so re-renders (e.g. re-running Monte Carlo) don't shuffle dots.
  const rng = mulberry32(index * 7919 + 13);
  const dots = values.map((v) =>
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
      y1: STRIP_Y,
      y2: STRIP_Y,
      class: "chart-gridline",
    }),
    ...dots,
  ];

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

  return svgEl(
    "svg",
    {
      viewBox: `0 0 ${WIDTH} ${HEIGHT}`,
      class: "chart-svg",
      role: "img",
      "aria-label": `${segment.name} time distribution`,
    },
    children.filter((c): c is SVGElement => c !== null),
  );
}

export function renderDistributions(run: Run, options: DistributionsOptions): HTMLElement {
  const cells = run.segments.map((segment, i) => {
    const gold = pick(segment.bestSegmentTime, options.method);
    return el("div", { class: "dist-cell" }, [
      el("p", { class: "dist-cell-name" }, [segment.name]),
      el("p", { class: "dist-cell-sub" }, [`gold ${formatSeconds(gold)} · last ${options.window}`]),
      stripPlot(run, i, options),
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
