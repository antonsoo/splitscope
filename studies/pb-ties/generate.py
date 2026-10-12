import hashlib
import json
import random
import xml.etree.ElementTree as E
from pathlib import Path

root = Path(__file__).resolve().parent
N = 10**9


def stamp(v):
    sign = "-" if v < 0 else ""
    sec, nano = divmod(abs(v), N)
    hour, sec = divmod(sec, 3600)
    minute, sec = divmod(sec, 60)
    return f"{sign}{hour:02}:{minute:02}:{sec:02}.{nano:09}"


def fixture(name, pools, pb, reset=0, offset=0, other=None):
    r = E.Element("Run", version="1.8.1")
    for k, v in [
        ("GameName", "Synthetic PB comparison"),
        ("CategoryName", name),
        ("Offset", stamp(offset)),
        ("AttemptCount", 3 + reset),
    ]:
        E.SubElement(r, k).text = str(v)
    a = E.SubElement(r, "AttemptHistory")
    for i in range(1, 4 + reset):
        at = E.SubElement(a, "Attempt", id=str(i))
        if i <= 3:
            for method in ["RealTime", "GameTime"]:
                E.SubElement(at, method).text = stamp(sum(p[i - 1] for p in pools))
    s = E.SubElement(r, "Segments")
    cum = 0
    for j, pool in enumerate(pools):
        seg = E.SubElement(s, "Segment")
        E.SubElement(seg, "Name").text = f"Segment {j + 1}"
        cum += pool[0]
        splits = E.SubElement(
            E.SubElement(seg, "SplitTimes"), "SplitTime", name="Personal Best"
        )
        gold = E.SubElement(seg, "BestSegmentTime")
        for method in ["RealTime", "GameTime"]:
            E.SubElement(splits, method).text = stamp(
                pb if j == len(pools) - 1 else cum
            )
            E.SubElement(gold, method).text = stamp(min(pool))
        hist = E.SubElement(seg, "SegmentHistory")
        for i, v in enumerate(pool, 1):
            t = E.SubElement(hist, "Time", id=str(i))
            for method in ["RealTime", "GameTime"]:
                E.SubElement(t, method).text = stamp(v)
    xml = E.tostring(r, encoding="unicode")
    (root / "fixtures" / f"{name}.lss").write_text(xml)
    return {
        "id": name,
        "sha256": hashlib.sha256(xml.encode()).hexdigest(),
        "bytes": len(xml.encode()),
        "expected": other,
    }


records = []
a, b = 120300000000, 120600000000
for delta, label in [
    (0, "exact-tie"),
    (100, "one-tick-faster"),
    (-100, "one-tick-slower"),
    (1, "one-nanosecond-faster"),
    (-1, "one-nanosecond-slower"),
]:
    records.append(
        fixture(
            label,
            [[a] * 3, [b] * 3],
            a + b + delta,
            other={"pbProbability": int(delta > 0), "finishProbability": 1},
        )
    )
records.append(
    fixture(
        "negative-offset-tie",
        [[-6000000000] * 3, [15600000000] * 3],
        9600000000,
        offset=-10000000000,
        other={"pbProbability": 0, "finishProbability": 1},
    )
)
records.append(
    fixture(
        "mixed-ties",
        [[a - 100, a, a + 100], [b] * 3],
        a + b,
        other={"exactPbProbability": "1/3", "finishProbability": 1},
    )
)
records.append(
    fixture(
        "mixed-with-resets",
        [[a - 100, a, a + 100], [b] * 3],
        a + b,
        reset=3,
        other={"exactPbProbability": "1/6", "exactFinishProbability": "1/2"},
    )
)
for name, seconds in [("many-segments", 120300000000), ("day-crossing", 120600000000)]:
    pools = [[seconds] * 3 for _ in range(720)]
    records.append(
        fixture(
            name,
            pools,
            seconds * 720,
            other={"pbProbability": 0, "finishProbability": 1},
        )
    )
for delta, label in [
    (0, "precision-boundary-tie"),
    (-1, "precision-boundary-faster"),
    (1, "precision-boundary-slower"),
]:
    records.append(
        fixture(
            label,
            [[2**20 * N - 1] * 3, [delta] * 3],
            2**20 * N - 1,
            other={"pbProbability": int(delta < 0), "finishProbability": 1},
        )
    )
records.append(
    fixture(
        "cancellation-tie",
        [[-(2**19) * N] * 3, [2**19 * N + 300000000] * 3],
        300000000,
        offset=-(2**19) * N,
        other={"pbProbability": 0, "finishProbability": 1},
    )
)
# Longer than the nanosecond recovery bound; cannot safely infer the raw ns from doubles.
records.append(
    fixture(
        "precision-unavailable",
        [[2**20 * N + N] * 3],
        2**20 * N + N,
        other={"unavailable": "precision"},
    )
)
# Individual values are within range, but the absolute sum would exceed safe integer ns.
records.append(
    fixture(
        "sum-unavailable",
        [[10**15] * 3 for _ in range(10)],
        0,
        other={"unavailable": "precision"},
    )
)
rng = random.Random(53261)
for i in range(60):
    pools = [[rng.randrange(1, 10000) * 10**6] * 3 for _ in range(rng.randrange(2, 50))]
    total = sum(p[0] for p in pools)
    delta = [0, 1, -1][i % 3]
    records.append(
        fixture(
            f"grid-{i:02}",
            pools,
            total + delta,
            other={"pbProbability": int(delta > 0), "finishProbability": 1},
        )
    )
(root / "fixtures" / "manifest.json").write_text(
    json.dumps(
        {
            "synthetic": True,
            "description": "Constructed recorded-time controls; no observed gameplay. Integer nanoseconds generate XML independently of the app.",
            "cases": records,
        },
        indent=2,
    )
    + "\n"
)
print(len(records))
