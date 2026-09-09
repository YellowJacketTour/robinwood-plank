#!/usr/bin/env bash
set -euo pipefail

app_dir="$1"
shift
test -d "$app_dir/shared"
test "$#" -gt 0

# Hold the SAME locks cron uses. A one-time kill alone allows cron to
# restart a writer while CREATE TRIGGER is still waiting for its table.
exec 201>"$app_dir/shared/market-mesh.lock"
exec 202>"$app_dir/shared/opensea-stream.lock"
exec 203>"$app_dir/shared/market-realtime.lock"
exec 204>"$app_dir/shared/akasha-hose.lock"

quiesce() {
  local script="$1" fd="$2" pid args attempt
  for attempt in 1 2 3; do
    while read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      args="$(ps -p "$pid" -o args= || true)"
      # Only this application's managed worker, never another checkout or
      # another account's similarly named process. No command text is run.
      if [[ "$args" == *"$app_dir/current/scripts/$script"* ||
            "$args" == *"$app_dir/releases/"*"/scripts/$script"* ]]; then
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done < <(pgrep -u "$(id -u)" -f -- "$script" || true)
    if flock -w 30 "$fd"; then
      echo "[migration-guard] acquired $script"
      return
    fi
  done
  echo "[migration-guard] could not quiesce $script" >&2
  return 1
}

quiesce mesh-tick-standalone.mjs 201
quiesce opensea-stream-standalone.mjs 202
quiesce market-realtime.mjs 203
quiesce akasha-hose-standalone.mjs 204

# File descriptors close on success, failure or disconnect; cron resumes
# naturally without editing or reconstructing the user's crontab.
"$@"
