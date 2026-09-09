# Customer account and staff overview UAT closure

This candidate addresses PS-13, PS-14, PS-16 and PS-17 from the end-to-end audit. It does not certify native builds or production readiness.

Customers can expand notifications, payment and invoice summaries, offers and points, and privacy support from Account. These replace toast-only entries. The billing API derives ownership from the authenticated customer session and checks both payment/invoice and booking ownership. Missing schema is explicitly unavailable; database errors propagate. Invoice summaries are not downloadable invoice documents.

The shared gateway now allows authenticated customers to reach their account-tool endpoints, while endpoint ownership checks remain enforced. Reading the notification inbox no longer runs the global notification sweep; the background scheduler retains that responsibility. Account balance and offers come from their APIs; the fake header unread count has been removed. Profile controls have accessible names, and address submission retains its form reference safely across the request. The floating notification control clears customer bottom navigation and checkout controls.

Inactive, incomplete or expired referral programmes do not display a referral code or promise a reward. Failed clipboard writes do not report success. A failed staff overview shows an explicit access/error recovery screen rather than a zero-filled dashboard.

## Evidence

- Billing regression: own records, mismatched ownership excluded, missing schema unavailable, database failure propagated.
- Signed-session route/gateway regression: customer access, anonymous denial, cross-account read and mark-read denial, query-string identity ignored.
- Notification contract retains background scheduling and ownership checks.
- Actual local browser: disposable customer OTP session, account panels, real zero-point and offer fixtures, unavailable billing state, referral unavailable state, support form navigation without submission, and forbidden admin overview. Inspected 390x844 and 1280x900 layouts; corrected the notification/navigation overlap found during inspection.
- Run `npm test`, `npm run typecheck`, and `npm run lint -- --ignore-pattern .wrangler`. Test counts and logs are recorded in the accompanying closure evidence.

## Remaining limits

This work has not exercised physical Android/iOS devices, production integrations, a populated billing panel in the browser, full invoice downloads, or a privacy request processing workflow. Native work associated with #590 remains separate. Existing lint warnings are not represented as cleared. Release certification still requires the integrated commit, all-service sandbox journeys, external integration evidence and human/device UAT.
