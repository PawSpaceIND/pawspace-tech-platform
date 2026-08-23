# Non-voice external integrations — controlled UAT closure

This runbook is intentionally evidence-gated. Passing repository tests or having credentials present is not live-provider proof. Do not use real customers, do not enable production traffic, and do not mark an integration verified without the evidence listed below.

## Global rules

- Use UAT/sandbox credentials only and allow-listed test identities/devices.
- Capture the exact application SHA, timestamp, test actor, provider request/reference IDs, DB/audit evidence, and expected/actual result.
- A missing credential, unavailable provider, denied permission, malformed callback, or failed provider request must remain a truthful failure/pending state.
- Never promote `configured` to `verified`, `delivered`, `route ready`, or `KYC approved` on credential presence alone.
- No production deployment or uncontrolled external traffic is part of this runbook.

## Maps / GPS / customer live tracking

Required controlled evidence before operational score can reach 9/10:

1. iOS customer + provider devices: permission granted, denied, foreground, background/foreground transition, and refresh.
2. Android customer + provider devices: same matrix.
3. Reject NaN/non-finite and out-of-range coordinates before provider traffic; reject stale timestamps according to the governed GPS contract.
4. Provider A can update only A's active assignment. Provider B is denied. After provider switch, old provider authority is denied.
5. Customer can view only their booking tracking; cross-customer lookup is denied.
6. City/zone/booking identity remains consistent through persisted location evidence.
7. Missing `GOOGLE_MAPS_SERVER_API_KEY_UAT` or non-sandbox Maps mode reports configuration required; it must not report route ready.
8. Provider 4xx/5xx/network failure is surfaced as failure, not a synthetic route/address.
9. Retry does not duplicate durable tracking/lateness state.

## Service media / private object storage

The current application boundary is fail-closed while storage/scanning is not connected. Before operational score can reach 9/10, connect the selected UAT object store and scanner and prove:

1. Authenticated assigned-provider upload succeeds for an allowed MIME/size and is private by default.
2. Wrong provider and unrelated customer are denied.
3. Invalid MIME, oversize payload, and corrupt object are rejected/quarantined.
4. Direct public object access fails; authorized signed access works and expires.
5. Required before/after proof blocks completion when absent.
6. Retry is idempotent and does not duplicate canonical proof state.
7. Provider switch revokes stale provider upload/access authority.
8. Customer sees only permitted proof for their booking.
9. Retention/deletion behavior is explicitly configured and evidenced.

## WhatsApp / SMS / email / reminder delivery

Use allow-listed test phone numbers and email addresses only.

1. One transactional/service delivery succeeds through the selected UAT provider and records provider acknowledgement plus delivery event.
2. Opted-out recipient is blocked before provider traffic.
3. Unknown/insufficient consent is blocked according to channel/classification policy.
4. Quiet-hours policy blocks or defers as designed.
5. Frequency cap and dedupe prevent duplicate external sends.
6. Transient provider failure exercises retry/backoff; terminal failure reaches dead-letter state.
7. Replayed/duplicate provider webhook/event is idempotent.
8. Provider rejection and failed delivery remain failed; no UI/audit record says delivered.
9. No configured provider means queued/not-configured truth only, never delivered.

## AI provider/orchestrator

Use UAT provider credentials only. Do not enable autonomous governed actions.

1. Exercise normal, empty, malformed, timeout, 4xx, 5xx, network, tool failure, and invalid tool-argument responses.
2. Confirm human approval remains mandatory for refund, price change, payment, payout, outbound communication, provider assignment, customer merge, campaign activation, and every other governed high-impact action.
3. Confirm forbidden action/tool requests fail closed and create audit evidence.
4. Confirm human handoff, retry/idempotency, and no-provider safe fallback.
5. Capture actual-provider request/reference evidence before changing operational status to verified.

## Provider KYC / IDfy

Credential presence requires all of `IDFY_API_KEY`, `IDFY_ACCOUNT_ID`, and `IDFY_URL`; it is configuration evidence only. The canonical readiness register keeps IDfy as a required P0 launch blocker with a partial code boundary and production setup still required.

Before operational score can reach 9/10:

1. Governed provider/session submits an automatable check and it enters pending/in-flight state with a provider reference.
2. Document ownership and cross-provider isolation are proved.
3. A valid correlated IDfy callback updates only the intended pending check.
4. Rejected remains rejected; a browser/client cannot forge approved/verified state.
5. Unknown/mismatched callback is rejected.
6. Duplicate/replayed callback is idempotent.
7. Staff/manual verification authority remains separate from automated IDfy authority.
8. Assignment/activation continues to require every mandated verification to be verified.
9. Capture callback signature/authentication, request/reference ID, DB transition, replay evidence, and audit record.

Until the callback boundary exists and the above controlled callback proof is captured, KYC must remain below `controlled_live_verified` and continue blocking launch approval.
