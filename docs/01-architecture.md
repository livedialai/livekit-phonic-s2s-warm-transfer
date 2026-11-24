# Architecture

## Components

| Component | Role | Technology |
|---|---|---|
| SIP carrier | provides the DID, sends the INVITE | SIP trunk with registration |
| SIP PBX | accepts the call, routes to the Cloud over TLS | RustPBX (any B2BUA works) |
| LiveKit Cloud | SFU, SIP gateway, dispatch to the worker | Cloud project + SIP trunks |
| Worker (this repo) | agent orchestration, tools, transfer logic | Node.js, `@livekit/agents` |
| Phonic | Realtime S2S (STT+LLM+TTS) and TTS endpoint | Phonic cloud API |
| Webhook adapter | prices / offers / forwarding list | your own HTTP endpoints |
| Audio assets | hold music | 48 kHz RIFF WAV |

## Signalling vs media

```
SIP (signalling)      carrier ──udp/tcp──► PBX ──tls──► Cloud
Media (RTP)           carrier ◄─────────► Cloud (SFU)     ← PBX only forwards signalling
Agent audio           Cloud ◄──WebRTC──► worker           ← worker only exchanges frames
```

The PBX never carries media for a Cloud-hosted call. It only proxies the INVITE; the
RTP path ends in the Cloud. This matters when debugging: no audio on the PBX capture
does **not** mean the call has no audio.

## State model (one call)

```
caller room                    consulting room
────────────                   ────────────────
[SIP participant]              (created on demand)
[caller session: Phonic]  ──►  [briefing bot: Room.connect]
[MOH audio track]              [human: createSipParticipant]
                               [approval session: Phonic]
```

Both rooms belong to the same LiveKit project; the worker holds a WebRTC connection
to each. The agent identity of the briefing bot is separate from the dispatch agent
so the approval session is not picked up by the dispatcher.

## Where the intelligence sits

| Layer | Owner |
|---|---|
| Turn detection, denoising, interruption | Phonic |
| Speech + language | Phonic |
| Tool decisions | Phonic LLM (via tool schemas) |
| Data (prices, offers, people) | webhook adapter |
| Briefing text | OpenAI-compatible LLM (summary of transcript) |
| Briefing audio | Phonic TTS |
| Room moves, dial, hold music | this worker |

The worker is an orchestrator: it moves participants and plays audio. It does not
run STT, LLM or TTS in the conversation path.
