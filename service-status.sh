#!/bin/bash
PLIST_NAME="com.showtimefinder.server.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ ! -f "$DEST" ]; then
  echo "Not installed as a background service."
  exit 0
fi

echo "--- launchd status ---"
launchctl list | grep showtimefinder || echo "Registered but not currently running."

echo ""
echo "--- Is it actually answering requests? ---"
CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:3000/ 2>/dev/null || echo "no response")
echo "http://localhost:3000/ -> $CODE"

echo ""
echo "--- Last 15 log lines ---"
tail -15 /tmp/showtime-finder.log 2>/dev/null || echo "(no log file yet)"
