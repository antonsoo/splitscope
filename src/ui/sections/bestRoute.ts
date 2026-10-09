import {
  BEST_ASSUMPTIONS,
  type BestLeg,
  bestLegEvidence,
  bestRoute,
  buildBestExport,
} from "../../core/best-route.js";
import type { ReviewSource } from "../../core/review.js";
import { pick, type Run, type TimingMethod } from "../../core/types.js";
import { el } from "../dom.js";
import { downloadText } from "../export.js";
import { formatSeconds } from "../format.js";

const PAGE_SIZE = 12;

export function legLabel(run: Run, leg: BestLeg): string {
  const first = run.segments[leg.from]?.label ?? "";
  const last = run.segments[leg.to - 1]?.label ?? "";
  return leg.to === leg.from + 1
    ? `${leg.from + 1}. ${first}`
    : `${leg.from + 1}–${leg.to}. ${first} → ${last}`;
}

export function sourceLabel(leg: BestLeg): string {
  return leg.source.kind === "gold"
    ? "Stored gold"
    : leg.source.kind === "personal-best"
      ? "PB splits"
      : `History #${leg.source.attemptId}`;
}

function region(label: string, table: HTMLTableElement): HTMLElement {
  return el(
    "div",
    { class: "review-table-scroll", tabindex: 0, role: "region", "aria-label": label },
    [table],
  );
}

function columns(labels: string[]) {
  return el("thead", {}, [
    el(
      "tr",
      {},
      labels.map((label) => el("th", { scope: "col" }, [label])),
    ),
  ]);
}

