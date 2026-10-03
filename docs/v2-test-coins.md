# PawSpace V2 TEST coins

Prepared as a disabled-by-default test pilot. No real reward program, money conversion, accounting changes, gateway discount, merge, deployment or enablement is authorized by this patch.

## V1 inspected and reused

`lib/paw-points-governance.ts` already provides an append-only SUM balance, booking-based unique keys, ownership checks, balance-guarded SQL debit, earn sweep and cancellation restoration. Its existing rates (0.1 point/rupee, INR0.5/point, 20% cap) feed `booking-credit-application`, staged payments and settlement parity. They are **not** TEST configuration or approved real policy for this initiative.

The new ledger adopts the V1 patterns in `v2_test_coin_ledger`. Real credit valuation is read only to confirm that a canonical service was funded. `paymentStageAmount` supplies actual canonical checkout totals including instalments and existing real credits. Neither is changed. Existing V1 PawPoints remain separate.

## Scope and source evidence

- Grooming, Boarding, Sitting, Walking, Training, Taxi, Vet, and other canonical service codes: canonical booking completed, owner-matched captured payment, no outstanding stay/taxi schedule, and adequate captured reconciliation evidence where available.
- Food: both order and fulfilment delivered, canonical `food_order_payment_events.status='sandbox_paid'`, and collected amount covering the order.
- Relocation: case delivered and its payment paid.
- Funeral/Memorial: case closed and its payment paid.

These source readers do not create vertical tables or seed orders. Absent source tables are returned as explicit sync gaps; query/schema faults fail rather than masquerade as no rewards. Same textual IDs in different verticals do not collide.

The pilot sync is owner-scoped and set-based, called when the TEST page opens or refreshes and before redemption. It awards all eligible completed history in the enabled test environment. It does not add a scheduler task, modify service completion or slots, or consume real refunds. Source records retain their existing authority.

## Test behavior

`PAWSPACE_TEST_COINS=on`, `FORBID_PRODUCTION=true`, and `APP_ENV` in `test`, `staging`, `development`, or `local` are all required. No environment file is changed by this patch.

Optional test-only knobs:

- `PAWSPACE_TEST_COINS_EARN_PERCENT`: configurable nonnegative earning percentage; current user-requested TEST value **10%**. Award whole coins by flooring eligible INR order value × percentage / 100. This is the earning rate, not a redemption cap.
- `PAWSPACE_TEST_COINS_PREVIEW_RUPEES`: positive finite simulated rupees per TEST coin; demonstration default **1**.

`PAWSPACE_TEST_COINS_EXPIRY_SECONDS` is a positive whole duration required for new grants, with **no default**. Until explicitly configured, the API reports expiry configuration required and does not issue new grants. Duration values used in tests are fixture inputs, not program policy.

Canonical eligible order value is the existing governed/post-offer `booking_payments.amount`; Food uses its governed order total, and special services use their existing paid case amount. No GST calculation or accounting basis is changed.

These values are displayed as TEST settings and stored with each immutable ledger entry. They do not change real INR payment value. No real earn rate, new conversion, expiry duration, redemption cap or real rollout policy is supplied. The existing INR1 simulated-per-coin TEST conversion remains unchanged and has no cash value. Changing earning or expiry configuration applies only to future grants. Per-grant `expires_at`, eligible value and percentage are retained in a separate TEST grant table; original ledger rows are not rewritten.

A TEST redemption uses a positive whole coin count from unexpired grants, is bound to an owned subsequent service, and must fit current actual payable. Delivered Food orders awaiting their existing payment-due event can also simulate redemption before payment; fully paid or cancelled services cannot. It posts a once-per-vertical/source debit guarded atomically by live TEST balance and current actual payable, including payment capture, instalment status, reconciliation and real credits. A financial input change after preview causes a retry refusal without spending coins; newly created optional financial tables also cause refusal and SQL refresh. Atomic allocations consume earliest-expiring grants first and exclude the grant’s own source booking. Each debit and its lot allocations commit together; exact retries return the existing result; different coin counts conflict. TEST discounts are displayed separately and capped to the current actual payable in later views. Real payments, wallet, PawPoints, GST, financial journals and customer refunds are untouched.

Reopened/unpaid/refunded services reverse the original entire TEST award once. Any completed partial refund removes the entire demonstration award; this is conservative pilot behavior, not a real refund policy. Cancellation or completed full refund restores the original TEST redemption once. Partial refunds do not restore redemption. Reversed awards are never re-earned automatically. A spent award's later reversal can produce a negative TEST balance; this debt is visible and spendable coins stay zero until covered by future TEST earns. No real debt is created. Expired unused principal is excluded dynamically from spendable balance. Cancellation restores the original lot allocations and therefore does not revive expired grants. Historical flat-grant entries lacking an expiry snapshot are shown as configuration-required and are not silently made immortal. Reversal after expiry does not remove already-expired unused principal twice.

## User and API entry points

Account links to `/v2/test-coins`, which lists owned service records and provides balance/history and booking simulation totals. `/api/v2/test-coins` admits only GET/POST through exact-path customer session gateway rules. The route requires a verified customer platform session and checks ownership; a supplied customer ID never selects another account. Writes reject cross-origin requests. There are no staff/client earn or grant actions.

The booking picker shows up to 50 records per source; sync covers all owned records. TEST trials remain in the central page rather than altering every service checkout.

## Evidence and remaining release decisions

SQLite-backed tests exercise lifecycle and concurrency plus real customer session/gateway routing. V1 loyalty and split payment regressions remain applicable. No browser, audio provider, live payment, hosted UI acceptance or performance/load acceptance is claimed.

The previous atomic-payable head was independently reviewed CLEAN. This percentage/expiry delta needs fresh independent review and bounded build/UI acceptance with the sole publisher. Before a real rewards initiative, the business must approve economics, qualification/payment-source rules, refunds/proration, caps, expiry, historical eligibility and finance/tax treatment. Before enabling this TEST pilot, explicitly choose an expiry duration and non-production environment and confirm that retrospective demo earning and conservative partial-refund reversal are wanted. The patch leaves all flags unset.

## Existing referral verification

Referral code creation/sharing already appears on the V2 Account page via the unchanged V1 ReferralCard. The existing programme begins paused with reward, discount, limit and validity values unset. Its server flow persists code → friend claim → first canonical booking discount → completed-paid qualification → released reward → subsequent-booking UAT reservation → configured reversal. Existing referral reservations explicitly are not authoritative booking pricing; they do not pay a gateway order.

The saved referral governance tests are source contracts, not runtime/hosted proof. New bounded SQLite runtime verification exercises that existing lifecycle, idempotency, self-referral, pause, owner and expiry guards using explicit fixture-only policy values. No referral production code or policy is changed. Current referral friend-discount booking support is explicitly restricted to Grooming, Dog Training and Boarding; other-service referral pricing (including Taxi) is configuration-required. That limitation is separate from the all-service TEST coin module. Hosted referral/authenticated-browser acceptance remains distinct from fixture runtime proof.
