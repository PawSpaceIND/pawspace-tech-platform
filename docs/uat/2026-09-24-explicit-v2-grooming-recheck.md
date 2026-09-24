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
