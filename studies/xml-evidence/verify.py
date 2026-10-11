"""Replay the parser defect and hash-check unchanged public history and derived routes.

Run from the repository root. The baseline source checkout needs the locked
node_modules (a symlink suffices); cache and --out contain large transient JSONL.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess

from inputs import controls

UPSTREAM = "fb62dd42505b16e813d2779468d81bbad7f01b5e"


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def replay(inputs, command, path):
    with inputs.open() as source, path.open("w") as output:
        subprocess.run(command, stdin=source, stdout=output, check=True)
    return [json.loads(line) for line in path.read_text().splitlines()]


def save_inputs(path, rows):
    path.write_text("".join(json.dumps(row) + "\n" for row in rows))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--baseline-ref", default="3fda8d483fdb07d138fbaf0d38c96bd56fbe7248")
    parser.add_argument("--oracle", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()
    args.out.mkdir(parents=True, exist_ok=True)
    baseline_commit = subprocess.check_output(["git", "rev-parse", args.baseline_ref], text=True).strip()
    baseline_hashes = {}
    for path in sorted((args.baseline / "src/core").glob("*.ts")):
        relative = path.relative_to(args.baseline).as_posix()
        expected = subprocess.check_output(["git", "show", f"{baseline_commit}:{relative}"])
        assert path.read_bytes() == expected, f"Baseline source differs: {relative}"
        baseline_hashes[relative] = digest(path)
    command = ["node", "--import", "tsx", "studies/xml-evidence/analyze.ts"]
    generated = controls()
    control_path = args.out / "controls.jsonl"
    save_inputs(control_path, generated)
    before = replay(control_path, command + [str(args.baseline)], args.out / "before.jsonl")
    after = replay(control_path, command + ["."], args.out / "after.jsonl")
    reference = replay(control_path, [str(args.oracle.resolve())], args.out / "upstream.jsonl")
    by_id = {row["id"]: row for row in after}
    for case, actual, upstream in zip(generated, after, reference, strict=True):
        assert case["id"] == actual["id"] == upstream["id"]
        if case["error"]:
            assert actual["status"] == "rejected" and case["error"] in actual["error"], case["id"]
        else:
            assert actual["run"] == upstream["run"] and actual["totals"] == upstream["totals"], case["id"]
            if case["same_as"]:
                assert actual["runHash"] == by_id[case["same_as"]]["runHash"], case["id"]

    manifest_path = Path("studies/pb-odds-backtest/manifest.json")
    manifest = json.loads(manifest_path.read_text())
    public, receipts = [], []
    for repo in manifest["repos"]:
        for file in repo["files"]:
            path = Path("studies/pb-odds-backtest/cache") / repo["repo"].replace("/", "_") / file["path"]
            assert digest(path) == file["sha256"], path
            raw = path.read_bytes()
            encoding = "utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8-sig"
            identifier = f'{repo["repo"]}/{file["path"]}'
            public.append({"id": identifier, "xml": raw.decode(encoding)})
            receipts.append({"id": identifier, "sha256": file["sha256"]})
    corpus = args.out / "corpus.jsonl"
    attributed = args.out / "corpus-attributed.jsonl"
    save_inputs(corpus, public)
    # Change only opening leaf tags. Keep every original value, id, and ordering.
    pattern = r"<(RealTime|GameTime|PauseTime|Offset|AttemptCount|GameName|CategoryName|Name|BestSegmentTime|PersonalBestSplitTime)>([^<]*)</\1>"
    mutations = []
    for row, receipt in zip(public, receipts, strict=True):
        xml, count = re.subn(pattern, r'<\1 xml:space="preserve">\2</\1>', row["xml"])
        receipt["attributed_elements"] = count
        mutations.append({"id": row["id"], "xml": xml})
    save_inputs(attributed, mutations)
    corpus_before = replay(corpus, command + [str(args.baseline), "--hash-only"], args.out / "corpus-before.jsonl")
    corpus_after = replay(corpus, command + [".", "--hash-only"], args.out / "corpus-after.jsonl")
    corpus_attr = replay(attributed, command + [".", "--hash-only"], args.out / "corpus-attributed-after.jsonl")
    assert corpus_before == corpus_after == corpus_attr
    # Independent upstream attribute invariance; do not equate its more permissive
    # acceptance policy or its name/group migration with Splitscope's model.
    upstream_public = replay(corpus, [str(args.oracle.resolve())], args.out / "upstream-public.jsonl")
    upstream_attr = replay(attributed, [str(args.oracle.resolve())], args.out / "upstream-attributed.jsonl")
    assert upstream_public == upstream_attr
    for receipt, actual in zip(receipts, corpus_after, strict=True):
        assert receipt["id"] == actual["id"]
        receipt.update(actual)
    summary = {
        "reference_commit": UPSTREAM,
        "baseline_commit": baseline_commit,
        "baseline_core_sha256": baseline_hashes,
        "controls": len(generated),
        "accepted_matching_reference": sum(row["status"] == "parsed" for row in after),
        "valid_controls_wrong_before": sum(not case["error"] and old.get("run") != new.get("run")
            for case, old, new in zip(generated, before, after, strict=True)),
        "rejected_controls": sum(row["status"] == "rejected" for row in after),
        "invalid_controls_accepted_before": sum(bool(case["error"]) and old["status"] == "parsed"
            for case, old in zip(generated, before, strict=True)),
        "public_files": len(public),
        "public_parsed": sum(row["status"] == "parsed" for row in corpus_after),
        "public_output_changes": 0,
        "attributed_public_output_changes": 0,
        "attributed_public_elements": sum(row["attributed_elements"] for row in receipts),
        "reference_public_parsed": sum("run" in row for row in upstream_public),
        "reference_attributed_public_output_changes": 0,
        "manifest_sha256": digest(manifest_path),
        "corpus_results_sha256": digest(args.out / "corpus-after.jsonl"),
        "files": receipts,
    }
    (args.out / "verification.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(json.dumps({k: v for k, v in summary.items() if k != "files"}, indent=2))


if __name__ == "__main__":
    main()
