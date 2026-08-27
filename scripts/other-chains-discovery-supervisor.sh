#!/bin/bash
cd "$(dirname "$0")/.."
source scripts/_supervisor-singleton.sh
supervisor_singleton "other-chains-discovery-supervisor"
set -a; source <(grep -E "^[A-Z_]+=" .env.local); set +a

ATTEMPT=0
while true; do
  ATTEMPT=$((ATTEMPT + 1))
  echo "=== other-chains supervisor: attempt $ATTEMPT, $(date -u +%H:%M:%S) UTC ==="
  supervisor_run node --import tsx scripts/other-chains-discovery-pass.mjs
  echo "=== other-chains supervisor: pass exited code $? ==="
  sleep 2
done
