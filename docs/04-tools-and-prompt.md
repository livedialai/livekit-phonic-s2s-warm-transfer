# Tools and prompt

## Caller-session tools

| Tool | Parameter | Returns | Purpose |
|---|---|---|---|
| `price_lookup` | `query` | text | price of an item |
| `offers_lookup` | `query` | text | current offers |
| `contacts` | – | **names only** | list people who can take a transfer |
| `transfer_to` | `name` | confirmation | start the warm transfer |

**Rule:** `transfer_to` receives **only a name**. The number is resolved server-side
from the forwarding API. The agent never sees a phone number and therefore cannot read
it out or invent one.

## Adapter response formats

- `contacts` returns **text**, not JSON:
  ```
  {"result":"Available contacts:\n1) <name> → +49…\n2) …"}
  ```
  The worker parses these lines (`parseForwards`) and strips numbers before the agent
  sees anything.
- The other tools return plain text that goes straight into the dialogue.

## Prompt rules (excerpt)

The rules that must never be broken go at the **top** of the prompt — at the end of a
long prompt they get lost:

1. Address the caller formally (German "Sie"; adapt per locale).
2. **Never** speak a phone number.
3. On "manager / staff": do not ask, do not mention a number, say one sentence and
   call `transfer_to` immediately.
4. Answer in one or two short sentences, no filler.

## Prompt loading

```js
const INSTRUCTIONS = fs.readFileSync(new URL('./prompt.txt', import.meta.url), 'utf8');
```

Load on start, so prompt edits need a restart but no code change. A hardcoded prompt
in the code silently overrides every database-driven edit — this exact mistake cost
hours.

## Summary LLM

- Input: last ~24 turns from `session.history`.
- Prompt: "Summarise the call in 2–3 short sentences. Facts only …".
- Output goes into the Phonic TTS (the wave), never into the dialogue.

## Debug markers

| Marker | Meaning |
|---|---|
| `TRANSFER-LOOKUP <name> -> <number>` | name resolved |
| `TRANSFER-TRANSCRIPT-LEN <n>` | transcript length (0 = no briefing possible) |
| `TRANSFER-SUMMARY "<text>"` | generated summary |
| `TRANSFER-TTS-BYTES <n>` | size of the decoded wave |
| `BRIEFING-DURATION-MS <n>` | planned playback duration |
| `TRANSFER-ACCEPT` / `TRANSFER-REJECT` | approval gate outcome |
