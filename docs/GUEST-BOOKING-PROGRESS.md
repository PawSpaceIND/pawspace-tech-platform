# Guest booking increment — 8 September 2026

Internal QA only. This is not whole-platform closure.

## Implemented

- Mobile grooming opens package discovery without a customer session.
- Existing pet form supports guest drafts without calling account APIs.
- Sole draft pet is selected automatically; package, address and requested time precede verification.
- Confirm asks for existing OTP login, then saves draft pets against the verified identity. Verification does not submit an order; review and confirmation remain explicit.
- Deterministic pet IDs and caller-supplied mutation keys protect retries. Server ownership checks remain unchanged.
- Tab-scoped draft recovery validates a 24-hour expiry, profile schema and draft-only IDs. It never restores address authority, customer identity, quotes, payments or photos.
- After OTP, customers explicitly match draft pets to existing profiles or save new pets. Existing profiles are not overwritten or merged by name.
- Anonymous address lookup passes the real gateway for GET only. Other methods remain protected; provider errors are redacted and an internal-preview burst limit applies.
- Subscription cards identify their actual care scope, use governed plan codes and price a shared-credit wallet once rather than multiplying its purchase price by pets. Savings compare the same care package. The city catalogue still validates the submitted reference price.

## Evidence

- Browser: fresh localhost origin, welcome skipped, Grooming opened directly without OTP.
- Browser: synthetic Guest QA Buddy draft added, automatically selected, no OTP required.
- Browser: Complete Makeover choice survives refresh and re-opening Grooming; OTP is not shown during discovery.
- Runtime gateway test: anonymous GET is allowed; POST, PUT, PATCH and DELETE are denied. Existing canonical booking ownership tests still pass.
- Final full regression checkpoint: 4,696 tests passed, zero failed, including sanitized refusal handling. Typecheck and build passed.
- Browser: selecting the three-credit dog plan changes the selected care to Bath & Basic, exposes haircut exclusions and keeps the wallet total at ₹3,597.
- Staging browser: guest pet creation → Maps-verified address → final-confirmation OTP → explicit existing/new pet choice → saved QA pet and verified checkout. No order is automatically placed by verification.
- Staging negative case: HSR Layout/South Bengaluru had no eligible grooming candidates. The scheduler returned NO_SCHEDULE_AVAILABLE, and account history showed no upcoming booking. Seeded grooming profiles currently cover East Bengaluru.
- Staging positive backend case: East Bengaluru reservation returned 200 and canonical booking returned 201, booking PS-UAT-MTSWB9HT-F9C1. Pay-after-service, zero capture. Governed cancellation then returned 200 with the cancelled-booking response, releasing synthetic test capacity. This is backend integration evidence, not a claim that the full positive browser journey was completed.
- Staging deployment b53a4e2 completed and certified isolation. Maps autocomplete returned configured suggestions and browser doorstep resolution succeeded.
- Address form now has themed inputs, a labelled PIN field, a narrow-screen-safe layout and collapsed service areas without raw colour-code text. A sample groomer is no longer preselected.
- Known scheduling refusals now reach Grooming as typed, sanitized messages; unknown errors keep the safe fallback, and post-commit failures still identify the existing booking and warn against rebooking.

## Outstanding before closure

- Full OTP → pet persistence → canonical booking browser test, including interrupted writes and expired identity.
- Equivalent guest flows for other services and standalone My Pets.
- Browser coverage of existing-pet reconciliation, interrupted writes and identity expiry.
- Training payment-first session scheduling and other previously agreed service-specific gaps.
- Training currently requires reserved sessions before programme creation. Payment-first/schedule-later needs a genuine pre-scheduling purchase/entitlement lifecycle, not fake dates or paid labels.
- Live city-specific subscription catalogue discovery, instead of reference prices checked only at submission. Cat six/twelve-session and trim variants are not offered here while their seeded service-package mapping names dog care.
- Local Maps lookup remains configuration_required; staging Maps works.
- Protected staff/CRM/Command Center and provider-role browser checks require approved staff/provider sign-in. An access-code checkpoint has been opened; no authentication bypass or secret extraction is part of this work.
- Taxi distance quotation, food catalogue reconciliation and the complete communications/partner/staff button-and-state audit remain unclosed.

Photo upload remains explicitly deferred. No production payment, SMS activation or production deployment is authorized by this document.
