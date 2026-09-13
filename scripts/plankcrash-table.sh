#!/bin/bash
# PlankCrash friend table: the whole stack as ONE supervised process tree.
#
#   :8545  anvil            the chain (stands in for `npx hardhat node`)
#   :8765  arcade preview   THE KEEPER, the practice clock, the simulated crew
#   :8766  invite gateway   the gate, the guest wallets, the filtered RPC
#
# SHAPE: this runs in the FOREGROUND under `flock -n` from a once-a-minute cron
# entry, exactly like market-realtime.mjs already does on this host -- which is
# the only shape proven to work here. The three services are CHILDREN of this
# script, not detached orphans: on CloudLinux/cPanel every process counts
# against the account's nproc/entry-process limits, and orphaned background
# processes are precisely what gets reaped. Worse, a detached design leaves the
# supervisor holding the lock after its children are killed, so the next cron
# tick is a no-op and the table stays down with nothing to notice.
#
# Here, if any child dies this script exits, the lock releases, and the next
# minute's cron tick rebuilds the whole table. Recovery is the default.
#
# Why anvil rather than hardhat: hardhat is a devDependency and the standalone
# Passenger release ships none. More importantly hardhat's chain is
# memory-only, so a restart would wipe contracts, balances and the round
# counter; anvil's --state-interval dumps to disk and survives even a hard kill.
#
# 8765 is MANDATORY and easy to mistake for a dev convenience:
#   - it runs the keeper. crash.html DISABLES its own browser-side lock/settle
#     whenever INVITE_TEST is on, so with no keeper the first round locks and
#     the table hangs forever with no fallback.
#   - it writes public/arcade/practice-clock.js, the measured chain-vs-wall
#     clock offset. crash.html imports it inside a try/catch and continues
#     silently on a mismatch, so a stale file is invisible and the countdown is
#     simply wrong.
#   - it seats the simulated crew so a lone friend is not watching empty rounds.
#
# The chain is fake and local; guests are funded from a pre-funded anvil
# account, so play costs nothing and needs no faucet.
set -uo pipefail

app_dir="${1:?app_dir required}"
node_bin="${2:?node_bin required}"

release="$app_dir/current"
table_dir="$app_dir/shared/plankcrash"
state_file="$table_dir/anvil-state.json"
manifest="$release/public/arcade/deploy-addresses.local.json"
anvil_bin="$table_dir/bin/anvil"
anvil_port="${ANVIL_PORT:-8545}"
preview_port="${PLANK_PREVIEW_PORT:-8765}"
gateway_port="${PLANK_INVITE_PORT:-8766}"
foundry_version="${FOUNDRY_VERSION:-v1.8.1}"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

mkdir -p "$table_dir/bin" "$table_dir/state"
chmod 700 "$table_dir"

anvil_pid=""; preview_pid=""; gateway_pid=""
# One exit path for every reason we stop: take the children with us so the next
# cron tick starts from nothing rather than colliding with survivors.
cleanup() {
  trap - EXIT INT TERM
  for pid in "$gateway_pid" "$preview_pid" "$anvil_pid"; do
    [ -n "$pid" ] && kill "$pid" 2>/dev/null
  done
  wait 2>/dev/null
}
trap cleanup EXIT INT TERM

listening() { curl --silent --max-time 3 -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null; }
chain_up() {
  curl --silent --max-time 10 -X POST "http://127.0.0.1:${anvil_port}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
    | grep -q '"result"'
}

# ── the binary ───────────────────────────────────────────────────────────────
# "Is it installed?" is the wrong question -- `-x` was true for a binary that
# could not run. An earlier attempt cached the GLIBC build here, and because a
# non-executable file was never the failure mode, every later run skipped the
# download and started a binary that died instantly with
# `/lib64/libc.so.6: version GLIBC_2.29 not found`. The table could not fix
# itself. Ask whether it RUNS, and replace it when it does not.
anvil_runs() { [ -x "$anvil_bin" ] && "$anvil_bin" --version >/dev/null 2>&1; }
if ! anvil_runs; then
  if [ -e "$anvil_bin" ]; then
    log "anvil present but will not run here; replacing it"
    rm -f "$anvil_bin"
  fi
  log "anvil missing; fetching foundry $foundry_version"
  tarball="$table_dir/foundry.tar.gz"
  # The ALPINE asset, not linux_amd64: it is musl-static, with no ELF
  # interpreter and no GLIBC version symbols. The glibc build wants
  # GLIBC_2.29-2.35 and this host is older, so it installed cleanly and then
  # died on launch with `/lib64/libm.so.6: version GLIBC_2.29 not found`.
  if ! curl --fail --silent --show-error --location --max-time 900 -o "$tarball" \
      "https://github.com/foundry-rs/foundry/releases/download/${foundry_version}/foundry_${foundry_version}_alpine_amd64.tar.gz"; then
    log "FATAL: could not download foundry from github.com."
    log "       If this host blocks github.com, stage the binary at $anvil_bin."
    exit 1
  fi
  tar -xzf "$tarball" -C "$table_dir/bin" anvil
  rm -f "$tarball"
  chmod 700 "$anvil_bin"
  # Prove it runs HERE, with the loader's own complaint, rather than letting an
  # unrunnable binary surface 40s later as an unrelated timeout.
  if ! version="$("$anvil_bin" --version 2>&1 | head -1)" || [ -z "$version" ]; then
    log "FATAL: the anvil binary does not run on this host:"
    "$anvil_bin" --version 2>&1 | head -5 | while read -r line; do log "       $line"; done
    rm -f "$anvil_bin"
    exit 1
  fi
  log "anvil installed: $version"
