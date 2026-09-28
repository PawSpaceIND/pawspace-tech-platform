# PawSpace V2: G02 / G05 location capture and address review

Date: 28 September 2026. Base: `f2cc5d4abc013d2a8ad27cab2a1f11a98455d8d3` (merged #1157).
Scope: the supplied G02/G05 requirements and G10's affected-detail revalidation rule. This is pre-reservation V2 Grooming, not a new subscription policy or map-pin editor.

## Implemented
- Use current location is an explicit customer action. No device permission request or coordinate lookup happens on page load.
- Reuse the existing device-location helper and server reverse-geocoding endpoint. Reverse lookup now uses the existing bounded API helper, including cancellation, safe errors and its eight-second response-body deadline; search and place-resolution methods are unchanged.
- Present a suggested address and matching postal code for review before replacing any existing text. Device position is not labelled a verified doorstep. The customer can keep their entered address or confirm the suggestion and add house/flat/floor details.
- Permission refusal, device failure, provider/configuration failure and malformed or contradictory responses retain manual address/PIN entry. No guessed neighbourhood PIN or fabricated fallback coordinate is accepted.
- Change address retains entered text and focuses its input. The customer's pets, package, chosen date, notes and coupon selection/removal intent remain in the draft.
- Confirming/changing an address clears only its dependent service-area, live-price, provider and coupon-quote state. Existing serviceability and server doorstep verification still apply before reservation/payment respectively.
- Pending location lookup/review blocks both the reservation button and its handler. Cancellation, manual edits and component replacement invalidate late GPS/map responses. Rejecting a suggestion leaves the existing quote/coupon untouched.
- No address is saved automatically. A newly accepted suggestion clears the Save this address checkbox; saving still requires the existing explicit opt-in.
- The new location draft contains address text and PIN only. No device coordinates are added to browser storage, booking payloads, provider selection authority or customer records by this flow.

## Verification boundary
New executed client tests cover validated reverse responses, structured/text postal codes, configuration/provider failures, malformed/mismatched data, permission/timeouts, invalid GPS, cancellation and non-JSON errors. The real compiled V2 page is exercised by seven added browser cases on both Chromium projects, retaining every prior browser case.
The added browser cases cover explicit review/confirmation, two device refusal paths, late map/GPS replies, keeping the existing address, and Change address preserving a removed-coupon decision. They use controlled API responses; the success path uses Playwright's permission-granted geolocation. No real GPS sensor, external map response or gateway transaction is certified by those fixtures.
Source fingerprints are refreshed only for intentionally changed protected files; no test threshold, authorization, payment invariant, timeout or skip is relaxed. Exact result counts, head identities and completed-run status are recorded on the pull request.

## Remaining scope
A dedicated interactive map-pin picker is not added; the required fallback here is typed full address/PIN. Changes to an already-created booking continue through existing booking-management/recovery flows. G01/G06 subscription purchase/address-scope decisions, G07 preferred-provider history, and the full G15-G19 leave/calendar/reassignment audit remain separate.
PR #1156 and voice settings are not changed. No shared staging or production deployment, outbound customer message, live payment or coupon issuance is part of this branch.
