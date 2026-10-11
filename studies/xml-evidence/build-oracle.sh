#!/usr/bin/env bash
set -euo pipefail
# Shares the pinned source, lockfile and toolchain with the sum-of-best study.
bash studies/sum-of-best/build-oracle.sh
checkout="$(pwd)/studies/sum-of-best/cache/livesplit-core"
cp studies/xml-evidence/oracle.rs "$checkout/examples/splitscope_xml_oracle.rs"
cargo +1.97.1 build --manifest-path "$checkout/Cargo.toml" --locked --release --no-default-features --features std --example splitscope_xml_oracle
