#!/bin/bash
# Restarts the app-controller LaunchAgent (after a rebuild, config change, etc.)
# and waits until the daemon is serving again. Managed apps are stopped gracefully
# and brought back automatically by boot restore.
set -euo pipefail

LABEL="${APPCTRL_LAUNCHD_LABEL:-com.app-controller}"
PORT="${APPCTRL_PORT:-4780}"
UID_NUM="$(id -u)"

if ! launchctl print "gui/$UID_NUM/$LABEL" > /dev/null 2>&1; then
  echo "LaunchAgent '$LABEL' is not installed — run scripts/install-launchd.sh first." >&2
  exit 1
fi

echo "Restarting daemon ($LABEL)..."
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

for _ in $(seq 1 60); do
  if curl -s -o /dev/null "http://127.0.0.1:$PORT/api/state"; then
    echo "Daemon is back on http://127.0.0.1:$PORT — managed apps are being auto-restored."
    exit 0
  fi
  sleep 1
done

echo "Daemon did not come back within 60s — check data/daemon.log" >&2
exit 1
