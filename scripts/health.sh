#!/usr/bin/env bash
# Worker-Health und Registrierung prüfen
set -u
echo "== Dienst =="
systemctl is-active voice-worker 2>/dev/null || systemctl is-active edeka-phonic-worker
echo "== Health =="
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:${HEALTH_PORT:-8095}/" || true
echo "== Registrierung =="
journalctl -u voice-worker --since "5 min ago" --no-pager 2>/dev/null | grep -c "registered worker" || true
