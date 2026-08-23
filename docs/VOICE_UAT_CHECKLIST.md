# Audio Bot / Telephony — Controlled Human UAT Checklist

**Status as of this change: ENGINEERING COMPLETE, OPERATIONALLY NOT CONNECTED.**

No voice call has ever been placed from this codebase, in any environment. There are no telephony
credentials in any environment this code has run in, so the Exotel adapter in
`lib/voice-telephony-provider.ts` has never exchanged a packet with Exotel. Everything below the
"Configuration" heading is work for a human with access to the provider accounts; nothing in this
document may be read as evidence that a call happened.

What *is* verified is the engineering: the state machine, the pre-dial policy gate, the callback
verification and deduplication, the SSRF/audio guard and the speech-failure classification are all
executed by tests in this repository against a real SQLite-backed D1 shape and an injected transport.

---

## 1. Current component state

| Component | State | Where |
|---|---|---|
| Call lifecycle state machine (27 states, exhaustive adjacency) | IMPLEMENTED | `lib/voice-call-state.ts` |
| Environment gate — voice OFF by default, no client-side enablement | IMPLEMENTED | `lib/voice-call-gate.ts` |
| Telephony provider contract (create call, callback verify, event normalise) | IMPLEMENTED | `lib/voice-telephony-provider.ts` |
| Exotel adapter (Connect API + Basic/HMAC callback verification) | IMPLEMENTED, **NOT CONNECTED** — no credentials, never executed against Exotel | `lib/voice-telephony-provider.ts` |
| Local simulator transport | IMPLEMENTED, **NON-PRODUCTION** — reports `productionCapable: false` | `lib/voice-telephony-provider.ts` |
| Pre-dial policy gate (10 checks, every decision persisted) | IMPLEMENTED | `lib/voice-outbound-governance.ts` |
| Call ledger, state-transition trail, policy-decision trail, curated provider events | IMPLEMENTED | `lib/voice-outbound-governance.ts` |
| Retry with correlation and re-proved policy | IMPLEMENTED | `lib/voice-outbound-governance.ts` |
| Human handoff into the Ops case queue | IMPLEMENTED | `lib/voice-outbound-governance.ts` |
| Governed call scripts (disclosure validation, claim restriction) | IMPLEMENTED | `lib/voice-outbound-governance.ts` |
| STT / TTS contract, fail-closed stubs | IMPLEMENTED | `lib/ai-voice-uat.ts` |
| Cloudflare Workers AI speech engine (first-party) | IMPLEMENTED — requires the `AI` binding | `lib/voice-workers-ai.ts` |
| Self-hosted HTTP speech engine | IMPLEMENTED, **NOT CONNECTED** — no endpoint configured | `lib/voice-provider-adapter.ts` |
| SSRF / audio-safety guard (shared by every voice path) | IMPLEMENTED | `lib/voice-safe-fetch.ts` |
| Speech failure classification + deadlines | IMPLEMENTED | `lib/voice-speech-failures.ts` |
| In-app conversation (transcript segments, barge-in, orchestrated AI turns) | IMPLEMENTED | `lib/ai-voice-uat.ts` |
| Outbound sales / pitch calling | IMPLEMENTED, **DISABLED** — no formal business approval on record | gated by `PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED` |
| Call recording | IMPLEMENTED, **DISABLED** — consent/compliance decision not taken | gated by `PAWSPACE_VOICE_RECORDING_APPROVED` |
| Live voice mode | **NOT AVAILABLE** — double-gated and never exercised | `PAWSPACE_VOICE_LIVE_APPROVED` |
| Operator UI surface for voice | NOT IMPLEMENTED — API only (`/api/voice-outbound`) | — |

## 2. Configuration — secret and variable NAMES only

Nothing below is a value. Set these as Cloudflare Worker secrets/vars in an isolated UAT
environment first. **Never commit a value to this repository.**

### Enablement (all default to off)

| Name | Purpose |
|---|---|
| `PAWSPACE_VOICE_ENV` | `uat` to enable controlled UAT calling. Absent or anything else = voice disabled. |
| `PAWSPACE_VOICE_UAT_APPROVED` | Must be exactly `true`. A second, deliberate switch. |
| `PAWSPACE_VOICE_UAT_ALLOWLIST` | Comma- or newline-separated recipient numbers that may be dialled. **Required** — an empty list disables voice rather than allowing everything. Whitespace inside a number is fine (`+91 98765 43210`). |
| `PAWSPACE_VOICE_LIVE_APPROVED` | Only for `PAWSPACE_VOICE_ENV=live`. Do not set until controlled UAT is signed off. |
| `PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED` | Must be `true` before `lead_qualification` or `sales_pitch` calls are possible. **Leave unset until outbound sales calling is formally approved.** |
| `PAWSPACE_VOICE_RECORDING_APPROVED` | Must be `true` before any recording reference is retained. **Leave unset until the recording consent policy is signed off.** |
| `PAWSPACE_VOICE_STATUS_CALLBACK_URL` | Absolute **https** URL of `/api/voice-provider-webhook` on this deployment. **Required** — without it a provider would accept the dial and we would never learn the outcome, so the gate refuses. An `http` URL is refused too. |
| `PAWSPACE_VOICE_TRANSPORT` | Set to `local_simulator_non_production` ONLY for engineering tests. Ignored when `PAWSPACE_VOICE_ENV=live`. |

