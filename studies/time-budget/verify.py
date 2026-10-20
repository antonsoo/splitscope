"""Independent XML/datetime accounting, plus the compiled upstream parser.

No Splitscope implementation is imported into the expectations. Inputs are the
pinned public corpus and clearly authored native-writer controls. Large per-run
results remain in --out; only the audit summary is checked into the repository.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import subprocess
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
STUDY = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "raw_practice", ROOT / "studies/practice-review/verify.py"
)
raw_practice = importlib.util.module_from_spec(spec)
spec.loader.exec_module(raw_practice)


def digest(raw):
    return hashlib.sha256(raw).hexdigest()


def parse_stamp(text):
    if text is None:
        return None
    try:
        return datetime.strptime(text.strip(), "%m/%d/%Y %H:%M:%S").replace(
            tzinfo=timezone.utc
        )
    except ValueError:
        return None


def clocks_from_xml(raw):
    root = ET.fromstring(raw)
    result, dates = {}, {}
    version = tuple(
        (list(map(int, root.attrib.get("version", "1").split("."))) + [0] * 4)[:4]
    )
    nodes = (
        root.findall("AttemptHistory/Attempt")
        if version >= (1, 5, 0, 0)
        else root.findall("RunHistory/Time")
    )
    for node in sorted(nodes, key=lambda a: int(a.attrib["id"])):
        aid = int(node.attrib["id"])
        start, end = node.get("started"), node.get("ended")
        a, b = parse_stamp(start), parse_stamp(end)
        status = (
            "missing"
            if start is None or end is None
            else "invalid"
            if a is None or b is None
            else "reversed"
            if b < a
            else "recorded"
        )
        result[aid] = {
            "attemptId": aid,
            "status": status,
            "elapsedSeconds": int((b - a).total_seconds())
            if status == "recorded"
            else None,
            "synchronized": node.get("isStartedSynced") == "True"
            and node.get("isEndedSynced") == "True",
            "overlap": None,
        }
        if status == "recorded" and b > a:
            dates[aid] = (a, b, start, end)
    # Independent overlap determination: start/end events, ending intervals removed
    # before starts at the same instant. Every witness must be a real intersecting interval.
    events = sorted(
        [(a, 1, aid) for aid, (a, b, _, _) in dates.items()]
        + [(b, 0, aid) for aid, (a, b, _, _) in dates.items()]
    )
    active = set()
    overlaps = set()
    for _, kind, aid in events:
        if not kind:
            active.remove(aid)
        else:
            if active:
                overlaps.add(aid)
                overlaps.update(active)
            active.add(aid)
    return result, dates, overlaps


def check_clocks(actual, expected, dates, overlaps):
    assert len(actual) == len(expected)
    assert [c["attemptId"] for c in actual] == list(expected)
    for value in actual:
        aid = value["attemptId"]
        assert {k: v for k, v in value.items() if k != "overlap"} == {
            k: v for k, v in expected[aid].items() if k != "overlap"
        }, (aid, value, expected[aid])
        witness = value["overlap"]
        assert (witness is not None) == (aid in overlaps), (aid, witness)
        if witness:
            other = witness["attemptId"]
            assert other != aid and other in dates
            a, b, start, end = dates[other]
            assert witness["started"] == start and witness["ended"] == end
            assert max(a, dates[aid][0]) < min(b, dates[aid][1])


def budget(rows, expected, overlaps):
    clocks = [expected[row["id"]] for row in rows]
    measured = [c for c in clocks if c["status"] == "recorded"]
    missing = Counter(c["status"] for c in clocks if c["status"] != "recorded")
    seconds = sum(c["elapsedSeconds"] for c in measured)
    in_range = seconds <= 2**53 - 1
    return {
        "attempts": len(rows),
        "timedAttempts": len(measured),
        "elapsedSeconds": seconds if measured and in_range else None,
        "sumStatus": "unavailable"
        if not measured
        else "available"
        if in_range
        else "out-of-range",
        "unavailable": {
            key: missing[key] for key in ["missing", "invalid", "reversed"]
        },
        "unsynchronizedAttempts": sum(not c["synchronized"] for c in measured),
        "overlappingAttempts": sum(c["attemptId"] in overlaps for c in measured),
    }


def check_group(actual, rows, segments, expected, dates, overlaps):
    partitions = {
        "total": rows,
        "completed": [r for r in rows if r["outcome"] == "completed"],
        "inferredResets": [r for r in rows if r["outcome"] == "inferred-reset"],
        "unknown": [r for r in rows if r["outcome"] == "unknown"],
    }
    for key, subset in partitions.items():
        assert actual[key] == budget(subset, expected, overlaps), (
            key,
            actual[key],
            budget(subset, expected, overlaps),
        )
    assert len(actual["byResetSegment"]) == segments
    for i, value in enumerate(actual["byResetSegment"]):
        subset = [r for r in rows if r["reset"] == i]
        assert value == budget(subset, expected, overlaps), (i, value, subset)
    check_clocks(
        actual["clocks"], {r["id"]: expected[r["id"]] for r in rows}, dates, overlaps
    )
    # Exact partition invariants over native integer-second timestamps.
    for field in [
        "attempts",
        "timedAttempts",
        "unsynchronizedAttempts",
        "overlappingAttempts",
    ]:
        assert actual["total"][field] == sum(
            actual[k][field] for k in ["completed", "inferredResets", "unknown"]
        )
    assert actual["inferredResets"]["timedAttempts"] == sum(
        s["timedAttempts"] for s in actual["byResetSegment"]
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument(
        "--oracle",
        type=Path,
        default=STUDY
        / "cache/livesplit-core-fb62dd42505b16e813d2779468d81bbad7f01b5e/target/release/examples/practice_clock",
    )
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads((ROOT / "studies/pb-odds-backtest/manifest.json").read_text())
    entries = []
    originals = {}
    for repo in manifest["repos"]:
        for item in repo["files"]:
            path = (
                ROOT
                / "studies/pb-odds-backtest/cache"
                / repo["repo"].replace("/", "_")
                / item["path"]
            )
            raw = path.read_bytes()
            assert len(raw) == item["bytes"] and digest(raw) == item["sha256"], path
            key = repo["repo"] + "/" + item["path"]
            originals[key] = raw
            entries.append({"id": key, "path": str(path)})
    for path in sorted((STUDY / "controls").glob("*.lss")):
        key = "authored/" + path.name
        originals[key] = path.read_bytes()
        entries.append({"id": key, "path": str(path)})
    assert entries and any(e["id"].startswith("authored/") for e in entries)
    target = args.out / "implementation.jsonl"
    with target.open("w") as output:
        subprocess.run(
            ["node", "--import", "tsx", str(STUDY / "analyze.ts")],
            input=json.dumps(entries),
            text=True,
            stdout=output,
            check=True,
            cwd=ROOT,
        )
    actual = [json.loads(line) for line in target.read_text().splitlines()]
    assert [r["id"] for r in actual] == [e["id"] for e in entries]
    good = [r for r in actual if "error" not in r]
    rejected = [r for r in actual if "error" in r]
    for row in rejected:
        assert row["id"] in {
            "SirCabby/splitSync/Test Data/Super Metroid blank.lss",
            "LiveSplit/livesplit-core/tests/run_files/livesplit_fuzz_crash.lss",
            "LiveSplit/livesplit-core/tests/run_files/livesplit_fuzz_crash_utf8.lss",
        }, row
    counts = Counter()
    anomalies = []
    reference_packets = []
    for result in good:
        raw = originals[result["id"]]
        assert result["sha256"] == digest(raw)
        expected, dates, overlaps = clocks_from_xml(raw)
        check_clocks(result["clocks"], expected, dates, overlaps)
        attempts, history, _ = raw_practice.read_run(raw)
        outcomes = raw_practice.outcomes(attempts, history)
        for group in result["groups"]:
            end, window = group["end"], group["window"]
            start = max(0, end - window)
            check_group(
                group["recent"],
                outcomes[start:end],
                len(history),
                expected,
                dates,
                overlaps,
            )
            check_group(
                group["previous"],
                outcomes[max(0, start - window) : start],
                len(history),
                expected,
                dates,
                overlaps,
            )
            counts["cohort_pairs"] += 1
        for clock in result["clocks"]:
            counts["attempts"] += 1
            counts[clock["status"]] += 1
            if clock["status"] != "recorded":
                anomalies.append({"id": result["id"], **clock})
        reference_packets.append(
            json.dumps(
                {
                    "id": result["id"],
                    "xml": raw.decode("utf-8-sig")
                    if raw[:2] not in [b"\xff\xfe", b"\xfe\xff"]
                    else raw.decode("utf-16"),
                }
            )
        )
    with (args.out / "upstream.jsonl").open("w") as output:
        subprocess.run(
            [str(args.oracle.resolve())],
            input="\n".join(reference_packets) + "\n",
            text=True,
            stdout=output,
            check=True,
        )
    reference = [
        json.loads(line)
        for line in (args.out / "upstream.jsonl").read_text().splitlines()
    ]
    assert [r["id"] for r in reference] == [r["id"] for r in good]
    for result, upstream in zip(good, reference, strict=True):
        # Authored invalid dates can be rejected by the reference parser. Real
        # corpus and unmodified native writer output must remain parseable.
        assert "error" not in upstream, upstream
        by_id = {a["id"]: a for a in upstream["attempts"]}
        assert set(by_id) == {c["attemptId"] for c in result["clocks"]}
        for value in result["clocks"]:
            native = by_id[value["attemptId"]]
            if value["status"] == "recorded":
                assert (
                    native["endUnix"] - native["startUnix"] == value["elapsedSeconds"]
                )
                assert native["durationSeconds"] == value["elapsedSeconds"]
                assert native["synchronized"] == value["synchronized"]
                counts["compiled_clock_matches"] += 1
    summary = {
        "publicFiles": len(entries) - 1,
        "authoredNativeFiles": 1,
        "accepted": len(good),
        "rejected": rejected,
        "checks": dict(counts),
        "unavailableClocks": anomalies,
        "reference": {
            "repository": "LiveSplit/livesplit-core",
            "commit": "fb62dd42505b16e813d2779468d81bbad7f01b5e",
            "method": "compiled parser and Attempt::duration; compare only available, nonnegative timestamp pairs",
        },
    }
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(
        json.dumps(
            {
                k: v
                for k, v in summary.items()
                if k not in ["unavailableClocks", "rejected"]
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
