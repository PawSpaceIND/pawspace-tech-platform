# PawSpace Dog Walking engineering closure

## Status

**Engineering target:** Dog Walking Gates 1–5 closed for internal UAT on one canonical booking/session path.

This is not a production-launch declaration. It documents the UAT contract and keeps disconnected integrations and unapproved commercial policy explicit.

## Gate 1 — Commercial + canonical schedule

- Shared platform scheduler now supports `dog_walking`; no separate allocator.
- Governed Walking provider capacity, roster, travel buffer and acceptance timeout.
- Server-owned 30/60-minute packages.
- One-time or bounded recurring UAT schedules (2–12 walks).
- One registered dog per canonical booking in this closure.
- Pay-after-service commercial model; ₹0 due at booking; coupons disabled.
- One canonical booking/work-order/payment intent and one `walking_sessions` row per scheduling reservation.
- Customer UI shows canonical booking/session truth and treats a selected walker as preference only; scheduler owns final assignment.

## Gate 2 — Walker lifecycle

- Walker acceptance with offer expiry/idempotency.
- Governed handover before a walk can start.
- Start/progress/completion against the exact canonical session.
- Lifecycle events limited to non-evidence walk updates; route/photo/incident evidence belongs to Gate 4 proof governance.
- Completion creates a canonical payment-due event for that completed walk; it never fabricates capture.
- Decline/unavailable/no-show recovery preserves the booking and completed sessions while escalating remaining walks to Operations.

## Gate 3 — Finance

- Customer cancellation is request-only and cannot fabricate a refund.
- In-progress walk cancellation is blocked until the operational/safety case is resolved.
- Finance explicitly approves any refund amount and may not exceed sandbox-paid completed-walk value.
- Each completed walk payment requires a unique sandbox payment reference.
- Refund ledger is sandbox-only and replay resistant.
- Walker settlement waits until all walks are complete and all completed-walk dues are sandbox-paid.
- Walker payout amount/rules and tax/GST remain `rule_pending` / `configuration_required`.
- Reconciliation exposes completed-due, paid, unpaid, refund, net, settlement and tax states.

## Gate 4 — Route proof, private media + incidents

- Short-lived hashed media upload grants and opaque object IDs.
- Exact booking/provider/session binding lives in `walking_media_session_bindings` without altering the shared media schema.
- JPEG/PNG/WebP, size, SHA-256, scan, private access and retention gates.
- Provider cannot self-approve storage finalization or scan status.
- Canonical route samples are stored for UAT but explicitly marked sandbox/unverified; production GPS is not claimed.
- Photo updates require clean private session-bound proof.
- Incident reporting queues Operations/customer notification without automatic refund or payout changes.
- Customer incident acknowledgement does not change money.
- Walk completion is gated by canonical route evidence in the final cross-cutting closure patch.

## Gate 5 — Operations + recovery

- One canonical Walking Operations exception queue.
- Replacement candidates must be active `dog_walking` providers in the governed zone, free for every remaining walk window and within provider limits.
- Completed sessions retain their original provider/history.
- Only recovery-pending remaining sessions/reservations move to the replacement walker.
- Same canonical booking ID, quote/payment history and completed walks are preserved.
- Replacement walker must explicitly accept the remaining schedule before Operations can close recovery.
- Finance and incident-resolution authority remain in their specialist canonical modules.

## Cross-role UAT contract

One canonical Dog Walking booking is shared by:

1. Customer Walking booking and management.
2. Walker session lifecycle and proof workspace.
3. Team Operations exception/recovery queue.
4. Team Finance completed-walk payment, cancellation/refund, settlement and reconciliation workspace.

Each walk is a canonical `walking_sessions` row linked to a canonical scheduling reservation. Completed-session history is immutable across recovery.

## Explicitly not production ready

The following remain launch dependencies:

- Production GPS/location provider, location-consent policy and route-verification rules.
- Production object storage and signed upload/download adapter.
- Production malware/content scanner.
- Live WhatsApp/push/SMS delivery adapters and approved templates.
- Live payment, refund and walker payout execution.
- Approved cancellation/refund policy.
- Approved walker compensation, travel allowance, incentives and penalty rules.
- GST/tax/accounting policy and filing integration.
- Final customer/walker identity provisioning and ownership mappings.
- Secure handover/OTP policy where required.
- Monitoring, alerting, backups, production domains and support SOP.
- Real-device internal UAT, employee pilot and controlled Bengaluru-zone pilot.

## Merge gate

Merge only after the **current PR head** passes build, full tests, lint, Sites artifact validation and backend typecheck/tests. Earlier green commits are not sufficient.
