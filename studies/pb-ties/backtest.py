"""Compare the existing walk-forward study's outputs, holding every draw fixed."""

import argparse
import hashlib
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("before", type=Path)
parser.add_argument("after", type=Path)
parser.add_argument("output", type=Path)
args = parser.parse_args()
before = json.loads(args.before.read_text())
after = json.loads(args.after.read_text())
assert before["files"] == after["files"]
assert before["skipped"] == after["skipped"]
assert len(before["rows"]) == len(after["rows"])
changes = []
for old, new in zip(before["rows"], after["rows"]):
    assert {k: v for k, v in old.items() if k != "pOne"} == {
        k: v for k, v in new.items() if k != "pOne"
    }
    if old["pOne"] != new["pOne"]:
        changes.append(
            {
                "file": before["files"][old["file"]],
                "k": old["k"],
                "pb": old["pb"],
                "before": old["pOne"],
                "after": new["pOne"],
                "outcomes": {k: old[k] for k in ("y1", "y10", "y50")},
            }
        )
horizons = []
for horizon in (1, 10, 50):
    scores = []
    for version in (before, after):
        rows = [r for r in version["rows"] if r[f"y{horizon}"] is not None]
        forecast = [1 - (1 - r["pOne"]) ** horizon for r in rows]
        outcome = [r[f"y{horizon}"] for r in rows]
        scores.append(
            {
                "windows": len(rows),
                "meanForecast": sum(forecast) / len(rows),
                "observedFrequency": sum(outcome) / len(rows),
                "brier": sum((p - y) ** 2 for p, y in zip(forecast, outcome))
                / len(rows),
            }
        )
    horizons.append({"attemptsAhead": horizon, "before": scores[0], "after": scores[1]})
report = {
    "description": "Paired replays at 5,000 simulations per stopping point; current adaptive window in both versions. Descriptive point estimates only. Overlapping windows are not independent observations. No new tuning or calibration claim.",
    "histories": len(before["files"]),
    "forecasts": len(before["rows"]),
    "changedForecasts": len(changes),
    "unchangedOtherFields": True,
    "skipped": before["skipped"],
    "inputSha256": {
        label: hashlib.sha256(file.read_bytes()).hexdigest()
        for label, file in [("before", args.before), ("after", args.after)]
    },
    "horizons": horizons,
    "changes": changes,
}
args.output.write_text(json.dumps(report, indent=2) + "\n")
print(
    json.dumps(
        {
            k: report[k]
            for k in ["histories", "forecasts", "changedForecasts", "horizons"]
        },
        indent=2,
    )
)
