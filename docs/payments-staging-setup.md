# Isolated staging + live-integration setup (payments first)

How to test real Razorpay/GPay payments — and later go live — **without ever touching the
production app or any live provider account.** The golden rule: a **separate environment, with its
own database and its own secrets.**

The code is built to make this safe: every external adapter is **fail-closed** and resolves its
credentials + database from the environment's own bindings, so an environment with no keys simply
cannot move money.

---

## 1. Two hard isolation rules

1. **Separate everything from production.** The staging Worker gets its **own D1 database** and its
   **own secrets**. Never copy production keys into staging; never point staging at the production
   D1. Production is never used for testing.
2. **Sandbox/test mode of each provider, never live mode** (until explicitly promoting). Razorpay
   **test** keys = test money; a **test** webhook secret; no real customers, no real charges.

---

## 2. Create the staging environment (Cloudflare)

- Create a **second Worker environment** (e.g. `pawspace-staging`) — separate from production.
- Bind a **new, empty D1 database** to it (e.g. `pawspace_staging`). Do **not** reuse the prod DB.
- Give it its own hostname (e.g. `staging.<yourdomain>`).

Everything below is set **on the staging environment only.**

---

## 3. Secrets — sandbox testing (do this first)

Set these as **secrets** on the staging Worker (`wrangler secret put <NAME>` or Dashboard →
Settings → Variables and Secrets → *Secret*):

| Secret | Value | Where to get it |
|---|---|---|
| `PAWSPACE_PAYMENT_ENV` | `sandbox` | (plain var is fine) |
| `RAZORPAY_KEY_ID_SANDBOX` | `rzp_test_...` | Razorpay Dashboard → **Test Mode** → API Keys |
| `RAZORPAY_KEY_SECRET_SANDBOX` | test secret | same |
| `RAZORPAY_WEBHOOK_SECRET_SANDBOX` | webhook secret | Razorpay → Test Mode → Webhooks (below) |

Register the webhook in Razorpay (**Test Mode**):
- **URL:** `https://staging.<yourdomain>/api/razorpay-webhook`
- **Payment/refund events:** `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`,
  `refund.created`, `refund.processed`, `refund.failed`
- **Recurring subscription events:** `subscription.authenticated`, `subscription.activated`,
  `subscription.charged`, `subscription.completed`, `subscription.updated`, `subscription.pending`,
  `subscription.halted`, `subscription.paused`, `subscription.resumed`, `subscription.cancelled`
- Copy the generated **webhook secret** into `RAZORPAY_WEBHOOK_SECRET_SANDBOX`.

The recurring events are mandatory for subscription certification. In Razorpay Test Mode, a
successful recurring test charge emits `subscription.charged`; a failed recurring test charge moves
the subscription to pending and emits `subscription.pending`. Do not certify recurring billing from
payment webhooks alone.

---

## 4. Run the sandbox payment UAT

1. Create a booking (customer app) choosing **online payment**.
2. The app calls `POST /api/payment-order` → a **real Razorpay test order** is created and linked;
   the booking payment is `awaiting_payment` (it is **not** captured yet).
3. Open Razorpay Checkout with the returned `orderId`/`keyId`; pay with a **test card/UPI**.
4. Razorpay fires the webhook → PawSpace verifies the signature, matches the order id, verifies
   amount/currency, and **only then** marks the payment `captured`.
5. Confirm on the Finance screen (`GET /api/payment-reconciliation`) that it reconciled cleanly.

**Also test the exceptions** (this is what the Finance action closes):
- Pay a **test transfer that isn't linked to the booking's order** → it lands as an **unmatched**
  exception → Finance uses `POST /api/payment-reconciliation` `action: "attach_to_booking"` to
  attach it (amount + currency must match) → booking becomes captured.
- Try a **wrong amount** → attach is refused → use `investigate` / `mark_refund` / `dismiss`.
- Pay from **someone else's GPay** → still reconciles automatically (matching is by **order id**,
  never by phone).

### Recurring subscription certification

For a subscription build, payment UAT is not sufficient. On the same isolated staging Worker/D1:

1. Create and approve the PawSpace billing plan, verifying its Razorpay Test Mode plan before local
   activation.
2. Start a real Razorpay Test Mode subscription and complete authentication.
3. Trigger a successful recurring test charge and require the signed `subscription.charged` webhook.
4. Verify one canonical billing cycle, one balanced renewal accounting set, one invoice, and exactly
   one entitlement grant for that cycle.
5. Replay the same signed webhook and verify that no second cycle, journal, invoice or entitlement is
   created.
6. Trigger a failed test charge and verify `subscription.pending` drives Past Due/grace handling;
   exercise halted/resume lifecycle events where applicable.
7. Request and approve a refund with different maker/checker identities. The refund must be capped by
   unused entitlement before any deferred-revenue reversal.
8. Execute the real Razorpay Test Mode refund and require the signed `refund.processed` webhook.
9. Verify the entitlement reservation finalizes exactly once, refund accounting/adjustment remains
   balanced, and reconciliation finishes with zero unexplained variance.

If any required provider event cannot be produced, received, signature-verified or reconciled, the
recurring-subscription release remains **NO-GO**. A locally fabricated webhook is regression evidence,
not provider certification.

---

## 5. Promote to LIVE — only after sandbox is proven, and **in staging first**

Do this in the **staging** environment first, with **small real amounts**, before production:

| Secret | Value |
|---|---|
| `PAWSPACE_PAYMENT_ENV` | `live` |
| `RAZORPAY_KEY_ID` | `rzp_live_...` (Razorpay **Live Mode** keys) |
| `RAZORPAY_KEY_SECRET` | live secret |
| `RAZORPAY_WEBHOOK_SECRET` | live webhook secret |

Register a **Live Mode** webhook pointing at the staging host, same events.

> **One deliberate extra step for live:** the webhook receiver is currently **hard-locked to
> sandbox** (it returns 503 in live mode) as a safety catch — so live cannot be switched on by an
> env var alone. Enabling the live webhook is a small, explicit code change (make the receiver
> env-aware: live secret + `environment: "live"`), done consciously when you're ready to promote.
> Ask and it can be added as its own reviewed change.

Once staging proves out end-to-end with live keys, replicate the **live** secrets on the production
environment.

---

## 6. Safety / rollback

- **Rollback is instant and fail-closed:** unset `PAWSPACE_PAYMENT_ENV` (→ defaults to `sandbox`) or
  remove the keys → the adapter returns `connected:false` and no money can move. No code deploy
  needed.
- Production and staging never share a database or secrets, so a staging test can never affect a
  real customer, a real charge, or the live app.

---

## 7. Same pattern for the other integrations

Each is a fail-closed, env-gated adapter — set its sandbox/test secret in **staging** to test it,
production stays untouched:

| Integration | Secret to set (staging) |
|---|---|
| AI (Anthropic) | `PAWSPACE_AI_PROVIDER_API_KEY` (set a spend cap in the Anthropic console) |
| WhatsApp / telephony | provider sandbox token + test recipients |
| Maps | a dev key with a quota cap |
| KYC | provider sandbox credentials |
