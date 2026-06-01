#!/bin/zsh
set -euo pipefail

APP_DIR="/Users/hamidaliyev/Desktop/Conveyer-Hum"
LABEL="com.conveyerhum.dev3001"
PORT="3001"

SUPPORT_DIR="$HOME/Library/Application Support/ConveyerHum"
LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
LOG_DIR="$HOME/Library/Logs/ConveyerHum"
RUNNER="$SUPPORT_DIR/start-dev-3001.zsh"
PLIST="$LAUNCH_AGENTS_DIR/$LABEL.plist"
GUI_DOMAIN="gui/$(id -u)"
NPM_BIN="$(command -v npm)"

if [[ ! -d "$APP_DIR" || ! -f "$APP_DIR/package.json" ]]; then
  echo "App folder not found at $APP_DIR"
  exit 1
fi

mkdir -p "$SUPPORT_DIR" "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

cat > "$RUNNER" <<EOF
#!/bin/zsh -l
set -euo pipefail

cd "$APP_DIR"
export PORT="$PORT"
export NEXT_TELEMETRY_DISABLED=1
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin:\$PATH"

exec "$NPM_BIN" run dev -- --port "$PORT"
EOF
chmod +x "$RUNNER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$RUNNER</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$APP_DIR</string>

  <key>RunAtLoad</key>
  <true/>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>StandardOutPath</key>
  <string>$LOG_DIR/dev3001.out.log</string>

  <key>StandardErrorPath</key>
  <string>$LOG_DIR/dev3001.err.log</string>
</dict>
</plist>
EOF

launchctl bootout "$GUI_DOMAIN" "$PLIST" >/dev/null 2>&1 || true
launchctl bootstrap "$GUI_DOMAIN" "$PLIST"
launchctl kickstart -k "$GUI_DOMAIN/$LABEL"

echo "Installed LaunchAgent: $PLIST"
echo "Runner: $RUNNER"
echo "Logs:"
echo "  $LOG_DIR/dev3001.out.log"
echo "  $LOG_DIR/dev3001.err.log"
echo
echo "Status:"
launchctl print "$GUI_DOMAIN/$LABEL" | sed -n '1,45p'
echo
echo "Port $PORT:"
lsof -nP -iTCP:"$PORT" -sTCP:LISTEN || true
