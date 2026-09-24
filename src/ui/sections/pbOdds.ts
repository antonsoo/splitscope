/**
 * The PB-odds panel: splitscope's one genuinely new number. Deliberately
 * built as its own visually distinct "odds board" (ice-blue border, the
 * only place on the page blue is used as a *headline* color rather than
 * strictly for chrome) so it reads as the answer the rest of the page was
 * building toward, not just another stat panel.
 */
import { simulatePbOdds } from "../../core/montecarlo.js";
import { pbTotal } from "../../core/stats.js";
import type { Run, TimingMethod } from "../../core/types.js";
import { el } from "../dom.js";
import { formatCount, formatPercent, formatSeconds } from "../format.js";

export interface PbOddsOptions {
  readonly method: TimingMethod;
  readonly recentWindow: number;
  readonly simulations: number;
  readonly lookaheadAttempts: number;
  readonly onChange: (next: Partial<PbOddsOptions>) => void;
}

function slider(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  suffix: string,
  onInput: (v: number) => void,
): HTMLElement {
  return el("label", { class: "odds-field" }, [
    label,
    el("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(value),
      oninput: (e: Event) => onInput(Number((e.target as HTMLInputElement).value)),
    }),
    el("span", { class: "val" }, [`${formatCount(value)}${suffix}`]),
  ]);
}

export function renderPbOdds(run: Run, options: PbOddsOptions): HTMLElement {
  const pb = pbTotal(run, options.method);
  const result = simulatePbOdds(run, pb, {
    method: options.method,
    recentWindow: options.recentWindow,
    simulations: options.simulations,
    lookaheadAttempts: options.lookaheadAttempts,
  });

  const body =
    pb === null
      ? el("p", { class: "odds-insufficient" }, [
          "No PB recorded yet — nothing to compare simulated attempts against.",
        ])
      : result.insufficientData
        ? el("p", { class: "odds-insufficient" }, [
            "Not enough segment history in the selected window to simulate a full run yet. Try a larger recent-form window, or come back after a few more attempts.",
          ])
        : el("div", {}, [
            el("div", { class: "odds-grid" }, [
              el("div", {}, [
                el("p", { class: "odds-metric-label" }, [
                  `Chance of a PB in your next ${result.lookaheadAttempts} attempts`,
                ]),
                el("p", { class: "odds-metric-value is-primary" }, [
                  formatPercent(result.probabilityAtLeastOnePb, 1),
                ]),
              ]),
              el("div", {}, [
                el("p", { class: "odds-metric-label" }, ["Chance the very next attempt beats PB"]),
                el("p", { class: "odds-metric-value" }, [
                  formatPercent(result.pbProbabilityPerAttempt, 2),
                ]),
                el("p", { class: "odds-metric-ci" }, [
                  `95% CI ${formatPercent(result.pbProbabilityPerAttemptCi[0], 2)} – ${formatPercent(result.pbProbabilityPerAttemptCi[1], 2)}`,
                ]),
              ]),
              el("div", {}, [
                el("p", { class: "odds-metric-label" }, ["Expected attempts to next PB"]),
                el("p", { class: "odds-metric-value" }, [
                  result.expectedAttemptsUntilPb === null
                    ? "—"
                    : formatCount(Math.round(result.expectedAttemptsUntilPb)),
                ]),
                el("p", { class: "odds-metric-ci" }, [
                  `finish rate ${formatPercent(result.finishProbability, 1)} · PB rate | finish ${formatPercent(result.pbProbabilityGivenFinish, 2)}`,
                ]),
              ]),
            ]),
            el("p", { class: "odds-metric-ci" }, [
              `${formatCount(result.simulations)} simulated attempts, resampled from the last ${options.recentWindow} attempts. PB target: ${formatSeconds(pb)}.`,
            ]),
          ]);

  return el("div", { class: "odds-panel" }, [
    el("div", { class: "odds-head" }, [
      el("div", {}, [
        el("span", { class: "odds-badge" }, ["Monte Carlo"]),
        el("h3", { class: "section-title", style: "margin:0" }, ["PB odds"]),
      ]),
    ]),
    body,
    el("div", { class: "odds-controls" }, [
      slider(
        "Recent form",
        options.recentWindow,
        5,
        Math.max(10, run.attempts.length),
        1,
        " attempts",
        (v) => options.onChange({ recentWindow: v }),
      ),
      slider("Look ahead", options.lookaheadAttempts, 1, 500, 1, " attempts", (v) =>
        options.onChange({ lookaheadAttempts: v }),
      ),
      slider("Simulations", options.simulations, 1000, 50000, 1000, "", (v) =>
        options.onChange({ simulations: v }),
      ),
    ]),
    el("details", { class: "odds-assumptions" }, [
      el("summary", {}, ["How this is modeled, and what it assumes"]),
      el("ul", {}, [
        el("li", {}, [
          "Each simulated segment time is bootstrap-resampled (drawn with replacement) from that segment's own recent history — not fit to a parametric distribution.",
        ]),
        el("li", {}, [
          "Each segment also rolls its own empirical reset hazard: how often, historically, an attempt that reached this segment died during it.",
        ]),
        ...result.assumptions.map((a) => el("li", {}, [a])),
      ]),
    ]),
  ]);
}