/** Preserve the selected source and page while the rest of the app rerenders. */
export function createBestRoute(run: Run, initialMethod: TimingMethod, source: ReviewSource) {
  const section = el("section", {
    class: "section best-route",
    id: "best-route",
    "aria-labelledby": "best-title",
  });
  let method = initialMethod;
  let route = bestRoute(run, method);
  const firstInteresting = () =>
    Math.max(
      0,
      route.legs.findIndex((leg) => leg.to - leg.from > 1),
    );
  let selected = firstInteresting();
  let page = Math.floor(selected / PAGE_SIZE);
  let detailPage = 0;

  function render(focusId?: string): void {
    const assumptionsOpen =
      section.querySelector<HTMLDetailsElement>("#best-assumptions")?.open ?? false;
    const routeTime = route.totalSeconds;
    const goldTime = route.goldSumSeconds;
    section.replaceChildren(
      el("div", { class: "section-head" }, [
        el("h2", { class: "section-title", id: "best-title", tabindex: -1 }, [
          "Where your sum of best comes from",
        ]),
        el(
          "button",
          {
            class: "btn",
            type: "button",
            id: "export-best",
            onclick: () => {
              downloadText(
                "splitscope-sum-of-best.json",
                JSON.stringify(buildBestExport(run, method, source), null, 2),
                "application/json",
              );
            },
          },
          ["Download calculation"],
        ),
      ]),
      el("p", { class: "section-desc" }, [
        "The fastest combination of saved golds, PB spans and skipped-split times. Open a span to inspect its source. This is a hypothetical combination, not one attempt or a pace forecast.",
      ]),
      el("div", { class: "best-comparison" }, [
        el("p", {}, [
          el("span", {}, ["Sum of best"]),
          el("strong", { id: "best-total" }, [
            routeTime === null ? "Unavailable" : formatSeconds(routeTime, 3),
          ]),
        ]),
        el("p", {}, [
          el("span", {}, ["Individual golds added"]),
          el("strong", { id: "best-golds" }, [
            goldTime === null ? "Incomplete" : formatSeconds(goldTime, 3),
          ]),
        ]),
        el("p", { class: "best-explanation" }, [
          routeTime === null
            ? "No complete path through the saved times. A subtotal cannot stand in for a full run."
            : goldTime === null
              ? "Recorded spans complete the calculation even though some individual golds are missing."
              : goldTime - routeTime > 1e-7
                ? `${formatSeconds(goldTime - routeTime, 3)} lower using the recorded spans below. A combined span's saving belongs to that whole span.`
                : "The saved golds already match the fastest complete combination.",
        ]),
      ]),
    );
    if (route.legs.length) {
      section.append(el("div", { class: "best-columns" }, [routeTable(), detail()]));
    }
    section.append(
      el("details", { id: "best-assumptions", ...(assumptionsOpen ? { open: true } : {}) }, [
        el("summary", {}, ["Calculation rules and limits"]),
        el(
          "ul",
          {},
          BEST_ASSUMPTIONS.map((text) => el("li", {}, [text])),
        ),
      ]),
      el("p", { class: "review-source-file" }, [
        `${source.name} · ${method} · ${source.bytes.toLocaleString("en-US")} bytes${source.synthetic ? " · Synthetic sample" : ""}`,
        el("br"),
        `SHA-256 ${source.sha256}`,
      ]),
    );
    if (focusId) section.querySelector<HTMLElement>(`#${focusId}`)?.focus({ preventScroll: true });
  }

  function routeTable(): HTMLElement {
    let cumulative = 0;
    const totals = route.legs.map((leg) => {
      cumulative += leg.seconds;
      return cumulative;
    });
    const start = page * PAGE_SIZE;
    const rows = route.legs.slice(start, start + PAGE_SIZE).map((leg, offset) => {
      const index = start + offset;
      return el("tr", { class: index === selected ? "best-selected" : "" }, [
        el("th", { scope: "row", class: "best-span" }, [
          el(
            "button",
            {
              type: "button",
              class: "best-inspect",
              id: `best-leg-${index}`,
              "aria-pressed": String(index === selected),
              "aria-label": `Inspect source for ${legLabel(run, leg)}`,
              onclick: () => {
                selected = index;
                detailPage = 0;
                render("best-detail-title");
              },
            },
            [legLabel(run, leg)],
          ),
        ]),
        el("td", { class: leg.source.kind === "gold" ? "gold-text" : "" }, [
          formatSeconds(leg.seconds, 3),
        ]),
        el("td", {}, [sourceLabel(leg)]),
        el("td", {}, [formatSeconds(totals[index] ?? null, 3)]),
      ]);
    });
    return el("div", { class: "best-list" }, [
      region(
        "Sum of best route",
        el("table", { class: "best-table" }, [
          columns(["Recorded span", "Time", "Source", "Running total"]),
          el("tbody", {}, rows),
        ]),
      ),
      pager(
        "best",
        start,
        Math.min(start + PAGE_SIZE, route.legs.length),
        route.legs.length,
        (delta) => {
          page += delta;
          render(`best-leg-${page * PAGE_SIZE}`);
        },
      ),
    ]);
  }

  function pager(
    prefix: string,
    start: number,
    end: number,
    total: number,
    move: (delta: number) => void,
  ) {
    return el("div", { class: "best-pagination" }, [
      el(
        "button",
        {
          class: "btn",
          id: `${prefix}-previous`,
          type: "button",
          disabled: start === 0,
          onclick: () => move(-1),
        },
        ["Previous"],
      ),
      el("span", { role: "status" }, [`${start + 1}–${end} of ${total}`]),
      el(
        "button",
        {
          class: "btn",
          id: `${prefix}-next`,
          type: "button",
          disabled: end >= total,
          onclick: () => move(1),
        },
        ["Next"],
      ),
    ]);
  }

  function detail(): HTMLElement {
    const leg = route.legs[selected];
    if (!leg) return el("div");
    const records = bestLegEvidence(run, leg);
    const historyId = leg.source.kind === "history" ? leg.source.attemptId : null;
    const recordedAttempt =
      historyId === null ? null : run.attempts.find((attempt) => attempt.id === historyId);
    const start = detailPage * PAGE_SIZE;
    const field =
      leg.source.kind === "gold"
        ? "BestSegmentTime"
        : leg.source.kind === "history"
          ? `SegmentHistory / Time id="${historyId}"`
          : 'SplitTimes / SplitTime name="Personal Best"';
    const rows = records.slice(start, start + PAGE_SIZE).map((record) => {
      const seconds = record.time === null ? null : pick(record.time, method);
      return el("tr", {}, [
        el("th", { scope: "row" }, [
          `${record.segmentIndex + 1}. ${run.segments[record.segmentIndex]?.label}`,
        ]),
        el("td", {}, [
          record.time === null ? "Not recorded" : seconds === null ? "Empty" : String(seconds),
        ]),
      ]);
    });
    return el("div", { class: "best-detail" }, [
      el("h3", { id: "best-detail-title", tabindex: -1 }, [legLabel(run, leg)]),
      el("p", { class: "best-source-label" }, [
        sourceLabel(leg),
        leg.to - leg.from > 1 ? " · Combined span" : "",
      ]),
      el("code", { class: "best-source-path" }, [field]),
      el("p", {}, [
        leg.source.kind === "personal-best"
          ? `${leg.source.endSeconds} − ${leg.source.startSeconds} = ${Number(leg.seconds.toFixed(7))} seconds. Empty intermediate splits stay inside this span.`
          : leg.source.kind === "history"
            ? "The empty entries and the following time belong together. No individual times are inferred inside this span."
            : "The file stores this gold directly. It does not identify which attempt set it.",
      ]),
      historyId === null
        ? null
        : el("p", {}, [
            recordedAttempt
              ? `ID ${historyId} is present in the saved attempt history.`
              : `ID ${historyId} has no matching attempt record. It may be imported history; no attempt or date is inferred.`,
          ]),
      region(
        "Selected source records",
        el("table", { class: "best-table best-records" }, [
          columns(["Segment", `${method === "RealTime" ? "Real" : "Game"} time (seconds)`]),
          el("tbody", {}, rows),
        ]),
      ),
      records.length > PAGE_SIZE
        ? pager(
            "best-record",
            start,
            Math.min(start + PAGE_SIZE, records.length),
            records.length,
            (delta) => {
              detailPage += delta;
              render("best-detail-title");
            },
          )
        : null,
      el("p", { class: "best-record-note" }, [
        "Values are shown in seconds. The download retains both timing methods and the complete input to this calculation.",
      ]),
      el(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: () => {
            page = Math.floor(selected / PAGE_SIZE);
            render(`best-leg-${selected}`);
          },
        },
        ["Back to selected span"],
      ),
    ]);
  }

  render();
  return {
    element: section,
    setMethod(next: TimingMethod): void {
      if (next === method) return;
      method = next;
      route = bestRoute(run, method);
      selected = firstInteresting();
      page = Math.floor(selected / PAGE_SIZE);
      detailPage = 0;
      render();
    },
  };
}
