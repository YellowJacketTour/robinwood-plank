#!/usr/bin/env bash
set -euo pipefail

app_dir_input="$1"
app_dir="$1"
app_dir="$(readlink -f -- "$app_dir")"
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
  local script="$1" fd="$2" pid arg resolved cwd owned attempt matched pids args
  for attempt in 1 2 3; do
    matched=0
    # CageFS on the production host has no usable /dev/fd. Bash process
    # substitution (< <(...)) silently prevented the previous PID loop
    # from running at all. A here-string needs no /dev/fd pathname.
    pids="$(pgrep -u "$(id -u)" -f -- "$script" || true)"
    while read -r pid; do
      [[ "$pid" =~ ^[0-9]+$ ]] || continue
      owned=0
      cwd="$(readlink -f -- "/proc/$pid/cwd" 2>/dev/null || true)"
      # Read actual argv, not display-width-limited ps output. Resolve a
      # relative script against THAT process's cwd, including symlinked
      # deployment roots. Do not interpret a shell command as an argv path.
      if [[ -r "/proc/$pid/cmdline" ]]; then
        while IFS= read -r -d '' arg; do
        [[ "$arg" == */"$script" || "$arg" == "$script" ]] || continue
        if [[ "$arg" == /* ]]; then
          resolved="$(readlink -f -- "$arg" || true)"
        else
          resolved="$(readlink -f -- "$cwd/$arg" || true)"
        fi
        if [[ "$resolved" == "$app_dir/current/scripts/$script" ||
              "$resolved" == "$app_dir/releases/"*"/scripts/$script" ]]; then
          owned=1
        fi
        done < "/proc/$pid/cmdline" 2>/dev/null || true
      else
        # Some jailed hosts also hide /proc. Their wide ps output still
        # identifies the absolute script path used by managed cron.
        args="$(ps -ww -p "$pid" -o args= 2>/dev/null || true)"
        if [[ "$args" == *"$app_dir/current/scripts/$script"* ||
              "$args" == *"$app_dir/releases/"*"/scripts/$script"* ||
              "$args" == *"$app_dir_input/current/scripts/$script"* ||
              "$args" == *"$app_dir_input/releases/"*"/scripts/$script"* ]]; then
          owned=1
        fi
      fi
      if [[ "$owned" == 1 ]]; then
        matched=$((matched + 1))
        kill -TERM "$pid" 2>/dev/null || true
      fi
    done <<< "$pids"
    if flock -w 30 "$fd"; then
      echo "[migration-guard] acquired $script"
      return
    fi
    echo "[migration-guard] waiting $script attempt=$attempt matched=$matched" >&2
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
