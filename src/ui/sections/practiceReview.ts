import {
  type AttemptFilter,
  type AttemptReview,
  buildPracticeExport,
  type CohortSide,
  comparePractice,
  filterAttempts,
  inspectAttempt,
  type PracticeCohort,
  REVIEW_ASSUMPTIONS,
  type ReviewSource,
} from "../../core/review.js";
import { pick, type Run, type TimingMethod } from "../../core/types.js";
import { el } from "../dom.js";
import { downloadText } from "../export.js";
import { formatDelta, formatPercent, formatSeconds } from "../format.js";

const ATTEMPT_PAGE = 10;
const SEGMENT_PAGE = 20;

function rangeLabel(cohort: PracticeCohort): string {
  const first = cohort.attempts[0]?.attempt.id;
  const last = cohort.attempts.at(-1)?.attempt.id;
  return first === undefined ? "No earlier records" : `#${first}–#${last}`;
}

function outcomeLabel(run: Run, row: AttemptReview): string {
  if (row.outcome === "completed") return "Completed";
  if (row.inferredResetSegment === null) return "Outcome unknown";
  return `Reset inferred: ${run.segments[row.inferredResetSegment]?.label}`;
}

function tableRegion(name: string, table: HTMLTableElement): HTMLElement {
  return el(
    "div",
    { class: "review-table-scroll", role: "region", "aria-label": name, tabindex: 0 },
    [table],
  );
}

function headingRow(labels: string[]): HTMLTableSectionElement {
  return el("thead", {}, [
    el(
      "tr",
      {},
      labels.map((label) => el("th", { scope: "col" }, [label])),
    ),
  ]);
}

