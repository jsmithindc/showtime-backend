#!/bin/bash
set -e

PLIST_NAME="com.showtimefinder.server.plist"
DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

if [ -f "$DEST" ]; then
  launchctl unload "$DEST" 2>/dev/null || true
  rm "$DEST"
  echo "Stopped and removed. It won't start again on login."
  echo "(This only removes the background-service registration --"
  echo "your showtime-backend folder and its files are untouched.)"
else
  echo "Not currently installed as a background service -- nothing to do."
fi
