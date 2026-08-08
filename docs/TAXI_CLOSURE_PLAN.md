# PawSpace Pet Taxi engineering closure

## Status

**Engineering target:** Pet Taxi Gates 1–5 closed for internal UAT on one canonical booking/trip path.

This is not a production-launch declaration. It documents the UAT contract and keeps production Maps/GPS, live money and unapproved commercial/compliance policy explicit.

## Gate 1 — Commercial + canonical trip

- Shared platform scheduler supports `pet_taxi`; no separate allocator.
- Governed Taxi driver capacity, travel buffers and acceptance timeouts.
- Server-owned synthetic Bengaluru East UAT route classes and fares.
- Pickup/drop-off labels are customer input; route distance/ETA is deliberately labelled synthetic until production Maps verification is connected.
- One registered pet per canonical trip in this closure.
- Sandbox-deferred payment intent, ₹0 due at booking; production payment timing policy remains pending.
- One canonical booking, work order, payment intent, scheduling reservation and `taxi_trips` row.
- Customer driver card is preference only; canonical scheduling owns persisted driver.

## Gate 2 — Driver lifecycle

- Driver acceptance with offer expiry/idempotency.
- UAT-verified vehicle assignment owned by the accepted driver.
- Governed pickup handover before trip start; production OTP/identity verification is not claimed.
- Trip start, non-evidence updates, arrival, drop-off handover and completion against the exact canonical trip.
- Route/location/photo/incident evidence stays out of lifecycle actions and belongs to Gate 4 proof governance.
- Completion creates a payment-due event; it never fabricates live capture.
- Driver decline/unavailable/no-show recovery is allowed only before the active trip. Active/closed trips must use the safety incident workflow.

## Gate 3 — Finance

- Customer cancellation is request-only and cannot fabricate a refund.
- Active-trip cancellation is blocked until Operations/safety resolution.
- Finance explicitly approves any refund amount and may not exceed sandbox-paid trip value.
- Completed-trip payment requires a unique sandbox reference.
- Refund ledger is sandbox-only and replay resistant.
- Driver settlement waits until the canonical trip is complete and sandbox-paid.
- Driver payout/travel/incentive/penalty and tax/GST remain `rule_pending` / `configuration_required`.
- Reconciliation exposes trip-due, paid, unpaid, refund, net, settlement and tax states.

## Gate 4 — Route proof, private media + incidents

- Short-lived hashed media upload grants and opaque object IDs.
- Exact booking/trip/driver media binding lives in `taxi_media_trip_bindings`; shared media schema is not changed.
- JPEG/PNG/WebP, size, SHA-256, scan, private access and retention gates.
- Driver cannot self-approve storage finalization or scanner state.
- Canonical location samples are stored for UAT but explicitly marked sandbox/unverified; production GPS/Maps is not claimed.
- Photo updates require clean private trip-bound proof.
- Incident reporting queues Operations/customer notification without automatic refund or payout changes.
- Customer incident acknowledgement does not change money.
- Final cross-cutting closure gates trip completion on canonical route evidence.

## Gate 5 — Operations + recovery

- One canonical Taxi Operations exception queue.
- Replacement candidates must be active `pet_taxi` providers in the governed zone, free for the exact trip window including travel buffer, and own an active UAT-verified vehicle.
- Recovery changes only driver assignment before trip activation.
- Same canonical booking ID, trip ID, pickup/drop-off labels, quoted UAT route class and payment history are preserved.
- Replacement driver must explicitly accept the trip before Operations can close recovery.
- Finance and incident-resolution authority remain in specialist canonical modules.

## Cross-role UAT contract

One canonical Pet Taxi booking is shared by:

1. Customer Taxi booking and management.
2. Driver trip lifecycle and proof workspace.
3. Team Operations exception/recovery queue.
4. Team Finance trip payment, cancellation/refund, settlement and reconciliation workspace.

The canonical `taxi_trips` row stays attached to the same booking across pre-trip driver recovery.

## Explicitly not production ready

Remaining launch dependencies include:

- Production Maps/routes/distance/ETA provider.
- Production GPS/live location, location-consent and route-verification policy.
- Production driver/vehicle verification and applicable compliance policy.
- Production pickup/drop-off handover/OTP identity verification where required.
- Production object storage and signed upload/download adapter.
- Production malware/content scanner.
- Live WhatsApp/push/SMS delivery adapters and approved templates.
- Live payment, refund and driver payout execution.
- Approved payment-timing and cancellation/refund policy.
- Approved driver compensation, travel allowance, incentives and penalty rules.
- GST/tax/accounting policy and filing integration.
- Final customer/driver identity provisioning and ownership mappings.
- Monitoring, alerting, backups, production domains and support SOP.
- Real-device internal UAT, employee pilot and controlled Bengaluru-zone pilot.

## Merge gate

Merge only after the **current PR head** passes build, full tests, lint, Sites artifact validation and backend typecheck/tests. Earlier green commits are not sufficient.
