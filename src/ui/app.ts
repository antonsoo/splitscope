import { LssParseError } from "../core/errors.js";
import { simulatePbOdds } from "../core/montecarlo.js";
import { parseRun } from "../core/parser.js";
import {
  pbTotal as computePbTotal,
  playtimeSummary,
  resetAnalysis,
  sumOfBest,
} from "../core/stats.js";
import type { Run, TimingMethod } from "../core/types.js";
import { pick } from "../core/types.js";
import { el } from "./dom.js";
import { buildMarkdownSummary, downloadText, exportPngCard } from "./export.js";
import { formatCount, formatHours, formatPercent, formatSeconds } from "./format.js";
import { renderDeltaChart } from "./sections/deltaChart.js";
import { renderDistributions } from "./sections/distributions.js";
import { renderPbOdds } from "./sections/pbOdds.js";
import { renderSegmentTable } from "./sections/segmentTable.js";
import { renderSurvivalChart } from "./sections/survivalChart.js";

interface AppState {
  run: Run | null;
  error: string | null;
  /** True only when the current run was loaded via "Load sample" — drives the synthetic-data badge. */
  isSample: boolean;
  method: TimingMethod;
  consistencyWindow: number;
  toleranceSeconds: number;
  mcRecentWindow: number;
  mcSimulations: number;
  mcLookahead: number;
  theme: "dark" | "light";
}

const SAMPLE_FILES = [
  { label: "Load sample (450 attempts)", path: "crystal-caverns-any.lss" },
  {
    label: "Load sample (fresh splits, 10 attempts)",
    path: "crystal-caverns-fresh-start.lss",
  },
];

function defaultState(): AppState {
  const stored = (() => {
    try {
      return localStorage.getItem("splitscope:theme");
    } catch {
      return null;
    }
  })();
  return {
    run: null,
    error: null,
    isSample: false,
    method: "RealTime",
    consistencyWindow: 30,
    toleranceSeconds: 1,
    mcRecentWindow: 30,
    mcSimulations: 8000,
    mcLookahead: 50,
    theme: stored === "light" ? "light" : "dark",
  };
}

