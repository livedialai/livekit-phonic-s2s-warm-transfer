# Operations

## Services

| Service | Host | Start | Log |
|---|---|---|---|
| worker (this repo) | worker host | `systemctl start voice-worker` | `journalctl -u voice-worker -f` |
| SIP PBX | PBX host | `systemctl restart <pbx>` | `journalctl -u <pbx> -f` |
| webhook adapter | adapter host | own unit | unit log |
| LiveKit Cloud | cloud | – | dashboard / `lk` CLI |

## Standard commands

```bash
sudo systemctl restart voice-worker                 # drops active calls
journalctl -u voice-worker --since "2 min ago" | grep "registered worker"
journalctl -u voice-worker --since "10 min ago" | grep -E "TRANSFER-|BRIEFING-"
```

## Change order

1. **Prompt** → restart.
2. **Code** → `node --check`, then restart.
3. **Env** → restart.
4. **Cloud dispatch / trunk** → no restart, verify with `lk sip dispatch list`.
5. **PBX route** → restart PBX (drops active calls).

After every change: a **real call from outside**. A log line alone proves nothing
(see `07-test-harness.md`).

## Rollback

```bash
cp agent.js.bak-<date> agent.js && node --check agent.js && sudo systemctl restart voice-worker
```

Config backups live next to the files (`*.bak-*`). Note trunk/dispatch ids before
changing them.

## Capacity

- One Node process, ~130 MB RSS per job worker before any call is active.
- Budget 150–250 MB per concurrent call → roughly 30–50 concurrent calls on 8 GB.
- Scale **horizontally** (more worker processes / hosts), not by growing one process.
- Vendor session limits (Phonic) and SIP concurrency (Cloud plan) cap parallel calls
  before local resources do.

## Measured latency (production, S2S only)

| Metric | Value |
|---|---|
| end-of-speech → reply start | median **266 ms**, p90 **324 ms**, min 199 ms, max 743 ms |
| turns measured | 84 |
| tool turn (transfer: summary + TTS + dial) | ≈ 3.6 s |
| approval turn (understand + move) | ≈ 0.5 s |

The 743 ms outlier correlates with `event loop blocked` immediately before — a
synchronous 5.7 MB file read. Load large assets asynchronously.

## Deliberately not built

No HA, no second worker, no load balancer, no monitoring/alerting, no automatic
fallback to a second vendor.
