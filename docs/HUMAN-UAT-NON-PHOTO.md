# Human test round: UI and non-photo wiring

Photo upload, storage, review and photo-dependent completion are explicitly deferred by the product owner. They are not a blocker for this test round, but are not marked passed or bypassed. No real customer data or real-money transactions should be used.

## Start here

Use the exact staging URL announced after deployment certification, not the retired localhost photo-review tab. Customer entry: `/mobile-app`. Partner entry: `/partner-app` with a verified provider identity; `/partner/onboarding` is the existing provider entry flow. Staff entry: `/staging-login`, using an approved seeded staff identity and the current access code supplied privately by operations. Customer and partner sessions must be tested separately from staff sessions.

## Test checklist

| Area | Human checks | Expected boundary |
|---|---|---|
| Customer | Home → service → pet details → eligible package → date/slot → OTP → price/payment choice → confirmation; refresh and revisit booking | One booking reference, correct pets and price; no invented provider or payment success |
| Services | Grooming, training, walking, boarding, sitting, taxi, relocation and memorial: compare available packages, validation, back navigation and empty states | Service-specific rules remain server-owned; unsupported data is an explicit state, not fabricated availability |
| Partner | Assigned jobs → accept → journey → arrival → start service; delay reporting, route, earnings and job switching | Only own assigned jobs; masked contact; photo-dependent action is disabled with a clear explanation |
| Payments | Sandbox checkout, cancellation/error return and refreshed payment status | A browser return alone cannot mark a booking paid; after-service payment can be tested on existing legitimate completed UAT fixtures |
| Communications | `/chat`, `/team/ai/handoff`, `/team/ai/configuration` and the team inbox/voice entries in staff navigation | Configured and permitted modes only; disconnected, denied and human-handoff states must be clear |
| Operations and employees | Use role-specific staff navigation for CRM, scheduling, employee and finance views | No cross-role access, wrong-person data or live payout |
| Accessibility | Phone and desktop; keyboard navigation, 200% zoom, contrast, focus, form labels, long names and text wrapping | Primary controls remain readable and reachable |
| Resilience | Slow connection, offline/reconnect, refresh, repeated taps, API rejection and empty lists | No raw stack traces, stuck loading or duplicate booking; state must be rechecked before retry |

## Explicitly not signed off in this round

- Pet/service photo upload and independent review; new jobs must not be force-completed without required proof.
- Physical-device background GPS, native camera permissions, push delivery and signed app-store packages.
- Live payments, production readiness and unconfigured external integrations. API credentials existing in GitHub do not alone prove an integration works.

Record each result with role, device/browser, route, booking reference, steps, expected vs actual outcome and a screenshot with personal data masked. Severity: blocker (cannot proceed), high (incorrect state/access/price), normal (UI issue). Mark every row Pass, Fail or Deferred; do not treat an unrun flow as passed.