export function mountApp(root: HTMLElement): void {
  const state = defaultState();
  document.documentElement.dataset.theme = state.theme;

  function setState(patch: Partial<AppState>): void {
    Object.assign(state, patch);
    render();
  }

  async function loadFile(file: File): Promise<void> {
    try {
      const text = await file.text();
      const run = parseRun(text);
      setState({
        run,
        error: null,
        isSample: false,
        consistencyWindow: Math.min(30, Math.max(5, run.attempts.length)),
        mcRecentWindow: Math.min(30, Math.max(5, run.attempts.length)),
      });
    } catch (cause) {
      const message =
        cause instanceof LssParseError
          ? cause.message
          : `Unexpected error: ${(cause as Error).message}`;
      setState({ run: null, error: message, isSample: false });
    }
  }

  async function loadSample(path: string): Promise<void> {
    try {
      const base = import.meta.env.BASE_URL;
      const response = await fetch(`${base}${path}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      const run = parseRun(text);
      setState({
        run,
        error: null,
        isSample: true,
        consistencyWindow: Math.min(30, Math.max(5, run.attempts.length)),
        mcRecentWindow: Math.min(30, Math.max(5, run.attempts.length)),
      });
    } catch (cause) {
      setState({ run: null, error: `Could not load the sample file: ${(cause as Error).message}` });
    }
  }

  function renderTopbar(): HTMLElement {
    const methodToggle = el(
      "div",
      { class: "segmented", role: "group", "aria-label": "Timing method" },
      [
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(state.method === "RealTime"),
            onclick: () => setState({ method: "RealTime" }),
          },
          ["RTA"],
        ),
        el(
          "button",
          {
            type: "button",
            "aria-pressed": String(state.method === "GameTime"),
            onclick: () => setState({ method: "GameTime" }),
          },
          ["IGT"],
        ),
      ],
    );

    const themeToggle = el(
      "button",
      {
        type: "button",
        class: "btn",
        title: "Toggle light/dark",
        onclick: () => {
          const next = state.theme === "dark" ? "light" : "dark";
          document.documentElement.dataset.theme = next;
          try {
            localStorage.setItem("splitscope:theme", next);
          } catch {
            /* private browsing / storage disabled — theme just won't persist */
          }
          setState({ theme: next });
        },
      },
      [state.theme === "dark" ? "Light" : "Dark"],
    );

    return el("header", { class: "topbar" }, [
      el("div", { class: "topbar-inner" }, [
        el("div", { class: "brand" }, [
          "split",
          el("span", { class: "brand-dot" }, ["scope"]),
          el("span", { class: "brand-tag" }, ["speedrun split analyzer"]),
        ]),
        state.run
          ? el("div", { class: "run-id" }, [
              el("span", { class: "run-id-text" }, [
                el("strong", {}, [state.run.gameName]),
                ` — ${state.run.categoryName}`,
              ]),
              // Deliberately outside the truncating run-id-text span: this badge must never be
              // the part that gets clipped by an ellipsis on a narrow screen — it's the whole
              // point of it.
              state.isSample
                ? el(
                    "span",
                    {
                      class: "sample-badge",
                      title: "Generated by scripts/generate-sample.ts — not a real speedrun",
                    },
                    ["SYNTHETIC SAMPLE"],
                  )
                : null,
            ])
          : el("div", { class: "run-id" }),
        el("div", { class: "topbar-controls" }, [
          state.run ? methodToggle : null,
          el(
            "button",
            {
              type: "button",
              class: "btn",
              hidden: !state.run,
              onclick: () => fileInput.click(),
            },
            ["Load file"],
          ),
          themeToggle,
        ]),
      ]),
    ]);
  }

  function renderHero(run: Run): HTMLElement {
    const pb = computePbTotal(run, state.method);
    const sob = sumOfBest(run, state.method);
    const reset = resetAnalysis(run);
    const playtime = playtimeSummary(run);
    const odds = simulatePbOdds(run, pb, {
      method: state.method,
      recentWindow: state.mcRecentWindow,
      simulations: state.mcSimulations,
      lookaheadAttempts: state.mcLookahead,
    });

    // Preview: the PB run's own segments — what a runner already knows from the timer, plus
    // one thing it doesn't show: how each of those segments compares to its own gold. This is
    // deliberately not colored green/red (this panel has no "current run" to be ahead or
    // behind — those colors are reserved for an actual comparison elsewhere on the page); a
    // segment reads gold only when it *is* that segment's gold, and faint otherwise. `cumulative`
    // starts at 0 (the run start) and, like pbSegmentDuration in core/stats.ts, propagates null
    // forward once a comparison split is missing, so a gap invalidates every duration after it too.
    const previewSegments = run.segments.slice(0, 6);
    let cumulative: number | null = 0;
    const previewRows = previewSegments.map((segment, i) => {
      const split = segment.splitTimes.get("Personal Best");
      const cumulativeTime = split ? pick(split, state.method) : null;
      const duration =
        cumulativeTime !== null && cumulative !== null ? cumulativeTime - cumulative : null;
      cumulative = cumulativeTime;
      const gold = pick(segment.bestSegmentTime, state.method);
      const isGold = duration !== null && gold !== null && Math.abs(duration - gold) < 1e-6;
      const vsGold = duration !== null && gold !== null ? duration - gold : null;
      return el("div", { class: "split-row", style: `animation-delay:${i * 60}ms` }, [
        el("span", { class: "split-row-name" }, [segment.name]),
        el("span", { class: "split-row-time" }, [formatSeconds(cumulativeTime)]),
        el("span", { class: `split-row-delta ${isGold ? "is-gold" : "is-flat"}` }, [
          isGold ? "GOLD" : vsGold === null ? "—" : `+${formatSeconds(vsGold)}`,
        ]),
      ]);
    });

    return el("section", { class: "hero" }, [
      el("div", {}, [
        el("p", { class: "hero-thesis" }, ["Your timer only shows the comparison"]),
        el("h1", { class: "hero-title" }, [
          "Here's what your ",
          el("strong", {}, [run.categoryName]),
          " splits actually know.",
        ]),
        el("p", { class: "hero-clock-label" }, ["Personal best"]),
        el("p", { class: "hero-clock mono" }, [formatSeconds(pb)]),
        el("div", { class: "hero-stats" }, [
          el("div", { class: "hero-stat" }, [
            el("p", { class: "hero-stat-label" }, ["Sum of best"]),
            el("p", { class: "hero-stat-value" }, [formatSeconds(sob.value)]),
          ]),
          el("div", { class: "hero-stat" }, [
            el("p", { class: "hero-stat-label" }, ["Time on the table"]),
            el("p", { class: "hero-stat-value" }, [
              pb !== null ? formatSeconds(pb - sob.value) : "—",
            ]),
          ]),
          el("div", { class: "hero-stat" }, [
            el("p", { class: "hero-stat-label" }, ["Attempts"]),
            el("p", { class: "hero-stat-value" }, [formatCount(run.attempts.length)]),
          ]),
          el("div", { class: "hero-stat" }, [
            el("p", { class: "hero-stat-label" }, ["Finish rate"]),
            el("p", { class: "hero-stat-value" }, [
              formatPercent(
                reset.totalAttempts ? reset.finishedAttempts / reset.totalAttempts : null,
                0,
              ),
            ]),
          ]),
          el("div", { class: "hero-stat" }, [
            el("p", { class: "hero-stat-label" }, ["Playtime"]),
            el("p", { class: "hero-stat-value" }, [formatHours(playtime.totalPlaytimeSeconds)]),
          ]),
        ]),
      ]),
      el("div", { class: "hero-side" }, [
        el("div", { class: "split-preview" }, [
          el("div", { class: "split-preview-head" }, [
            "Personal best splits",
            el("span", {}, [state.method === "RealTime" ? "RTA" : "IGT"]),
          ]),
          ...previewRows,
        ]),
        el("a", { class: "odds-teaser", href: "#pb-odds" }, [
          el("p", { class: "odds-teaser-label" }, ["MONTE CARLO · PB ODDS"]),
          pb === null || odds.insufficientData
            ? el("p", { class: "odds-teaser-value" }, ["Not enough data yet — see what it needs ↓"])
            : el("p", {}, [
                el("span", { class: "odds-teaser-value mono" }, [
                  formatPercent(odds.probabilityAtLeastOnePb, 1),
                ]),
                el("span", { class: "odds-teaser-sub" }, [
                  ` chance of a PB in your next ${formatCount(odds.lookaheadAttempts)} attempts`,
                ]),
              ]),
          el("span", { class: "odds-teaser-link" }, ["See the full model ↓"]),
        ]),
      ]),
    ]);
  }

  function section(
    eyebrow: string,
    title: string,
    desc: string,
    controls: (Node | null)[],
    body: Node,
  ): HTMLElement {
    return el("section", { class: "section" }, [
      el("div", { class: "section-head" }, [
        el("div", {}, [
          el("p", { class: "section-eyebrow" }, [eyebrow]),
          el("h2", { class: "section-title" }, [title]),
        ]),
        el("div", { class: "section-controls" }, controls),
      ]),
      el("p", { class: "section-desc" }, [desc]),
      body,
    ]);
  }

  function numberField(
    label: string,
    value: number,
    min: number,
    max: number,
    onChange: (v: number) => void,
  ): HTMLElement {
    return el("label", { class: "odds-field" }, [
      label,
      el("input", {
        type: "number",
        min: String(min),
        max: String(max),
        value: String(value),
        style: "width:60px",
        onchange: (e: Event) => onChange(Number((e.target as HTMLInputElement).value)),
      }),
    ]);
  }

  function renderContent(): HTMLElement {
    if (state.error) {
      return el("div", { class: "error-banner" }, [
        // h1: with an error, this replaces the empty state's h1 as the page's top heading —
        // there's no hero heading rendered in this state to be a level below.
        el("h1", {}, ["Couldn't read that file"]),
        el("p", {}, [state.error]),
      ]);
    }

    if (!state.run) {
      return el("div", { class: "empty" }, [
        el("h1", {}, ["Your LiveSplit file knows more than your timer shows."]),
        el("p", { class: "lede" }, [
          "Find your realistic time save, your reset habits, and your odds of a PB — from the .lss file you already have. Everything runs in your browser; nothing is uploaded.",
        ]),
        el(
          "div",
          {
            class: "dropzone",
            id: "dropzone",
            ondragover: (e: Event) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.add("drag-over");
            },
            ondragleave: (e: Event) =>
              (e.currentTarget as HTMLElement).classList.remove("drag-over"),
            ondrop: (e: Event) => {
              e.preventDefault();
              (e.currentTarget as HTMLElement).classList.remove("drag-over");
              const file = (e as DragEvent).dataTransfer?.files?.[0];
              if (file) void loadFile(file);
            },
          },
          [
            el("div", { class: "empty-actions" }, [
              el(
                "button",
                { type: "button", class: "btn btn-accent", onclick: () => fileInput.click() },
                ["Choose a .lss file"],
              ),
              ...SAMPLE_FILES.map((s) =>
                el(
                  "button",
                  { type: "button", class: "btn", onclick: () => void loadSample(s.path) },
                  [s.label],
                ),
              ),
            ]),
            el("p", {}, ["or drop a file here · splits.lss lives in your LiveSplit folder"]),
          ],
        ),
        el("p", { class: "privacy-note" }, [
          el("span", { class: "dot" }),
          "Parsed entirely client-side. Nothing is uploaded, logged, or stored anywhere but your browser.",
        ]),
      ]);
    }

    const run = state.run;
    const mcOnChange = (
      patch: Partial<{ recentWindow: number; simulations: number; lookaheadAttempts: number }>,
    ) => {
      setState({
        mcRecentWindow: patch.recentWindow ?? state.mcRecentWindow,
        mcSimulations: patch.simulations ?? state.mcSimulations,
        mcLookahead: patch.lookaheadAttempts ?? state.mcLookahead,
      });
    };

    return el("div", {}, [
      renderHero(run),

      section(
        "Segment breakdown",
        "Time save & consistency",
        "Possible time save is your PB's own segment duration minus that segment's gold (the best it's ever been split). Consistency is computed over the last N attempts.",
        [
          numberField("Window", state.consistencyWindow, 3, Math.max(5, run.attempts.length), (v) =>
            setState({ consistencyWindow: v }),
          ),
          numberField("Tolerance (s)", state.toleranceSeconds, 0, 30, (v) =>
            setState({ toleranceSeconds: v }),
          ),
        ],
        renderSegmentTable(run, {
          method: state.method,
          consistencyWindow: state.consistencyWindow,
          toleranceSeconds: state.toleranceSeconds,
        }),
      ),

      section(
        "Progression",
        "Delta vs. PB, over attempts",
        "Every finished attempt's total time, relative to your current PB. Gold dots are attempts that beat everything before them — your PB's own history.",
        [],
        renderDeltaChart(run, state.method),
      ),

      section(
        "Reset analysis",
        "Where do your runs die?",
        "The survival curve is the share of attempts that reached each segment at all; the red bars are how many attempts specifically reset during that segment.",
        [],
        renderSurvivalChart(run),
      ),

      section(
        "Per-segment shape",
        "Time distributions & gold history",
        `Every recorded time for each segment in the last ${state.consistencyWindow} attempts, jittered vertically to reduce overlap (dashed line is gold, blue tick is median), plus each segment's full gold history — every time a new record was set, across all ${run.attempts.length} attempts.`,
        [],
        renderDistributions(run, { method: state.method, window: state.consistencyWindow }),
      ),

      el("section", { class: "section" }, [
        renderPbOdds(run, {
          method: state.method,
          recentWindow: state.mcRecentWindow,
          simulations: state.mcSimulations,
          lookaheadAttempts: state.mcLookahead,
          onChange: mcOnChange,
        }),
      ]),

      el("section", { class: "section" }, [
        el("div", { class: "section-head" }, [
          el("div", {}, [
            el("p", { class: "section-eyebrow" }, ["Share"]),
            el("h2", { class: "section-title" }, ["Export"]),
          ]),
        ]),
        el("div", { class: "export-row" }, [
          el(
            "button",
            {
              type: "button",
              class: "btn btn-accent",
              onclick: () =>
                downloadText(
                  `splitscope-${run.gameName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
                  buildMarkdownSummary(run, {
                    method: state.method,
                    recentWindow: state.mcRecentWindow,
                    simulations: state.mcSimulations,
                    lookaheadAttempts: state.mcLookahead,
                  }),
                ),
            },
            ["Download Markdown summary"],
          ),
          el(
            "button",
            {
              type: "button",
              class: "btn",
              onclick: () =>
                exportPngCard(run, {
                  method: state.method,
                  recentWindow: state.mcRecentWindow,
                  simulations: state.mcSimulations,
                  lookaheadAttempts: state.mcLookahead,
                }),
            },
            ["Download PNG card"],
          ),
        ]),
      ]),
    ]);
  }

  // Visually hidden and out of the tab order: it's a programmatic target for the visible
  // "Choose a .lss file" / "Load file" buttons (via .click()), not a control of its own —
  // a sighted keyboard user tabbing onto an invisible 0×0 element would otherwise see focus
  // seem to vanish, since a zero-size element can't show a focus ring.
  const fileInput = el("input", {
    type: "file",
    id: "file-input",
    tabindex: "-1",
    "aria-hidden": "true",
    accept: ".lss,text/xml,application/xml",
    onchange: (e: Event) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) void loadFile(file);
    },
  });

  function render(): void {
    root.replaceChildren(
      el("div", { class: "shell" }, [
        el("a", { class: "skip-link", href: "#main-content" }, ["Skip to content"]),
        el("hr", { class: "rule" }),
        renderTopbar(),
        el("main", { id: "main-content" }, [renderContent()]),
        fileInput,
        el("footer", {}, [
          el("div", { class: "footer-inner" }, [
            el("span", {}, [
              "splitscope · ",
              el("a", { href: "https://github.com/antonsoo/splitscope" }, ["source"]),
              " · MIT licensed",
            ]),
            el("span", {}, [
              "Parses LiveSplit .lss files entirely in your browser. No accounts, no analytics, no uploads.",
            ]),
          ]),
        ]),
      ]),
    );
  }

  render();
}
