"""Compare actual .lss inputs with compiled LiveSplit; audit selected sources in XML.

Requires the pinned corpus cache (../pb-odds-backtest/fetch.py), npm ci, and a
compiled oracle (build-oracle.sh). No package or algorithm is imported by Python.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

UPSTREAM = "fb62dd42505b16e813d2779468d81bbad7f01b5e"
EXCLUDED = {
    "SirCabby/splitSync/Test Data/Super Metroid blank.lss",
    "LiveSplit/livesplit-core/tests/run_files/livesplit_fuzz_crash.lss",
    "LiveSplit/livesplit-core/tests/run_files/livesplit_fuzz_crash_utf8.lss",
}


def seconds(text):
    if not text or not text.strip():
        return None
    text = text.strip()
    sign = -1 if text.startswith("-") else 1
    hours, minutes, secs = text.lstrip("-+").split(":")
    days, hours = hours.split(".") if "." in hours else (0, hours)
    return sign * (int(days) * 86400 + int(hours) * 3600 + int(minutes) * 60 + float(secs))


def near(a, b):
    return a is b if a is None or b is None else math.isclose(a, b, abs_tol=1e-7, rel_tol=1e-12)


def controlled_inputs(count):
    rng = random.Random(823561)
    def dual(parent, rt, gt):
        for method, value in [("RealTime", rt), ("GameTime", gt)]:
            if value is not None:
                # Integer 100 ns ticks, including zero and one-tick differences.
                ticks = value * 1_000_000 + rng.choice([0, 1, 2])
                secs, ticks = divmod(ticks, 10_000_000)
                Sub = ET.SubElement(parent, method)
                Sub.text = f"00:{secs // 60:02d}:{secs % 60:02d}.{ticks:07d}"
    for case in range(count):
        root = ET.Element("Run", version="1.8.0")
        ET.SubElement(root, "GameIcon")
        for tag, text in [("GameName", "Constructed path control"), ("CategoryName", str(case)),
                          ("Offset", "-00:00:05"), ("AttemptCount", "0")]:
            ET.SubElement(root, tag).text = text
        ET.SubElement(root, "AttemptHistory")
        segments = ET.SubElement(root, "Segments")
        pb = [0, 0]
        for i in range(rng.randrange(1, 13)):
            seg = ET.SubElement(segments, "Segment")
            ET.SubElement(seg, "Icon")
            ET.SubElement(seg, "Name").text = f"Segment {i + 1}"
            pb = [value + rng.randrange(0, 150) for value in pb]
            dual(ET.SubElement(ET.SubElement(seg, "SplitTimes"), "SplitTime", name="Personal Best"),
                 *[value if rng.random() < .7 else None for value in pb])
            dual(ET.SubElement(seg, "BestSegmentTime"),
                 *[rng.randrange(0, 180) if rng.random() < .7 else None for _ in range(2)])
            history = ET.SubElement(seg, "SegmentHistory")
            for attempt in [-3, 0, 2, 8, 19]:
                if rng.random() < .7:
                    dual(ET.SubElement(history, "Time", id=str(attempt)),
                         *[rng.randrange(0, 300) if rng.random() < .5 else None for _ in range(2)])
        yield {"id": f"controlled/{case:04}", "xml": ET.tostring(root, encoding="unicode")}


def verify_sources(xml, result):
    root = ET.fromstring(xml)
    version = tuple((list(map(int, root.get("version", "1").split("."))) + [0] * 4)[:4])
    segments = root.findall("Segments/Segment")
    key = "realTime" if result["method"] == "RealTime" else "gameTime"
    def dual(node):
        if node is None:
            return None
        return {"realTime": seconds(node.text) if version < (1, 4, 1, 0) else seconds(node.findtext("RealTime")),
                "gameTime": None if version < (1, 4, 1, 0) else seconds(node.findtext("GameTime"))}
    def pb(i):
        if version < (1, 3, 0, 0):
            return dual(segments[i].find("PersonalBestSplitTime"))
        return dual(next((node for node in segments[i].findall("SplitTimes/SplitTime")
                          if node.get("name") == "Personal Best"), None))
    def value(item):
        return None if item is None else item[key]
    def history(i, attempt):
        return dual(next((node for node in segments[i].findall("SegmentHistory/Time")
                          if int(node.get("id")) == attempt), None))
    golds = [value(dual(seg.find("BestSegmentTime"))) for seg in segments]
    expected_gold_sum = sum(golds) if golds and all(g is not None for g in golds) else None
    assert near(result["goldSumSeconds"], expected_gold_sum)
    if result["totalSeconds"] is None:
        assert result["legs"] == [] and result["evidence"] == []
        return 0
    boundary = 0
    total = 0
    for leg, evidence in zip(result["legs"], result["evidence"], strict=True):
        start, end = leg["from"], leg["to"]
        assert start == boundary and start < end <= len(segments)
        source = leg["source"]
        if source["kind"] == "gold":
            assert end == start + 1
            duration = golds[start]
            rows = [(start, "BestSegmentTime", None, dual(segments[start].find("BestSegmentTime")))]
        elif source["kind"] == "history":
            attempt = source["attemptId"]
            rows = [(i, "SegmentHistory", attempt, history(i, attempt)) for i in range(start, end)]
            assert all(row[3] is not None for row in rows)
            assert all(value(row[3]) is None for row in rows[:-1])
            assert start == 0 or history(start - 1, attempt) is None or value(history(start - 1, attempt)) is not None
            duration = value(rows[-1][3])
        else:
            assert source["kind"] == "personal-best"
            before = 0 if start == 0 else value(pb(start - 1))
            after = value(pb(end - 1))
            assert before is not None and after is not None
            assert all(value(pb(i)) is None for i in range(start, end - 1))
            duration = after - before
            assert near(source["startSeconds"], before) and near(source["endSeconds"], after)
            rows = [(i, "SplitTimes/Personal Best", None, pb(i)) for i in range(max(0, start - 1), end)]
        assert duration is not None and near(duration, leg["seconds"])
        assert len(evidence) == len(rows)
        for actual, (i, field, attempt, time) in zip(evidence, rows, strict=True):
            assert (actual["segmentIndex"], actual["field"], actual["attemptId"]) == (i, field, attempt)
            if time is None:
                assert actual["time"] is None
            else:
                assert all(near(actual["time"][k], v) for k, v in time.items())
        boundary = end
        total += duration
    assert boundary == len(segments) and near(total, result["totalSeconds"])
    return len(result["legs"])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--oracle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--controls", type=int, default=1000)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    manifest = json.loads(Path("studies/pb-odds-backtest/manifest.json").read_text())
    inputs = []
    for repo in manifest["repos"]:
        for file in repo["files"]:
            path = Path("studies/pb-odds-backtest/cache") / repo["repo"].replace("/", "_") / file["path"]
            raw = path.read_bytes()
            assert hashlib.sha256(raw).hexdigest() == file["sha256"], path
            encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
            inputs.append({"id": f'{repo["repo"]}/{file["path"]}', "xml": raw.decode(encoding)})
    public_count = len(inputs)
    inputs.append({"id": "controlled/combined-best", "xml": Path("tests/fixtures/combined-best.lss").read_text()})
    inputs.extend(controlled_inputs(args.controls))
    assert len({row["id"] for row in inputs}) == len(inputs)
    source = "".join(json.dumps(row, ensure_ascii=True) + "\n" for row in inputs)
    input_path = args.out / "inputs.jsonl"
    input_path.write_text(source)
    outputs = []
    for name, command in [("upstream", [str(args.oracle.resolve())]),
                          ("splitscope", ["node", "--import", "tsx", "studies/sum-of-best/analyze.ts"])]:
        with input_path.open() as stdin, (args.out / f"{name}.jsonl").open("w") as stdout:
            subprocess.run(command, stdin=stdin, stdout=stdout, check=True)
        rows = [json.loads(line) for line in (args.out / f"{name}.jsonl").read_text().splitlines()]
        assert [row["id"] for row in rows] == [row["id"] for row in inputs], name
        outputs.append(rows)
    changed = []
    counts = {"publicFiles": public_count, "excludedFiles": len(EXCLUDED),
              "controlledFiles": args.controls + 1, "comparisons": 0, "boundaries": 0, "sourceLegs": 0}
    errors = []
    for source_row, ref, got in zip(inputs, *outputs, strict=True):
        identifier = source_row["id"]
        if identifier in EXCLUDED:
            assert "error" in got, identifier
            errors.append({"id": identifier, "splitscope": got.get("error"), "upstream": ref.get("error")})
            continue
        assert "error" not in ref and "error" not in got, (identifier, ref.get("error"), got.get("error"))
        assert [x["method"] for x in got["results"]] == ["RealTime", "GameTime"]
        for expected, actual in zip(ref["results"], got["results"], strict=True):
            assert expected["method"] == actual["method"]
            assert near(expected["total"], actual["totalSeconds"]), (identifier, expected, actual)
            assert len(expected["boundaries"]) == len(actual["boundaries"])
            for old, new in zip(expected["boundaries"], actual["boundaries"], strict=True):
                assert near(None if old is None else old["seconds"], new), (identifier, old, new)
                counts["boundaries"] += 1
            counts["comparisons"] += 1
            try:
                counts["sourceLegs"] += verify_sources(source_row["xml"], actual)
            except AssertionError as error:
                raise AssertionError((identifier, actual["method"], "source evidence")) from error
            if not identifier.startswith("controlled/") and not near(actual["goldSumSeconds"], expected["total"]):
                changed.append({"id": identifier, "method": actual["method"],
                    "goldSumSeconds": actual["goldSumSeconds"], "sumOfBestSeconds": expected["total"],
                    "combinedHistoryLegs": [leg for leg in actual["legs"] if leg["source"]["kind"] == "history"]})
    summary = {"upstreamCommit": UPSTREAM, "counts": counts, "disagreements": 0,
               "changedPublicResults": len(changed), "exclusions": errors, "changes": changed}
    (args.out / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k not in ("exclusions", "changes")}, indent=2))


if __name__ == "__main__":
    main()
