# Founder-confirmed PawSpace business decisions — 28 September 2026

Status: **reviewed source / knowledge and code draft**, not active publication or transaction authority.
Source: the founder's explicit 28 September 2026 handoff in this conversation. These six decisions supersede conflicting assumptions in the previous audit only. Other documented answers and purchased terms are not rewritten by this update.

## Confirmed business rules

| Service | Confirmed rule |
| --- | --- |
| Grooming | Prepaid and pay-after-service allowed; cash and UPI accepted. |
| Grooming subscriptions | Prepaid or pay-after-service; cash and UPI accepted. Never describe all subscriptions as prepaid-only. Collection basis and credit activation are not settled. |
| Daycare | Full prepaid or 50% at booking and 50% due 24 hours before the exact start date/time. No overnight-stay longer-than-four-nights restriction applies. |
| Walking | Upfront only for one-time bookings, subscriptions and renewals. Supersedes the earlier pay-after-service UAT assumption. |
| Food | Prepaid only. |
| Relocation | Enquiry only: capture requirements and route to the specialist team. No instant booking or payment collection. |

Payment **timing** and payment **method** are separate fields. Cash/UPI acceptance is confirmed for Grooming and its subscriptions; do not copy those methods to another service without its own evidence. Every payment must be recorded and reconciled against its booking. Neither a customer claim nor a screenshot proves receipt.

## Two implementation questions still open

1. For Daycare booked **less than 24 hours before start**, must full prepayment be mandatory? The split balance deadline is already past. Do not invent a late split deadline or automatically declare full prepayment mandatory.
2. For Grooming subscriptions paid after service, is collection **per redeemed session** or **the whole pack at a specified milestone**? Confirm the milestone and credit activation separately; neither is inferred.

The review-only deadline helper reports the known 24-hour cutoff and an unresolved status below it. Exactly 24 hours is not treated as less than 24 hours: both halves are due at that instant under the described schedule. This helper is NOT connected to a payment engine, creates no quote/booking, and grants no collection permission.

## Unchanged code terms

Training code records 50% upfront, the balance scheduled for the final session and 60% extra per additional dog. This handoff does not change those terms or newly approve every training entitlement. Existing plan-specific restrictions remain in the actual quote/booking flow.

## Eight remaining commercial decision groups

1. Grooming extras: travel/access/early/late charges, de-matting assessment and above-45-kg surcharge approval.
2. Subscription terms: final active plans, cat-equivalent coverage, sharing, pause/grace and expiry.
3. Training: weekend centre socialisation eligibility, visit count, parent participation and transport.
4. Cancellation/refunds: conflicting full-refund and 100%/50%/0% rules, service exceptions, rescheduling fees and timelines.
5. Care services: holidays, weather cancellations, missed visits, extensions and included supplies.
6. Centre/support: operating address, hours, admission rules, handoff team and after-hours fallback.
7. Food: verified labels/allergens, packs, storage/expiry, coverage, substitutions and recurring-plan terms.
8. Taxi/funeral: final approved inclusions, extras and specialist arrangements.

## Separate authorizations — not granted here

AI voice access to every payment option and the proposed V2 source-authority hierarchy require separate decisions. This source update does not activate knowledge, change live customers/payments, expand voice tools or authorize a handset call. Existing payment-engine and entitlement code is left unchanged in this revision; the only specialist change is explanatory prompt wording. A source-approved rule and an implemented channel capability are different facts.

## Review and validation sequence

1. Review this register, the corresponding knowledge cards and code changes; execute local tests and exact-head CI.
2. After review, validate the exact revision in isolated staging with draft-only/disposable test context. Do not publish to the live customer knowledge collection or mutate live customer/payment records.
3. Run the original five synthetic multi-turn audio scenarios unchanged, plus the founder decision follow-up probes in `tests/fixtures/ai-founder-business-acceptance.json`. The manifest records **not_run_on_this_revision**, not five passing calls.
4. Retain audio/ASR evidence, final transcripts, source versions, response timings, all failures, and proof that no booking/payment/carrier/handset side effect occurred. Expected human handoff is a success only when the scenario actually requests it.
5. Handset remains on hold. Live publication and customer/payment changes need separate authorization.

No staging deployment, activation, carrier request, booking/payment change or synthetic model/audio test was executed while preparing this review revision. Local tests use disposable SQLite data and simulated external responses.
