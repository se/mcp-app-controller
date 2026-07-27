#!/bin/bash
# Removes the app-controller LaunchAgent (stops the daemon and its managed processes).
set -euo pipefail

LABEL="${APPCTRL_LAUNCHD_LABEL:-com.app-controller}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "Removed LaunchAgent '$LABEL'"
