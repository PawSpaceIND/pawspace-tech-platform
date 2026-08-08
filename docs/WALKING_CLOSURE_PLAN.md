# PawSpace Walking closure plan

Status date: 2026-08-08

## Closure principle
Walking is hardened as one canonical UAT transaction across Customer, Walker, Team Operations and Finance before any live GPS, OTP, messaging, storage, payment, refund or payout integration is enabled. Engineering closure does not equal production launch approval.

## Gate 1 — commercial truth and canonical booking
Status: CLOSED — application/UAT contract, subject to green CI evidence.
- Server-owned one-time 30/60 minute Walking catalogue and expiring quotes.
- Governed exact-window walker selection using shared provider capacity, scheduling decision and reservation tables.
- One reservation per one-time Walking booking.
- Full prepaid sandbox attestation only; no live money.
- Recurring cadence/billing, post-service charging and coupons remain policy-pending.
- Canonical booking, work order and payment records share one booking identity.

## Gate 2 — walker lifecycle, handover and recovery trigger
Status: CLOSED — application/UAT contract, subject to green CI evidence.
- Walker acceptance, decline, unavailable and no-show states are canonical and idempotent.
- Customer safety instructions, emergency contact and handover method are persisted before walk start.
- UAT handover verification does not claim a live OTP/SMS provider.
- Start, care events and completion update booking, work order and scheduling reservation together.
- Walker failures preserve the same booking and paid walk window while opening Operations recovery.
- Live GPS remains disconnected; route checkpoints are UAT metadata only.

## Gate 3 — cancellation, reschedule, refunds and settlement readiness
Status: CLOSED — application/sandbox contract; business policy still required.
- Cancellation stays `policy_review_required` until Walking cancellation/refund policy is approved.
- Refund amount is explicit staff input; no invented percentage.
- Refund ledger is sandbox-only and replay-resistant.
- Reschedules require a fresh Walking quote and fresh exact-window canonical schedule.
- Lower-priced reschedules are blocked until refund/credit policy exists.
- Walker settlement remains `rule_pending`; tax remains `configuration_required`; payout remains `not_instructed`.
- Reconciliation surfaces unresolved refund, settlement and tax states.

## Gate 4 — private proof, route evidence and incidents
Status: CLOSED — application trust-state contract; external media/GPS delivery pending.
- Private opaque media metadata with short-lived upload grants.
- MIME, size, SHA-256, exact booking/provider/purpose and scan-state validation.
- Quarantine, clean/blocked, ready, retention and revoke states.
- Route proof is evidence metadata only and does not claim live GPS tracking.
- Attention/urgent/emergency incidents are canonical and surfaced to Operations.
- Incidents never auto-refund or change walker payout.
- Customer incident acknowledgement changes no money state.

## Gate 5 — Operations exception control and cross-role closure
Status: CLOSED — engineering/UAT contract, subject to green CI evidence. PRODUCTION READY = FALSE.
- One Walking Operations queue projects canonical recovery, incidents, cancellation policy review, reschedule quote needs, pending refunds, blocked media and settlement readiness.
- Replacement walkers must be exact-window eligible through governed `dog_walking` provider rules.
- Replacement preserves the same booking ID and paid walk window.
- Replacement walker must accept before Operations can close recovery.
- Recovery finalization normalizes booking, work order, offer, scheduling decision and reservation state.
- Operations notes are idempotent/auditable.
- Finance and proof authority remain in their specialist modules.
- Customer, Walker, Ops and Finance share the same canonical booking ID.

## Production blockers intentionally left open
- Approved recurring Walking cadence/billing and post-service charging policy if desired.
- Approved cancellation/refund/credit policy.
- Live GPS/maps route tracking and location privacy/retention policy.
- Live OTP/SMS/WhatsApp/push delivery and reconciliation.
- Production object storage and malware/image scanning.
- Live payment/refund execution and production credentials.
- Walker payout formula, travel/incentive/penalty approvals and payout execution.
- GST/tax/invoice/accounting policy.
- Final customer/walker identity provisioning.
- Production monitoring, backups/restore proof, support runbook, production domains and real-device UAT/pilot.

## Launch rule
Do not connect production credentials or claim production readiness merely because Walking Gates 1–5 are engineering-closed. Complete green synthetic regression, approved business/privacy/security policies, external sandbox execution where applicable, controlled real-device UAT and an explicitly authorized monitored pilot first.
