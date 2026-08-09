# Coupon Governance UAT Gate

## Status

**PRODUCTION READY = FALSE**

This gate replaces browser/localStorage coupon authority with a server-owned UAT boundary. It is intended for engineering validation and staff UAT only.

## Canonical truth

- `coupon_campaigns` owns UAT coupon configuration.
- `coupon_quotes` freezes the evaluated policy and discount for a short-lived quote.
- `coupon_redemptions` owns replay-safe booking-linked consumption.
- Customer kind and order history are derived from canonical PawSpace records, not accepted from the browser.
- The server computes the discount and never accepts a final discount amount from the client.

## UAT scenarios

1. Valid UAT coupon returns a bounded server quote.
2. Unknown, paused and expired coupons are rejected.
3. Service, city, channel, package, subscription and payment-mode mismatches are rejected.
4. First-booking eligibility is derived from canonical booking history.
5. Subscriber eligibility is derived from canonical Grooming subscription state.
6. Total and per-customer redemption limits cannot be exceeded.
7. Quote expiry blocks late consumption.
8. A quote cannot be consumed for another customer.
9. A redemption must bind to an existing canonical booking owned by that customer.
10. Repeating the same idempotency key returns the existing redemption rather than creating another one.
11. Staff campaign mutations require Pricing authority.
12. Coupon consumption requires booking-management authority.

## Deliberately not approved here

- Production discount values or campaign budgets.
- Production accounting treatment for discounts and marketing spend.
- Live campaign publication or customer marketing communications.
- Cross-service production rollout.
- Referral rewards; referral governance is a separate gate.
- Automatic refunds/reinstatement of coupon capacity after cancellation or refund. That policy must be approved before launch.

## Exit criteria

CI must pass build, regression, lint, artifact validation, backend typecheck and backend tests. Staff UAT must then capture positive, negative, replay and permission evidence. CI green means **ready for staff UAT**, not launch approval.
