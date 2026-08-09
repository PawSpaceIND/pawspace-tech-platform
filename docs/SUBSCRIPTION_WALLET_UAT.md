# Subscription Wallet & Lifecycle — UAT Gate

## Status

`CODE READY FOR CI = PENDING`

`STAFF UAT COMPLETE = FALSE`

`PRODUCTION READY = FALSE`

This gate extends the existing canonical Grooming subscription purchase and completion logic. It does not introduce a second subscription truth.

## Canonical invariants

- One `customer_grooming_subscriptions` account owns total, reserved and consumed credits.
- One `booking_subscription_usage` row links a booking to its reserved/consumed/released credits.
- Available credits are `total - reserved - consumed` and never intentionally go below zero.
- Reserve requires a canonical Grooming booking for the same customer and sufficient available credits.
- Consume is permitted only after canonical booking completion.
- Release is permitted only while the service is not completed.
- Wallet mutations are idempotent and audited.
- Pause uses only the plan-configured pause entitlement and requires a reason.
- Pause does not invent an expiry extension; expiry extension remains `policy_required` until approved.
- Expiry respects the configured grace period.
- Renewal readiness may be surfaced, but auto-renewal is disabled and renewal pricing remains `configuration_required`.
- No live money is moved by the wallet API.

## CI gate

The branch must pass:

- web build and all repository tests;
- lint;
- artifact validation;
- backend typecheck;
- backend tests.

## Staff UAT required after CI

1. Load a canonical UAT subscription and verify total/reserved/consumed/available balances.
2. Attempt a reservation for another customer's booking and confirm denial.
3. Reserve one credit for a valid future Grooming booking.
4. Retry the same action with the same idempotency key and confirm no duplicate movement.
5. Attempt to over-reserve and confirm rejection.
6. Attempt consumption before booking completion and confirm rejection.
7. Complete the canonical Grooming service and verify exactly-once consumption.
8. Reserve against a cancellable booking, cancel it through the governed cancellation flow, then release and verify the credit returns to available balance.
9. Pause within configured entitlement; try exceeding entitlement and confirm rejection; resume.
10. Validate expiry, grace and renewal-due calculations with controlled UAT dates/data.
11. Confirm customer ownership, staff permissions and security audit records.
12. Confirm no renewal charge, refund, capture or production payment instruction is generated.

## Intentionally open

- Production renewal charging and renewal discounts.
- Upgrade/downgrade commercial rules.
- Pause-related validity extension policy.
- Production refund policy for subscription purchases.
- Cross-service/mixed-care memberships.
- Production payment gateway and accounting/GST treatment.

These require approved PawSpace policy and separate UAT before launch.
