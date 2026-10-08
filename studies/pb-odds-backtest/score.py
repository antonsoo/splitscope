"""Score the backtest rows: Brier, decomposition, reliability curves, runner-level bootstrap.

Run: python3 -I score.py        (reads cache/rows-*.json and manifest.json; writes results.json, reliability.svg)
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import math
import random
import statistics

from scorelib import BINS, brier, decompose, forecasts, load_rows, split_assignment

SP = split_assignment("manifest.json")
HORIZONS = (1, 10, 50)
KEY = {1: "y1", 10: "y10", 50: "y50"}
BASELINES = ("recent100", "longrun", "never")
REPS = 2000


def rows_for(name):
    rows, files = load_rows(f"cache/rows-{name}.*.json")
    return rows, files


def part_rows(rows, part, h):
    return [r for r in rows if (part == "all" or SP[r["runner"]] == part) and r[KEY[h]] is not None]


def by_runner(rows):
    out = {}
    for r in rows:
        out.setdefault(r["runner"], []).append(r)
    return out


def boot(rows, stat, reps=REPS, seed=11):
    """Runner-level bootstrap: resample runners with replacement, never individual forecasts."""
    groups = by_runner(rows)
    keys = sorted(groups)
    rng = random.Random(seed)
    point = stat(rows)
    vals = []
    for _ in range(reps):
        pick = [rng.choice(keys) for _ in keys]
        sample = [r for k in pick for r in groups[k]]
        v = stat(sample)
        if v == v:
            vals.append(v)
    vals.sort()
    if len(vals) < 20:
        return [point, None, None]
    return [point, vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]]


def bs(which, h):
    return lambda rs: brier([forecasts(r, h, which) for r in rs]) if rs else float("nan")


def diff(a, b, h):
    return lambda rs: (bs(a, h)(rs) - bs(b, h)(rs)) if rs else float("nan")


def headline(rows):
    out = {}
    for part in ("dev", "held", "all"):
        out[part] = {}
        for h in HORIZONS:
            rs = part_rows(rows, part, h)
            pairs = {w: [forecasts(r, h, w) for r in rs] for w in ("model",) + BASELINES}
            d = decompose(pairs["model"])
            entry = {
                "n": len(rs),
                "runners": len({r["runner"] for r in rs}),
                "base_rate": d["base_rate"],
                "mean_forecast": sum(p for p, _ in pairs["model"]) / len(rs),
                "brier": {w: brier(pairs[w]) for w in pairs},
                "decomposition": {k: d[k] for k in ("reliability", "resolution", "uncertainty")},
                "brier_model_minus": {b: boot(rs, diff("model", b, h)) for b in BASELINES},
            }
            if h == 50:
                rr = [r for r in rs if r["beatCount50"] is not None]
                exp = sum(50 * r["pOne"] for r in rr)
                obs = sum(r["beatCount50"] for r in rr)
                entry["expected_pbs_per_attempt_next50"] = exp
                entry["observed_pbs_per_attempt_next50"] = obs
                entry["observed_over_expected"] = boot(
                    rr, lambda s: sum(r["beatCount50"] for r in s) / sum(50 * r["pOne"] for r in s) if s and sum(r["pOne"] for r in s) > 0 else float("nan")
                )
                entry["finishes_expected_next50"] = sum(50 * r["finishProb"] for r in rr)
                entry["finishes_observed_next50"] = sum(r["finCount50"] for r in rr)
            out[part][str(h)] = entry
    return out


def curves(rows, h, bins=BINS):
    rs = part_rows(rows, "all", h)
    pairs = [(forecasts(r, h, "model")[0], r[KEY[h]], r["runner"]) for r in rs]
    groups = {}
    for p, y, k in pairs:
        groups.setdefault(k, []).append((p, y))
    keys = sorted(groups)
    out = []
    rng = random.Random(5)
    picks = [[rng.choice(keys) for _ in keys] for _ in range(REPS)]
    for lo, hi in zip(bins[:-1], bins[1:]):
        sel = [(p, y) for p, y, _ in pairs if lo <= p < hi]
        if not sel:
            continue
        vals = []
        for pick in picks:
            s = [(p, y) for k in pick for p, y in groups[k] if lo <= p < hi]
            if s:
                vals.append(sum(y for _, y in s) / len(s))
        vals.sort()
        ci = [vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]] if len(vals) > 50 else [None, None]
        out.append({
            "lo": lo, "hi": min(hi, 1.0), "n": len(sel), "runners": len({k for p, y, k in pairs if lo <= p < hi}),
            "mean_forecast": sum(p for p, _ in sel) / len(sel), "observed": sum(y for _, y in sel) / len(sel), "observed_ci95": ci,
        })
    return out


def common_compare(base_name, names, h):
    """Brier of each variant on the stopping points every listed variant could forecast."""
    V = {n: {(r["file"], r["k"]): r for r in rows_for(n)[0]} for n in names}
    common = set.intersection(*[set(v) for v in V.values()])
    out = {}
    for n in names:
        ent = {"all_points": len(V[n]), "common_points": len(common)}
        for part in ("dev", "held"):
            rs = [V[n][k] for k in common if (SP[V[n][k]["runner"]] == part) and V[n][k][KEY[h]] is not None]
            own = [r for r in V[n].values() if SP[r["runner"]] == part and r[KEY[h]] is not None]
            ent[part] = {
                "common_n": len(rs),
                "common_brier": brier([forecasts(r, h, "model") for r in rs]),
                "common_mean_forecast": sum(forecasts(r, h, "model")[0] for r in rs) / len(rs),
                "own_n": len(own),
                "own_brier": brier([forecasts(r, h, "model") for r in own]),
            }
        out[n] = ent
    return out


def drift(rows):
    """Observed P(new PB | finish) by completed attempts so far, against the iid-records expectation."""
    buckets = [(0, 5), (5, 10), (10, 20), (20, 50), (50, 10**9)]
    out = []
    rr = [r for r in rows if r["beatCount50"] is not None]
    for lo, hi in buckets:
        s = [r for r in rr if lo <= r["nFin"] < hi]
        if not s:
            continue
        fins = sum(r["finCount50"] for r in s)
        iid = sum(sum(1 / (r["nFin"] + 1 + j) for j in range(int(r["finCount50"]))) for r in s)
        out.append({
            "finishes_so_far": f"{lo}-{hi - 1}" if hi < 10**9 else f"{lo}+", "points": len(s), "future_finishes": fins,
            "observed_beat_per_finish": sum(r["beatCount50"] for r in s) / fins,
            "model_expected_beats_per_finish": sum(50 * r["pOne"] for r in s) / fins,
            "iid_records_expectation": iid / fins,
        })
    return out


def cdf_diag(rows):
    ratios = [0.9, 0.95, 1, 1.02, 1.05, 1.1, 1.2, 1.35, 1.6, 2.2]
    rs = [r for r in rows if r.get("cdf")]
    out = []
    for i, q in enumerate(ratios):
        num = den = mm = 0.0
        for r in rs:
            m, o = r["cdf"][i]
            if m is None or o is None or not r["finCount50"]:
                continue
            w = r["finCount50"]
            mm += m * w; num += o * w; den += w
        out.append({"ratio_to_pb": q, "model_cdf_given_finish": mm / den, "realized_fraction_of_next_finishes": num / den})
    return out


def per_runner(rows, files):
    out = []
    for run in sorted({r["runner"] for r in rows}):
        rs = [r for r in rows if r["runner"] == run and r["y50"] is not None]
        fs = [f for f in files if f["runner"] == run]
        out.append({
            "runner": f"R{run + 1}", "split": SP[run], "histories": len(fs), "attempts": sum(f["attempts"] for f in fs),
            "forecast_points_h50": len(rs),
            "mean_forecast_h50": sum(forecasts(r, 50, "model")[0] for r in rs) / len(rs) if rs else None,
            "observed_h50": sum(r["y50"] for r in rs) / len(rs) if rs else None,
            "brier_model_h50": brier([forecasts(r, 50, "model") for r in rs]) if rs else None,
            "brier_never_h50": brier([forecasts(r, 50, "never") for r in rs]) if rs else None,
        })
    return out


def svg(curve_sets, path):
    W, H = 880, 510
    out = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="system-ui, sans-serif" font-size="12">',
           '<title>Reliability diagram: splitscope PB odds against what happened next</title>',
           f'<rect width="{W}" height="{H}" fill="#ffffff"/>']
    panels = [("Next 10 attempts", 10, 0.6, 50), ("Next 50 attempts", 50, 1.0, 470)]
    for title, h, top, x0 in panels:
        pw = ph = 340
        y0 = 70
        def X(v): return x0 + v / top * pw
        def Y(v): return y0 + ph - v / top * ph
        out.append(f'<text x="{x0}" y="30" font-size="15" font-weight="600" fill="#111">{title}: P(at least one PB)</text>')
        for t in [i * (0.1 if h == 10 else 0.2) for i in range(int(round(top / (0.1 if h == 10 else 0.2))) + 1)]:
            out.append(f'<line x1="{X(0):.1f}" y1="{Y(t):.1f}" x2="{X(top):.1f}" y2="{Y(t):.1f}" stroke="#e5e5e5"/>')
            out.append(f'<line x1="{X(t):.1f}" y1="{Y(0):.1f}" x2="{X(t):.1f}" y2="{Y(top):.1f}" stroke="#e5e5e5"/>')
            out.append(f'<text x="{X(0)-6:.1f}" y="{Y(t)+4:.1f}" text-anchor="end" fill="#444">{t:.0%}</text>')
            out.append(f'<text x="{X(t):.1f}" y="{Y(0)+16:.1f}" text-anchor="middle" fill="#444">{t:.0%}</text>')
        out.append(f'<line x1="{X(0):.1f}" y1="{Y(0):.1f}" x2="{X(top):.1f}" y2="{Y(top):.1f}" stroke="#888" stroke-dasharray="4 4"/>')
        out.append(f'<text x="{X(top)-4:.1f}" y="{Y(top)+14:.1f}" text-anchor="end" fill="#666">perfectly calibrated</text>')
        out.append(f'<text x="{X(top/2):.1f}" y="{Y(0)+36:.1f}" text-anchor="middle" fill="#222">forecast</text>')
        out.append(f'<text x="{x0-38}" y="{y0+ph/2}" text-anchor="middle" fill="#222" transform="rotate(-90 {x0-38} {y0+ph/2})">observed frequency</text>')
        for label, color, curve, filled in curve_sets[h]:
            pts = [c for c in curve if c["mean_forecast"] <= top and c["observed"] <= top * 1.2]
            out.append("<polyline fill=\"none\" stroke=\"%s\" stroke-width=\"1.5\" %s points=\"%s\"/>" % (color, "" if filled else 'stroke-dasharray="3 3"', " ".join(f"{X(c['mean_forecast']):.1f},{Y(min(c['observed'], top)):.1f}" for c in pts)))
            for c in pts:
                cx, cy = X(c["mean_forecast"]), Y(min(c["observed"], top))
                lo, hi = c["observed_ci95"]
                if filled and lo is not None:
                    out.append(f'<line x1="{cx:.1f}" y1="{Y(min(lo, top)):.1f}" x2="{cx:.1f}" y2="{Y(min(hi, top)):.1f}" stroke="{color}" stroke-opacity="0.45" stroke-width="2"/>')
                r = 2.5 + math.sqrt(c["n"]) / 4
                out.append(f'<circle cx="{cx:.1f}" cy="{cy:.1f}" r="{r:.1f}" fill="{color if filled else "#fff"}" stroke="{color}" fill-opacity="{0.85 if filled else 1}"/>')
    ly = H - 54
    lx = 50
    for label, color, filled in [(l, c, f) for l, c, _, f in curve_sets[50]]:
        out.append(f'<circle cx="{lx}" cy="{ly}" r="5" fill="{color if filled else "#fff"}" stroke="{color}"/>')
        out.append(f'<text x="{lx+10}" y="{ly+4}" fill="#222">{label}</text>')
        lx += 330
    out.append(f'<text x="50" y="{H-26}" fill="#555">Bars: 95% interval from resampling runners, not forecasts. Marker size grows with the forecasts in the bin.</text>')
    out.append(f'<text x="50" y="{H-10}" fill="#555">Bins: 0-1, 1-2, 2-5, 5-10, 10-20, 20-40, 40-70, 70-100%. Nearly all points lie above the diagonal: the forecast runs low.</text>')
    out.append("</svg>")
    open(path, "w").write("\n".join(out))


def main():
    manifest = json.load(open("manifest.json"))
    res = {"split": {f"R{i + 1}": SP[i] for i in range(len(manifest["repos"]))}, "bootstrap_replicates": REPS}
    fix, files = rows_for("fix")
    head, _ = rows_for("head")
    rel, _ = rows_for("released")
    res["histories_in_manifest"] = sum(len(x["files"]) for x in manifest["repos"])
    res["eligible_before_dedupe"] = json.load(open("cache/rows-fix.0.json"))["eligibleBeforeDedupe"]
    res["files"] = [{k: f[k] for k in ("i", "attempts", "finishes", "segments", "method")} | {"runner": f"R{f['runner'] + 1}"} for f in files]
    potential = {}
    res["versions"] = {"released_0.2.4": headline(rel), "checkout_before_change": headline(head), "checkout_with_change": headline(fix)}
    res["curves"] = {n: {str(h): curves(rs, h) for h in (10, 50)} for n, rs in (("released_0.2.4", rel), ("checkout_with_change", fix))}
    res["per_runner_checkout_with_change"] = per_runner(fix, files)
    res["per_runner_released"] = per_runner(rel, files)
    # coverage: every stopping point with a PB, forecast or not
    import glob
    res["coverage"] = {}
    for name in ("released", "head", "fix"):
        sk = {"unknownOutcome": 0, "emptyPool": 0, "noPb": 0}
        n_rows = 0
        for p in glob.glob(f"cache/rows-{name}.*.json"):
            d = json.load(open(p))
            n_rows += len(d["rows"])
            for k in sk:
                sk[k] += d["skipped"][k]
        res["coverage"][name] = {"stopping_points_with_a_pb": n_rows + sk["unknownOutcome"] + sk["emptyPool"], "forecasts": n_rows,
                                 "withheld_segment_without_samples": sk["emptyPool"], "withheld_unknown_outcome": sk["unknownOutcome"], "no_pb_yet": sk["noPb"]}
    res["same_points_released_vs_head_vs_fix"] = {h: common_compare("head", ["released", "head", "fix"], h) for h in (10, 50)}
    exp = ["w10", "w15", "w20", "head", "w50", "w100", "w300", "w100000", "fin5", "fin10", "joint5", "trend", "trendshrunk", "hazard5", "ms1", "ms2", "ms3", "ms5", "ms8"]
    res["experiments_h50_common_with_head_window30"] = None
    res["experiments"] = {}
    # per experiment: own coverage plus Brier on the points shared with `head`
    headkeys = {(r["file"], r["k"]) for r in head}
    for n in exp:
        rows, _ = rows_for(n)
        ent = {"forecasts": len(rows)}
        for h in (10, 50):
            for part in ("dev", "held"):
                shared = [r for r in rows if (r["file"], r["k"]) in headkeys and SP[r["runner"]] == part and r[KEY[h]] is not None]
                hs = {(r["file"], r["k"]): r for r in head}
                hrs = [hs[(r["file"], r["k"])] for r in shared]
                ent[f"h{h}_{part}_shared_with_head"] = {
                    "n": len(shared), "brier": brier([forecasts(r, h, "model") for r in shared]) if shared else None,
                    "brier_head_on_same_points": brier([forecasts(r, h, "model") for r in hrs]) if shared else None,
                    "mean_forecast": sum(forecasts(r, h, "model")[0] for r in shared) / len(shared) if shared else None,
                    "observed": sum(r[KEY[h]] for r in shared) / len(shared) if shared else None,
                }
        rr = [r for r in rows if r["beatCount50"] is not None]
        ent["expected_pbs_next50_per_attempt"] = sum(50 * r["pOne"] for r in rr)
        ent["observed_pbs_next50"] = sum(r["beatCount50"] for r in rr)
        res["experiments"][n] = ent
    # the change, on the stopping points the earlier version could also forecast, and on the added ones
    hd = {(r["file"], r["k"]): r for r in head}
    rl = {(r["file"], r["k"]): r for r in rel}
    fx = {(r["file"], r["k"]): r for r in fix}
    res["change_on_shared_points"] = {}
    res["change_on_added_points"] = {}
    for h in (10, 50):
        for part in ("dev", "held", "all"):
            keys = [k for k in fx if k in hd and (part == "all" or SP[fx[k]["runner"]] == part) and fx[k][KEY[h]] is not None]
            a = [hd[k] for k in keys]
            b = [fx[k] for k in keys]
            pair = [{"i": i, "h": hd[k], "f": fx[k], "runner": fx[k]["runner"]} for i, k in enumerate(keys)]
            def d(rs):
                return brier([forecasts(r["f"], h, "model") for r in rs]) - brier([forecasts(r["h"], h, "model") for r in rs]) if rs else float("nan")
            groups = {}
            for p in pair:
                groups.setdefault(p["runner"], []).append(p)
            rng = random.Random(3)
            ks = sorted(groups)
            vals = []
            for _ in range(REPS):
                pk = [rng.choice(ks) for _ in ks]
                v = d([p for k in pk for p in groups[k]])
                if v == v:
                    vals.append(v)
            vals.sort()
            res["change_on_shared_points"][f"h{h}_{part}"] = {
                "n": len(keys), "brier_before": brier([forecasts(r, h, "model") for r in a]), "brier_after": brier([forecasts(r, h, "model") for r in b]),
                "difference_after_minus_before": [d(pair), vals[int(0.025 * len(vals))], vals[int(0.975 * len(vals)) - 1]],
            }
            added = [r for k, r in fx.items() if k not in hd and (part == "all" or SP[r["runner"]] == part) and r[KEY[h]] is not None]
            if added:
                res["change_on_added_points"][f"h{h}_{part}"] = {
                    "n": len(added), "runners": len({r["runner"] for r in added}), "mean_forecast": sum(forecasts(r, h, "model")[0] for r in added) / len(added),
                    "observed": sum(r[KEY[h]] for r in added) / len(added),
                    "brier": {w: brier([forecasts(r, h, w) for r in added]) for w in ("model",) + BASELINES},
                    "brier_model_minus_never": boot(added, diff("model", "never", h)),
                }
    # released against the checkout before the change, same points
    rk = [k for k in rl if k in hd]
    res["released_vs_checkout_before"] = {f"h{h}": {"n": len([k for k in rk if hd[k][KEY[h]] is not None]),
        "brier_released": brier([forecasts(rl[k], h, "model") for k in rk if hd[k][KEY[h]] is not None]),
        "brier_checkout": brier([forecasts(hd[k], h, "model") for k in rk if hd[k][KEY[h]] is not None]),
        "max_abs_forecast_difference": max(abs(rl[k]["pOne"] - hd[k]["pOne"]) for k in rk)} for h in (10, 50)}
    res["released_only_points"] = len([k for k in rl if k not in hd]); res["checkout_only_points"] = len([k for k in hd if k not in rl])
    # one global multiplier on the odds, fitted on one half and tested on the other
    grid = [x / 2 for x in range(1, 25)]
    res["recalibration"] = {}
    for h in (10, 50):
        def sc(rs, a, h=h):
            return brier([(1 - (1 - r["pOne"]) ** (a * h), r[KEY[h]]) for r in rs])
        halves = {p: part_rows(fix, p, h) for p in ("dev", "held")}
        ent = {}
        for fit_on, test_on in (("dev", "held"), ("held", "dev")):
            a = min(grid, key=lambda g: sc(halves[fit_on], g))
            ent[f"fit_on_{fit_on}"] = {"exponent": a, f"brier_{test_on}_before": sc(halves[test_on], 1), f"brier_{test_on}_after": sc(halves[test_on], a)}
        gr = by_runner(part_rows(fix, "all", h))
        ent["best_exponent_by_runner"] = {f"R{k + 1}": min(grid, key=lambda g: sc(v, g)) for k, v in sorted(gr.items())}
        res["recalibration"][f"h{h}"] = ent
    res["pb_rate_by_experience_head"] = drift(head)
    cdf, _ = rows_for("cdf")
    res["model_cdf_vs_realized_finish_times"] = cdf_diag(cdf)
    json.dump(res, open("results.json", "w"), indent=1)
    draw(res)


def draw(res):
    svg({10: [("0.2.4 release", "#c2570c", res["curves"]["released_0.2.4"]["10"], False), ("checkout with the change", "#1d5fa8", res["curves"]["checkout_with_change"]["10"], True)],
         50: [("0.2.4 release", "#c2570c", res["curves"]["released_0.2.4"]["50"], False), ("checkout with the change", "#1d5fa8", res["curves"]["checkout_with_change"]["50"], True)]}, "reliability.svg")


if "--svg-only" in sys.argv:
    draw(json.load(open("results.json")))
else:
    main()
