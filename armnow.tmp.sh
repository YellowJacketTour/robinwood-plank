#!/usr/bin/env bash
set -uo pipefail
cd /c/tmp/robinwood-sync-fix2
for i in $(seq 1 60); do
  line=$(gh run list --branch master --limit 6 2>/dev/null | grep InMotion | grep aa15fd7 | head -1)
  st=$(echo "$line" | awk '{print $1}'); res=$(echo "$line" | awk '{print $2}')
  [ "$st" = "completed" ] && break
  sleep 30
done
if [ "${res:-}" != "success" ]; then echo "DEPLOY aa15fd7 = ${res:-timeout}; not arming"; exit 1; fi
echo "deploy ok; arming"
gh workflow run inmotion.yml -f operation=cutover-bitcoin-existence -f cutover_direction=arm --ref master >/dev/null 2>&1
sleep 15
RUN=$(gh run list --workflow=inmotion.yml --limit 3 --json databaseId --jq '.[0].databaseId' 2>/dev/null)
for i in $(seq 1 40); do
  s=$(gh run view "$RUN" --json status,conclusion --jq '"\(.status)/\(.conclusion // "-")"' 2>/dev/null)
  echo "$s" | grep -q completed && break
  sleep 20
done
echo "ARM RESULT: $s"
gh run view "$RUN" --log 2>/dev/null | grep -E "\[cutover\]|CUTOVER_STATE" | grep -v '\[36' | tail -8
