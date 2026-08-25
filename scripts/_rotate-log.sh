#!/bin/bash
# REAL INCIDENT 2026-08-23: genesis-seaport-backfill-supervisor.log grew to
# 28.1 GB (plus two sibling logs at 250MB/177MB) over a few hours of
# unattended running, filling a 1.9TB drive down to 8GB free -- a real
# resource leak, exactly the class of failure the owner explicitly asked
# to guard against. No single supervisor log line was individually
# verbose; the growth came from sheer volume over hours with no cap at
# all. This is a universal safeguard so that mechanism (whatever it is,
# for whatever process) can never again grow a log past a hard ceiling --
# it doesn't depend on diagnosing or trusting any one root cause.
#
# Usage: some-command 2>&1 | bash scripts/_rotate-log.sh /path/to/log MAX_MB
# Reads stdin line by line, appends to the target file, and truncates the
# file down to its last MAX_MB whenever it exceeds 2x that ceiling --
# hysteresis so this doesn't truncate on every single line once near the
# cap (that would mean constant full-file rewrites, real wasted I/O).
LOGFILE="$1"
MAX_MB="${2:-50}"
MAX_BYTES=$((MAX_MB * 1024 * 1024))
TRIGGER_BYTES=$((MAX_BYTES * 2))
LINES_SINCE_CHECK=0

while IFS= read -r line; do
  echo "$line" >> "$LOGFILE"
  LINES_SINCE_CHECK=$((LINES_SINCE_CHECK + 1))
  # Checking file size on every line is real, wasted syscall overhead at
  # high volume -- checking every 200 lines bounds worst-case overshoot to
  # a small, real, acceptable amount while avoiding a stat() call per line.
  if [ "$LINES_SINCE_CHECK" -ge 200 ]; then
    LINES_SINCE_CHECK=0
    size=$(stat -c%s "$LOGFILE" 2>/dev/null || echo 0)
    if [ "$size" -gt "$TRIGGER_BYTES" ]; then
      tail -c "$MAX_BYTES" "$LOGFILE" > "$LOGFILE.tmp" && mv "$LOGFILE.tmp" "$LOGFILE"
    fi
  fi
done