/** Keep this workspace's controls and selections through unrelated app/theme renders. */
export function createPracticeReview(run: Run, initialMethod: TimingMethod, source: ReviewSource) {
  const section = el("section", {
    class: "section practice-review",
    id: "practice-review",
    "aria-labelledby": "practice-title",
  });
  let method = initialMethod;
  let windowSize = Math.min(30, Math.max(1, run.attempts.length));
  let endOrdinal = run.attempts.length;
  let comparison = comparePractice(run, method, windowSize, endOrdinal);
  let side: CohortSide = "recent";
  let filter: AttemptFilter = { outcome: "all", resetSegment: null };
  let page = 0;
  let segmentPage = 0;
  let detailPage = 0;
  let selectedId: number | null = null;

  function render(focusId?: string, reveal = false): void {
    const activeId =
      focusId ??
      (section.contains(document.activeElement) ? document.activeElement?.id : undefined);
    const assumptionsOpen =
      section.querySelector<HTMLDetailsElement>("#practice-assumptions")?.open ?? false;
    const scrolls = [...section.querySelectorAll<HTMLElement>(".review-table-scroll")].map(
      (node) => [node.getAttribute("aria-label"), node.scrollLeft] as const,
    );
    section.replaceChildren(
      el("div", { class: "section-head" }, [
        el("div", {}, [
          el("p", { class: "section-eyebrow" }, ["Recorded practice"]),
          el("h2", { class: "section-title", id: "practice-title" }, [
            "What changed in your recent attempts?",
          ]),
        ]),
      ]),
      el("p", { class: "section-desc" }, [
        "Compare consecutive groups of recorded attempts, then open the split records behind a count. Reset locations are inferred from the saved history.",
      ]),
    );
    if (!run.attempts.length) {
      section.append(
        el("div", { class: "panel" }, [
          el("p", {}, [
            "No attempt history is recorded in this file. Segment golds and imported segment history cannot establish practice attempts.",
          ]),
        ]),
      );
      return;
    }
    section.append(controls(), summaries());
    section.append(el("div", { class: "review-columns" }, [resetTable(), attemptList()]));
    if (selectedId !== null) section.append(attemptDetail(selectedId));
    section.append(
      el("div", { class: "review-export" }, [
        el(
          "button",
          {
            type: "button",
            class: "btn",
            id: "export-practice",
            onclick: () =>
              downloadText(
                "splitscope-practice.json",
                JSON.stringify(buildPracticeExport(run, comparison, source), null, 2),
                "application/json",
              ),
          },
          ["Download both groups + split records"],
        ),
        el("p", { class: "section-desc" }, [
          "JSON includes both complete groups, original split records and the input file's SHA-256. List filters and pages do not remove export evidence.",
        ]),
      ]),
    );
    section.append(
      el(
        "details",
        { id: "practice-assumptions", class: "review-assumptions", open: assumptionsOpen },
        [
          el("summary", {}, ["How to read this comparison"]),
          el(
            "ul",
            {},
            REVIEW_ASSUMPTIONS.map((text) => el("li", {}, [text])),
          ),
          el("p", {}, [
            "Other charts cover the whole history. Consistency and PB odds use their own labelled windows; changing this review does not change a forecast.",
          ]),
        ],
      ),
    );
    for (const [name, scroll] of scrolls) {
      const node = [...section.querySelectorAll<HTMLElement>(".review-table-scroll")].find(
        (item) => item.getAttribute("aria-label") === name,
      );
      if (node) node.scrollLeft = scroll;
    }
    if (activeId) {
      const node = section.querySelector<HTMLElement>(`#${activeId}`);
      node?.focus({ preventScroll: true });
      if (reveal) node?.scrollIntoView({ block: "start" });
    }
  }

  function resetSelection(): void {
    page = 0;
    selectedId = null;
  }

  function applyRange(size: number, end: number): void {
    windowSize = size;
    endOrdinal = end;
    comparison = comparePractice(run, method, windowSize, endOrdinal);
    resetSelection();
    render();
  }

  function controls(): HTMLElement {
    const error = el("p", { class: "field-error", role: "alert", id: "practice-range-error" });
    const size = el("input", {
      type: "number",
      id: "practice-window",
      min: 1,
      max: run.attempts.length,
      step: 1,
      required: true,
      value: windowSize,
      "aria-describedby": "practice-range-error",
    });
    const end = el("input", {
      type: "number",
      id: "practice-end",
      step: 1,
      required: true,
      value: run.attempts[endOrdinal - 1]?.id ?? "",
      "aria-describedby": "practice-range-error",
    });
    return el(
      "form",
      {
        class: "review-controls",
        novalidate: true,
        onsubmit: (event: Event) => {
          event.preventDefault();
          const n = size.valueAsNumber;
          const ordinal = run.attempts.findIndex((attempt) => attempt.id === end.valueAsNumber) + 1;
          if (!Number.isSafeInteger(n) || n < 1 || n > run.attempts.length || !ordinal) {
            size.setAttribute(
              "aria-invalid",
              String(!Number.isSafeInteger(n) || n < 1 || n > run.attempts.length),
            );
            end.setAttribute("aria-invalid", String(!ordinal));
            error.textContent = `Use 1–${run.attempts.length} attempts per group and an ending ID present in this file. The applied comparison is unchanged.`;
            return;
          }
          applyRange(n, ordinal);
        },
      },
      [
        el("label", { for: "practice-window" }, ["Attempts per group", size]),
        el("label", { for: "practice-end" }, ["Ending at attempt ID", end]),
        el("button", { type: "submit", class: "btn btn-accent", id: "practice-apply" }, [
          "Apply range",
        ]),
        el(
          "button",
          {
            type: "button",
            class: "btn",
            id: "practice-latest",
            onclick: () => applyRange(windowSize, run.attempts.length),
          },
          ["Latest attempts"],
        ),
        error,
      ],
    );
  }

  function chooseGroup(
    next: CohortSide,
    nextFilter: AttemptFilter,
    focus = "practice-list-title",
  ): void {
    side = next;
    filter = nextFilter;
    resetSelection();
    render(focus, true);
  }

  function summaries(): HTMLElement {
    return el(
      "div",
      { class: "review-summaries", role: "group", "aria-label": "Applied practice groups" },
      (["previous", "recent"] as const).map((key) => {
        const group = comparison[key];
        const n = group.attempts.length;
        return el("div", { class: `review-summary review-${key}` }, [
          el("p", { class: "section-eyebrow" }, [
            `${key === "recent" ? "Recent" : "Previous"} · ${rangeLabel(group)}`,
          ]),
          el("p", { class: "review-finish" }, [
            el(
              "button",
              {
                class: "review-count",
                type: "button",
                id: `review-${key}-completed`,
                disabled: !group.completed,
                onclick: () => chooseGroup(key, { outcome: "completed", resetSegment: null }),
                "aria-label": `Inspect ${group.completed} completed attempts in ${key} group`,
              },
              [`${group.completed} / ${n}`],
            ),
            " finished",
            el("span", { class: "review-rate" }, [formatPercent(n ? group.completed / n : null)]),
          ]),
          el("p", {}, [
            `${group.inferredResets} inferred resets · ${group.unknown} unknown outcomes`,
          ]),
          el("p", { class: "section-desc" }, [
            `${method} median ${formatSeconds(group.medianCompletion)} · ${group.timedCompletions} timed completions`,
          ]),
          n < windowSize
            ? el("p", { class: "section-desc" }, [
                `Only ${n} of ${windowSize} requested records are available.`,
              ])
            : null,
        ]);
      }),
    );
  }

  function pagination(
    current: number,
    count: number,
    size: number,
    prefix: string,
    change: (page: number) => void,
  ): HTMLElement | null {
    const pages = Math.ceil(count / size);
    if (pages < 2) return null;
    return el(
      "div",
      { class: "review-pagination", role: "group", "aria-label": `${prefix} pages` },
      [
        el(
          "button",
          {
            type: "button",
            class: "btn",
            id: `${prefix}-previous`,
            disabled: current === 0,
            onclick: () => {
              change(current - 1);
              section.querySelector<HTMLElement>(`#${prefix}-page`)?.focus({ preventScroll: true });
            },
          },
          ["Previous"],
        ),
        el("span", { id: `${prefix}-page`, tabindex: -1, role: "status" }, [
          `${current + 1} / ${pages}`,
        ]),
        el(
          "button",
          {
            type: "button",
            class: "btn",
            id: `${prefix}-next`,
            disabled: current + 1 >= pages,
            onclick: () => {
              change(current + 1);
              section.querySelector<HTMLElement>(`#${prefix}-page`)?.focus({ preventScroll: true });
            },
          },
          ["Next"],
        ),
      ],
    );
  }

  function resetTable(): HTMLElement {
    const rows = run.segments
      .slice(segmentPage * SEGMENT_PAGE, (segmentPage + 1) * SEGMENT_PAGE)
      .map((segment, offset) => {
        const index = segmentPage * SEGMENT_PAGE + offset;
        return el("tr", {}, [
          el("th", { scope: "row" }, [
            el("span", { class: "review-segment-number" }, [`${index + 1}. `]),
            segment.label,
          ]),
          ...(["previous", "recent"] as const).map((key) => {
            const counts = comparison[key].segments[index];
            if (!counts) return el("td");
            return el("td", {}, [
              el(
                "button",
                {
                  type: "button",
                  class: `review-reset-count review-${key}`,
                  id: `resets-${key}-${index}`,
                  disabled: !counts.resets,
                  "aria-label": `Inspect ${counts.resets} inferred resets at ${segment.label} in ${key} group`,
                  onclick: () =>
                    chooseGroup(key, { outcome: "inferred-reset", resetSegment: index }),
                },
                [
                  el("span", {}, [`${counts.resets} / ${counts.started}`]),
                  el("span", { class: "review-rate" }, [formatPercent(counts.resetRate, 0)]),
                ],
              ),
            ]);
          }),
        ]);
      });
    return el("div", { class: "panel review-panel" }, [
      el("h3", {}, ["Resets / attempts reaching each segment"]),
      el("p", { class: "section-desc" }, [
        "Open a nonzero count to inspect its attempts. Rates use attempts reaching that segment, so later segments have smaller denominators.",
      ]),
      tableRegion(
        "Practice reset comparison",
        el("table", { class: "review-table" }, [
          headingRow(["Segment", "Previous", "Recent"]),
          el("tbody", {}, rows),
        ]),
      ),
      pagination(segmentPage, run.segments.length, SEGMENT_PAGE, "review-segments", (next) => {
        segmentPage = next;
        render("review-segments-next");
      }),
    ]);
  }

  function attemptList(): HTMLElement {
    const group = comparison[side];
    const matches = filterAttempts(group, filter).reverse();
    page = Math.min(page, Math.max(0, Math.ceil(matches.length / ATTEMPT_PAGE) - 1));
    const start = page * ATTEMPT_PAGE;
    const chooser = el(
      "select",
      {
        id: "practice-outcome",
        onchange: (event: Event) => {
          filter = {
            outcome: (event.target as HTMLSelectElement).value as AttemptFilter["outcome"],
            resetSegment: null,
          };
          resetSelection();
          render();
        },
      },
      [
        ["all", "All outcomes"],
        ["completed", "Completed"],
        ["inferred-reset", "Inferred resets"],
        ["unknown", "Unknown outcomes"],
      ].map(([value, label]) =>
        el("option", { value, selected: value === filter.outcome }, [label]),
      ),
    );
    return el("div", { class: "panel review-panel" }, [
      el("h3", { id: "practice-list-title", tabindex: -1 }, ["Attempts behind the counts"]),
      el("div", { class: "review-list-controls" }, [
        el(
          "div",
          { class: "segmented", role: "group", "aria-label": "Attempt group" },
          (["previous", "recent"] as const).map((key) =>
            el(
              "button",
              {
                type: "button",
                id: `practice-side-${key}`,
                "aria-pressed": String(side === key),
                onclick: () => {
                  side = key;
                  resetSelection();
                  render();
                },
              },
              [key === "recent" ? "Recent" : "Previous"],
            ),
          ),
        ),
        el("label", { for: "practice-outcome", class: "review-outcome" }, ["Outcome", chooser]),
      ]),
      el("p", { class: "review-list-status", role: "status" }, [
        `${side === "recent" ? "Recent" : "Previous"} ${rangeLabel(group)} · ${matches.length} matching attempts${filter.resetSegment === null ? "" : ` · reset inferred at ${run.segments[filter.resetSegment]?.label}`}. Newest first.`,
      ]),
      filter.resetSegment === null
        ? null
        : el(
            "button",
            {
              type: "button",
              id: "practice-clear-filter",
              class: "btn",
              onclick: () => {
                filter = { outcome: "all", resetSegment: null };
                resetSelection();
                render("practice-outcome");
              },
            },
            ["Clear segment filter"],
          ),
      matches.length
        ? tableRegion(
            "Practice attempts",
            el("table", { class: "review-table review-attempt-table" }, [
              headingRow(["Attempt", "Recorded outcome", method]),
              el(
                "tbody",
                {},
                matches.slice(start, start + ATTEMPT_PAGE).map((row) =>
                  el(
                    "tr",
                    { "data-selected": row.attempt.id === selectedId ? "true" : undefined },
                    [
                      el("th", { scope: "row" }, [
                        el(
                          "button",
                          {
                            type: "button",
                            id: `inspect-attempt-${row.attempt.id}`,
                            class: "review-count",
                            "aria-label": `Inspect attempt ${row.attempt.id}`,
                            onclick: () => {
                              selectedId = row.attempt.id;
                              detailPage = 0;
                              render("practice-attempt-title", true);
                            },
                          },
                          [`#${row.attempt.id}`],
                        ),
                      ]),
                      el("td", {}, [outcomeLabel(run, row)]),
                      el("td", { class: "review-time" }, [
                        formatSeconds(pick(row.attempt.time, method)),
                      ]),
                    ],
                  ),
                ),
              ),
            ]),
          )
        : el("p", { class: "review-empty" }, [
            "No attempts match this selection. Choose another outcome or group.",
          ]),
      pagination(page, matches.length, ATTEMPT_PAGE, "review-attempts", (next) => {
        page = next;
        render();
      }),
    ]);
  }

  function attemptDetail(id: number): HTMLElement {
    const row = comparison[side].attempts.find((item) => item.attempt.id === id);
    if (!row) return el("div");
    const records = inspectAttempt(run, id, method);
    const rows = records
      .slice(detailPage * SEGMENT_PAGE, (detailPage + 1) * SEGMENT_PAGE)
      .map((record) => {
        const segment = run.segments[record.segmentIndex];
        const status =
          record.kind === "missing"
            ? "No history entry"
            : record.kind === "untimed"
              ? `No ${method} time (skipped or untimed)`
              : record.kind === "combined"
                ? `Combined: segments ${(record.combinedFrom ?? 0) + 1}–${record.segmentIndex + 1}`
                : "Single segment";
        return el("tr", {}, [
          el("th", { scope: "row" }, [`${record.segmentIndex + 1}. ${segment?.label}`]),
          el("td", {}, [
            status,
            el("span", { class: "review-mobile-time" }, [
              `${method}: ${formatSeconds(record.seconds)}`,
              record.deltaToCurrentPb === null ? null : el("br"),
              record.deltaToCurrentPb === null
                ? null
                : `${formatDelta(record.deltaToCurrentPb)} vs. PB`,
            ]),
          ]),
          el("td", { class: "review-time" }, [formatSeconds(record.seconds)]),
          el(
            "td",
            {
              class: `review-time ${record.deltaToCurrentPb === null ? "" : record.deltaToCurrentPb < 0 ? "delta-ahead" : record.deltaToCurrentPb > 0 ? "delta-behind" : ""}`,
            },
            [formatDelta(record.deltaToCurrentPb)],
          ),
          el("td", { class: "review-source" }, [
            record.recordedTime === null
              ? "No record"
              : `Time id="${id}" · segment ${record.segmentIndex + 1}`,
          ]),
        ]);
      });
    return el("div", { class: "panel review-detail" }, [
      el("div", { class: "review-detail-head" }, [
        el("div", {}, [
          el("p", { class: "section-eyebrow" }, [
            `Recorded attempt ${row.ordinal} of ${run.attempts.length}`,
          ]),
          el("h3", { id: "practice-attempt-title", tabindex: -1 }, [
            `Attempt #${id} · ${outcomeLabel(run, row)}`,
          ]),
        ]),
        el(
          "button",
          {
            type: "button",
            class: "btn",
            id: "practice-back",
            onclick: () => {
              render(`inspect-attempt-${id}`, true);
            },
          },
          ["Back to attempt list"],
        ),
      ]),
      el("p", { class: "review-attempt-times" }, [
        `Recorded totals · RTA ${formatSeconds(row.attempt.time.realTime)} · IGT ${formatSeconds(row.attempt.time.gameTime)} · pause ${formatSeconds(row.attempt.pauseTime)}`,
      ]),
      el("p", { class: "section-desc" }, [
        `Started: ${row.attempt.started ?? "not recorded"} · ended: ${row.attempt.ended ?? "not recorded"}. Timestamps are shown as saved.`,
      ]),
      el("p", { class: "section-desc" }, [
        "The time column is the stored segment-history duration. Combined entries cover multiple segments and have no single-segment PB delta. Missing records do not establish where an attempt stopped. PB deltas compare to today's saved PB, not the PB held at that attempt.",
      ]),
      tableRegion(
        "Selected attempt split records",
        el("table", { class: "review-table" }, [
          headingRow(["Segment", "Evidence", method, "vs. current PB", "Source entry"]),
          el("tbody", {}, rows),
        ]),
      ),
      pagination(detailPage, records.length, SEGMENT_PAGE, "review-records", (next) => {
        detailPage = next;
        render();
      }),
      el("p", { class: "review-source-file" }, [`${source.name} · SHA-256 ${source.sha256}`]),
    ]);
  }

  render();
  return {
    element: section,
    setMethod(next: TimingMethod) {
      if (method === next) return;
      method = next;
      comparison = comparePractice(run, method, windowSize, endOrdinal);
      render();
    },
  };
}
