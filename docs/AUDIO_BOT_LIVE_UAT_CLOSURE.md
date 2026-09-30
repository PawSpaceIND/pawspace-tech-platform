# Audio Bot / Exotel — Live UAT Closure Gate

Status: **REPOSITORY READY FOR CONTROLLED UAT; LIVE CARRIER MEDIA CERTIFICATION PENDING.**

This document supersedes the stale statement in `VOICE_UAT_CHECKLIST.md` that the operator UI is not implemented. `/team/voice` now provides the governed dial console, readiness, policy preview, call ledger, 27-state transition audit, provider callback audit, transcript segments, barge-in visibility and operator handoff controls.

## What is connected in code

- Exotel Connect API dial + signed/basic-auth callback adapter.
- Fail-closed UAT environment gate and explicit recipient allow-list.
- Stored consent, opt-out, quiet-hours and frequency-cap checks before dial.
- Cloudflare Workers AI speech providers, defaulting to `@cf/openai/whisper-large-v3-turbo` for STT and `@cf/myshell-ai/melotts` for TTS.
- Canonical AI conversation segments, barge-in events and human handoff.
- Explicit manual workflow `.github/workflows/voice-uat-staging.yml` to activate voice only on isolated `pawspace-staging`; it never places a call.

## Important remaining boundary

The repository now contains the native bidirectional carrier path: direct Exotel AgentStream connects to the PawSpace WebSocket handler, linear16 carrier audio is transcribed by Workers AI, the governed Maya/Atlas turn runs on the canonical PawSpace conversation, and carrier-safe linear16 TTS is streamed back. A private, staff-only native-UAT override can exercise that path while ordinary staging calls remain pinned to ElevenLabs.

That is executable architecture, not live-carrier certification. A successful Exotel dial or automated simulator test does **not** by itself certify two-way autonomous audio. The live gate remains red until a real single-allowlisted UAT call proves carrier audio -> STT -> Maya/Atlas -> TTS -> carrier audio, including callback reconciliation and failure recovery, with sanitized evidence attached.

## Required staging configuration

Encrypted secrets (values never committed or printed):

- `EXOTEL_API_KEY`
- `EXOTEL_API_TOKEN`
- `EXOTEL_SID` (canonical repository name; use the Exotel account SID value here)
- `EXOTEL_CALLER_ID`
- `EXOTEL_VOICE_APP_ID`
- `EXOTEL_WEBHOOK_SECRET`
- `PAWSPACE_VOICE_UAT_ALLOWLIST`

Administrator-controlled non-secret variable:

- `PAWSPACE_VOICE_STATUS_CALLBACK_URL_UAT` — absolute HTTPS URL for `/api/voice-provider-webhook` on the isolated staging deployment.

The voice activation workflow sets only UAT-safe runtime values: `PAWSPACE_VOICE_ENV=uat`, explicitly pins ordinary routing to `PAWSPACE_VOICE_RUNTIME=elevenlabs`, enables the private native-UAT approval, sets AgentStream STT to auto-detect, pins the approved speech models and deadline, and binds Workers AI. `PAWSPACE_VOICE_LIVE_APPROVED` is deliberately not set.

## First-call procedure

1. Run `Voice UAT staging activation` for the exact certified SHA.
2. Sign in to `/team/voice` as an operator with `communications.call`.
3. Confirm Environment shows UAT mode, six Exotel secret names configured, HTTPS callback configured and the expected allow-list size.
4. Record explicit consent for the allow-listed test recipient using the existing governed `record_consent` API/action. Consent must reflect a real prior human grant; do not manufacture it for the test.
5. Confirm the activation summary says ordinary voice runtime is ElevenLabs, controlled native AgentStream UAT is enabled, and STT language mode is auto-detect.
6. Run `policy_preview` for the exact recipient/use case and require all checks to pass.
7. From the staff voice surface/API invoke only the governed `uat_native_agentstream_test` action for the canonical customer (and booking for booking confirmation). The route loads the phone from canonical customer ownership; it does not accept a dial number from the request.
8. Only during the approved 08:00–21:00 IST window, place one controlled native call. Ordinary calls must continue to resolve to ElevenLabs.
9. Open Audit and retain policy decisions, state transitions, Exotel Call Details reconciliation, transcript segments, language/latency diagnostics, barge-in events and handoff evidence.
10. Do not widen the allow-list, flip the global runtime away from ElevenLabs, or enable live/customer rollout as a workaround for a failing scenario.

## 18-scenario certification matrix

The scenarios remain those in `VOICE_UAT_CHECKLIST.md`: completed call; missing consent; opt-out; quiet hours; non-allowlisted recipient; missing credentials; provider dial error; busy; no-answer; barge-in; STT failure; TTS failure; AI timeout/handoff; explicit human request; in-call opt-out; retry; duplicate callback; bad/absent callback signature.

Automated simulator coverage is supporting evidence only. A scenario may be marked **LIVE VERIFIED** only when its staging run has provider/call evidence. Cases whose purpose is to prove a local policy refusal may be executed without ringing a phone, but the carrier-dependent scenarios must use the real UAT provider.

## Closure rule

Audio Bot is operationally closed only when all of the following are true:

- protected CI is green on the exact code SHA;
- isolated voice-UAT staging activation succeeds;
- Workers AI STT and TTS readiness is connected;
- a real signed Exotel callback is received;
- at least one allow-listed, consented two-way call completes inside the approved time window;
- carrier audio -> STT -> AI turn -> TTS -> carrier audio is evidenced end to end;
- human handoff creates a real Ops case and preserves the canonical conversation;
- all 18 UAT scenarios have sanitized evidence attached to the staging release gate;
- `PAWSPACE_VOICE_LIVE_APPROVED` remains unset until separate production approval.
