# PawSpace human-test readiness acceptance checklist

Target: 95% evidence-backed human-test readiness. **Not certified.**

Every checkbox below is an end-to-end closure item, not a source-code-presence check. Unchecked items may have passing local regression coverage; that alone does not close the full requested frontend-to-recovery pipeline. Financial safety and P0 blockers must all pass regardless of the numerical threshold.

Evidence for each flow must link: frontend action → gateway → rules → transaction → event → notification → admin → finance → analytics → recovery.

No readiness percentage is inferred from the test pass count. Staging-only items require the named deployment, effective bindings, approved synthetic identities and provider receipts.

## 1. Analytics

The built analytics API includes both completed demo bookings and matches seeded GMV/collections, and no longer reports degraded sources after scheduled initialization. Warehouse delivery and the full KPI dictionary remain open.

- [ ] Leads
- [ ] Lead → booking conversion
- [ ] Booking conversion
- [ ] Revenue
- [ ] Service-wise revenue
- [ ] City-wise revenue
- [ ] Agent performance
- [ ] Provider performance
- [ ] Subscription renewal
- [ ] Churn
- [ ] Repeat booking
- [ ] Cross-sell
- [ ] Refund rate
- [ ] Cancellation rate

## 2. Audit Trail

Demo lifecycle rows contain the booking ID, actor, timestamp and from/to changes. This does not yet prove immutable before/after coverage for every administrative mutation.

- [ ] Customer changes
- [ ] Provider changes
- [ ] Booking changes
- [ ] Admin overrides
- [ ] Pricing changes
- [ ] Refund approvals
- [ ] Payment actions
- [ ] User/action/timestamp
- [ ] Before/after values

## 3. External Integrations

All new demo financial events were synthetic sandbox events; in-app notifications are visible, but 13 chat outbox messages reached DLQ with `unsupported_outbox_channel` during the real scheduler probe. The follow-up now routes chat through the configured UAT bridge and verifies retry/signed-callback recovery locally; controlled replay of definitively unsent failures is now implemented and verified through native browser → API → atomic audit/outbox → inbox refresh. Real provider delivery and ambiguous delivery reconciliation remain open; see `communication-replay-closure.md`. No real provider callback, payout, push, email, KYC or external-message delivery is certified.

- [ ] Razorpay
- [ ] RazorpayX
- [ ] Meta WhatsApp
- [ ] Interakt/WATI
- [ ] Exotel
- [ ] Google Maps
- [ ] IDfy
- [ ] Storage/R2/S3
- [ ] Push-notification provider
- [ ] Email provider

## 4. Webhook Architecture

The local suite covers signatures, duplicate captures and replay/error behavior. Deployed callback receipts and alert delivery remain open.

- [ ] Authentication/signature
- [ ] Duplicate event prevention
- [ ] Idempotency
- [ ] Event ordering
- [ ] Retry
- [ ] Dead-letter handling
- [ ] Logging
- [ ] Failure alerts

## 5. Background Jobs / Queues

The demo produced in-app notification and communication-outbox records. Found and fixed cold subscription schema ordering and D1 trigger initialization failures; final runtime evidence is recorded in the companion audit.

- [ ] Notifications
- [ ] WhatsApp outbox
- [ ] Payment reconciliation
- [ ] Refund reconciliation
- [ ] Subscription reminders
- [ ] Win-back campaigns
- [ ] Provider assignment
- [ ] Expiry jobs
- [ ] Retry jobs

## 6. Real-Time System

Fixed the CX recovery-screen render and destructive remount on updates. Native browser preserved search across Worker restart/reconnect while new notifications became visible. Unit regression checks dedupe and disposal.

- [ ] Customer chat
- [ ] CX inbox
- [ ] Provider status
- [ ] Booking status
- [ ] Live service updates
- [ ] SSE/WebSocket reconnect
- [ ] Duplicate-event handling

## 7. Database Integrity

Local D1 integrity_check returned ok and foreign_key_check returned no violations after demo completion. Two simultaneous booking requests returned one canonical booking. Distributed/staging concurrency remains open.

- [ ] Foreign keys
- [ ] Transactions
- [ ] Atomic updates
- [ ] Race conditions
- [ ] Booking duplication
- [ ] Payment duplication
- [ ] Ledger duplication
- [ ] Session-credit duplication
- [ ] Concurrent slot booking

## 8. Error & Edge-Case Handling

The local suite includes provider HTTP/timeouts, atomic rollback and duplicate-event cases. Built-Worker concurrent duplicate booking and notification retries were exercised. Full interrupted browser payment flow remains open.

