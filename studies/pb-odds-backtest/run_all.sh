#!/bin/bash
# Runs every backtest variant used in the write-up: 4 shards at a time, rows into cache/rows-<name>.<shard>.json.
# Usage: ./run_all.sh <released-src> <head-src>
#   <released-src>, <head-src>: src/ directories of the 0.2.4 release commit and of the checkout before the study's change.
set -e
cd "$(dirname "$0")/../.."
REL=$1; HEAD=$2
run() { # name, extra args...
  name=$1; shift
  for i in 0 1 2 3; do npx --no-install tsx studies/pb-odds-backtest/backtest.ts --shard $i/4 --sims 5000 --out cache/rows-$name.$i.json "$@" 2>&1 | grep -E "^shard|rror" & done
  wait; echo "done $name"
}
V="--mc montecarlo-variants.ts"
run released --src "$REL"
run head --src "$HEAD"
run fix
for w in 10 15 20 50 100 300 100000; do run w$w $V --opts "{\"recentWindow\":$w}"; done
run fin5 $V --opts '{"pool":"finished","minFinishedRuns":5}'
run fin10 $V --opts '{"pool":"finished","minFinishedRuns":10}'
run joint5 $V --opts '{"pool":"finished","minFinishedRuns":5,"joint":true}'
run trend $V --opts '{"trend":true}'
run trendshrunk $V --opts '{"trend":"shrunk"}'
run hazard5 $V --opts '{"hazardPrior":5}'
for m in 1 2 3 5 8; do run ms$m $V --opts "{\"minSegmentSamples\":$m}"; done
run cdf $V --cdf 1 --sims 2000
