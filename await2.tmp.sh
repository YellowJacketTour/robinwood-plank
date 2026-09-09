#!/usr/bin/env bash
# Provision as soon as ANY release carrying the hose artifact is active.
#
# Gating on one specific SHA was wrong once 391/392 merged: b63964c will
# supersede ea6e66e as the live build, and every release from ea6e66e onward
# contains akasha-hose-standalone.mjs. Waiting for a SHA that gets overtaken
# is how a watcher sleeps through the thing it was waiting for.
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36"
HOSE_SHAS="ea6e66e de14e51 b63964c"
for i in $(seq 1 120); do
  live=$(curl -s -m 30 -A "$UA" "https://plank.love/" | grep -oE 'data-dpl-id="[a-f0-9]{8}' | sed 's/.*"//')
  for s in $HOSE_SHAS; do
    if [ -n "$live" ] && echo "$s" | grep -q "^${live}"; then
      echo "RELEASE ACTIVE: $live (carries the hose artifact)"
      gh workflow run inmotion.yml -f operation=provision-akasha-hose --ref master \
        && echo "PROVISION DISPATCHED"
      exit 0
    fi
  done
  sleep 40
done
echo "TIMED OUT waiting for a hose-carrying release"
exit 2
