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
- Full regression checkpoint: 4,695 tests passed, zero failed. Final draft-normalization/label edits also passed typecheck, build and eight focused tests.
- Browser: selecting the three-credit dog plan changes the selected care to Bath & Basic, exposes haircut exclusions and keeps the wallet total at ₹3,597.

## Outstanding before closure

- Full OTP → pet persistence → canonical booking browser test, including interrupted writes and expired identity.
- Equivalent guest flows for other services and standalone My Pets.
- Browser coverage of existing-pet reconciliation, interrupted writes and identity expiry.
- Training payment-first session scheduling and other previously agreed service-specific gaps.
- Training currently requires reserved sessions before programme creation. Payment-first/schedule-later needs a genuine pre-scheduling purchase/entitlement lifecycle, not fake dates or paid labels.
- Live city-specific subscription catalogue discovery, instead of reference prices checked only at submission. Cat six/twelve-session and trim variants are not offered here while their seeded service-package mapping names dog care.
- Local Maps lookup reports configuration_required; the staging secret name exists, but a successful provider lookup has not been verified in this increment.
- Taxi distance quotation, food catalogue reconciliation and the complete communications/partner/staff button-and-state audit remain unclosed.

Photo upload remains explicitly deferred. No production payment, SMS activation or production deployment is authorized by this document.
