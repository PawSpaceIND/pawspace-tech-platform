# Post-merge acceptance: interrupted webhook acknowledgement

Base: PR #1090 merge `0fab41ac553c32e196d13a45cfa1b16718b77dc5`.
Target environment: isolated staging only; production and live-money actions are out of scope.

## Reproduced defect

A verified Razorpay webhook can be durably stored with `processing_status=PROCESSING` before its payment effects commit. On a repeated delivery, the claim fails and the previous code returned HTTP 200 / `ok:true` even when no payment or journal had been committed. This can suppress the provider retry that an incomplete event still needs.

The added in-memory regression reproduced this on the merged code: 14 existing cases passed; the new incomplete-claim assertion failed because the route returned 200 instead of 503. This is synthetic signed-delivery evidence, not a real Razorpay payment.

## Bounded repair

After the existing post-commit recovery attempt, re-read the authoritative inbox status. Only terminal `PROCESSED` or `REJECTED` records retain the completed-duplicate acknowledgement. Incomplete or missing records return HTTP 503 with `ok:false`, `retryable:true`, and `code=inbox_processing_incomplete`.

No inbox claim is stolen or reset. No raw webhook, payment amount, customer charge, signature gate, finance journal or terminal payment transition is changed. Already-processed duplicate behavior and existing capture-effect recovery stay covered. The two new cases also verify that invalid signatures/body swaps remain refused, pending balances stay pending, and no second provider order is created.

Focused verification: 55 tests passed, zero failures/cancellations/skips.

## Release boundary

This repair keeps retry signalling truthful; it does not prove or perform recovery of historical stuck claims. Lease/recovery and any historical repair require separate investigation with current ownership and payment evidence. No historical staging inbox records have been changed.

The queued exact-main staging deployment remains pinned to the approved merged SHA. It is not silently replaced with this unreviewed candidate. The shared staging queue is not bypassed, and other active acceptance runs are not interrupted.

A prior completed master workflow contained preflight evidence only. Another completed Training report contains both successful and failed/blocked steps. Green workflow status is not accepted as full booking, balance, provider, completion or accounts/GST evidence. Both reports relate to the previously deployed build, not a certified deployment of PR #1090.
