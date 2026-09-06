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

The current Exotel automated dial adapter is a **call-control plane** (create call + status callbacks). The existing Workers AI speech path is an **in-app audio plane**. There is not yet repository evidence of a deployed bidirectional carrier media stream transporting Exotel call audio into Workers AI and synthesized audio back to the carrier.

A successful Exotel dial therefore does **not** by itself certify two-way autonomous audio. The live gate remains red until a real allow-listed UAT call proves both media directions and the evidence is attached.

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

The voice activation workflow sets only UAT-safe runtime values: `PAWSPACE_VOICE_ENV=uat`, `PAWSPACE_VOICE_UAT_APPROVED=true`, the two model names, the speech deadline and the Workers AI binding. `PAWSPACE_VOICE_LIVE_APPROVED` is deliberately not set.

## First-call procedure

1. Run `Voice UAT staging activation` for the exact certified SHA.
2. Sign in to `/team/voice` as an operator with `communications.call`.
3. Confirm Environment shows UAT mode, six Exotel secret names configured, HTTPS callback configured and the expected allow-list size.
4. Record explicit consent for the allow-listed test recipient using the existing governed `record_consent` API/action. Consent must reflect a real prior human grant; do not manufacture it for the test.
5. Run `policy_preview` for the exact recipient/use case and require all checks to pass.
6. Only during the approved 08:00–21:00 IST window, place one controlled call.
7. Open Audit and retain policy decisions, state transitions, signed carrier callbacks, transcript segments, barge-in events and handoff evidence.
8. Do not widen the allow-list or enable live/customer rollout as a workaround for a failing scenario.

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
