"""Integer-nanosecond oracle over independently parsed XML and the same PRNG draws.

No application module is imported. Model parameters: last 30 attempts, widening
until each segment has 3 individual samples; 8,000 trials; 50-attempt lookahead.
Public files are read from the pinned existing corpus and hash-checked first.
"""

import argparse
import hashlib
import json
import math
import subprocess
import xml.etree.ElementTree as ET
from pathlib import Path

NANO = 10**9
MASK = 2**32 - 1


def nanos(text):
    if text is None or not text.strip():
        return None
    text = text.strip()
    negative = text.startswith("-")
    hours, minutes, seconds = text.lstrip("-").split(":")
    days, hours = hours.split(".") if "." in hours else ("0", hours)
    seconds, _, fraction = seconds.partition(".")
    if fraction[9:].strip("0"):
        raise ValueError("Sub-nanosecond input outside the oracle contract")
    result = (
        int(days) * 86400 + int(hours) * 3600 + int(minutes) * 60 + int(seconds)
    ) * NANO
    result += int(fraction[:9].ljust(9, "0"))
    return -result if negative else result


def rng(seed):
    a = seed & MASK
    while True:
        a = (a + 0x6D2B79F5) & MASK
        t = ((a ^ (a >> 15)) * (1 | a)) & MASK
        t = ((t + (((t ^ (t >> 7)) * (61 | t)) & MASK)) & MASK) ^ t
        yield ((t ^ (t >> 14)) & MASK) / 2**32


def seed(text):
    value = 2166136261
    raw = text.encode("utf-16-le")
    for i in range(0, len(raw), 2):
        value = ((value ^ int.from_bytes(raw[i : i + 2], "little")) * 16777619) & MASK
    return value


