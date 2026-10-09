#!/usr/bin/env bash
set -euo pipefail
# Run from the repository root. All downloaded source/build output stays in cache.
root="$(pwd)/studies/sum-of-best"
checkout="$root/cache/livesplit-core"
commit=fb62dd42505b16e813d2779468d81bbad7f01b5e
if [ ! -d "$checkout/.git" ]; then
  git clone --no-checkout https://github.com/LiveSplit/livesplit-core.git "$checkout"
fi
git -C "$checkout" checkout --detach "$commit"
mkdir -p "$checkout/examples"
cp "$root/oracle.rs" "$checkout/examples/splitscope_oracle.rs"
cp "$root/oracle.Cargo.lock" "$checkout/Cargo.lock"
cargo +1.97.1 build --manifest-path "$checkout/Cargo.toml" --locked --release --no-default-features --features std --example splitscope_oracle
