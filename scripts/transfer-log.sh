#!/usr/bin/env bash
# Transfer-Ablauf des letzten Anrufs anzeigen
set -u
UNIT="${UNIT:-voice-worker}"
journalctl -u "$UNIT" --since "${1:-15 min ago}" --no-pager \
  | grep -E "TRANSFER-|BRIEFING-|ROOM-CHECK|registered worker"
