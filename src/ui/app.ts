import { bestRoute } from "../core/best-route.js";
import { LssParseError } from "../core/errors.js";
import { type PbOddsResult, simulatePbOdds } from "../core/montecarlo.js";
import type { ReviewSource } from "../core/review.js";
import { pbTotal as computePbTotal, playtimeSummary, resetAnalysis } from "../core/stats.js";
import type { Run, TimingMethod } from "../core/types.js";
import { pick } from "../core/types.js";
import { el } from "./dom.js";
import { buildMarkdownSummary, downloadText, exportPngCard } from "./export.js";
import { formatCount, formatHours, formatPercent, formatSeconds } from "./format.js";
import { readFileBytes, readSampleBytes } from "./input.js";
import { parseInput } from "./parse-input.js";
import { createBestRoute } from "./sections/bestRoute.js";
import { renderDeltaChart } from "./sections/deltaChart.js";
import { renderDistributions } from "./sections/distributions.js";
import { renderPbOdds } from "./sections/pbOdds.js";
import { createPracticeReview } from "./sections/practiceReview.js";
import { renderSegmentTable } from "./sections/segmentTable.js";
import { renderSurvivalChart } from "./sections/survivalChart.js";

interface AppState {
  run: Run | null;
  source: ReviewSource | null;
  error: string | null;
  loading: string | null;
  exportStatus: string | null;
  /** True only when the current run was loaded via "Load sample" — drives the synthetic-data badge. */
  isSample: boolean;
  method: TimingMethod;
  consistencyWindow: number;
  /** null = auto (max(1s, 8% of that segment's gold)); a number is a flat-seconds override. */
  toleranceSeconds: number | null;
  mcRecentWindow: number;
  mcSimulations: number;
  mcLookahead: number;
  theme: "dark" | "light";
}

const SAMPLE_FILES = [
  { label: "Load sample (450 attempts)", path: "crystal-caverns-any.lss", synthetic: true },
  {
    label: "Load sample (fresh splits, 10 attempts)",
    path: "crystal-caverns-fresh-start.lss",
    synthetic: true,
  },
  {
    label: "Open combined-split example (Destrega)",
    path: "recorded/destrega.lss",
    synthetic: false,
  },
  {
    label: "Open time-budget example (Re-Loaded)",
    path: "recorded/re-loaded.lss",
    synthetic: false,
  },
  {
    label: "Open recorded practice (124 attempts)",
    path: "recorded/zero-divide-2.lss",
    synthetic: false,
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
    source: null,
    error: null,
    loading: null,
    exportStatus: null,
    isSample: false,
    method: "RealTime",
    consistencyWindow: 30,
    toleranceSeconds: null,
    mcRecentWindow: 30,
    mcSimulations: 8000,
    mcLookahead: 50,
    theme: stored === "light" ? "light" : "dark",
  };
}

