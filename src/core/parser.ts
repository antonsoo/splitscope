/**
 * Parser for LiveSplit's `.lss` XML save format.
 *
 * The element structure and per-version quirks below are verified against
 * LiveSplit's own parser, `livesplit-core`'s
 * `src/run/parser/livesplit.rs` (function `parse`, and the version-gated
 * helpers `parse_segment`, `parse_attempt_history`, `parse_run_history`).
 * See `docs/format.md` for the exact source citation and a walkthrough of
 * every version branch reproduced here.
 */

import { XMLParser } from "fast-xml-parser";
import { LssParseError } from "./errors.js";
import { segmentLabels } from "./names.js";
import { parseOptionalTimeSpan, parseTimeSpan } from "./timespan.js";
import type { Attempt, DualTime, Run, Segment, SegmentHistoryEntry } from "./types.js";
import { attr, childArray, childNode, childText, ownText, type XmlNode } from "./xml-helpers.js";

const REPEATED_TAGS = new Set(["Attempt", "Segment", "SplitTime", "Time", "SegmentGroup"]);

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  // Numeric XML references (e.g. &#10; and &#x1F31F;) need entity decoding too.
  htmlEntities: true,
  attributeNamePrefix: "@_",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  isArray: (tagName) => REPEATED_TAGS.has(tagName),
  // Keep large payloads opaque at their actual schema paths. Let the XML
  // parser identify nodes: tag-like text in comments, CDATA or instructions
  // must never remove timing records before validation.
  stopNodes: ["Run.GameIcon", "Run.Segments.Segment.Icon", "Run.AutoSplitterSettings"],
});

/** A parsed 4-component version, e.g. `1.7.0.0`. Missing components default to 0. */
type Version = readonly [number, number, number, number];

const V_1_3_0 = versionOf("1.3.0.0");
const V_1_4_1 = versionOf("1.4.1.0");
const V_1_5_0 = versionOf("1.5.0.0");

function versionOf(text: string): Version {
  if (!/^\d+(?:\.\d+){0,3}$/.test(text)) {
    throw new LssParseError(
      "Invalid LiveSplit format version: expected one to four integer components.",
    );
  }
  const parts = text.split(".").map((p) => readInteger(p, "format version", 0, 65535));
  return [parts[0] ?? 1, parts[1] ?? 0, parts[2] ?? 0, parts[3] ?? 0];
}

function readInteger(
  text: string | undefined,
  field: string,
  min = -2147483648,
  max = 2147483647,
): number {
  const value = Number(text);
  if (
    text === undefined ||
    !/^-?\d+$/.test(text) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new LssParseError(`Invalid ${field}: expected an integer from ${min} to ${max}.`);
  }
  return value;
}

function requireUnique(ids: Set<number>, id: number, field: string): void {
  if (ids.has(id))
    throw new LssParseError(
      `Duplicate ${field} ${id}. Repair the conflicting records before analyzing this file.`,
    );
  ids.add(id);
}