def oracle(xml, method, simulations):
    root = ET.fromstring(xml)
    version = tuple(int(v) for v in root.get("version", "1.0.0.0").split("."))
    version += (0,) * (4 - len(version))
    modern = version >= (1, 4, 1, 0)

    def time(element, selected=method):
        if element is None:
            return None
        return nanos(
            element.findtext(selected)
            if modern
            else element.text
            if selected == "RealTime"
            else None
        )

    nodes = (
        root.findall("AttemptHistory/Attempt")
        if version >= (1, 5, 0, 0)
        else root.findall("RunHistory/Time")
    )
    attempts = sorted(
        
            (
                int(a.attrib["id"]),
                time(a, "RealTime") is not None or time(a, "GameTime") is not None,
            )
            for a in nodes
        
    )
    segments = root.findall(".//Segment")
    histories = [
        {int(t.attrib["id"]): time(t) for t in s.findall("SegmentHistory/Time")}
        for s in segments
    ]
    own = [
        {
            id: value
            for id, value in h.items()
            if i == 0 or id not in histories[i - 1] or histories[i - 1][id] is not None
        }
        for i, h in enumerate(histories)
    ]
    ordinal = {id: i for i, (id, _) in enumerate(attempts)}
    needed = 30
    if len(attempts) > needed:
        for h in own:
            newest = sorted(
                (ordinal[id] for id, v in h.items() if v is not None and id in ordinal),
                reverse=True,
            )
            needed = max(
                needed, len(attempts) - newest[2] if len(newest) >= 3 else len(attempts)
            )
    window = attempts[-needed:]
    ids = {id for id, _ in window}
    furthest = {
        id: len(segments) - 1
        if finished
        else max((i for i, h in enumerate(histories) if id in h), default=-1)
        for id, finished in window
    }
    pbnode = (
        segments[-1].find("SplitTimes/SplitTime[@name='Personal Best']")
        if segments and version >= (1, 3, 0, 0)
        else segments[-1].find("PersonalBestSplitTime")
        if segments
        else None
    )
    pb = time(pbnode)
    pools = [
        [v for id, v in sorted(h.items()) if id in ids and v is not None] for h in own
    ]
    unknown = any(not done and furthest[id] >= len(segments) - 1 for id, done in window)
    if unknown or not segments or any(not p for p in pools):
        return {"unavailable": "history", "recentAttempts": len(window)}
    precision = (
        (pb is not None and abs(pb) > 2**20 * NANO)
        or any(abs(v) > 2**20 * NANO for p in pools for v in p)
        or sum(max(map(abs, p)) for p in pools) > 2**53 - 1
    )
    hazards = []
    for i in range(len(segments)):
        started = sum(furthest[id] >= i - 1 for id, _ in window)
        deaths = sum(not done and furthest[id] == i - 1 for id, done in window)
        hazards.append(deaths / started if started else 0)
    random = rng(
        seed(
            f"{root.findtext('GameName', '').strip()}|{root.findtext('CategoryName', '').strip()}|{root.findtext('AttemptCount', '0')}"
        )
    )
    finished = beat = 0
    for _ in range(simulations):
        total = 0
        for p, hazard in zip(pools, hazards):
            if next(random) < hazard:
                break
            total += p[math.floor(next(random) * len(p))]
        else:
            finished += 1
            beat += pb is not None and total < pb
    return {
        "pb": None if pb is None else pb / NANO,
        "recentAttempts": len(window),
        "finished": finished,
        "beats": beat if pb is not None else None,
        "simulations": simulations,
        "precisionUnavailable": precision,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkout", type=Path, required=True)
    ap.add_argument("--output", type=Path, required=True)
    ap.add_argument("--corpus", type=Path, required=True)
    ap.add_argument("--expect-corrected", action="store_true")
    args = ap.parse_args()
    here = Path(__file__).resolve().parent
    cases = []
    manifest = json.loads((here / "fixtures/manifest.json").read_text())
    for case in manifest["cases"]:
        file = here / "fixtures" / f"{case['id']}.lss"
        raw = file.read_bytes()
        assert hashlib.sha256(raw).hexdigest() == case["sha256"]
        cases.append(
            {
                "id": "constructed/" + case["id"],
                "xml": raw.decode(),
                "sha256": case["sha256"],
                "simulations": 8000,
            }
        )
    corpus_manifest = json.loads((args.corpus / "manifest.json").read_text())
    for repo in corpus_manifest["repos"]:
        for file in repo["files"]:
            raw = (
                args.corpus / "cache" / repo["repo"].replace("/", "_") / file["path"]
            ).read_bytes()
            assert hashlib.sha256(raw).hexdigest() == file["sha256"]
            cases.append(
                {
                    "id": repo["repo"] + "/" + file["path"],
                    "xml": raw.decode("utf-8-sig"),
                    "sha256": file["sha256"],
                    "simulations": 8000,
                }
            )
    payload = "".join(json.dumps(c) + "\n" for c in cases)
    command = [
        str(args.checkout / "node_modules/.bin/tsx"),
        str(args.checkout / "studies/pb-ties/analyze.ts"),
    ]
    proc = subprocess.run(
        command,
        input=payload,
        text=True,
        capture_output=True,
        check=True,
        cwd=args.checkout,
    )
    observed = [json.loads(line) for line in proc.stdout.splitlines()]
    assert len(observed) == len(cases)
    rows, differences, oracle_unavailable, rejected = [], [], [], []
    assumptions = None
    for case, out in zip(cases, observed):
        assert case["id"] == out["id"]
        if "error" in out:
            rejected.append({"id": out["id"], "error": out["error"]})
            continue
        for row in out["results"]:
            result = row["result"]
            if assumptions is None:
                assumptions = result["assumptions"]
            assert result["assumptions"] == assumptions
            result = {k: v for k, v in result.items() if k != "assumptions"}
            try:
                expected = oracle(case["xml"], row["method"], case["simulations"])
            except (ValueError, ET.ParseError, KeyError) as error:
                oracle_unavailable.append(
                    {"id": case["id"], "method": row["method"], "error": str(error)}
                )
                continue
            correct = result["recentAttempts"] == expected["recentAttempts"]
            if "unavailable" in expected or expected.get("precisionUnavailable"):
                correct &= (
                    result["insufficientData"]
                    and result["pbProbabilityPerAttempt"] is None
                )
            else:
                correct &= (
                    not result["insufficientData"]
                    and result["finishProbability"]
                    == expected["finished"] / case["simulations"]
                )
                correct &= result["pbProbabilityPerAttempt"] == (
                    None
                    if expected["beats"] is None
                    else expected["beats"] / case["simulations"]
                )
            item = {
                "id": case["id"],
                "method": row["method"],
                "sha256": case["sha256"],
                "oracle": expected,
                "result": result,
                "markdownSha256": hashlib.sha256(row["markdown"].encode()).hexdigest(),
                "correct": correct,
            }
            rows.append(item)
            if not correct:
                differences.append(
                    {k: item[k] for k in ["id", "method", "oracle", "result"]}
                )
    report = {
        "summary": {
            "files": len(cases),
            "forecasts": len(rows),
            "correct": len(rows) - len(differences),
            "differences": len(differences),
            "rejectedFiles": len(rejected),
            "oracleUnavailable": len(oracle_unavailable),
        },
        "assumptions": assumptions,
        "differences": differences,
        "rejected": rejected,
        "oracleUnavailable": oracle_unavailable,
        "rows": rows,
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps(report["summary"]))
    if args.expect_corrected:
        assert not differences and not oracle_unavailable


if __name__ == "__main__":
    main()
