#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. The source archive is immutable and hash checked.
study="$(pwd)/studies/time-budget"
python3 - "$study/cache" <<'PY'
import hashlib
from pathlib import Path
import sys
import tarfile
import urllib.request

cache = Path(sys.argv[1])
cache.mkdir(parents=True, exist_ok=True)
commit = "fb62dd42505b16e813d2779468d81bbad7f01b5e"
archive = cache / "upstream.tar.gz"
if not archive.exists():
    archive.write_bytes(urllib.request.urlopen(
        f"https://codeload.github.com/LiveSplit/livesplit-core/tar.gz/{commit}"
    ).read())
assert hashlib.sha256(archive.read_bytes()).hexdigest() == "b52f55b62ec3a4d3ea73a908df2815f9569c558f53da782f6c0e3181ce996981"
with tarfile.open(archive) as source:
    source.extractall(cache, filter="data")
PY
upstream="$study/cache/livesplit-core-fb62dd42505b16e813d2779468d81bbad7f01b5e"
mkdir -p "$upstream/examples"
cp "$study/oracle.rs" "$upstream/examples/practice_clock.rs"
cp "$study/../sum-of-best/oracle.Cargo.lock" "$upstream/Cargo.lock"
cargo +1.97.1 build --manifest-path "$upstream/Cargo.toml" --locked --release \
  --no-default-features --features std --example practice_clock
"$upstream/target/release/examples/practice_clock" "$study/controls"
