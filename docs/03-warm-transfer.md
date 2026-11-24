# Warm transfer

## Principle

The caller is **never** moved to another room. The **human** is placed in a separate
consulting room, hears the briefing there, and is moved into the caller's room only
after approving. The caller stays in their room the whole time and only hears hold
music — the briefing never exists in their room.

## Phases

| # | Phase | What happens | Log marker |
|---|---|---|---|
| 1 | Hold | caller session input/output disabled, MOH track published | `TRANSFER-CALLER-ON-HOLD`, `TRANSFER-MOH-STARTED` |
| 2 | Consulting | token + `Room.connect` into `<caller-room>-human` | `TRANSFER-HUMAN-ROOM` |
| 3 | Dial | `createSipParticipant` with `waitUntilAnswered: true` | `TRANSFER-CHEF-ANSWERED` |
| 4 | Briefing | wave (summary **+** "Shall I connect you?") in the consulting room | `TRANSFER-BRIEFING-PLAYED` |
| 5 | Approval | second Phonic session asks nothing, waits for yes/no | `TRANSFER-AGENT-READY` |
| 6a | Approve | "Connecting." → MOH off → `MoveParticipant(human → caller room)` | `TRANSFER-ACCEPT`, `TRANSFER-MOVED` |
| 6b | Decline | "Okay, I will not connect." → `removeParticipant(human)` → caller session back | `TRANSFER-REJECT` |

After 6a both agents terminate (caller session `shutdown`, briefing room `disconnect`);
caller and human talk directly.

## Why the approval gate is a second session

The human must be able to say **yes or no** before the connection happens. The
caller-side session sits in the caller room and cannot hear the human in the
consulting room. The approval agent is therefore a second, short-lived Phonic
session joined to the consulting room. Its system prompt contains exactly one rule:
the question was already asked inside the wave, wait for the answer, then call
`connect` or `decline`.

## Why `waitUntilAnswered`

`createSipParticipant` returns immediately after initiating the call, while the human
is still ringing. A briefing played at that moment goes into an empty room. With
`waitUntilAnswered: true` the wave waits for the pickup.

## Why the question is inside the wave

Summary and question are produced in **one** TTS call:

```
<summary> Shall I connect you with the caller?
```

No seam between wave and agent voice, and the approval agent has nothing to say.

## Known characteristic: 150–200 ms residual MOH

During `MoveParticipant` the SIP participant is re-homed into the caller room; the
last frames of the MOH track are still in the line for the duration of the switch.
This is structural. Stopping MOH earlier only trades the music for silence.

## Failure modes

See `06-failure-modes.md` for the full table (briefing silent, briefing in the wrong
room, buzzing audio, overlap with MOH, …).
