# PawSpace Sitting engineering closure

## Status

**Engineering target:** Sitting Gates 1–5 closed for internal UAT on one canonical booking path.

This document does **not** declare production launch readiness. It records the server-owned UAT contract and the dependencies that must remain explicit before live launch.

## Gate 1 — Commercial + canonical booking

Closed in this branch:

- Server-owned Sitting catalogue and quote.
- Full-prepaid UAT commercial policy only; coupons and unapproved split-payment rules remain disabled.
- Canonical `pet_sitting` scheduling decision and exactly one care reservation.
- Server-attested sandbox payment capture.
- One canonical customer/pet/booking/work-order/payment bundle.
- Idempotent quote consumption and booking creation.
- Customer success screen displays the canonical booking ID and scheduler-owned sitter.

## Gate 2 — Sitter lifecycle + Care Card

Closed in this branch:

- Sitter acceptance and acceptance timeout enforcement.
- Customer-owned canonical Care Card before check-in.
- Check-in, care events and checkout on the same booking.
- Decline, unavailable and no-show recovery preserve the booking and escalate to Operations.
- Checkout closes the work order and scheduling reservation without inventing payout or tax rules.

## Gate 3 — Cancellation, date changes + Finance

Closed in this branch:

- Customer cancellation is a request; no refund amount is fabricated in the browser.
- Finance explicitly approves cancellation/refund amount.
- Refund ledger is sandbox-only and replay resistant.
- Date changes leave the paid care window untouched until a fresh canonical quote and fresh replacement schedule are supplied.
- Higher-priced changes require an explicit sandbox payment adjustment reference.
- Lower-priced changes remain blocked until refund policy is explicitly approved.
- Provider identity is synchronized across booking and work order after an approved date change.
- Sitter settlement/tax remain `rule_pending` / `configuration_required` until PawSpace publishes approved rules.
- Reconciliation surfaces unresolved refund, settlement and tax states.

## Gate 4 — Private proof + incidents

Closed in this branch:

- Short-lived hashed upload grants and opaque storage object IDs.
- JPEG/PNG/WebP, size, SHA-256, booking/provider/purpose, scan and retention gates.
- Provider cannot self-approve upload finalization or malware/content scan state.
- Medication evidence requires the canonical Care Card and a clean private media asset.
- Incident reporting escalates to Operations and customer notification queues without automatic refund or payout changes.
- Customer can acknowledge incidents without changing money.
- Legacy medication/photo/incident care-event bypass is blocked.

## Gate 5 — Operations + recovery

Closed in this branch subject to current-head CI:

- One canonical Sitting Operations exception queue.
- Exact-window replacement candidates use the existing provider-capacity contract: active `pet_sitting` provider, governed zone, no overlapping unavailability and sufficient remaining pet capacity.
- Recovery preserves the same booking ID and paid care window.
- Operations can offer only an eligible replacement sitter.
- Replacement sitter must explicitly accept the preserved booking.
- Recovery finalization verifies booking, work order, accepted offer, scheduling decision and reservation provider consistency before Operations closes the recovery case.
- Finance and incident-resolution authority remain in their specialist canonical modules.

## Cross-role UAT contract

The same canonical Sitting booking is the shared identity across:

1. Customer Sitting booking and management.
2. Sitter lifecycle and private proof workspace.
3. Team Operations exception/recovery queue.
4. Team Finance cancellation/refund/settlement/reconciliation workspace.

No role may create its own competing booking truth.

## Explicitly not production ready

The Sitting engineering contract deliberately keeps these launch dependencies unresolved/disabled until they are configured and approved:

- Production object storage and signed upload/download adapter.
- Production malware/content scanner.
- Production WhatsApp / push / SMS delivery adapters and templates.
- Live payment, refund and payout execution.
- Approved cancellation/refund policy.
- Approved sitter compensation/payout rules.
- GST/tax/accounting policy and filing integration.
- Production customer and sitter identity provisioning/ownership mappings.
- Production GPS/home check-in verification where required by policy.
- Monitoring, alerting, backups, production domains and support SOP.
- Real-device internal UAT, employee pilot and controlled Bengaluru zone pilot.

## Merge gate

Merge only after the **current PR head** passes build, tests, lint, artifact validation and backend typecheck/tests. A green earlier commit is not sufficient for this closure.
