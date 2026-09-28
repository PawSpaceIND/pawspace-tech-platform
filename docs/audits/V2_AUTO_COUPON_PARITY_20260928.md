# V2 automatic coupons and AI eligibility parity

Scope: G08/G09 and the recorded recommendation to automatically apply the highest-saving eligible normal coupon. Continues PR #1152 and reuses V1's server coupon quote/redemption pipeline. This is not a new autonomous discount model.

## Behaviour implemented

- After a verified V2 Grooming price is available, load the existing contextual offer list and automatically validate/apply its highest-saving normal offer. Display the applied code, saving and payable total.
- Block reservation until that context's offer check/automatic application settles; the existing pending-coupon guard remains authoritative after refusals.
- Manual selection remains the choice for subsequent basket rechecks. Remove remains removed across in-draft navigation, address/date/package changes and fresh pricing. It is not silently reapplied. The intent is scoped to the current customer and in-memory booking draft, not a permanent cross-session preference.
- A typed special code is not an instruction to apply it. It remains pending through a changed basket until Apply or Remove is pressed.
- Late offer or coupon responses cannot override manual input, removal or a new basket. Lost eligibility cannot silently become full-price checkout; the customer removes or changes the previously selected offer.
- Validate the server's recommendation shape and exact paise amounts before automatic application. Invalid, duplicate, contradictory or incorrectly ordered offers fail safely with Retry.

## AI uses the same decision as checkout

- `approvedSalesOffers` now invokes `couponEligibilityIssue`: booking count, intended customer, channel, city, service, package, spend, first-order, subscription, payment, validity, live approval and quota all use the checkout policy.
- Failed history, city or redemption reads cannot fabricate an eligible customer or unused quota. Anonymous users receive no personalised approved coupon; sign-in is required before claiming account eligibility.
- Exact server booking contexts produce the same amount as coupon quotation. General catalogue-based suggestions are explicitly labelled estimates requiring a final checkout quote, not guaranteed appointment totals.
- Web/WhatsApp sales preparation supplies its server quote's exact package, pet-count bundle, city, payment and subscription context before applying a code. A single-pet campaign is not broadened to a multi-pet bundle.
- Customer city/existence joins the existing authoritative history-count read, so the warm chat D1 budget is not raised. Existing V1 cold-schema owners and fail-closed counts are retained.

## Deliberate boundaries

The allowed AI sales campaign templates remain the existing configured closing/cross-sell campaigns. The model cannot create new discount amounts, override the three-booking rule or issue arbitrary private vouchers. Existing Training bonus issuance is retained, not replaced. A complete private-campaign distribution workflow, subscription purchase UI/scope, and uniform automatic-offer UI on all other services are not implemented by this batch. No production deployment, real payment or live campaign mutation is part of these code changes.

## Verification

Executable negative cases first reproduced ten AI eligibility/amount failures. All eleven new AI parity cases passed after the shared evaluator change. Automatic-response validation, browser race/choice/removal scenarios and wider regression results are recorded with the PR at the exact tested commit. Browser contract runs use explicit API/SDK fixtures; hosted staging acceptance is a separate gate.
