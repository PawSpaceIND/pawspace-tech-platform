# AI guardrails for controlled human UAT

Base: `11ab937275cbfba6ea05adb167224d7a24b14d58`. This change does not select a different voice provider, change credentials, widen customer rollout, place calls, send external messages, activate knowledge, merge or deploy.

## Changes

- Generic ElevenLabs replies use the same final draft validation as the conversation orchestrator. Negative catalogue-price verification cannot become a pass. Speculative model text is withheld until complete validation, current customer/thread ownership, AI ownership, handoff and customer-audience checks pass. Reply persistence rechecks ownership/handoff atomically. Generated messages remain `ready`, not `sent`; a final refusal marks them `suppressed`. Provider receipt evidence, not a returned function, must establish delivery. A valid complete answer still uses the existing Responses SSE transport. Action envelopes stay in the governed orchestrator.
- Voice service credentials no longer stand in for permission to talk to customers when rollout is off/staff-only or outside the approved UAT environment. This is intentionally fail-closed and requires the existing customer rollout gate to be set appropriately by an authorized operator.
- AI request/token/cost quotas are rechecked within one conditional INSERT, closing the interleaving where multiple requests read the same remaining allowance before each inserted a reservation.
- Static fixture categories without an executable evaluator report `not_evaluated`; the small static suite no longer counts them as passes. This does not replace model-quality or live-provider evaluations and never marks production ready.
- Breathing distress, collapse and other explicit emergency red flags receive immediate emergency-veterinarian guidance before lead collection, pending OTP, sales or callback routing. Copy follows the existing published veterinary page. This response creates no call, booking or emergency dispatch and does not diagnose or prescribe. Explicit hypothetical/no-contact/no-create requests also remain information-only in direct chat, voice and WhatsApp orchestration: no staff request is queued. Ordinary emergencies retain the existing human-escalation policy; ordinary requests and human handoff controls remain.

## Latency and remaining acceptance

Safety changes the generic voice timing: full speculative model output is buffered, rather than audible token-by-token before its truth checks. No claim of unchanged first-audible latency or real-phone quality is made. Actual attended synthetic-provider/handset UAT, with exact serving revision, is still required. Specialist booking authority remains prepaid/customer-confirmed and uses existing tools. No native-voice cutover is included.

## Verification

- Executable guardrail regressions cover unsafe fabricated price/refund/offer output, safe SSE reply, off/staff-only rollout, takeover/closed-thread/rollout changes during generation, ownership mismatch, a race at persistence, malformed provider output, explicit negative price verification, honest static evaluation coverage, three50-way quota races and emergency precedence including pending visitor verification.
- Native local D1/Miniflare verifies50 simultaneous requests against each of RPM/token/cost limits with one remaining slot: exactly one reservation in each case. External requests are trapped.
- The existing specialist action-chain regression declares UAT for its voice phase, then restores the unchanged local simulator context for its separate payment-event assertions. No production auth exception was added.
- Existing protected source fingerprints are refreshed only for reviewed changed paths after comparing every previous digest with exact base. No protected path, guard, assertion or limit is removed.
- Focused AI/voice/bot/provider regressions:156/156 passed under the forced-loader path with an additional local rejecting boundary for unstubbed external fetch. The protected-contract/checkout/native-D1 selection passed193/193 with the separately owned hermetic checkout fixture repair applied locally. These selections overlap and are not additive.
- Current source typecheck passed. Focused lint is clean in changed production/new-test files; the pre-existing unused `serviceActor` warning remains in the specialist fixture. The final application build and artifact checks also passed with the external-fetch rejecting boundary.
- Full local suite is not claimed passed. The initial aggregate run was stopped after a missing network fixture was discovered in the separately owned checkout test; its hermetic repair must be integrated once before aggregate CI. Also, the unchanged real-D1 booking-fanout test fails before health because this executor refuses Wrangler's `uv_interface_addresses` call. Direct Miniflare quota tests pass. Earlier voice fixture failures were corrected by explicit UAT/customer-stage fixtures and buffered-provider response mocks, preserving their action and ownership assertions. Exact integrated-head CI remains required.

Run focused checks:

`node --experimental-strip-types --test tests/ai-guardrails-closure.test.mjs tests/ai-provider-quota-native-d1.test.mjs tests/elevenlabs-specialist-sales-gateway.test.mjs`

`PAWSPACE_FORCE_LOADER_HOOK=1 node --experimental-strip-types --test tests/ai-guardrails-closure.test.mjs tests/elevenlabs-specialist-sales-gateway.test.mjs`
