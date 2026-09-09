#!/usr/bin/env bash
# Land PR 397 (liveness-window fix), deploy, then ARM.
# Each step gates on the previous actually succeeding.
set -uo pipefail
cd /c/tmp/robinwood-sync-fix2
say() { echo "[finish3] $*"; }

for i in $(seq 1 80); do
  b=$(gh pr checks 398 2>/dev/null | grep -E "^build" | awk '{print $2}' | head -1)
  [ -n "$b" ] && [ "$b" != "pending" ] && break
  sleep 30
done
if [ "${b:-}" != "pass" ]; then say "PR398 build = ${b:-unknown}; stopping."; exit 1; fi
say "build passed; merging 397"
gh pr merge 398 --squash --delete-branch >/dev/null 2>&1 || true
sleep 5
[ "$(gh api repos/YellowJacketTour/robinwood-plank/pulls/398 --jq .merged 2>/dev/null)" = "true" ] || { say "397 did not merge; stopping."; exit 1; }
git fetch -q origin master
SHA=$(git rev-parse --short=8 origin/master)
say "master is $SHA; waiting for its deploy"

for i in $(seq 1 110); do
  line=$(gh run list --branch master --limit 8 2>/dev/null | grep InMotion | grep "$SHA" | head -1)
  st=$(echo "$line" | awk '{print $1}'); res=$(echo "$line" | awk '{print $2}')
  [ "$st" = "completed" ] && break
  sleep 40
done
if [ "${res:-}" != "success" ]; then say "deploy = ${res:-timeout}; stopping."; exit 1; fi
say "deployed; arming"

gh workflow run inmotion.yml -f operation=cutover-bitcoin-existence -f cutover_direction=arm --ref master >/dev/null 2>&1
sleep 12
RUN=$(gh run list --workflow=inmotion.yml --limit 3 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
say "arm run $RUN"
for i in $(seq 1 40); do
  st=$(gh run view "$RUN" --json status,conclusion --jq '"\(.status)|\(.conclusion // "-")"' 2>/dev/null)
  echo "$st" | grep -q '^completed' && break
  sleep 25
done
say "ARM RESULT: $st"
gh run view "$RUN" --log 2>/dev/null | grep -E "\[cutover\]|CUTOVER_STATE" | grep -v '\[36' | tail -8
say "done"