fi

# ── the chain ────────────────────────────────────────────────────────────────
# Flags are parity with Astra's hardhat node, each found by running the stack:
#   --block-time 0.1 --mixed-mining   hardhat.config.ts runs
#     mining {auto:false, interval:100} PLUS automine. 100ms blocks keep the
#     multiplier climbing at a watchable pace and chain time tracking the wall
#     clock; automine is what makes a bet or a guest funding land instantly.
#     Without mixed mining, joining took 8.6 SECONDS. With it, 0.23s.
#   NO --preserve-historical-states   it was here because the gateway once
#     binary-searched old blocks for the deploy; the manifest now carries
#     deployedAtBlock, so nothing reads deep state. With it on, every 100ms
#     block kept a full state snapshot: the dump grew from 24MB to 89MB in
#     minutes, each 10s --state-interval rewrite stalled the RPC past the 3s
#     health probe, the supervisor declared the chain dead and the table
#     rebuilt itself every ~3 minutes forever. Bounded state, 60s dumps, and
#     a 30k-block tx keeper (~50 min of history) keep it flat.
#   --accounts 20                     the stack uses signers 0-4, 7, 8 and 9;
#     anvil defaults to 10, leaving no headroom.
#   --order fifo                      EDR mines in nonce order; anvil defaults
#     to fee order, which reorders across the keeper, funder and crew senders.
# ── a newer release means a newer seed ───────────────────────────────────────
# CI deploys the casino fresh on every build and ships that chain as the seed,
# and the release also ships the manifest the arcade reads. The state on disk
# came from SOME earlier seed. Keeping it across a deploy leaves the table
# fronting a chain the new manifest does not describe -- deterministic
# addresses hid most of it, but not all, and a table that "keeps its state"
# then never matches its own release again. So a seed whose manifest is newer
# than the one the state was born from replaces the state. Guest wallets die
# with the chain, so the gateway sessions go too; the invite TOKEN stays, and
# the same link re-joins everyone with a fresh funded wallet.
seed="$release/ops/plankcrash-table/anvil-seed.json"
seed_marker="$table_dir/state/seed.generatedAt"
want_seed=""
if [ -s "$manifest" ]; then
  want_seed="$("$node_bin" -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).generatedAt||'')}catch{}" "$manifest")"
fi
have_seed="$(cat "$seed_marker" 2>/dev/null || true)"
if [ -s "$seed" ] && [ -n "$want_seed" ] && [ "$want_seed" != "$have_seed" ]; then
  log "release seed $want_seed is newer than the running state (${have_seed:-none}); reseeding"
  cp "$seed" "$state_file" && chmod 600 "$state_file"
  rm -f "$table_dir/state/sessions.json"
  printf '%s' "$want_seed" > "$seed_marker"
fi

# anvil.log is append-only; the FATAL branch below re-prints its tail with a
# fresh timestamp, and last time that resurrected a week-old "trailing
# characters" error while the real failure was elsewhere. Start each run clean.
: > "$table_dir/anvil.log"
log "starting anvil"
"$anvil_bin" \
  --port "$anvil_port" --host 127.0.0.1 --chain-id 31337 \
  --accounts 20 --balance 10000 --order fifo \
  --state "$state_file" --state-interval 60 \
  --transaction-block-keeper 30000 \
  --block-time 0.1 --mixed-mining --silent \
  >> "$table_dir/anvil.log" 2>&1 &
anvil_pid=$!
for _ in $(seq 1 40); do chain_up && break; sleep 1; done
if ! chain_up; then
  # anvil writes its own reason to anvil.log and nothing ever read it, so a
  # failure here looked identical whether the binary could not run, the port
  # was taken, or the state file was rejected. Print it.
  log "FATAL: anvil did not come up. Its own output follows:"
  tail -n 25 "$table_dir/anvil.log" 2>/dev/null | while read -r line; do log "  anvil| $line"; done
  log "  probe| exec test:"
  "$anvil_bin" --version 2>&1 | head -3 | while read -r line; do log "  probe| $line"; done
  log "  probe| port ${anvil_port} holders:"
  (command -v ss >/dev/null && ss -ltnp 2>/dev/null | grep ":${anvil_port}" || netstat -ltnp 2>/dev/null | grep ":${anvil_port}" || echo "none") | while read -r line; do log "  probe| $line"; done
  exit 1
fi
log "anvil up (pid $anvil_pid)"

