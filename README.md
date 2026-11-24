> **Status:** reference implementation, extracted from a working production deployment.
> Vendor-neutral example — no customer data, no brand, no real phone numbers.

# LiveKit Cloud + Phonic S2S — Warm Transfer (Node)

**A guided warm transfer for a Realtime S2S voice agent: briefing audio, spoken
approval gate, and a defined return path when the human declines.**

This is built specifically for **Phonic as the Realtime S2S model**. The caller talks
to Phonic (German voice in production, any Phonic voice here). The briefing wave is
generated through the **Phonic TTS endpoint**. There is deliberately **no cascade
pipeline** (no Deepgram/Inworld), no `WarmTransferTask` and no Inworld realtime.

---

## Why this exists

Transfer tools from the usual vendors ship the **mechanics** — dial, bridge, SIP REFER,
caller-ID, DTMF. What they do not ship is the **guided** part:

| Capability | Phonic transfer tools | LiveKit `WarmTransferTask` | This repo |
|---|---|---|---|
| Dial a human and bridge | ✅ | ✅ | ✅ |
| Music on hold for the caller | ❌ | ✅ (`holdAudio`) | ✅ |
| Spoken briefing for the human **before** connecting | ❌ | ✅ (LLM) | ✅ (pre-rendered wave) |
| Human can **decline**, caller is returned | ❌ | ❌ | ✅ |
| Question to the human is part of the briefing audio | ❌ | ❌ | ✅ |
| Works with a Realtime S2S session | ✅ | ❌ (needs conversation history) | ✅ |

Without a briefing, a "warm" transfer is a blind transfer with a hold message — the
human asks everything again and the caller repeats themselves. This repo implements
the part that makes the transfer actually warm.

---

## Flow

```
Caller ──► SipLoad ──► SIP-PBX ──► LiveKit Cloud (SIP trunk) ──► dispatch rule
                                                                      │
                                                                      ▼
                                                        Node worker (this repo)
                                                        Phonic Realtime S2S
                                                                      │
                              "Chef" ─────────────────────────────────┤
                                                                      ▼
  1  Caller on hold            session input/output disabled + MOH track
  2  Consulting room           token + Room.connect to  <caller-room>-human
  3  Dial the human            createSipParticipant(waitUntilAnswered: true)
  4  Briefing wave             summary + "Shall I connect you?" in ONE TTS call
  5  Approval gate             second Phonic session listens for yes / no
  6a Approve                   "Connecting." → MoveParticipant(human → caller room)
                               both agents shut down, nobody talks anymore
  6b Decline                   "Okay, I will not connect." → removeParticipant(human)
                               caller session audio back on → generic reply
                               "Can I help with anything else, or would you like
                                to try again later?"
```

The **caller never changes rooms**. The human is moved into the caller's room at the
very end, so the caller never hears the briefing — no subscription juggling needed.

---

## Why `waitUntilAnswered: true`

`createSipParticipant` returns as soon as the call is initiated, while the human is
still ringing. Playing the briefing at that point sends it into an empty room.
`waitUntilAnswered` blocks until the human picks up, then the wave plays.

## Why the question is inside the wave

The summary and the approval question are rendered in a **single** TTS call:

```
<summary> Shall I connect you with the caller?
```

This removes any seam between the wave and the agent voice. The approval agent does
not ask anything — it only waits for yes/no and calls its tool.

---

## Quick start (sketch)

```bash
cp config/worker.env.example .env      # fill in your own values
npm install
node agent.js start                    # registers with LiveKit Cloud
```

Environment (see `config/worker.env.example` for the full list):

| Variable | Purpose |
|---|---|
| `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET` | LiveKit Cloud project |
| `PHONIC_API_KEY` | Phonic Realtime + TTS |
| `LIVEKIT_SIP_OUTBOUND_TRUNK` | trunk id used for `createSipParticipant` |
| `MOH_FILE` | music-on-hold WAV (48 kHz, RIFF) |
| `TRANSFER_NUMBER` | fallback destination when the caller asks for a person |
| `HEALTH_PORT` | local health endpoint |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL` | any OpenAI-compatible model for the summary |

The database / tenant prompt wiring is deployment-specific and intentionally left
out. `docs/04-tools-and-prompt.md` describes the contract.

---

## Documentation

| File | Content |
|---|---|
| `docs/01-architecture.md` | components, signalling vs media, state model |
| `docs/02-sip-routing.md` | carrier → PBX → Cloud, trunk gotchas |
| `docs/03-warm-transfer.md` | phase table, approval gate, known 150–200 ms MOH tail |
| `docs/04-tools-and-prompt.md` | tool contracts, adapter formats, prompt rules |
| `docs/05-operations.md` | services, change order, rollback, capacity |
| `docs/06-failure-modes.md` | **every real failure we hit**, symptom → cause → fix |
| `docs/07-test-harness.md` | what each test proves — and what it does not |
| `docs/ROLES.md` | role → value table with placeholders |

Start with `docs/06-failure-modes.md`. It is the most valuable file here: a JSON
body parsed as raw PCM, a track unpublished before playout, a briefing played into
an empty room — each of those cost hours and is documented with the exact fix.

---

## Known characteristics (not bugs)

- **150–200 ms MOH tail at the human's ear.** `MoveParticipant` re-homes the SIP
  participant; the last frames of the hold track are still in the line during the
  switch. Stopping MOH earlier only trades it for silence.
- **Anthropic/Phonic session limits** are contractual, not technical. Concurrent
  realtime sessions are capped by the vendor, not by this worker.
- **Memory is the local ceiling.** Each job process holds ~130 MB before a call;
  plan for ~150–250 MB per active call and scale horizontally, not vertically.
- **Latency measured in production:** 199–743 ms end-of-speech → reply start,
  median **266 ms**, p90 **324 ms** for pure speech turns (84 turns measured).
  Tool turns add the tool time (summary + TTS + dial ≈ 3.6 s for a transfer).

---

## License

MIT. Use it, fork it, sell your own version — a note that it helped would be nice.
