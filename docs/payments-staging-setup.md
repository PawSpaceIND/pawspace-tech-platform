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
- **Events:** `payment.authorized`, `payment.captured`, `payment.failed`, `order.paid`,
  `refund.created`, `refund.processed`, `refund.failed`
- Copy the generated **webhook secret** into `RAZORPAY_WEBHOOK_SECRET_SANDBOX`.

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
