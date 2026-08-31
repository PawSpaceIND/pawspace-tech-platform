# PawSpace Lead-to-Resolution Lifecycle Audit — 2026-08-31

Base: `b39ba8c579259ec2ec40fcd9d07d6436edcb0590`

This document freezes the confirmed defects that must be closed by the lifecycle remediation branch. It is evidence, not a substitute for executable regressions.

## Confirmed defects

1. WhatsApp inbound can resolve a customer and create a communication thread without creating a lead tracking record when no open lead exists.
2. The repository has Meta WhatsApp handling and marketing attribution tables, but no Meta Lead Ads `leadgen_id` ingestion path that initializes a canonical lead.
3. `lead_work_items.status` mixes operational queue state with the business lifecycle. The canonical lifecycle (`new`, `contacted`, `qualified`, `converted`, `dropped`) is not protected independently and terminal leads can regress.
4. CRM lifecycle transitions are not guarded by legal source states.
5. Lead conversion attribution exact-matches `lead_work_items.service` to `canonical_bookings.service_code`, so display-name/code aliases can be misclassified as direct bookings.
6. Verified payment capture is durable, but downstream collection posting, lead conversion, and notification failures can be swallowed without a durable recovery item.
7. Order-notification idempotency is recorded before communication enqueue. A failed enqueue can therefore suppress all later retries; `payment_captured` is also absent from the customer-facing event set.
8. Refund request/approval audit identity uses request-body `providerId` instead of authenticated `actor.email`; requester != approver is not enforced and refund state mutation is not compare-and-set.
9. Unified case progress/wait/resolve/reopen actions do not enforce legal source states, and no-op transitions can still emit events.
10. Unified case SLA events are idempotent, but sweep counters increment even when an `INSERT OR IGNORE` inserts nothing.
11. Unified case SLA escalation is not wired into the background scheduler.
12. The parallel CRM leaderboard can disagree with dedicated sales productivity reporting because it joins lead/booking/payment/reconciliation rows directly and relies on overloaded lead status.

## Closure gate

The branch is not complete until executable regressions prove the remediations, typecheck is green, and exact-head Release CI plus Master zero-gap are green. No production deployment or live-provider activation is part of this audit.
