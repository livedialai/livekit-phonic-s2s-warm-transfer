#!/usr/bin/env bash
# Prüft die MOH-Datei: RIFF-Header, Samplerate, Dauer
set -u
F="${1:-./music_hold.wav}"
[ -f "$F" ] || { echo "fehlt: $F"; exit 1; }
head -c 4 "$F" | od -c | head -1
ffprobe -v error -show_entries stream=sample_rate,channels -show_entries format=duration \
  -of default=nw=1 "$F"
