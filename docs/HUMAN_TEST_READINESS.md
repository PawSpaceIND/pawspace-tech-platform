# PawSpace — Human Test Readiness

**Status: ready for human testing with ZERO live third-party integrations.**

The whole platform runs and is fully exercisable in a fail-closed / sandbox posture. No live
Exotel, Razorpay, or WATI credential is needed to test the product end-to-end — every external
integration is pluggable and switched on later, in an isolated staging environment first. Nothing
here can touch the live production app or live provider accounts.

Latest gates (on `main` after the open activation PR merges): **typecheck 0 · full test suite
690/690 · lint 0 errors**, plus real-execution harnesses for the new layers (staging-activation
21/21, Workers AI voice 18/18).

---

## What a human can test **right now** (no integration required)

| Area | Testable today | Notes |
|---|---|---|
| Customer journey | ✅ | Booking, wallet (10% enhanced redemption), Paw Points, pet passport, reminders |
| Provider journey | ✅ | Onboarding, capacity, dispatch, service execution |
| CRM & leads | ✅ | Capture → assignment → SLA → callbacks → conversion |
| Ops & team | ✅ | Alerts, escalations, productivity, incentives |
| Finance | ✅ | Accrual revenue recognition (used-session value), advance-on-utilisation, cash-flow statement, GST |
| Payments (sandbox) | ✅ | Verify-first order → signed webhook → capture/reconcile, all in **sandbox** |
| AI assistant (AI-off) | ✅ | Default: every conversation goes to a human. This is the "without AI" mode |
| AI assistant (staff preview) | ✅* | Flip rollout to `staff_only`: staff get AI answers, customers still get a human |
| In-app voice bot | ✅* | Works once Cloudflare Workers AI (`env.AI`) is bound in staging — first-party, no vendor |
| Background scheduler | ✅ | All sweeps run cold-DB safe (revenue rec, targeting, reminders, Haptik readiness, …) |

`*` needs one staging switch (bind `env.AI`, or set the AI rollout stage) — no third party.

---

## Deferred integrations — "all tech later" (each fail-closed until you switch it on)

| Integration | Purpose | Current behaviour (off) | How to switch on (staging first) |
|---|---|---|---|
| **Razorpay (live)** | Live customer payments | Sandbox works for testing; live is **double-gated** off | Set `PAWSPACE_PAYMENT_LIVE_APPROVED="true"` **and** `RAZORPAY_WEBHOOK_SECRET_LIVE` |
| **WATI (WhatsApp)** | WhatsApp messaging | Comms flow works via canonical messages; WATI send is fail-closed | Configure WATI credentials (checked by the integration control) |
| **Exotel (telephony)** | Real phone-call line | In-app voice works without it; phone calls need a carrier line | Configure Exotel API key / token / SID for the line only |
| **Workers AI (voice)** | First-party STT/TTS | Disconnected stubs until bound | Bind `env.AI`; optional model overrides |
| **AI provider key** | LLM responses | Fail-closed → human handoff | Set `PAWSPACE_AI_PROVIDER_API_KEY` in staging, staff-first |
| **Haptik (optional)** | External voice/WhatsApp bot | Inbound + outbound built, fail-closed | Set `HAPTIK_API_KEY` / outbound keys — only if you choose to use it |

Readiness of each can be checked live, without exposing any secret, via:
`GET /api/payment-readiness`, `GET /api/voice-providers`, `GET /api/ai-rollout`, and the system
integration readiness register (`docs/INTEGRATION_READINESS_REGISTER.md`).

---

## How to set up a human test run

1. **Environment:** an isolated staging environment with its **own D1 database** and **own sandbox
   secrets** — never production credentials, never the production database.
2. **Seed test data:** the seed + 360° journey harnesses live in `scratchpad/` (`e2e-seed.mjs`,
   `test-e2e-360.mjs`, `test-e2e-booking.mjs`) — 100 customers / 30 providers across verticals.
3. **Follow the area UAT scripts** in `docs/` (e.g. `END_TO_END_STAFF_UAT_EXECUTION.md`,
   `PRELIVE_REGRESSION_BENGALURU_PILOT_UAT.md`, `SUBSCRIPTION_WALLET_UAT.md`, and the
   provider-onboarding / finance / revenue UAT specs).
4. **AI (optional):** to preview AI, bind `env.AI` and `POST /api/ai-rollout {"stage":"staff_only"}`
   so only staff see AI; customers keep getting a human until you widen to `customers`.
5. **Payments:** keep `PAWSPACE_PAYMENT_ENV=sandbox` for testing. Live stays off until deliberately
   unlocked (double-gated) in staging.

---

## The safety guarantee

Every external integration is **off by default and fails closed** — it does nothing until a human
deliberately configures its credentials in an isolated environment. So human testing can proceed in
full confidence: the live production app and live provider accounts are never disturbed, and no live
money moves.