### Telephony provider (Exotel — the provider already selected in `INT-VOICE-01`)

| Name | Purpose |
|---|---|
| `EXOTEL_API_KEY` | Exotel API key. |
| `EXOTEL_API_TOKEN` | Exotel API token. |
| `EXOTEL_SID` | Exotel account SID. |
| `EXOTEL_CALLER_ID` | The Exophone the call originates from. |
| `EXOTEL_VOICE_APP_ID` | The Exotel voice app / flow the call is connected to. |
| `EXOTEL_WEBHOOK_SECRET` | Shared secret for callback verification (see §3). |
| `EXOTEL_SUBDOMAIN` | Optional. Defaults to `api.exotel.com`; set for a regional endpoint. |

All six of the first group are required together, as is the https status callback above. With any one
missing the gate refuses and names the missing variable — it does not degrade to a silent no-op.

### Speech (choose ONE engine)

First-party (preferred — speech stays inside our own Cloudflare stack):

| Name | Purpose |
|---|---|
| `AI` | Cloudflare Workers AI binding. Its presence selects the first-party engine. |
| `VOICE_STT_MODEL` | Optional. Defaults to `@cf/openai/whisper`. |
| `VOICE_TTS_MODEL` | Optional. Defaults to `@cf/myshell-ai/melotts`. |

Self-hosted HTTP endpoint (fallback):

| Name | Purpose |
|---|---|
| `VOICE_STT_API_KEY`, `VOICE_STT_URL` | Both required together. |
| `VOICE_TTS_API_KEY`, `VOICE_TTS_URL` | Both required together. |
| `VOICE_STT_PROVIDER`, `VOICE_TTS_PROVIDER` | Optional labels for the readiness surface. |
| `VOICE_ENGINE` | Optional. `http_endpoint` forces the self-hosted engine even when the `AI` binding exists. |

Shared:

| Name | Purpose |
|---|---|
| `VOICE_AUDIO_ALLOWED_HOSTS` | Comma-separated hostnames that may be fetched for audio. Everything else is refused; private, loopback, link-local and cloud-metadata destinations are refused regardless of this list. |
| `VOICE_SPEECH_TIMEOUT_MS` | Optional. Default 12000; honoured between 1000 and 60000. |

## 3. Callback verification — what to configure at the provider

The receiver at `POST /api/voice-provider-webhook` accepts exactly two mechanisms and refuses
everything else with 401:

1. **HMAC-SHA256** — `x-pawspace-voice-signature` = hex HMAC of `${timestamp}.${rawBody}` keyed on
   `EXOTEL_WEBHOOK_SECRET`, with `x-pawspace-voice-timestamp` inside a 5-minute window. Use this if
   the callback passes through anything of ours that can sign.
2. **HTTP Basic** — password equal to `EXOTEL_WEBHOOK_SECRET`. Exotel's status callback cannot
   HMAC-sign a payload, but its callback URL can carry Basic credentials, so this is the mechanism to
   configure at Exotel. It has no freshness of its own; replay is handled by provider-event
   deduplication on `(provider, provider_event_id)`.

A query-string token is deliberately **not** accepted — it would land in access logs and referrers.

Configure the Exotel StatusCallback to the `PAWSPACE_VOICE_STATUS_CALLBACK_URL` above, with
`StatusCallbackEvents` covering call progress, completion and (only if recording is approved)
recording availability.

## 4. Data seeding before the first UAT call

Voice consent is proved from a stored record; the caller cannot assert it. For each allow-listed test
recipient, before dialling:

```http
POST /api/voice-outbound  { "action": "record_consent",
                            "phone": "<allow-listed number>",
                            "subjectType": "customer", "subjectId": "<customer id>",
                            "granted": true, "source": "<where consent was actually given>" }
```

Then confirm what the gate would decide, without creating or dialling anything:

```http
POST /api/voice-outbound  { "action": "policy_preview", "useCase": "booking_confirmation",
                            "phone": "...", "cityId": "blr", "customerId": "...", "bookingId": "..." }
```

