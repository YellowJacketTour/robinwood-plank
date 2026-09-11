#!/bin/bash
# PlankCrash friend table -- the whole stack, supervised by one cron entry.
# Each invocation owns the table for its budget then exits so the next takes
# over; flock makes overlap impossible, exactly as the drand relayer and the
# akasha hose already work on this host.
#
# The stack is Astra's, unchanged (docs/marketplank/FRIEND-INVITE-TEST.md):
#
#   :8545  the chain            anvil, standing in for `npx hardhat node`
#   :8765  arcade preview       THE KEEPER. Also writes practice-clock.js and
#                               seats the simulated crew. Not optional -- see
#                               below.
#   :8766  invite gateway       the gate, the guest wallets, the filtered RPC
#
# Why anvil rather than hardhat: hardhat is a devDependency and the standalone
# Passenger release ships none, so it is not on this box. More importantly
# hardhat's chain is memory-only, and the hourly restart that cron supervision
# requires would wipe contracts, balances and the round counter every hour.
# anvil's --state-interval dumps to disk and survives even a hard kill.
#
# 8765 is MANDATORY, and it is easy to mistake for a dev convenience:
#   - it runs the keeper with mockImmediateAfterClose, which is what makes the
#     round cycle feel fast. Without a keeper, crash.html does NOT fall back:
#     it disables its own browser-side lock/settle whenever INVITE_TEST is on,
#     so the first round locks and the table hangs forever.
#   - it writes public/arcade/practice-clock.js, the measured chain-vs-wall
#     clock offset. crash.html imports it inside a try/catch and silently
#     continues on a mismatch, so a stale or missing file is invisible -- the
#     countdown is simply wrong.
#   - it seats the simulated crew, so a lone friend is not staring at empty
#     rounds.
#
# The chain is fake and local. Guests are funded from a pre-funded anvil
# account: play costs nothing and needs no faucet.
set -euo pipefail

app_dir="${1:?app_dir required}"
node_bin="${2:?node_bin required}"
budget="${3:-3300}"

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

listening() {
  curl --silent --max-time 3 -o /dev/null "http://127.0.0.1:$1/" 2>/dev/null
}
chain_up() {
  curl --silent --max-time 3 -X POST "http://127.0.0.1:${anvil_port}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
    | grep -q '"result"'
}

# ── the binary ───────────────────────────────────────────────────────────────
if [ ! -x "$anvil_bin" ]; then
  log "anvil missing; fetching foundry $foundry_version"
  tarball="$table_dir/foundry.tar.gz"
  # This host reaches the public internet over HTTPS already -- the drand
  # relayer polls api.drand.sh from here every minute -- so the only real
  # unknown is github.com specifically. Say that plainly rather than failing
  # with a bare curl exit code.
  # The ALPINE asset, not linux_amd64: it is musl-static, with no ELF
  # interpreter and no GLIBC version symbols at all. The glibc build needs
  # GLIBC_2.29-2.35 and this host has older, so it died on launch with
  #   /lib64/libm.so.6: version `GLIBC_2.29' not found
  # and the supervisor then reported only "anvil did not come up".
  if ! curl --fail --silent --show-error --location --max-time 900 -o "$tarball" \
      "https://github.com/foundry-rs/foundry/releases/download/${foundry_version}/foundry_${foundry_version}_alpine_amd64.tar.gz"; then
    log "FATAL: could not download foundry from github.com."
    log "       If this host blocks github.com, stage the binary by hand at"
    log "       $anvil_bin and re-run."
    exit 1
  fi
  tar -xzf "$tarball" -C "$table_dir/bin" anvil
  rm -f "$tarball"
  chmod 700 "$anvil_bin"
  # Prove it actually executes here. The previous build installed fine and
  # only failed when launched, which surfaced as an unrelated timeout.
  if ! version="$("$anvil_bin" --version 2>&1 | head -1)" || [ -z "$version" ]; then
    log "FATAL: the anvil binary does not run on this host:"
    "$anvil_bin" --version 2>&1 | head -5 | while read -r line; do log "       $line"; done
    rm -f "$anvil_bin"
    exit 1
  fi
  log "anvil installed: $version"
fi

# ── the chain ────────────────────────────────────────────────────────────────
if chain_up; then
  log "chain already listening on ${anvil_port}"
