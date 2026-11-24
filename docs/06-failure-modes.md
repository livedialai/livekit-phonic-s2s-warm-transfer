# Failure modes

Every entry below was hit in a real deployment. **Symptom → Cause → Fix.**

## Call never reaches the agent

| Symptom | Cause | Fix |
|---|---|---|
| Call rings out, PBX log shows `487 Caller cancelled` | INVITE sent to Cloud port 5060, Cloud listens on 5061 | trunk target `…:5061`, `transport = tls` |
| Cloud answers `404 No trunk found` | `X-Sip-Address` is the registrar, not the PBX IP | register numbers with the PBX IP as origin |
| Call lands in the wrong dispatch, agent never joins | a second (old) inbound trunk holds the same number | a number lives in exactly one trunk |
| `200 OK` but no agent | dispatch rule points to a different agent name | `lk sip dispatch list`, align the name |

## Agent joins but stays silent

| Symptom | Cause | Fix |
|---|---|---|
| No audio after answer | invalid Phonic voice: `4313 (private use) Invalid voice` | select the voice through the Phonic agent, not the raw `voice` field |
| Agent never stops talking | `minWordsToInterrupt` too high | set to `2` |
| Agent answers in English | `defaultLanguage` missing / `en` | `defaultLanguage: 'de'`, `additionalLanguages: []` |
| Agent ignores every prompt rule | prompt hardcoded in code instead of loaded from file | `fs.readFileSync('./prompt.txt')` — a 7-line constant silently overrides all DB edits |
| Agent uses informal address / reads out numbers | rules placed at the **end** of a 12k prompt | put inviolable rules at the **top** |

## Warm transfer

| Symptom | Cause | Fix |
|---|---|---|
| Tool call cancelled instantly (`cancelled due to user interruption`) | long-running tool inside a realtime session | run the transfer as a background task, return from the tool immediately |
| `Realtime model does not support resuming function calls` | `WarmTransferTask` (AgentTask) with an S2S session | own orchestration with `createSipParticipant` / `MoveParticipant` |
| `host.startsWith is not a function` | `new SipClient({host})` — object instead of string | `new SipClient(url, key, secret)` |
| `createSIPParticipant is not a function` | wrong method name | `createSipParticipant` |
| Human hears no briefing | wave played before the human picked up | `waitUntilAnswered: true` |
| Caller hears the briefing | briefing published in the caller room | briefing only inside the consulting room |
| Buzzing / noise instead of speech | Phonic TTS returns JSON `{"audio":"<base64>"}`, played as raw PCM | base64-decode the `audio` field |
| Log says `PLAYED`, audio silent | track unpublished 600 ms after publish; the queue is discarded | wait for the audio duration, then unpublish |
| MOH and briefing at the same time | MOH queue still running | `source.close()` + `await`, pause before the move |
| 150–200 ms of MOH at the human's ear | `MoveParticipant` transition | structural, accepted |

## MOH

| Symptom | Cause | Fix |
|---|---|---|
| No MOH at all | file is raw PCM without RIFF header | use a real WAV, parse the `data` chunk |
| MOH sounds like a test tone | test file instead of music | use the real hold music file |
| MOH distorted | 8 kHz mono without resampling | resample to 48 kHz |

## Operations

| Symptom | Cause | Fix |
|---|---|---|
| `EADDRINUSE 127.0.0.1:8082` | health port already bound | change `HEALTH_PORT` |
| Service takes forever to stop, ends in `SIGKILL` | process ignores SIGTERM (large heap) | raise `TimeoutStopSec` |
| 2 GB download during `npm install` | `@livekit/agents-plugin-silero` pulls onnxruntime | drop silero, use `inference.VAD` |
| Transfer fails with no INVITE in the log | PBX geo-IP firewall blocks Cloud IPs | allow the Cloud egress ranges |

## Data

| Symptom | Cause | Fix |
|---|---|---|
| "no contacts found" | adapter returns text, code expects a JSON array | parse the text lines (`parseForwards`) |
| Wrong number dialled | number chosen by the LLM instead of the server | resolve server-side; the agent only passes the name |
| Transfer calls an outdated number | stale row in the forwarding table | correct the record and confirm via API |

## Components we stopped using

- **Inworld TTS**: `Inworld WebSocket closed` / out of credits → briefing stays silent.
- **Cartesia**: prompt latency at 12k-char prompts, REFER transfers unreliable.
- **`WarmTransferTask`**: not compatible with Realtime S2S sessions (see above).