function compareVersion(a: Version, b: Version): number {
  for (let i = 0; i < 4; i++) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const gte = (a: Version, b: Version) => compareVersion(a, b) >= 0;

/**
 * Reads a `<RealTime>`/`<GameTime>` pair from a node. Before format 1.4.1,
 * the same logical value was instead the *direct text* of the parent
 * element (no RealTime/GameTime wrapper, and no GameTime at all) — that
 * shape is handled by `readDirectTime`, not this function.
 */
function readNestedTime(node: XmlNode | undefined): DualTime {
  return {
    realTime: parseOptionalTimeSpan(childText(node, "RealTime")),
    gameTime: parseOptionalTimeSpan(childText(node, "GameTime")),
  };
}

/** Pre-1.4.1 shape: the element's own text is the RealTime value; GameTime does not exist. */
function readDirectTime(text: string | undefined): DualTime {
  return { realTime: parseOptionalTimeSpan(text), gameTime: null };
}

function readTime(version: Version, node: XmlNode | undefined): DualTime {
  return gte(version, V_1_4_1) ? readNestedTime(node) : readDirectTime(ownText(node));
}

function parseSegment(
  version: Version,
  node: XmlNode,
): Omit<Segment, "label" | "group" | "isSubsplit"> {
  const name = childText(node, "Name");
  if (name === undefined) {
    throw new LssParseError("A <Segment> is missing its required <Name> element.");
  }

  const splitTimes = new Map<string, DualTime>();
  if (gte(version, V_1_3_0)) {
    for (const splitTimeNode of childArray(childNode(node, "SplitTimes"), "SplitTime")) {
      const comparisonName = attr(splitTimeNode, "name");
      if (comparisonName === undefined)
        throw new LssParseError(
          `A <SplitTime> in segment "${name}" is missing its name attribute.`,
        );
      if (splitTimes.has(comparisonName))
        throw new LssParseError(`Duplicate comparison in segment "${name}".`);
      splitTimes.set(comparisonName, readTime(version, splitTimeNode));
    }
  } else {
    // Pre-1.3.0 files have exactly one comparison, spelled out as its own element.
    const pbText = childText(node, "PersonalBestSplitTime");
    if (pbText !== undefined) {
      splitTimes.set("Personal Best", readDirectTime(pbText));
    }
  }

  const bestSegmentNode = childNode(node, "BestSegmentTime");
  const bestSegmentTime = gte(version, V_1_4_1)
    ? readNestedTime(bestSegmentNode)
    : readDirectTime(childText(node, "BestSegmentTime"));

  const history: SegmentHistoryEntry[] = [];
  const ids = new Set<number>();
  for (const timeNode of childArray(childNode(node, "SegmentHistory"), "Time")) {
    const attemptId = readInteger(attr(timeNode, "id"), `history id in segment "${name}"`);
    requireUnique(ids, attemptId, `history id in segment "${name}"`);
    history.push({
      attemptId,
      time: readTime(version, timeNode),
    });
  }
  history.sort((a, b) => a.attemptId - b.attemptId);

  return { name, splitTimes, bestSegmentTime, history };
}

/** Adds each segment's display label and section, which depend on its neighbours' names. */
function withLabels(segments: Omit<Segment, "label" | "group" | "isSubsplit">[]): Segment[] {
  const labels = segmentLabels(segments.map((segment) => segment.name));
  return segments.map((segment, i) => ({ ...segment, ...labels[i]! }));
}

function parseBool(text: string | undefined): boolean {
  return text === "True";
}

/**
 * `AttemptHistory` (>= 1.5.0): one entry per attempt, with timestamps and pause time.
 * Missing, malformed or repeated IDs are rejected: guessing their identity would
 * merge unrelated histories or count the same attempt more than once.
 */
function parseAttemptHistory(root: XmlNode): Attempt[] {
  const ids = new Set<number>();
  return childArray(childNode(root, "AttemptHistory"), "Attempt").map((node): Attempt => {
    const id = readInteger(attr(node, "id"), "attempt id");
    requireUnique(ids, id, "attempt id");
    return {
      id,
      started: attr(node, "started") ?? null,
      isStartedSynced: parseBool(attr(node, "isStartedSynced")),
      ended: attr(node, "ended") ?? null,
      isEndedSynced: parseBool(attr(node, "isEndedSynced")),
      pauseTime: parseOptionalTimeSpan(childText(node, "PauseTime")),
      time: readNestedTime(node),
    };
  });
}

/** `RunHistory` (< 1.5.0): just an id and an overall time, no timestamps. */
function parseRunHistory(version: Version, root: XmlNode): Attempt[] {
  const ids = new Set<number>();
  return childArray(childNode(root, "RunHistory"), "Time").map((node): Attempt => {
    const id = readInteger(attr(node, "id"), "run history id");
    requireUnique(ids, id, "run history id");
    return {
      id,
      started: null,
      isStartedSynced: false,
      ended: null,
      isEndedSynced: false,
      pauseTime: null,
      time: readTime(version, node),
    };
  });
}

/** Parses a LiveSplit `.lss` file's XML text into a {@link Run}. */
export function parseRun(xmlText: string): Run {
  if (xmlText.trim() === "") {
    throw new LssParseError("The file is empty.");
  }

  let parsed: unknown;
  try {
    parsed = xmlParser.parse(xmlText, true);
  } catch (cause) {
    throw new LssParseError(
      `Could not parse this file as XML. Is it really a LiveSplit .lss file? (${(cause as Error).message})`,
    );
  }

  const root = childNode(parsed, "Run");
  if (root === undefined) {
    throw new LssParseError(
      "This XML file has no <Run> root element — it doesn't look like a LiveSplit .lss file.",
    );
  }

  const version = versionOf(attr(root, "version") ?? "1.0.0.0");

  const gameName = childText(root, "GameName");
  const categoryName = childText(root, "CategoryName");
  const offsetText = childText(root, "Offset");
  const attemptCountText = childText(root, "AttemptCount");
  const segmentNodes = childArray(childNode(root, "Segments"), "Segment");

  const missing: string[] = [];
  if (gameName === undefined) missing.push("GameName");
  if (categoryName === undefined) missing.push("CategoryName");
  if (offsetText === undefined) missing.push("Offset");
  if (attemptCountText === undefined) missing.push("AttemptCount");
  if (segmentNodes.length === 0) missing.push("Segments");
  if (missing.length > 0) {
    throw new LssParseError(
      `This file is missing required LiveSplit elements: ${missing.join(", ")}. It may be corrupted or not a splits file.`,
    );
  }

  const attempts = gte(version, V_1_5_0)
    ? parseAttemptHistory(root)
    : parseRunHistory(version, root);

  return {
    gameName: gameName ?? "",
    categoryName: categoryName ?? "",
    formatVersion: version.join("."),
    offset: parseTimeSpan(offsetText ?? "00:00:00"),
    attemptCount: readInteger(attemptCountText, "AttemptCount", 0, 4294967295),
    attempts: attempts.sort((a, b) => a.id - b.id),
    segments: withLabels(segmentNodes.map((node) => parseSegment(version, node))),
  };
}
