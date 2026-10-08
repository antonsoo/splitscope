"""Download the pinned repositories' .lss files into cache/ and write manifest.json.

Run: python3 -I fetch.py
Untrusted data: the archives are only unpacked for *.lss members, never executed.
"""
import hashlib
import io
import json
import os
import sys
import tarfile
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CACHE = os.path.join(HERE, "cache")
UA = "splitscope-study (read-only research; contact anton@praviel.com)"

REPOS = [
    "AmenAnthem/speedrun-livesplit-splits",
    "bubzia/speedrun_splits",
    "narfman0/livesplit-data",
    "periwinkle9/LiveSplit-Files",
    "zhrakula/nes",
    "SirCabby/splitSync",
    "LiveSplit/livesplit-core",
    "jaspersiebring/saltysplits",
    "slaurent22/lss-tools",
    "bluu0105/Livesplit-Best-Segment-Between-Multiple-Splits",
    "gonX/livesplit2urn",
]
# Licence as reported by the GitHub repository search API on 2026-10-08; None = the repository declares none.
LICENCES = {
    "AmenAnthem/speedrun-livesplit-splits": "MIT",
    "bubzia/speedrun_splits": None,
    "narfman0/livesplit-data": None,
    "periwinkle9/LiveSplit-Files": None,
    "zhrakula/nes": "Unlicense",
    "SirCabby/splitSync": None,
    "LiveSplit/livesplit-core": "Apache-2.0",
    "jaspersiebring/saltysplits": "AGPL-3.0",
    "slaurent22/lss-tools": "GPL-3.0",
    "bluu0105/Livesplit-Best-Segment-Between-Multiple-Splits": None,
    "gonX/livesplit2urn": "MIT",
}
PINNED = os.path.join(HERE, "pins.json")


def get(url):
    for attempt in range(4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            return urllib.request.urlopen(req, timeout=180).read()
        except Exception as e:  # noqa: BLE001
            print("retry", url, e, file=sys.stderr)
            time.sleep(2 ** attempt * 3)
    raise SystemExit("failed " + url)


def main():
    pins = json.load(open(PINNED)) if os.path.exists(PINNED) else {}
    manifest = {"fetched": time.strftime("%Y-%m-%d"), "repos": []}
    for repo in REPOS:
        ref = pins.get(repo, "HEAD")
        data = get(f"https://codeload.github.com/{repo}/tar.gz/{ref}")
        tf = tarfile.open(fileobj=io.BytesIO(data), mode="r:gz")
        sha = tf.pax_headers.get("comment") or ref
        pins[repo] = sha
        dest = os.path.join(CACHE, repo.replace("/", "_"))
        os.makedirs(dest, exist_ok=True)
        files = []
        for m in tf.getmembers():
            if not m.isfile() or not m.name.lower().endswith(".lss"):
                continue
            rel = m.name.split("/", 1)[1]
            raw = tf.extractfile(m).read()
            out = os.path.join(dest, rel)
            os.makedirs(os.path.dirname(out), exist_ok=True)
            open(out, "wb").write(raw)
            files.append({"path": rel, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest()})
        manifest["repos"].append(
            {
                "repo": repo,
                "licence": LICENCES[repo],
                "commit": sha,
                "archive_url": f"https://codeload.github.com/{repo}/tar.gz/{sha}",
                "archive_sha256": hashlib.sha256(data).hexdigest(),
                "files": sorted(files, key=lambda f: f["path"]),
            }
        )
        print(repo, sha[:10], len(files))
        time.sleep(1)
    json.dump(pins, open(PINNED, "w"), indent=1)
    json.dump(manifest, open(os.path.join(HERE, "manifest.json"), "w"), indent=1)


main()