export function mountApp(root: HTMLElement): void {
  const state = defaultState();
  document.documentElement.dataset.theme = state.theme;

  function setState(patch: Partial<AppState>, afterFocusTransfer = false): void {
    Object.assign(state, patch);
    if (afterFocusTransfer) {
      // Number-input change fires during blur, before Tab/click finishes moving
      // focus. Keep the old DOM until that native transfer has completed.
      const run = state.run;
      setTimeout(() => {
        if (state.run === run) render();
      }, 0);
    } else {
      render();
    }
  }

  let importController: AbortController | null = null;
  let lastImport: (() => void) | null = null;
  let oddsCache: { run: Run; key: string; result: PbOddsResult } | null = null;
  let bestCache: { run: Run; workspace: ReturnType<typeof createBestRoute> } | null = null;
  let practiceCache: { run: Run; workspace: ReturnType<typeof createPracticeReview> } | null = null;

  function oddsFor(run: Run): PbOddsResult {
    const key = [state.method, state.mcRecentWindow, state.mcSimulations, state.mcLookahead].join(
      "|",
    );
    if (oddsCache?.run === run && oddsCache.key === key) return oddsCache.result;
    const result = simulatePbOdds(run, computePbTotal(run, state.method), {
      method: state.method,
      recentWindow: state.mcRecentWindow,
      simulations: state.mcSimulations,
      lookaheadAttempts: state.mcLookahead,
    });
    oddsCache = { run, key, result };
    return result;
  }

  function focusContent(): void {
    root.querySelector<HTMLElement>("main h1")?.focus({ preventScroll: true });
  }

  function cancelImport(): void {
    importController?.abort();
    importController = null;
    lastImport = null;
    setState({ loading: null, error: null });
    focusContent();
  }

  function reset(): void {
    importController?.abort();
    importController = null;
    lastImport = null;
    oddsCache = null;
    practiceCache = null;
    bestCache = null;
    fileInput.value = "";
    Object.assign(state, defaultState(), { theme: state.theme });
    render();
    root.querySelector<HTMLElement>("#choose-file")?.focus();
  }

  async function importRun(
    label: string,
    sourceName: string,
    isSample: boolean | null,
    read: (signal: AbortSignal) => Promise<Uint8Array>,
    retry: () => void,
  ): Promise<void> {
    importController?.abort();
    const controller = new AbortController();
    importController = controller;
    lastImport = retry;
    setState({ loading: label, error: null });
    try {
      const bytes = await read(controller.signal);
      if (importController !== controller) return;
      const byteLength = bytes.length;
      setState({ loading: `Parsing ${sourceName}…` });
      const { run, sha256 } = await parseInput(bytes as Uint8Array<ArrayBuffer>, controller.signal);
      if (importController !== controller) return;
      const previous = { ...state };
      const previousCaches = { oddsCache, practiceCache, bestCache };
      oddsCache = null;
      practiceCache = null;
      bestCache = null;
      Object.assign(state, {
        run,
        source: {
          name: sourceName,
          sha256,
          bytes: byteLength,
          synthetic: isSample,
        },
        loading: null,
        error: null,
        exportStatus: null,
        isSample: isSample === true,
        method: run.segments.some((s) => s.splitTimes.get("Personal Best")?.realTime != null)
          ? "RealTime"
          : run.segments.some((s) => s.splitTimes.get("Personal Best")?.gameTime != null)
            ? "GameTime"
            : "RealTime",
        consistencyWindow: Math.min(30, Math.max(1, run.attempts.length)),
        mcRecentWindow: Math.min(30, Math.max(1, run.attempts.length)),
      });
      try {
        render();
      } catch (cause) {
        // Rendering can fail too. Keep ownership until the whole workspace is
        // ready so an accepted file cannot silently strand the loading screen.
        Object.assign(state, previous);
        ({ oddsCache, practiceCache, bestCache } = previousCaches);
        throw cause;
      }
      importController = null;
      lastImport = null;
      focusContent();
    } catch (cause) {
      if (importController !== controller) return;
      importController = null;
      const message = cause instanceof Error ? cause.message : String(cause);
      setState({
        loading: null,
        error: cause instanceof LssParseError ? message : `Could not read the input: ${message}`,
      });
      root.querySelector<HTMLElement>("#import-error")?.focus();
    }
  }

  function loadFile(file: File): void {
    void importRun(
      `Reading ${file.name}…`,
      file.name,
      null,
      (signal) => readFileBytes(file, signal),
      () => loadFile(file),
    );
  }

  function loadSample(path: string, synthetic = true): void {
    void importRun(
      synthetic ? "Loading synthetic sample…" : "Loading recorded practice…",
      path,
      synthetic,
      (signal) => readSampleBytes(`${import.meta.env.BASE_URL}${path}`, signal),
      () => loadSample(path, synthetic),
    );
  }

  function renderTopbar(): HTMLElement {
    const methodToggle = el(
      "div",
      { class: "segmented", role: "group", "aria-label": "Timing method" },
      [
        el(
          "button",
          {
            id: "method-rta",
            type: "button",
            "aria-pressed": String(state.method === "RealTime"),
            onclick: () => setState({ method: "RealTime" }),
          },
          ["RTA"],
        ),
        el(
          "button",
          {
            id: "method-igt",
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
        id: "theme-toggle",
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
              id: "load-file",
              onclick: () => fileInput.click(),
            },
            ["Load file"],
          ),
          state.run || state.loading
            ? el("button", { id: "reset", type: "button", class: "btn", onclick: reset }, [
                "New file",
              ])
            : null,
          themeToggle,
        ]),
      ]),
    ]);
  }

  function renderHero(run: Run): HTMLElement {
    const pb = computePbTotal(run, state.method);
    const sob = bestRoute(run, state.method);
    const reset = resetAnalysis(run);
    const playtime = playtimeSummary(run);
    const odds = oddsFor(run);

    // Preview: the PB run's own segments — what a runner already knows from the timer, plus
    // one thing it doesn't show: how each of those segments compares to its own gold. This is
    // deliberately not colored green/red (this panel has no "current run" to be ahead or
    // behind — those colors are reserved for an actual comparison elsewhere on the page); a
    // segment reads gold only when it *is* that segment's gold, and faint otherwise. `cumulative`
    // starts at 0 (the run start) and, like pbSegmentDuration in core/stats.ts, propagates null
    // forward once a comparison split is missing, so a gap invalidates every duration after it too.
    const previewSegments = run.segments.slice(0, 6);
    let cumulative: number | null = 0;
    const previewRows = previewSegments.map((segment) => {
      const split = segment.splitTimes.get("Personal Best");
      const cumulativeTime = split ? pick(split, state.method) : null;
      const duration =
        cumulativeTime !== null && cumulative !== null ? cumulativeTime - cumulative : null;
      cumulative = cumulativeTime;
      const gold = pick(segment.bestSegmentTime, state.method);
      const isGold = duration !== null && gold !== null && Math.abs(duration - gold) < 1e-6;
      const vsGold = duration !== null && gold !== null ? duration - gold : null;
      return el("div", { class: "split-row" }, [
        el(
          "span",
          {
            class: `split-row-name${segment.isSubsplit ? " is-subsplit" : ""}`,
            ...(segment.group ? { title: `${segment.group}: ${segment.label}` } : {}),
          },
          [segment.label],
        ),
        el("span", { class: "split-row-time" }, [formatSeconds(cumulativeTime)]),
        el("span", { class: `split-row-delta ${isGold ? "is-gold" : "is-flat"}` }, [
          isGold ? "GOLD" : vsGold === null ? "—" : `+${formatSeconds(vsGold)}`,
        ]),
      ]);
    });

    return el("section", { class: "hero" }, [
      el("div", {}, [
        el("p", { class: "hero-thesis" }, ["Your timer only shows the comparison"]),
        el("h1", { class: "hero-title", tabindex: -1 }, [
          "Here's what your ",
          el("strong", {}, [run.categoryName]),
          " splits actually know.",
        ]),
        el("p", { class: "hero-clock-label" }, ["Personal best"]),
        el("p", { class: "hero-clock mono" }, [formatSeconds(pb)]),
        el("div", { class: "hero-stats" }, [
          el("div", { class: "hero-stat" }, [
            el("a", { class: "hero-stat-label", href: "#best-route" }, ["Sum of best"]),
            el("p", { class: "hero-stat-value" }, [
              sob.totalSeconds !== null ? formatSeconds(sob.totalSeconds) : "Unavailable",
            ]),
          ]),
          el("div", { class: "hero-stat" }, [
            el("p", { class: "hero-stat-label" }, ["Time on the table"]),
            el("p", { class: "hero-stat-value" }, [
              pb !== null && sob.totalSeconds !== null ? formatSeconds(pb - sob.totalSeconds) : "—",
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
            el("p", { class: "hero-stat-label" }, ["Elapsed attempts"]),
            el("p", { class: "hero-stat-value" }, [
              playtime.attemptsMissingTimestamps === run.attempts.length
                ? "—"
                : `${formatHours(playtime.totalPlaytimeSeconds)}${playtime.attemptsMissingTimestamps ? " (partial)" : ""}`,
            ]),
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
    const errorId = `setting-${label.toLowerCase().replaceAll(" ", "-")}-error`;
    const error = el("span", { id: errorId, class: "field-error", role: "alert" });
    const input = el("input", {
      id: "consistency-window",
      "aria-label": label,
      type: "number",
      min: String(min),
      max: String(max),
      step: "1",
      required: true,
      value: String(value),
      "aria-describedby": errorId,
      onchange: () => {
        const next = input.valueAsNumber;
        if (!Number.isInteger(next) || next < min || next > max) {
          input.setAttribute("aria-invalid", "true");
          error.textContent = `Use a whole number from ${min} to ${max}. Results still use ${value}.`;
          return;
        }
        onChange(next);
      },
    });
    return el("label", { class: "odds-field" }, [label, input, error]);
  }

  function toleranceField(value: number | null, onChange: (v: number | null) => void): HTMLElement {
    const error = el("span", { id: "tolerance-error", class: "field-error", role: "alert" });
    const input = el("input", {
      id: "tolerance",
      "aria-label": "Near-gold tolerance",
      type: "number",
      min: "0",
      max: "60",
      step: "any",
      placeholder: "auto",
      value: value === null ? "" : String(value),
      "aria-describedby": "tolerance-error",
      onchange: () => {
        const next =
          input.value.trim() === "" && !input.validity.badInput ? null : input.valueAsNumber;
        if (next !== null && (!Number.isFinite(next) || next < 0 || next > 60)) {
          input.setAttribute("aria-invalid", "true");
          error.textContent = "Use 0 to 60 seconds, or clear for auto. Results have not changed.";
          return;
        }
        onChange(next);
      },
    });
    return el("label", { class: "odds-field" }, [
      "Near-gold tolerance",
      input,
      el("span", { class: "val" }, [value === null ? "auto (8%, at least 1s)" : `${value}s fixed`]),
      error,
    ]);
  }

  function renderContent(): HTMLElement {
    if (!state.run) {
      return el("div", { class: "empty" }, [
        el("h1", { tabindex: -1 }, ["Open the history behind your splits."]),
        el("p", { class: "lede" }, [
          "Compare recorded attempts, inspect the time behind your resets, and open the saved records behind a sum of best. Analysis stays in your browser.",
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
                {
                  id: "choose-file",
                  type: "button",
                  class: "btn btn-accent",
                  onclick: () => fileInput.click(),
                },
                ["Choose a .lss file"],
              ),
              ...SAMPLE_FILES.map((s) =>
                el(
                  "button",
                  {
                    type: "button",
                    class: "btn",
                    onclick: () => void loadSample(s.path, s.synthetic),
                  },
                  [s.label],
                ),
              ),
            ]),
            el("p", {}, ["or drop a file here · splits.lss lives in your LiveSplit folder"]),
            el("p", { class: "recorded-credit" }, [
              "Recorded examples: Destrega, Re-Loaded and Zero Divide 2, shared by ",
              el(
                "a",
                {
                  href: "https://github.com/AmenAnthem/speedrun-livesplit-splits/tree/21676ae91d9379b0c1380104c817cfc3d5b71776",
                },
                ["AmenAnthem"],
              ),
              " under the MIT license. The Crystal Caverns samples are synthetic.",
            ]),
          ],
        ),
        el("p", { class: "privacy-note" }, [
          el("span", { class: "dot" }),
          "Parsed entirely client-side. Nothing is uploaded, logged, or stored anywhere but your browser.",
        ]),
      ]);
    }

    const run = state.run;
    if (state.source && practiceCache?.run !== run) {
      practiceCache = { run, workspace: createPracticeReview(run, state.method, state.source) };
    }
    practiceCache?.workspace.setMethod(state.method);
    if (state.source && bestCache?.run !== run) {
      bestCache = { run, workspace: createBestRoute(run, state.method, state.source) };
    }
    bestCache?.workspace.setMethod(state.method);
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

      bestCache?.workspace.element,

      practiceCache?.workspace.element,

      section(
        "Segment breakdown",
        "Time save & consistency",
        "Possible time save is your PB's own segment duration minus that segment's gold (the best it's ever been split). Consistency is computed over the last N attempts.",
        [
          numberField("Window", state.consistencyWindow, 1, Math.max(1, run.attempts.length), (v) =>
            setState({ consistencyWindow: v }, true),
          ),
          toleranceField(state.toleranceSeconds, (v) => setState({ toleranceSeconds: v }, true)),
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
        "Finished attempt times relative to your current PB. Gold dots mark new best-so-far times. Large histories retain each display column's first, last, fastest and slowest points; statistics use every attempt.",
        [],
        renderDeltaChart(run, state.method),
      ),

      section(
        "Reset analysis",
        "Where do your runs die?",
        "The survival curve is the share of attempts that reached each segment at all; the red bars show inferred resets at each segment, assuming its history has not been edited.",
        [],
        renderSurvivalChart(run),
      ),

      section(
        "Per-segment shape",
        "Time distributions & gold history",
        `Recorded times for each segment in the last ${state.consistencyWindow} attempts: individual dots, or count histograms above 1,024 timings (dashed line is gold, blue tick is median). Gold-history plots follow record order; large displays are summarized. Imported IDs do not establish dates.`,
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
          result: oddsFor(run),
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
              id: "export-markdown",
              onclick: () =>
                downloadText(
                  `splitscope-${run.gameName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.md`,
                  buildMarkdownSummary(run, {
                    isSample: state.isSample,
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
              id: "export-png",
              onclick: () => {
                void exportPngCard(run, {
                  isSample: state.isSample,
                  method: state.method,
                  recentWindow: state.mcRecentWindow,
                  simulations: state.mcSimulations,
                  lookaheadAttempts: state.mcLookahead,
                })
                  .then(() => {
                    if (state.run === run) setState({ exportStatus: "PNG card downloaded." });
                  })
                  .catch((cause: unknown) => {
                    if (state.run === run)
                      setState({
                        exportStatus:
                          cause instanceof Error ? cause.message : "Could not export the PNG.",
                      });
                  });
              },
            },
            ["Download PNG card"],
          ),
          el("p", { role: "status", class: "export-status" }, [state.exportStatus]),
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
      fileInput.value = "";
      if (file) loadFile(file);
    },
  });

  function render(): void {
    const focusedId = root.contains(document.activeElement)
      ? document.activeElement?.id
      : undefined;
    const disclosures = [...root.querySelectorAll<HTMLDetailsElement>("details[open][id]")].map(
      (node) => node.id,
    );
    const tableScroll = root.querySelector('[aria-label="Segment table"]')?.scrollLeft ?? 0;
    root.replaceChildren(
      el("div", { class: "shell" }, [
        el("a", { class: "skip-link", href: "#main-content" }, ["Skip to content"]),
        el("hr", { class: "rule" }),
        renderTopbar(),
        el("main", { id: "main-content" }, [
          state.loading
            ? el("div", { class: "load-banner" }, [
                el("span", { role: "status" }, [state.loading]),
                el("button", { type: "button", class: "btn", onclick: cancelImport }, [
                  "Cancel loading",
                ]),
              ])
            : null,
          state.error
            ? el(
                "div",
                { id: "import-error", class: "error-banner", role: "alert", tabindex: -1 },
                [
                  el("strong", {}, ["Could not load this file"]),
                  el("p", {}, [state.error]),
                  state.run
                    ? el("p", {}, ["Your previous analysis is still available below."])
                    : null,
                  lastImport
                    ? el(
                        "button",
                        { type: "button", class: "btn", onclick: () => lastImport?.() },
                        ["Retry import"],
                      )
                    : null,
                  el(
                    "button",
                    {
                      type: "button",
                      class: "btn",
                      onclick: () => {
                        lastImport = null;
                        setState({ error: null });
                        focusContent();
                      },
                    },
                    ["Dismiss error"],
                  ),
                ],
              )
            : null,
          renderContent(),
        ]),
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
    for (const id of disclosures) {
      const node = document.getElementById(id);
      if (node instanceof HTMLDetailsElement) node.open = true;
    }
    const table = root.querySelector('[aria-label="Segment table"]');
    if (table) table.scrollLeft = tableScroll;
    if (focusedId) document.getElementById(focusedId)?.focus({ preventScroll: true });
  }

  render();
}
