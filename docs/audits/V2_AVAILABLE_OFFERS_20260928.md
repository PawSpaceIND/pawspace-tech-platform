# PawSpace V2: available offers and the three-booking allowance

## Scope
Implements G11–G14 from the founder's running issue list on the V2 grooming page, reusing the existing governed coupon engine. Depends on the coupon and multi-pet corrections in PR #1148. This is not closure of all G01–G19 requirements.

## Customer experience
The review card lists context-eligible normal offers with savings, conditions, expiry and Apply buttons. Highest immediate savings appear first; the customer explicitly selects one. Remove coupon is available. An unavailable or withdrawn selected coupon cannot silently become full-price checkout: the customer must remove or reapply it. Offer-lookup failure is shown with Retry and does not invent a discount.

“Have a special code?” is separate from the normal offer list. No private code is shown as an input placeholder, and customer-bound campaigns are never enumerated in the offer list, including for their intended customer. All codes are validated by the existing quote endpoint before becoming applied.

## Explicit policy interpretation
The source proposed counting the first three bookings across PawSpace and excluding failed/cancelled bookings. This implementation uses canonical bookings across services, excluding only statuses `failed` and `cancelled`. Pending/confirmed/completed bookings count, whether they used a coupon or not. A fourth booking cannot use a normal coupon, even if the code is typed or the browser forges a special flag.

A special exception requires a persisted, non-empty intended-customer restriction (`customerIds`). An unlisted campaign or a code named “special” is not sufficient. Existing generic unlisted sales codes are therefore not exempt from the three-booking rule unless staff issue a customer-bound campaign. Existing per-customer/global redemption limits, expiry, service, package, channel and payment/subscription gates still apply.

The transaction checks current customer history before inserting the redemption, excluding only the booking being created. Two quotes prepared while two bookings exist cannot both consume the third position: the loser rolls back with its booking. First-order-only campaigns are also checked at commit. Retry of an already-created booking may recover its own consumed coupon by the same customer/key/code/service/city/package/channel and gross amount; it is not permission to use that discount for a new booking.

## Reuse and boundaries
Browse and quote share the same eligibility function and exact-paise calculation. Browsing computes savings without creating coupon quotes, reservations or bookings; idempotent schema/seed initialization is retained. Ownership is checked on the offers endpoint; partial or malformed context is refused, not broadened.

No new AI model or automatic private-offer distribution is introduced. Subscription purchase/visit discount scope, GPS capture, subscription selection and provider leave/calendar work remain separate. The UI is tested with explicit browser API/SDK fixtures; database cases execute real route/engine code over transactional SQLite-backed D1. No live-money transaction is part of this change.
