# Handset investigation: exact correlation and honest completion evidence

Date: 28 September 2026. Operational tracking: #1166. Independent of PR #1169.
Base: `a2154d9e6848ec0b55e7e9517e10b81348912a71`.

## Established evidence and limits
The completed specialist run 36449714019 reported one obsolete fixture phone reference retired and an app response `201`, `dialed:true`, `provider:elevenlabs_exotel`, recipient ending 7878. It then exhausted polling with `initiated`, zero transcript turns and no stored audio, yet exited successfully. This was not an answered conversation.
The following diagnostic 36450289763 reported a time-aligned latest carrier call as `no-answer`, `from_leg_unanswered`, 55 seconds elapsed, zero talk time. It did not prove exact app/carrier/conversation correlation; its call-legs request returned 401. Do not conclude that the tester's handset visibly rang or that the tester ignored it.
A fresh browser/session inventory request in this workstream was blocked by the tool safety check. It was not repeated through another route. Current exact ownership, historical preservation and the failed call leg have NOT been reverified by this workstream. No live data repair or additional call was performed.

## Source findings
1. The native ElevenLabs adapter kept `callSid` but discarded `conversation_id` when both were returned.
2. The specialist workflow used a hard-coded customer ID and selected the newest recent conversation instead of exact acceptance IDs.
3. Its final checks rejected only a wrong agent or explicit `failed` status, so `initiated` with zero turns could finish green.

## Prepared repair
- Preserve separate carrier, conversation and agent IDs in the accepted handle and existing dialing-transition audit metadata. No schema changes and no misuse of internal `ai_call_id`.
- Expose only curated correlation on the existing authenticated audit read. Legacy records remain explicitly uncorrelated, not backfilled from guesses.
- Add a GET-only verifier that reads the exact app audit, carrier CDR and conversation. No latest-call search, alternate-host fallback, provider dial, data repair or recording fetch.
- Require matching IDs and recipient, carrier completion with positive conversation time, final model status, user speech followed by a complete substantive reply and two-way audio evidence. Human audio/answer quality remains `not_assessed`.
- Wire the specialist job to that verifier, require an explicit existing customer ID, and use the workflow run ID for retry idempotency. App ownership, consent, opt-out and frequency policy are unchanged; the request still uses the normal app endpoint.
- Recording-disabled sessions are not reconfigured. The pure evaluator can accept separately observed same-session audio evidence; the current remote verifier requires stored audio proof and otherwise fails closed.

## Validation
- Node 22.16.0: 191/191 selected voice, ownership, integration, authority and evidence tests passed, no skips.
- Forced loader fallback: 129/129 passed, no skips.
- Native Node import of the read-only verifier passed without network requests.
- Typecheck and focused ESLint completed with no errors; one unused-variable warning remains in audit projection.

## Review hold and next operational gate
A subsequent source-refinement command was blocked by the tool and confirmed unapplied. It was not retried. Before approving this draft, review strict typing of the talk-time field, allowlisted report status values, removal of the new lint warning, and moving verifier credential/region/run-ID checks ahead of the dial. The existing whitespace-separated specialist allowlist parsing should also be aligned with the shared canonical parser. These refinements are NOT claimed implemented.
The current verifier rejects recording-disabled calls without separate observed audio; this must not be solved by turning recording on without approval. The attended listening/evidence route remains an explicit acceptance decision.
This draft must not be deployed or used to call a handset before review and exact-head CI. Its runtime changes only affect new calls after an approved deployment. The historical call still requires an authorized read of the exact IDs and live recipient validation; do not repeat the already attempted fixture retirement.
No production/staging deployment, workflow dispatch, provider-configuration change, customer/contact/consent/payment mutation, knowledge activation or handset dial was performed by this workstream.

## Primary-source reference checks
- ElevenLabs native Exotel integration: https://elevenlabs.io/docs/eleven-agents/phone-numbers/telephony/exotel
- Native outbound response includes distinct `conversation_id` and `callSid`: https://elevenlabs.io/docs/eleven-agents/api-reference/integrations/exotel/outbound-call
- Exotel CDR details and conversation duration: https://developer.exotel.com/api/call-details-bulk
- Exotel call-detail statuses: https://developer.exotel.com/api/call-details-beta
- Exotel leg-details access can require account enablement: https://support.exotel.com/support/solutions/articles/3000108446-leg-details-api-to-get-all-participants-details-of-a-call
The documentation establishes API meaning, not this account's current entitlements or the root cause of its particular unanswered call.

Final local checks on the prepared source also passed: application build, Worker artifact validation, workflow YAML parsing with the repository's installed js-yaml parser, specialist shell syntax and embedded JavaScript syntax. Syntax checks did not execute the workflow. Full repository CI and an actual connected handset exchange are separate pending gates; no full-suite or live-call pass is claimed.
