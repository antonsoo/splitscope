"""Scoring helpers: Brier score, Murphy decomposition, reliability bins, cluster bootstrap."""
import hashlib
import json
import glob
import random

BINS = [0, 0.01, 0.02, 0.05, 0.10, 0.20, 0.40, 0.70, 1.0000001]


def split_assignment(manifest_path):
    """Dev / held-out split by runner, fixed by hash of the repo name before any scoring."""
    repos = [r["repo"] for r in json.load(open(manifest_path))["repos"]]
    order = sorted(range(len(repos)), key=lambda i: hashlib.sha256(("splitscope-pb-backtest|" + repos[i]).encode()).hexdigest())
    return {runner: ("dev" if pos % 2 == 0 else "held") for pos, runner in enumerate(order)}


def load_rows(pattern):
    rows, files = [], None
    for p in sorted(glob.glob(pattern)):
        d = json.load(open(p))
        rows += d["rows"]
        files = d["files"]
    return rows, files


def forecasts(r, h, which):
    """Probability of >=1 PB in the next h attempts for model / baselines, and the outcome."""
    y = {1: r["y1"], 10: r["y10"], 50: r["y50"]}[h]
    base = {"model": r["pOne"], "recent100": r["bW"], "longrun": r["bAll"], "never": 0.0}[which]
    p = base if h == 1 else 1 - (1 - base) ** h
    return p, y


def brier(pairs):
    return sum((p - y) ** 2 for p, y in pairs) / len(pairs) if pairs else float("nan")


def decompose(pairs, bins=BINS):
    n = len(pairs)
    if not n:
        return None
    obar = sum(y for _, y in pairs) / n
    rel = res = 0.0
    curve = []
    for lo, hi in zip(bins[:-1], bins[1:]):
        b = [(p, y) for p, y in pairs if lo <= p < hi]
        if not b:
            continue
        pk = sum(p for p, _ in b) / len(b)
        ok = sum(y for _, y in b) / len(b)
        rel += len(b) * (pk - ok) ** 2
        res += len(b) * (ok - obar) ** 2
        curve.append({"lo": lo, "hi": min(hi, 1.0), "n": len(b), "mean_forecast": pk, "observed": ok})
    return {"n": n, "base_rate": obar, "reliability": rel / n, "resolution": res / n, "uncertainty": obar * (1 - obar), "brier": brier(pairs), "curve": curve}


def cluster_bootstrap(rows_by_runner, stat, reps=2000, seed=7):
    """Resample runners (not forecasts) with replacement; return (point, lo, hi) of stat(list of rows)."""
    runners = sorted(rows_by_runner)
    rng = random.Random(seed)
    point = stat([r for k in runners for r in rows_by_runner[k]])
    vals = []
    for _ in range(reps):
        pick = [rng.choice(runners) for _ in runners]
        rows = [r for k in pick for r in rows_by_runner[k]]
        v = stat(rows)
        if v == v:
            vals.append(v)
    vals.sort()
    if not vals:
        return point, float("nan"), float("nan")
    return point, vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]
