#!/usr/bin/env bash
# Land PR 396 (the cutover switch), let it deploy, then ARM the cutover.
#
# Each step gates on the previous one actually succeeding, and the arm step is
# the workflow's own -- which refuses unless the hose is provably alive. If any
# gate fails this stops and says why rather than pushing on.
set -uo pipefail
cd /c/tmp/robinwood-sync-fix2

say() { echo "[finish] $*"; }

# --- 1. wait for PR 396's build, then merge -------------------------------
for i in $(seq 1 80); do
  b=$(gh pr checks 396 2>/dev/null | grep -E "^build" | awk '{print $2}' | head -1)
  [ -n "$b" ] && [ "$b" != "pending" ] && break
  sleep 30
done
if [ "${b:-}" != "pass" ]; then
  say "PR396 build = ${b:-unknown}; not merging. Stopping."
  exit 1
fi
say "PR396 build passed; merging"
gh pr merge 396 --squash --delete-branch >/dev/null 2>&1 || true
sleep 5
merged=$(gh api repos/YellowJacketTour/robinwood-plank/pulls/396 --jq .merged 2>/dev/null)
if [ "$merged" != "true" ]; then say "PR396 did not merge. Stopping."; exit 1; fi
git fetch -q origin master
SHA=$(git rev-parse --short=8 origin/master)
say "merged; master is now $SHA"

# --- 2. wait for that deploy ----------------------------------------------
say "waiting for the deploy of $SHA (this carries the new workflow)"
for i in $(seq 1 110); do
  line=$(gh run list --branch master --limit 8 2>/dev/null | grep InMotion | grep "$SHA" | head -1)
  st=$(echo "$line" | awk '{print $1}')
  res=$(echo "$line" | awk '{print $2}')
  if [ "$st" = "completed" ]; then break; fi
  sleep 40
done
if [ "${res:-}" != "success" ]; then
  say "deploy of $SHA = ${res:-timeout}; not arming. Stopping."
  exit 1
fi
say "deploy succeeded"

# --- 3. status first, then arm --------------------------------------------
say "reading current cutover state"
gh workflow run inmotion.yml -f operation=cutover-bitcoin-existence -f cutover_direction=status --ref master >/dev/null 2>&1
sleep 45

say "ARMING the cutover"
gh workflow run inmotion.yml -f operation=cutover-bitcoin-existence -f cutover_direction=arm --ref master >/dev/null 2>&1
sleep 10
RUN=$(gh run list --workflow=inmotion.yml --limit 3 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
say "arm dispatched as run $RUN"

for i in $(seq 1 40); do
  line=$(gh run list --workflow=inmotion.yml --limit 5 2>/dev/null | grep "$RUN" | head -1)
  st=$(echo "$line" | awk '{print $1}')
  res=$(echo "$line" | awk '{print $2}')
  if [ "$st" = "completed" ]; then break; fi
  sleep 25
done
say "ARM RESULT: ${res:-timeout}"
gh run view "$RUN" --log 2>/dev/null | grep -iE "cutover|CUTOVER_STATE|refusing" | tail -12
say "done"
