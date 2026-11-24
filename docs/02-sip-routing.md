# SIP routing

## Chain

```
carrier ──INVITE (To = DID)──► PBX :5060
                                 │ route "inbound-to-bridge"
                                 ▼
                         trunk "livekit-cloud" (TLS, :5061)
                                 │
                                 ▼
                    <project>.sip.livekit.cloud
                                 │  inbound trunk (numbers allowlist)
                                 ▼
                         dispatch rule → agent name
                                 │
                                 ▼
                    room  <prefix>__<caller>_<random>
                                 │
                                 ▼
                        worker (this repo)
```

## Numbers

- DIDs are registered with the carrier **and** with the Cloud inbound trunk.
- The inbound trunk carries `allowed_addresses` = the PBX IP (and loopback for local tests).
- The outbound trunk needs at least one number; `createSipParticipant` presents that number.

## Five trunk traps

1. **Port.** Cloud SIP listens on **5061/TLS**. A trunk pointing at `:5060` gets
   `487 Caller cancelled` and the call never exists as far as the Cloud is concerned.
2. **`X-Sip-Address`.** Must be the PBX public IP, not the registrar hostname —
   otherwise the provider-side routing fails with `404 No trunk found`.
3. **Duplicate numbers.** A number present in two inbound trunks is dispatched by the
   first match. Telephony "sometimes works" is usually two trunks fighting.
4. **Address whitelist.** Cloud trunks filter by `allowed_addresses`. After moving the
   PBX to a new IP, transfers fail with no INVITE in the PBX log — add the new range.
5. **Geo-IP firewalls.** A PBX that only allows domestic IPs drops the Cloud egress
   addresses. Symptom: outbound transfer dials, then nothing.

## Signalling-only PBX

For a Cloud-hosted call the PBX proxies only the INVITE. RTP terminates in the Cloud.
Capturing no media on the PBX is expected — debug media in the Cloud / on the worker.

## Verification

```bash
lk sip inbound list && lk sip outbound list && lk sip dispatch list
journalctl -u <pbx> -f | grep -E "INVITE|trunk|registration"
```