Also confirm the governed script for each use case (`GET /api/voice-outbound` → `scripts`). Each
opening disclosure must identify PawSpace, state that the call is automated, offer a human, and offer
an opt-out; a script making a price, refund or offer claim is refused unless that script is explicitly
claims-approved.

## 5. Controlled human UAT scenarios

Run these in order, against allow-listed numbers only, with a human on the line. For every scenario
the evidence is the call audit: `GET /api/voice-outbound?scope=audit&callId=<id>`, which returns the
policy-decision trail, the state-transition trail and the curated provider events.

| # | Scenario | Expected terminal state | Expected evidence |
|---|---|---|---|
| 1 | Successful call to an allow-listed, consented recipient | `ended` via `connected` → `completed` | all 10 policy checks passed; `dialed_at` and `connected_at` set |
| 2 | Consent absent | `blocked_consent` | `voice_consent` failed; `dialed_at` NULL; no provider event |
| 3 | Recipient previously opted out | `blocked_opt_out` (or `blocked_consent` — an opt-out revokes consent) | `opt_out_clear` failed; `dialed_at` NULL |
| 4 | Dial attempted inside quiet hours | `blocked_quiet_hours` | `quiet_hours` failed with the local hour and the window |
| 5 | Recipient not on the allow-list | `blocked_not_allowlisted` | `uat_allowlist` failed; `dialed_at` NULL |
| 6 | Telephony credentials removed | `blocked_disabled` naming the missing variable | no provider contact |
| 7 | Provider returns an error on dial | `provider_unavailable` / `provider_error` | `dialed_at` NULL; transition trail ends at the failure |
| 8 | Recipient's line busy | `busy` → `ended` | provider event `busy` applied |
| 9 | Recipient does not answer | `no_answer` → `ended` | provider event `no_answer` applied |
| 10 | Recipient interrupts the bot (barge-in) | continues, `speaking`/`listening` recorded | `ai_voice_events` row `barge_in` |
| 11 | STT fails mid-call | `stt_failed`, then handoff | `failure_reason_class = speech_stack_failure` |
| 12 | TTS fails mid-call | `tts_failed`, then handoff | `failure_reason_class = speech_stack_failure` |
| 13 | AI turn times out | `handoff_requested` → `ai_handoff` | a real case id on the call row |
| 14 | Recipient asks for a human | `ai_handoff` | case created in the Ops queue |
| 15 | Recipient opts out during the call | `ended`, opt-out stored | `voice_call_opt_outs` row; the next request for that number is blocked |
| 16 | Retry after no-answer | new call correlated by `retry_of` | the retry re-ran all 10 checks; bounded by the use case's `maxAttempts` |
| 17 | Provider redelivers a callback | unchanged | one `voice_call_provider_events` row; no second transition |
| 18 | Callback with a bad/absent signature | unchanged | 401; nothing recorded |

Two provider behaviours to confirm explicitly during scenario 1, because the engineering depends on
which one Exotel actually does:

- **Does the StatusCallback fire only once, at the end?** If so, a lone `CallStatus=completed` arrives
  while the ledger still says `dialing`. That is handled: the receiver applies the missing `connected`
  hop first, marked `inferred: true` in the transition detail, then applies `completed`. Check the audit
  trail shows `dialing → connected (inferred) → completed`.
- **Does it also fire on progress events?** If `StatusCallbackEvents` includes in-progress callbacks,
  the trail should show observed `ringing`/`connected` steps with no `inferred` flag.

Also worth watching on the readiness surface after each run: `unappliedProviderEvents` should be 0 and
`callsOpenOverAnHour` should be 0. A non-zero value means a callback could not be applied to any legal
state — investigate before running more scenarios rather than assuming the call completed.

Scenarios 2–5, 7–9 and 15–18 are already executed as automated tests against the simulator
(`tests/voice-outbound-policy.test.mjs`, `tests/voice-provider-webhook.test.mjs`). Running them again
here is about proving the *provider* behaves as the contract assumes, not about proving the logic.

## 6. Explicitly out of scope for this UAT

- **Live voice mode.** `PAWSPACE_VOICE_LIVE_APPROVED` must stay unset.
- **Outbound sales / pitch calling.** No formal approval is on record, so
  `PAWSPACE_VOICE_SALES_OUTBOUND_APPROVED` stays unset and both sales use cases remain refused.
- **Call recording.** Requires a recording-consent policy decision first.
- **Production customer calls.** The allow-list is the boundary; do not widen it to reach real
  customers during UAT.

## 7. What would move this to operationally verified

`INT-VOICE-01` stays at `sandbox_setup_required` until, in an isolated UAT environment: the six Exotel
variables are configured; the callback receiver has verified at least one real signed provider callback;
and at least one allow-listed call has completed with a full audit trail. Until then, the honest
statement is the one at the top of this document.
