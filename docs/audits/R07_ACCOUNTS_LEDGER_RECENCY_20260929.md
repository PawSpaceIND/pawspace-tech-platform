# R07 — Accounts ledger recency repair (2026-09-29)

Hosted pay-after Grooming acceptance completed booking `PS-UAT-MUMMJ9PH-5824`, issued invoice `PS-2026-571BB344`, resolved tax, and withheld provider payout pending collection. The same booking was visible in Grooming Finance with an outstanding receivable, but `/api/accounts-business-view` did not include it in its 100-row transaction ledger.

## Cause
`buildAccountsBusinessView` fetched all recognised canonical bookings, built invoice/payment rows, then capped the transaction ledger to 100 **after sorting by booking ID text**. Booking IDs are identifiers, not chronology, so a newly completed booking could be hidden by 100 lexically larger IDs even while its receivable and invoice were present in the source tables.

## Repair
The canonical booking read now includes `updated_at`. The display ledger ranks rows by canonical booking business recency (`updated_at` descending), using booking ID only as a deterministic tie-breaker, before applying the existing 100-row display cap. Receivable, GST, refund and provider-payable calculations are otherwise unchanged.

## Regression and verification
A new executable regression seeds 150 bookings, makes lexically-old `BK00000` the newest changed booking, changes it to uncollected and issues its invoice. Before the repair it failed because the first ledger row was `BK00149`; after the repair `BK00000` leads the capped ledger with its issued invoice and ₹1,000 receivable.

Completed on the repair branch:
- focused before/after reproduction: RED then GREEN;
- Accounts/D1 fanout, domain money truth, degraded-read, source-contract and provider-payout review selection: 48/48 passed;
- TypeScript typecheck: passed;
- changed-source lint: passed;
- diff check: passed.

Nine existing fixture manifests already protected `lib/accounts-business-view.ts`; each prior fingerprint matched current main before being refreshed to the reviewed repaired source. No safety check or threshold was disabled.

This repair changes no payment capture, payout release, booking completion, GST calculation or production setting. Staging reacceptance of the same-booking Accounts projection remains required after merge/deploy.
