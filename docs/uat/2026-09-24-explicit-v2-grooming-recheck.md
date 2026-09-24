# Explicit V2 Grooming recheck - 24 September 2026

## Product and evidence boundary

The deployed product was b50d1091a15e4df4e45a1322b8ae6f19a24a5a3b. This recheck used the explicit /v2/grooming page in visible Chrome, not the separate /mobile-app grooming wizard.

A genuine Razorpay TEST Netbanking checkout captured INR 1,241 for synthetic booking PS-UAT-MUFJM7ZY-1A07 (order_TfsrEyDtWK4wje / pay_TfstPblFnNeEC0). The customer projection was confirmed and ready; Activity displayed the same booking; Control Center showed zero due/open revenue; Finance showed matched reconciliation, zero variance and zero receivable. The capture authority was authenticated provider API reconciliation, not proof of webhook delivery. Provider completion, retained-photo approval, invoice and earnings were not closed for that booking.

## Additional explicit-route defects and fixes

- A Mumbai/Maharashtra address paired with a Bengaluru PIN reached service-area coverage. Reuse the existing city/PIN contradiction check both on area lookup and before client booking mutations. This is not a replacement geocoder; the existing server-verified doorstep requirement still gates payment.
- A puppy and kitten shared the young-pet category, bypassing the UI species warning. Validate species independently of age, and reject unsupported species or package-age mismatches before reservation.
- The fifth pet was silently ignored. Reuse the existing large-family ContactForm, preserve four selected pets, prefill the enquiry and leave communication consent unchecked.
- Review summarized only area and PIN. Retain the full typed street/apartment text; label the earlier operation as a service-area check rather than a verified doorstep.

## Verification

- 89 focused executable V2 checkout, selection and integration checks passed.
- Typecheck and targeted lint passed.
- 22/22 headed Chrome desktop/mobile tests passed on the local application. External API and Razorpay responses in this browser suite are explicit test doubles, not additional gateway captures.
- The first browser run was not green: it included an ambiguous aside selector (cookie dialog plus booking summary), cold-compilation timeout and browser closure. The selector now targets the care summary; the complete rerun passed. No assertion was removed to waive a defect.

These changes are not a certificate that every service option, coupon, subscription, provider workflow or AI function has passed. The explicit V2 page and the legacy wizard are distinct surfaces and require separate coverage.

## Partner balance follow-up

The visible /v2/partner view for the same captured INR 1,241 booking still reported INR 1,241 due online. The Control Center and customer checkout had zero due, so this was an independent provider-feed projection defect, not a failed Razorpay payment.

The provider feed now reuses bookingPaymentBalances on its existing primary-read session. This reads current payment state, split schedules and applied credits without changing the original instalment in booking_payments. Missing financial projections fail closed rather than claiming zero. The helper accepts a prepare-only D1 interface so it can retain the existing session constraint. Provider ownership and contact masking are unchanged.

Seven new executed provider-route tests cover pending/captured/refunded/partially-refunded states, unchanged original instalments, pay-after service totals, second split captures and foreign-provider denial. The expanded related checkout/provider suite passed 113/113; typecheck, targeted ESLint and git diff --check passed. A source-shape assertion requiring the obsolete original-instalment projection was updated to require the shared current-balance path; the seven execution cases independently verify behavior.

These provider changes still require protected CI, staging deployment and a visible-browser recheck. The paid booking is now visible as assigned to its provider; completion, approved stored images and invoicing have not been certified.

Review follow-up: an executable concurrent-update test reproduced old payment mode/method combined with newer balance. The provider's payment mode, method, status and amounts now come from the same financial SELECT; other callers retain their existing minimal schema contract. Expanded tests after this correction: 203/203 passed; typecheck and targeted lint passed. This is not a transaction-wide snapshot claim for all non-financial job details.

Visible staging continuation on b50d1091: the paid synthetic booking reached assigned, on_the_way, arrived and in_service through the Partner UI. Start service was disabled before the three-item checklist and enabled after it. Arrival used the existing sandbox GPS bypass; this is NOT a successful geofence/GPS validation and does not represent a physical service.