# ── the clock ────────────────────────────────────────────────────────────────
# anvil resumes from the saved state's timestamp, so every restart gap pushes
# the chain further behind the wall; measured 26.6 hours behind after two days
# of rebuilds, and a CI seed is hours old on arrival. The contracts schedule
# rounds in chain time and the arcade anchors its countdown to it, so bring the
# next block to now. Forward only: anvil refuses a timestamp in its past. The
# practice contract already guards a jump (a liftoff less than 23s out is
# rescheduled to +38s), so the in-flight round simply closes and the next one
# starts on the real clock.
chain_ts="$(curl --silent --max-time 5 -X POST "http://127.0.0.1:${anvil_port}" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["latest",false]}' \
  | "$node_bin" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(String(parseInt(JSON.parse(s).result.timestamp,16)))}catch{process.stdout.write('0')}})")"
wall_ts="$(date +%s)"
if [ "${chain_ts:-0}" -gt 0 ] && [ $((wall_ts - chain_ts)) -gt 5 ]; then
  curl --silent --max-time 5 -X POST "http://127.0.0.1:${anvil_port}" -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"evm_setNextBlockTimestamp\",\"params\":[$wall_ts]}" >/dev/null
  log "chain clock was $((wall_ts - chain_ts))s behind the wall; advanced to now"
fi

# ── the casino ───────────────────────────────────────────────────────────────
# local-casino-setup.ts imports hardhat and cannot be bundled (native .node
# modules), so CI deploys once against an identical anvil and ships the state.
crash=""
if [ -s "$manifest" ]; then
  crash="$("$node_bin" -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).crash||'')}catch{}" "$manifest")"
fi
code="0x"
if [ -n "$crash" ]; then
  code="$(curl --silent --max-time 5 -X POST "http://127.0.0.1:${anvil_port}" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$crash\",\"latest\"]}" \
    | "$node_bin" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).result||'0x')}catch{process.stdout.write('0x')}})")"
fi
if [ "${#code}" -le 4 ]; then
  log "FATAL: no casino on this chain. Copy ops/plankcrash-table/anvil-seed.json"
  log "       to $state_file and restart."
  exit 1
fi
log "casino present at $crash"

# ── the preview: keeper, practice clock, simulated crew ──────────────────────
log "starting arcade preview"
cd "$release" || exit 1
"$node_bin" ops/plankcrash-table/arcade-preview.mjs >> "$table_dir/preview.log" 2>&1 &
preview_pid=$!
for _ in $(seq 1 40); do listening "$preview_port" && break; sleep 1; done
listening "$preview_port" || { log "FATAL: preview did not come up"; exit 1; }
log "preview up (pid $preview_pid)"

# ── the gate ─────────────────────────────────────────────────────────────────
# PLANK_INVITE_PUBLIC_ORIGIN: the gateway's CSRF check compares Origin to Host,
# and a reverse proxy rewrites Host to this loopback listener, so without this
# every POST is 403.
# PLANK_INVITE_TABLE_PATH: crash.html carries <base href="/arcade/">, so the
# stamped copy must be served under that path or every asset 404s -- and it
# must be a filename absent from public/, or the static handler shadows the
# proxy and serves a page with no invite meta tag, silently dropping
# INVITE_TEST so the green dock never mounts.
log "starting invite gateway"
PLANK_INVITE_STATE_DIR="$table_dir/state" \
PLANK_INVITE_PORT="$gateway_port" \
PLANK_INVITE_PUBLIC_ORIGIN="${PLANK_INVITE_PUBLIC_ORIGIN:-https://plank.love}" \
PLANK_INVITE_TABLE_PATH="/arcade/table.html" \
"$node_bin" ops/plankcrash-table/invite-gateway.mjs >> "$table_dir/gateway.log" 2>&1 &
gateway_pid=$!
for _ in $(seq 1 40); do listening "$gateway_port" && break; sleep 1; done
listening "$gateway_port" || { log "FATAL: gateway did not come up"; exit 1; }
log "gateway up (pid $gateway_pid)"

# ── run ──────────────────────────────────────────────────────────────────────
# Stay in the foreground for as long as the table is healthy. Exiting releases
# the flock, and the next minute's cron tick rebuilds everything -- so a crash
# is self-healing rather than a silent outage.
log "table up; supervising"
chain_strikes=0
while :; do
  sleep 20
  # A state dump can hold the RPC for a few seconds; one slow probe is not a
  # dead chain. A dead PROCESS is, immediately.
  if ! kill -0 "$anvil_pid" 2>/dev/null; then log "anvil process died; exiting so the next tick rebuilds"; exit 1; fi
  if chain_up; then chain_strikes=0; else chain_strikes=$((chain_strikes+1)); log "chain probe failed ($chain_strikes/2)"; fi
  if [ "$chain_strikes" -ge 2 ]; then log "chain unhealthy; exiting so the next tick rebuilds"; exit 1; fi
  if ! kill -0 "$preview_pid" 2>/dev/null || ! listening "$preview_port"; then
    log "preview unhealthy; exiting so the next tick rebuilds"; exit 1
  fi
  if ! kill -0 "$gateway_pid" 2>/dev/null || ! listening "$gateway_port"; then
    log "gateway unhealthy; exiting so the next tick rebuilds"; exit 1
  fi
done
