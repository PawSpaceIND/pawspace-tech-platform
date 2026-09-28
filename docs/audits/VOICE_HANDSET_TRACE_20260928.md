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

## Continuation: signed initiation-failure recovery

The documented `call_initiation_failure` payload includes agent/conversation identifiers but does not promise the dynamic variables used by a completed transcription. The previous handler looked only for those variables, swallowed reconciliation errors, and could acknowledge a failure as processed while leaving the outbound order unresolved. This is a reproduced source defect, not evidence that it caused the historical carrier no-answer.

Implemented in this continuation:
- Resolve an outbound failure against exactly one persisted acceptance matching conversation, agent, carrier and any supplied app-call identifier. Reject missing, malformed, ambiguous or conflicting correlation; never select by latest call or phone suffix.
- Keep unresolved or storage-failed callbacks unprocessed. A later authorized delivery/replay can finish without another provider call or duplicate CRM task.
- Reconcile a matched failure to the existing provider-error state, release its existing dial reservation and record the existing CRM disposition. This does not automatically retry or dial anyone.
- Preserve HMAC authentication and unchanged customer identities. The legacy inbound-session path still uses its existing session resolver; this change does not certify that separate path or modify successful-transcription handling.

Validation on the prepared callback revision (Node 22.16.0):
- Broader voice/integration selection: 448/448 passed, no skips.
- Final targeted callback, handset, policy, authority and schema/static-ratchet selection: 230/230 passed, no skips.
- Forced loader compatibility selection: 146/146 passed, no skips.
- Typecheck, application build, Worker artifact validation and diff checks passed. New-file lint passed; the previously documented audit-projection warning remains.
These selections overlap and must not be added together as unique test coverage. Full repository CI remains a separate gate.

Delivery limitation: ElevenLabs currently documents automatic retries only for `post_call_transcription`, disabled by default. These failure-recovery tests exercise replay in the application; they do NOT establish automatic redelivery of `call_initiation_failure`. Missing/early/failed initiation callbacks still require an authorized replay or exact-call reconciliation process; no such production process was enabled here.
Sources checked: https://elevenlabs.io/docs/eleven-agents/workflows/post-call-webhooks and https://elevenlabs.io/docs/eleven-api/resources/webhooks .

The previously documented draft holds remain. No blocked live-inspection or refinement operation was repeated, no phone-record cleanup was repeated, and no call, provider change, knowledge activation, shared deployment, or customer/payment mutation was performed. This patch improves forward-looking callback correctness, not proof of handset connectivity or a resolved historical failed leg.

## PR #1171 CodeQL correction — 28 September 2026

Current-head check `109063661656` on `5f201592c9b90536da7e27acead14b81c076d12b` failed with two high-severity `Incomplete URL substring sanitization` annotations, both in `tests/voice-handset-evidence.test.mjs` (then lines 106 and 124). The separate CodeQL SAST workflow had completed successfully; that did not mean its uploaded analysis passed the CodeQL result gate.

Both findings were broad URL-prefix comparisons in simulated carrier-response error injection. Replaced them with one exact expected evidence-endpoint predicate, covering the scheme, host, account, call ID and query. The normal stub dispatch uses the same predicate; the app-audit fixture URL now also uses full equality. No security finding was dismissed and no scanner, rule, workflow or production implementation was weakened.

Added nine executable regressions: one verifies the intended error injection and eight reject a lookalike host, user-info hostname confusion, HTTP downgrade, alternate port, different account, different call, dial endpoint and extra query. All requests remain in-memory stubs, with no external provider contact.

Validation on the corrected source:
- Node 22.16.0: 227/227 focused handset/callback/ownership/policy/authority/test-quality tests passed, no skips.
- Same selection with forced loader fallback: 227/227 passed, no skips.
- Focused test-file ESLint: zero errors and warnings; typecheck and diff checks passed.
- Current main observed: `3a37d67e4a6fa47971e1187de483fa7496777abe`, already incorporated in the branch.

Only the handset test and this audit note are changed by this correction. Fresh CodeQL and full CI must validate the pushed head; the earlier failure is not relabelled passed. Existing draft review holds remain independent. No handset call, remote database/configuration change, recording enablement, knowledge activation, deployment or PR merge was performed.

## Current-head CI repair: protected presentation fingerprints

Inspected head: `3e3071560dcc5397e1f4dc7f6679dbfc8f6cd728`.
Current main: `3a37d67e4a6fa47971e1187de483fa7496777abe`; behind count was zero.
This is not a recurrence of the cleared CodeQL URL-prefix alerts.

Pre-UAT run `36462886127`, job `109065775625`, finished with 9 failed assertions
(9,203 passed / 9,212 total, zero skips). The hook-path job `109069065798`
failed the two corresponding Inbox assertions. All reported mismatches were
historical byte-preservation snapshots for intentional changes in this PR.

Compared the complete main-to-PR diff for `lib/elevenlabs-post-call.ts`,
`lib/voice-outbound-governance.ts`, `lib/voice-telephony-provider.ts`, and
`.github/workflows/elevenlabs-provider-preflight.yml`. Each old expected hash
matched the actual current-main file. Updated only their 28 existing protected
hash values across the nine presentation JSON contracts. Every other JSON value,
all key sets, stylesheet normalization, assertions, test limits and runtime
sources were preserved. This aligns the UI guard's baseline; it does not approve
the unfinished handset/evidence refinements or certify a connected call.

Focused Node 22.16.0 validation includes all eight affected presentation suites
plus handset, callback, provider, policy, authority, fixture and test-quality
regressions: 438/438 passed with normal hooks and 438/438 with forced loader
fallback, zero skips in either selection. Full-suite and GitHub CI outcomes are
reported separately after execution. The prior hardening stash `a74a6098` was
left untouched. No merge, shared deployment, remote data repair or dial occurred.
