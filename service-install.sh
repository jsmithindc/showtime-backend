#!/bin/bash
set -e
cd "$(dirname "$0")"

PLIST_NAME="com.showtimefinder.server.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST_NAME" "$DEST"

launchctl unload "$DEST" 2>/dev/null || true  # in case it's already loaded from a previous install
launchctl load "$DEST"

echo "Installed and started. The server now runs in the background,"
echo "independent of this terminal window -- closing it won't stop it."
echo ""
echo "Check it's actually up:  curl -s http://localhost:3000/ -o /dev/null -w '%{http_code}\n'"
echo "Watch its logs:          tail -f /tmp/showtime-finder.log"
echo "Stop it:                 ./service-uninstall.sh"