else
  log "starting anvil"
  # Every flag here is parity with Astra's hardhat node, and each was found by
  # running the real stack rather than reading about it:
  #
  #   --block-time 0.1 --mixed-mining
  #     hardhat.config.ts runs mining {auto:false, interval:100} PLUS automine.
  #     100ms blocks keep the multiplier climbing at a watchable pace and the
  #     chain clock tracking the wall clock; automine is what makes a bet or a
  #     guest funding land instantly. With a 1s block time and no mixed mining,
  #     joining took 8.6 SECONDS. With these, 0.23s.
  #
  #   --preserve-historical-states
  #     the gateway binary-searches old blocks for its own deployment. anvil
  #     prunes historical state by default and answers BlockOutOfRangeError,
  #     and the gateway cannot even boot.
  #
  #   --transaction-block-keeper 100000
  #     at 100ms blocks the chain makes 36,000 blocks an hour, and the default
  #     retention pruned the deployment out from under that same search after
  #     roughly ten minutes of uptime.
  #
  #   --accounts 20
  #     the stack uses signers 0-4, 7 (preview keeper), 8 (gateway funder) and
  #     9 (simulated crew). anvil defaults to 10, leaving zero headroom.
  #
  #   --order fifo
  #     EDR mines in nonce order; anvil defaults to fee order, which can
  #     reorder across the keeper, funder and crew senders.
  nohup "$anvil_bin" \
    --port "$anvil_port" --host 127.0.0.1 --chain-id 31337 \
    --accounts 20 --balance 10000 --order fifo \
    --state "$state_file" --state-interval 10 \
    --preserve-historical-states --transaction-block-keeper 100000 \
    --block-time 0.1 --mixed-mining --silent \
    >> "$table_dir/anvil.log" 2>&1 &
  for _ in $(seq 1 40); do chain_up && break; sleep 1; done
  chain_up || { log "FATAL: anvil did not come up"; exit 1; }
  log "anvil up"
fi

# ── the casino ───────────────────────────────────────────────────────────────
# The deploy script imports hardhat and cannot be bundled (native .node
# modules), so CI deploys once against anvil and ships the resulting state
# file. A chain with no casino loads that seed; a chain that already has one is
# left alone.
deployed=false
if [ -s "$manifest" ]; then
  crash="$("$node_bin" -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).crash||'')}catch{}" "$manifest" || true)"
  if [ -n "$crash" ]; then
    code="$(curl --silent --max-time 5 -X POST "http://127.0.0.1:${anvil_port}" \
      -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$crash\",\"latest\"]}" \
      | "$node_bin" -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).result||'0x')}catch{process.stdout.write('0x')}})")"
    [ "${#code}" -gt 4 ] && deployed=true
  fi
fi
if [ "$deployed" = false ]; then
  log "FATAL: no casino on this chain and no seeded state to load."
  log "       The release ships ops/plankcrash-table/anvil-seed.json; copy it"
  log "       to $state_file and restart, or re-run the deploy in CI."
  exit 1
fi
log "casino present at $crash"

# ── the preview: keeper, practice clock, simulated crew ──────────────────────
if listening "$preview_port"; then
  log "preview already listening on ${preview_port}"
else
  log "starting arcade preview (keeper + practice clock + crew)"
  ( cd "$release" && nohup "$node_bin" ops/plankcrash-table/arcade-preview.mjs \
      >> "$table_dir/preview.log" 2>&1 & )
  for _ in $(seq 1 40); do listening "$preview_port" && break; sleep 1; done
  listening "$preview_port" || { log "FATAL: preview did not come up"; exit 1; }
  log "preview up"
fi

# ── the gate ─────────────────────────────────────────────────────────────────
if listening "$gateway_port"; then
  log "gateway already listening on ${gateway_port}"
else
  log "starting invite gateway"
  # PLANK_INVITE_PUBLIC_ORIGIN: the gateway's CSRF check compares Origin to
  # Host, and a reverse proxy rewrites Host to this loopback listener while
  # Origin stays the public site -- without this every POST is 403.
  #
  # PLANK_INVITE_TABLE_PATH: crash.html carries <base href="/arcade/">, so the
  # gateway's stamped copy must be served under that path or every asset 404s.
  # It must ALSO be a filename that does not exist in public/, or the static
  # handler shadows the proxy and the page loads without the invite meta tag --
  # which silently drops INVITE_TEST and the green dock never mounts.
  ( cd "$release" && nohup env \
      PLANK_INVITE_STATE_DIR="$table_dir/state" \
      PLANK_INVITE_PORT="$gateway_port" \
      PLANK_INVITE_PUBLIC_ORIGIN="${PLANK_INVITE_PUBLIC_ORIGIN:-https://plank.love}" \
      PLANK_INVITE_TABLE_PATH="/arcade/table.html" \
      "$node_bin" ops/plankcrash-table/invite-gateway.mjs \
      >> "$table_dir/gateway.log" 2>&1 & )
  for _ in $(seq 1 40); do listening "$gateway_port" && break; sleep 1; done
  listening "$gateway_port" || { log "FATAL: gateway did not come up"; exit 1; }
  log "gateway up"
fi

# ── hold the lock for the rest of the budget ─────────────────────────────────
# The services are detached; this process exists to own the flock, notice a
# death, and exit before the next cron invocation starts.
log "table up; holding for ${budget}s"
deadline=$(( $(date +%s) + budget ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  sleep 15
  chain_up            || { log "chain died; exiting so the next run rebuilds"; exit 1; }
  listening "$preview_port" || { log "preview died; exiting so the next run restarts it"; exit 1; }
  listening "$gateway_port" || { log "gateway died; exiting so the next run restarts it"; exit 1; }
done
log "budget reached; exiting cleanly"
