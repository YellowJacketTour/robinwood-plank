#!/bin/bash
# PlankCrash friend table -- one cron invocation owns the whole stack for an
# hour, then exits so the next invocation takes over. flock makes overlap
# impossible, exactly as the drand relayer and akasha hose already work.
#
# Why anvil and not hardhat: hardhat is a devDependency and the standalone
# Passenger release ships none, so it does not exist on this box. anvil is a
# single static binary. More importantly hardhat's chain is memory-only, so
# every hourly restart would wipe contracts, balances and the round counter --
# players would lose their wallets every hour. anvil's --state-interval dumps
# to disk periodically, which survives even a hard kill (verified).
#
# The chain is fake and local. Guest wallets are funded from a pre-funded
# anvil account, so play costs nothing and needs no faucet.
set -euo pipefail

app_dir="${1:?app_dir required}"
node_bin="${2:?node_bin required}"
budget="${3:-3300}"

table_dir="$app_dir/shared/plankcrash"
state_file="$table_dir/anvil-state.json"
manifest="$app_dir/current/public/arcade/deploy-addresses.local.json"
anvil_bin="$table_dir/bin/anvil"
log() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

mkdir -p "$table_dir/bin"
chmod 700 "$table_dir"

# ── the binary ───────────────────────────────────────────────────────────────
# Fetched once and kept. The box already reaches the public internet over
# HTTPS (the drand relayer polls api.drand.sh from here every minute), so the
# only real unknown is whether github.com specifically is reachable -- say so
# plainly rather than failing with a bare curl exit code.
if [ ! -x "$anvil_bin" ]; then
  log "anvil missing; fetching foundry $FOUNDRY_VERSION"
  tarball="$table_dir/foundry.tar.gz"
  if ! curl --fail --silent --show-error --location --max-time 600 \
      -o "$tarball" \
      "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz"; then
    log "FATAL: could not download foundry from github.com."
    log "       This host may not permit outbound access to github.com."
    log "       Stage $table_dir/bin/anvil by hand and re-run."
    exit 1
  fi
  tar -xzf "$tarball" -C "$table_dir/bin" anvil
  rm -f "$tarball"
  chmod 700 "$anvil_bin"
  log "anvil installed: $("$anvil_bin" --version | head -1)"
fi

# ── the chain ────────────────────────────────────────────────────────────────
chain_up() {
  curl --silent --max-time 3 -X POST "http://127.0.0.1:${ANVIL_PORT}" \
    -H 'Content-Type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' 2>/dev/null \
    | grep -q '"result"'
}

if chain_up; then
  log "chain already listening on ${ANVIL_PORT}"
else
  log "starting anvil (state $state_file)"
  # --state loads an existing snapshot and keeps dumping to it; the interval
  # is what makes an ungraceful kill survivable.
  nohup "$anvil_bin" \
    --port "$ANVIL_PORT" --host 127.0.0.1 --chain-id 31337 \
    --state "$state_file" --state-interval 10 \
    --preserve-historical-states --block-time 1 --silent \
    >> "$table_dir/anvil.log" 2>&1 &
  for _ in $(seq 1 30); do chain_up && break; sleep 1; done
  chain_up || { log "FATAL: anvil did not come up"; exit 1; }
  log "anvil up"
fi

# ── the casino ───────────────────────────────────────────────────────────────
# The deploy needs hardhat, which is not on this box. CI compiles and bundles
# it instead (ops/plankcrash-deploy/deploy.mjs), so this only has to notice an
# empty chain and run it.
deployed=false
if [ -s "$manifest" ]; then
  crash="$(node -e "try{process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).crash||'')}catch{}" || true)"
  if [ -n "$crash" ]; then
    code="$(curl --silent --max-time 5 -X POST "http://127.0.0.1:${ANVIL_PORT}" \
      -H 'Content-Type: application/json' \
      -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"eth_getCode\",\"params\":[\"$crash\",\"latest\"]}" \
      | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{process.stdout.write(JSON.parse(s).result||'0x')}catch{process.stdout.write('0x')}})")"
    [ "${#code}" -gt 4 ] && deployed=true
  fi
fi

if [ "$deployed" = false ]; then
  log "no casino on this chain; deploying"
  ( cd "$app_dir/current" && \
    TEST_RIG=1 DEPLOY_RPC_URL="http://127.0.0.1:${ANVIL_PORT}" \
    "$node_bin" ops/plankcrash-deploy/deploy.mjs ) >> "$table_dir/deploy.log" 2>&1
  log "deployed"
else
  log "casino already deployed"
fi

# ── the keeper ───────────────────────────────────────────────────────────────
# Advances rounds for the rest of the budget, then exits so the next cron
# invocation takes the lock. Rounds are what make the table never die.
log "keeper starting (budget ${budget}s)"
cd "$app_dir/current"
exec env \
  PLANK_KEEPER_MAIN=1 \
  KEEPER_RPC_URL="http://127.0.0.1:${ANVIL_PORT}" \
  KEEPER_MOCK_BEACON=1 \
  KEEPER_MAX_SECONDS="$budget" \
  KEEPER_INTERVAL_MS=2000 \
  CRASH_ADDRESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).crash)")" \
  LOTTERY_ADDRESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).lottery)")" \
  BEACON_ADDRESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).beacon)")" \
  ROUTER_ADDRESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).rakeRouter)")" \
  ORACLE_ADDRESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).oracle||'')")" \
  BURN_ENGINE_ADDRESS="$(node -e "process.stdout.write(JSON.parse(require('fs').readFileSync('$manifest','utf8')).burnEngine||'')")" \
  KEEPER_PK="$KEEPER_PK" \
  "$node_bin" ops/casino-keeper/casino-keeper.mjs
