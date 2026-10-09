"""Check the practice comparison against raw XML using only Python's standard library.

Run from the repository root after fetching the pinned pb-odds-backtest corpus:
  python3 studies/practice-review/verify.py --out /tmp/practice-review

The oracle does not import splitscope, reuse its reset analysis, or synthesize
its expected values from TypeScript results. Native output is retained for audit.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path


def seconds(text):
    if text is None or not text.strip():
        return None
    text = text.strip()
    sign = -1 if text.startswith("-") else 1
    text = text.lstrip("-+")
    hours, minutes, secs = text.split(":")
    days = 0
    if "." in hours:
        days, hours = hours.split(".")
    return sign * (
        int(days) * 86400 + int(hours) * 3600 + int(minutes) * 60 + float(secs)
    )


def times(node, version):
    if node is None:
        return {"realTime": None, "gameTime": None}
    if version < (1, 4, 1, 0):
        return {"realTime": seconds(node.text), "gameTime": None}
    return {
        "realTime": seconds(node.findtext("RealTime")),
        "gameTime": seconds(node.findtext("GameTime")),
    }


def read_run(raw):
    root = ET.fromstring(raw)
    version = tuple(
        (list(map(int, root.attrib.get("version", "1").split("."))) + [0] * 4)[:4]
    )
    nodes = (
        root.findall("AttemptHistory/Attempt")
        if version >= (1, 5, 0, 0)
        else root.findall("RunHistory/Time")
    )
    attempts = sorted((int(node.attrib["id"]), times(node, version)) for node in nodes)
    segments = root.findall("Segments/Segment")
    history = [
        {
            int(node.attrib["id"]): times(node, version)
            for node in segment.findall("SegmentHistory/Time")
        }
        for segment in segments
    ]
    pbs = []
    for segment in segments:
        if version < (1, 3, 0, 0):
            pb = segment.find("PersonalBestSplitTime")
        else:
            pb = next(
                (
                    node
                    for node in segment.findall("SplitTimes/SplitTime")
                    if node.attrib.get("name") == "Personal Best"
                ),
                None,
            )
        pbs.append(times(pb, version))
    return attempts, history, pbs


def outcomes(attempts, history):
    rows = []
    for ordinal, (attempt_id, total) in enumerate(attempts, 1):
        recorded = [i for i, segment in enumerate(history) if attempt_id in segment]
        last = max(recorded, default=-1)
        finished = any(value is not None for value in total.values())
        reset = None if finished or last == len(history) - 1 else last + 1
        rows.append(
            {
                "id": attempt_id,
                "ordinal": ordinal,
                "total": total,
                "outcome": "completed"
                if finished
                else "unknown"
                if reset is None
                else "inferred-reset",
                "last": None if last < 0 else last,
                "reset": reset,
            }
        )
    return rows


def oracle_group(rows, n_segments, method):
    key = "realTime" if method == "RealTime" else "gameTime"
    totals = [
        row["total"][key]
        for row in rows
        if row["outcome"] == "completed" and row["total"][key] is not None
    ]
    segments = []
    for i in range(n_segments):
        started = sum(row["reset"] is None or row["reset"] >= i for row in rows)
        resets = sum(row["reset"] == i for row in rows)
        segments.append(
            {
                "started": started,
                "resets": resets,
                "resetRate": resets / started if started else None,
            }
        )
    return {
        "completed": sum(row["outcome"] == "completed" for row in rows),
        "inferredResets": sum(row["outcome"] == "inferred-reset" for row in rows),
        "unknown": sum(row["outcome"] == "unknown" for row in rows),
        "timedCompletions": len(totals),
        "bestCompletion": min(totals, default=None),
        "medianCompletion": statistics.median(totals) if totals else None,
        "segments": segments,
    }


def oracle_records(attempt_id, method, history, pbs):
    key = "realTime" if method == "RealTime" else "gameTime"
    records = []
    for i, segment in enumerate(history):
        stored = segment.get(attempt_id)
        value = stored[key] if stored is not None else None
        combined_from = None
        if value is not None:
            j = i - 1
            while (
                j >= 0
                and attempt_id in history[j]
                and history[j][attempt_id][key] is None
            ):
                combined_from = j
                j -= 1
        kind = (
            "missing"
            if stored is None
            else "untimed"
            if value is None
            else "combined"
            if combined_from is not None
            else "timed"
        )
        current = pbs[i][key]
        previous = 0 if i == 0 else pbs[i - 1][key]
        pb_duration = (
            current - previous if current is not None and previous is not None else None
        )
        delta = (
            value - pb_duration if kind == "timed" and pb_duration is not None else None
        )
        records.append(
            {
                "segmentIndex": i,
                "recordedTime": stored,
                "kind": kind,
                "seconds": value,
                "combinedFrom": combined_from,
                "deltaToCurrentPb": delta,
            }
        )
    return records


def same(actual, expected, label):
    if isinstance(expected, dict):
        assert actual.keys() == expected.keys(), (label, actual.keys(), expected.keys())
        for key in expected:
            same(actual[key], expected[key], f"{label}.{key}")
    elif isinstance(expected, list):
        assert len(actual) == len(expected), (label, len(actual), len(expected))
        for i, (a, e) in enumerate(zip(actual, expected, strict=True)):
            same(a, e, f"{label}[{i}]")
    elif isinstance(expected, float):
        assert isinstance(actual, (int, float)) and math.isclose(
            actual, expected, rel_tol=1e-12, abs_tol=1e-9
        ), (label, actual, expected)
    else:
        assert actual == expected, (label, actual, expected)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest_path = Path("studies/pb-odds-backtest/manifest.json")
    manifest = json.loads(manifest_path.read_text())
    files = {}
    for repo in manifest["repos"]:
        for file in repo["files"]:
            filename = (
                manifest_path.parent
                / "cache"
                / repo["repo"].replace("/", "_")
                / file["path"]
            )
            raw = filename.read_bytes()
            assert hashlib.sha256(raw).hexdigest() == file["sha256"], filename
            files[f"{repo['repo']}/{file['path']}"] = raw
    started_at = time.perf_counter()
    with (args.out / "native.jsonl").open("w") as output:
        subprocess.run(
            [
                "node",
                "--import",
                "tsx",
                "studies/practice-review/analyze.ts",
                str(manifest_path),
            ],
            stdout=output,
            check=True,
        )
    groups = inspections = segment_records = attempts = 0
    kinds = {kind: 0 for kind in ["timed", "combined", "untimed", "missing"]}
    excluded = []
    expected_exclusions = {
        "SirCabby/splitSync/Test Data/Super Metroid blank.lss",
        "LiveSplit/livesplit-core/tests/run_files/livesplit_fuzz_crash.lss",
        "LiveSplit/livesplit-core/tests/run_files/livesplit_fuzz_crash_utf8.lss",
    }
    checked = set()
    for line in (args.out / "native.jsonl").open():
        result = json.loads(line)
        file_id = result["id"]
        assert file_id not in checked and file_id in files, file_id
        checked.add(file_id)
        if "error" in result:
            assert file_id in expected_exclusions, (
                "Unexpected parse failure",
                file_id,
                result["error"],
            )
            excluded.append({"file": file_id, "error": result["error"]})
            continue
        records, history, pbs = read_run(files[file_id])
        rows = outcomes(records, history)
        attempts += len(rows)
        expected_configs = [
            (size, end, method)
            for size, end in [(30, len(rows)), (17, len(rows) // 2)]
            for method in ["RealTime", "GameTime"]
        ]
        assert [
            (c["window"], c["endOrdinal"], c["method"]) for c in result["comparisons"]
        ] == expected_configs, ("Missing comparison", file_id)
        for comparison in result["comparisons"]:
            end = comparison["endOrdinal"]
            size = comparison["window"]
            start = max(0, end - size)
            for side, expected_rows in [
                ("recent", rows[start:end]),
                ("previous", rows[max(0, start - size) : start]),
            ]:
                actual = comparison[side].copy()
                native_rows = actual.pop("attempts")
                same(
                    [
                        {
                            "id": row["attempt"]["id"],
                            "ordinal": row["ordinal"],
                            "total": row["attempt"]["time"],
                            "outcome": row["outcome"],
                            "last": row["lastRecordedSegment"],
                            "reset": row["inferredResetSegment"],
                        }
                        for row in native_rows
                    ],
                    expected_rows,
                    file_id,
                )
                same(
                    actual,
                    oracle_group(expected_rows, len(history), comparison["method"]),
                    file_id,
                )
                groups += 1
        expected_inspections = [
            (row["id"], method)
            for row in rows[-60:]
            for method in ["RealTime", "GameTime"]
        ]
        assert [
            (item["id"], item["method"]) for item in result["inspections"]
        ] == expected_inspections, ("Missing inspection", file_id)
        for inspection in result["inspections"]:
            expected = oracle_records(
                inspection["id"], inspection["method"], history, pbs
            )
            same(inspection["records"], expected, file_id)
            inspections += 1
            segment_records += len(expected)
            for record in expected:
                kinds[record["kind"]] += 1
    assert checked == files.keys(), "Missing or extra file results"
    assert {item["file"] for item in excluded} == expected_exclusions, (
        "Changed exclusion set"
    )
    summary = {
        "manifestSha256": hashlib.sha256(manifest_path.read_bytes()).hexdigest(),
        "inputFilesHashVerified": len(files),
        "acceptedFiles": len(files) - len(excluded),
        "excludedFiles": excluded,
        "recordedAttempts": attempts,
        "groupsChecked": groups,
        "attemptInspectionsChecked": inspections,
        "segmentRecordsChecked": segment_records,
        "recordKinds": kinds,
        "disagreements": 0,
        "seconds": round(time.perf_counter() - started_at, 3),
        "sourceSha256": {
            str(p): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in [
                Path("src/core/review.ts"),
                Path("src/core/stats.ts"),
                Path("src/core/parser.ts"),
            ]
        },
    }
    (args.out / "verification.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
