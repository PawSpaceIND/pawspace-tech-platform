# Controlled communication recovery

Parent candidate: `7c039c1f`. The overall 95% human-test readiness goal remains unverified.

## Connected flow implemented

CX delivery recovery → authenticated communications API → reason and failure-version validation → atomic security audit and requeue → unresolved failure closes → inbox shows queued → normal dispatch policy/retry remains in force.

The CX page now lists unresolved failures with customer, booking and message references. An operator supplies a recovery reason. The API requires `communications.manage`; a customer cannot invoke it. The request includes a stable retry key and the failure's version, preventing refresh/network retries or concurrent operators from reopening the same failure twice.

Only definitively unsent configuration/recipient/unsupported-channel failures are eligible. A provider reference, accepted/sent/delivered/read receipt, simulator ownership, ambiguous timeout, or stale failure requires reconciliation or refresh. Recovery does not erase provider evidence, change the original send idempotency key, or label a message delivered.

The existing `security_audit_events` table stores the operator, reason, failure snapshot and before/after state. Its insert, outbox/message updates and failure resolution are one D1 batch. No new schema or migration is required. If a later attempt dead-letters again, the failure row reopens with a newer version; the earlier audit remains unchanged.

## Evidence

- Four executing recovery tests cover concurrent identical requests, competing independent requests, stale versions, key reuse conflicts, customer refusal, receipt/timeout refusal, retry after requeue, preserved send keys and a deliberately injected mid-batch failure. The injected failure rolls back the audit and all state changes.
- **317 infrastructure tests passed**, zero failures/skips. This includes all four service execution suites and the communication recovery/isolation tests.
- Rendered-page regression and TypeScript passed. The application build passed. Diff and shell checks passed.
- Native desktop browser QA used the seeded synthetic admin through the local identity fixture. The operator selected one of 13 historical demo failures, entered a reason, and clicked **Requeue message**. The page reported successful requeue; the conversation stream changed that same message from dead letter to queued.
- A read-only D1 inspection confirmed the actor/reason, dead-letter → queued audit, attempt count reset to zero, resolved failure and unchanged original send key. Twelve other failures remained unresolved. No third-party delivery or financial transaction occurred.
- A reusable Playwright recovery journey was added to the hardened desktop/mobile runner. It has not been executed headlessly on this host; the native-browser run is the local UI evidence.

The latest full-platform run is still the earlier 4,652-test pass at `205f17f6`; the current candidate is supported by the targeted infrastructure and UI evidence above, not a claimed fresh full-suite run.

## Hosting and remaining gates

The Sites connector was queried using the exact project ID in `.openai/hosting.json` and returned **Sites project not found**. No replacement project was invented, no access policy changed, and nothing was deployed. An accessible target project/staging URL and approved identities are needed for hosted checks.

Real provider receipts, ambiguous delivery reconciliation, external recovery, full browser golden journeys, load thresholds and release/rollback evidence remain open. This closes the local eligible-message recovery path, not every DLQ case or the overall 95% goal.
