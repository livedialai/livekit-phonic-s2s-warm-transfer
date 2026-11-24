# Roles → values

This is the **only** file that carries installation-specific identifiers, and here they
are **placeholders**. Substitute your own values; nothing else in the repository needs
to change.

| Role | Placeholder |
|---|---|
| SIP carrier registrar | `<carrier-registrar>` |
| PBX host (public IP) | `<pbx-host>` |
| PBX trunk → Cloud | `<cloud-trunk>`, target `<cloud-sip-host>:5061`, `transport = tls` |
| LiveKit project | `<livekit-project>` |
| Cloud SIP host | `<cloud-sip-host>` |
| Cloud inbound trunk | `<inbound-trunk-id>` (numbers `<did-range>`) |
| Cloud outbound trunk | `<outbound-trunk-id>` (number `<did-outbound>`) |
| Dispatch rule | `<dispatch-id>`, agent name `<agent-name>`, room template `<prefix>__<caller>_<random>` |
| Worker host | `<worker-host>`, directory `<worker-dir>` |
| Worker service | `<worker-service>.service`, health port `8095` |
| Phonic agent / voice | `<phonic-agent>`, voice `<voice-id>`, language `<locale>` |
| Phonic API | `https://api.phonic.ai/v1` |
| Webhook adapter | `<adapter-base-url>/{price,offers,contacts}` |
| Tenant database | `<db-host>` / `<db-name>`, tenant `<tenant-id>` |
| Prompt record | `<prompt-table>.<id>` |
| Forwarding table | `<forwarding-table>` (name → number rows) |
| MOH file | `<moh-file>` (48 kHz RIFF WAV) |
| Summary LLM | OpenAI-compatible, model `<model-id>` |

## Secrets (never in the repo)

| Value | Location |
|---|---|
| LiveKit API key / secret | service environment |
| Phonic API key | secrets store |
| LLM key | secrets store |
| PBX SSH | secrets store |
| Tenant JWT secret | secrets store |

## Free choices

Agent name, room prefix, tenant id and market name are free — they only have to be
**identical** across worker (`.env`), dispatch rule and database.
