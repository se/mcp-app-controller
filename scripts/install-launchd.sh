#!/bin/bash
# Installs the app-controller daemon as a macOS LaunchAgent so it starts on login
# and is kept alive. Re-run after changing the port or moving the project.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
NODE_BIN="$(command -v node)"
USER_SHELL="$(dscl . -read "/Users/$USER" UserShell 2>/dev/null | awk '{print $2}')"
USER_SHELL="${USER_SHELL:-$SHELL}"
PORT="${APPCTRL_PORT:-4780}"
LABEL="${APPCTRL_LAUNCHD_LABEL:-com.app-controller}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -f "$PROJECT_DIR/dist/index.js" ]; then
  echo "dist/index.js not found — run 'npm run build' first" >&2
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$PROJECT_DIR/data"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <!-- Launch through the user's login shell so managed apps inherit the full
       shell environment (PATH, app config vars, etc.) -->
  <key>ProgramArguments</key>
  <array>
    <string>$USER_SHELL</string>
    <string>-l</string>
    <string>-c</string>
    <string>exec '$NODE_BIN' '$PROJECT_DIR/dist/index.js'</string>
  </array>
  <key>WorkingDirectory</key><string>$PROJECT_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>APPCTRL_PORT</key><string>$PORT</string>
    <key>HOME</key><string>$HOME</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PROJECT_DIR/data/daemon.log</string>
  <key>StandardErrorPath</key><string>$PROJECT_DIR/data/daemon.log</string>
</dict>
</plist>
EOF

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
launchctl kickstart -k "gui/$UID_NUM/$LABEL"

echo "Installed and started LaunchAgent '$LABEL'"
echo "  plist : $PLIST"
echo "  logs  : $PROJECT_DIR/data/daemon.log"
echo "  check : launchctl print gui/$UID_NUM/$LABEL | head -20"
