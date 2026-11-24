# Test harness — what each check proves

| Question | Proof | What it does **not** prove |
|---|---|---|
| Does the carrier accept the call? | `200 OK` in the PBX log, `registration successful` | that the agent answers |
| Does the call reach the Cloud? | `processing invite` + `SIP participant joined room` | that the agent joins |
| Does the agent join? | `registered worker` + job log with a room | that audio flows |
| Does the agent speak? | `AGENT-SAID …` in the log / transcript | that the caller hears it |
| Does the caller hear the agent? | **a real call from outside** | – |
| Does the transfer run? | `TRANSFER-CHEF-ANSWERED` → `TRANSFER-MOVED` | that the human hears anything |
| Does the briefing arrive? | `TRANSFER-BRIEFING-PLAYED` + `BRIEFING-DURATION-MS` | intelligibility |
| Does the approval gate work? | `TRANSFER-ACCEPT` / `TRANSFER-REJECT` | correct handling of ambiguous answers |
| Is the hold music audible? | **a real call** | – |

## Rule

A green log line is **not** proof of a working phone path. Every change to SIP,
trunks, dispatch or audio is accepted with a **real call from outside** — not with a
cloud probe and not with a log grep.

## Tooling

```bash
journalctl -u voice-worker -f | grep -E "TRANSFER-|BRIEFING-|registered worker"
journalctl -u <pbx> -f | grep -E "INVITE|registration|trunk"
lk sip inbound list && lk sip outbound list && lk sip dispatch list
```

`evidence/` holds excerpts of real runs (SIP codes, log lines, timestamps). Names and
numbers are neutralised, measurements unchanged.