- [ ] API timeout
- [ ] Payment timeout
- [ ] Provider timeout
- [ ] Network loss
- [ ] Double tap
- [ ] Refresh during payment
- [ ] Duplicate request
- [ ] Webhook retry
- [ ] Partial DB failure
- [ ] External-service outage

## 9. Security

The simulator boundary follow-up rejects manual forged provider receipts, requires explicit sandbox locks, records refusals in the audit trail and prevents failed synthetic messages from reaching external dispatchers. Local executing tests and a built-Worker refusal probe pass; see `communication-simulator-boundary.md`.

Built gateway returned 401 for anonymous callers and 403 for unauthorized customer access to staff APIs. Fixed customer notification mapping while preserving ownership and cross-origin guards.

- [ ] Authentication bypass
- [ ] Authorization
- [ ] Admin permissions
- [ ] API rate limiting
- [ ] Input validation
- [ ] File-upload validation
- [ ] Secret handling
- [ ] Sensitive-data masking
- [ ] Log sanitisation
- [ ] Webhook signatures

## 10. Performance

An older hosted Track 3 run measured aggregate p95 834.29 ms against an under-750 ms gate, with booking p95 18,755.13 ms. That candidate failed performance acceptance. These timings are not evidence for this branch or the current staging version; see `consolidated-readiness-and-staging.md`.

- [ ] Booking API latency
- [ ] Pricing latency
- [ ] Availability latency
- [ ] DB query performance
- [ ] Concurrent bookings
- [ ] SQLite/DB locks
- [ ] Cache correctness
- [ ] p95 latency
- [ ] Error rate

## 11. Monitoring & Observability

Scheduled-handler failures surfaced as runtime exceptions during the probe. Remote alert routing, delivery and business-alert acknowledgement remain open.

- [ ] Health endpoints
- [ ] API errors
- [ ] Payment failures
- [ ] Webhook failures
- [ ] Queue failures
- [ ] DB errors
- [ ] Notification failures
- [ ] Performance alerts
- [ ] Business-critical alerts

## 12. UAT / Automated Test Coverage

The consolidated local suite at c35ef49d passed 4,662 tests with zero failures or skips. The built-Worker HTTP demo covers reservation through completion/finance/notifications. Native browser inspection covers CX; the headless browser launcher is blocked by host sandbox permissions.

- [ ] Customer golden journey
- [ ] Provider golden journey
- [ ] Grooming journey
- [ ] Training journey
- [ ] Sitting journey
- [ ] Walking journey
- [ ] Payment journey
- [ ] Refund journey
- [ ] Subscription journey
- [ ] Cancellation journey
- [ ] Admin journey
- [ ] Failure scenarios

## 13. Production / Release Flow

Sandbox flags, build and typecheck are validated locally. No push, merge, deployment or production financial action has been performed. Standalone staging is reachable, but its latest inspected certified candidate is 34 commits ahead of the main baseline. The stricter sandbox certification fix is local; it has not re-certified that deployment.

- [ ] Environment configuration
- [ ] Secrets
- [ ] DB migrations
- [ ] CI
- [ ] Release tests
- [ ] Staging
- [ ] Production deployment
- [ ] Rollback
- [ ] Feature flags
- [ ] Production-enforcement flags

## 14. Data Consistency Checks

Demo booking/payment/provider/invoice/payout-readiness and in-app notifications were correlated by booking ID. Actual payout, renewal/refund credit effects and the warehouse require further demo evidence.

- [ ] Booking status ↔ payment
- [ ] Booking ↔ provider assignment
- [ ] Booking ↔ ledger
- [ ] Refund ↔ ledger
- [ ] Subscription ↔ credits
- [ ] Package ↔ sessions
- [ ] Provider completion ↔ payout
- [ ] Customer app ↔ admin
- [ ] Admin ↔ analytics

## 15. Complete E2E Golden Journey

Partial: existing demo identities → reservation → booking → simulated capture → provider lifecycle/GPS/proof → completion → invoice/balanced ledger/accrued payout readiness → customer notifications/CX. Lead/signup, actual payout, reviews and retention stages are not represented by this one demo.

- [ ] Lead → signup → pet → address → service → availability → pricing → booking → payment → provider assignment → provider acceptance → service execution → completion → ledger → provider payout → review → repeat booking → subscription → retention → cross-sell → win-back

Total acceptance items: 136. All remain subject to complete-flow signoff; local evidence above is the current checkpoint.
