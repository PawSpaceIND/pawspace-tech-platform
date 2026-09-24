# V2 paid-journey remediation - 24 September 2026

## Evidence and scope

The visible staging audit used product `a7efb3e1a6b11db54dcaf760c190b333635c411d`.
The hosted proof run `35983457513` captured INR 1,241 for booking `PS-UAT-MUFCPRER-FF6F` in Razorpay TEST. Finance reported matched reconciliation and zero receivable. The overall run failed later, while waiting for uploaded-photo approval text. This is not evidence of a general Razorpay capture outage.

The original Boarding Care Card request returned HTTP 500 while checkout proceeded. A later idempotent retry on the same stay returned HTTP 200 and `care_plan_ready`. The original server-side exception is not established; it must not be described as a proven permanent schema fault.

## Changes

1. Stay care instructions must save before payment. A failed write displays a retry boundary carrying the existing booking ID. Retrying cannot rerun reservation or canonical booking creation. No local test transaction is published as paid before verification.
2. Boarding care snapshot, ready state, audit event and idempotency receipt commit in one database batch. Injected failures on either final write roll the batch back; retry creates one event, not another booking.
3. Control Center reads the same current payment-stage calculation used by checkout. Original instalment amounts remain unchanged. Captured prepaid money is not shown as due; split balances, credits and later captures retain their real outstanding amounts. Reads are bounded to seven queries per 80 bookings, not seven per booking.
4. Training Activity links to the customer-owned booking/payment recovery page, preserving V2 navigation. A missing or unauthorized booking projection cannot offer payment.
5. Food quantity increase is disabled at the lower of stock allocation and per-order maximum, with an explanation and labelled controls.
6. A verified payment followed by a failed UI-finalization callback exposes retry-confirmation, not retry-payment. Aborted/5xx receipt confirmation first reads the exact same order; rejected receipts do not take this recovery branch.
7. Split-deposit status is distinct from whole-booking settlement. Exact deposit capture can confirm its booking, while the remaining balance stays payable. A different unpaid order cannot borrow the first order's capture evidence.

## Private media dependency

The staging Worker had no private media bucket binding. It recorded photo hashes but did not retain the bytes. The existing private-storage adapter is reused rather than weakening proof checks.
A dedicated `pawspace-staging-private-media` bucket was created and repository variable `STAGING_R2_BUCKET_NAME` set. Its r2.dev public URL is disabled. Production storage was not touched. The binding takes effect only on a subsequent staging deployment.
The BTM proof now requires both `adapterConnected` and `objectStored`; a hash-only upload cannot pass. The review note explicitly describes synthetic pipeline fixtures rather than claiming an actual service photograph was inspected.

## Local verification

- New and related executable database/payment checks: see PR verification results.
- Desktop and mobile Chromium component fault injection: 4/4 passed. These tests use mocked transport and are not external payment evidence.
- Atlas and mobile employee-AI regression selection: 129/129 passed on this branch's base.
- Typecheck passed. Targeted lint has zero errors; existing unrelated hook warnings remain explicit.

## Human-UAT acceptance gates still requiring deployed evidence

Fresh Razorpay TEST capture and return; canonical booking/customer/partner/Control/Finance agreement; stored-photo retrieval, separate Ops review and provider completion; invoice/receivable/earnings reconciliation; refund/replayed-webhook behavior; actual speech-to-text/AI/text-to-speech; every vertical's completion and cancellation policy.

A code test, configuration flag or opened page never substitutes for these gates. Production payments, real customer outreach, provider ownership, consent/DND and sensitive approvals remain protected.
