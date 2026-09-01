# Razorpay Gateway & Webhook Live Test-Mode Smoke — 2026-09-01

Target product SHA: `d5d99ebf6223437e42793b1f261f27d5c8005e7f` (PR #382). QA harness branch only; no product code changed.

## Live run

GitHub Actions run: `33475310552` (`Razorpay gateway smoke QA`).

### Order creation / verify-first

Seeded isolated staging booking `CERT-GATEWAY-SMOKE-20260901` and payment `CERT-PAY-GATEWAY-SMOKE-20260901` for INR 1,500.

Live call to staging `POST /api/payment-order` returned HTTP 500 with `Unable to open payment`; therefore Razorpay did not issue an `order_id` and Checkout could not be completed.

Non-mutating D1 diagnostics immediately after the failure showed:

```json
{
  "booking": [{"id":"CERT-GATEWAY-SMOKE-20260901","status":"confirmed","total_amount":1500,"currency":"INR"}],
  "payment": [{"id":"CERT-PAY-GATEWAY-SMOKE-20260901","status":"created","gateway":"razorpay_sandbox"}],
  "intents": {"error":"no such table: payment_intents: SQLITE_ERROR"},
  "outbox": {"error":"no such table: financial_outbox: SQLITE_ERROR"},
  "links": [],
  "recon": []
}
```

Root cause: isolated staging D1 is missing the durable verify-first financial tables `payment_intents` and `financial_outbox`. This blocks order creation before the provider transaction can start.

### Live invalid-HMAC webhook negative test

Request used a dummy `x-razorpay-signature` and unique event id against the real staging webhook endpoint.

```json
{"status":401,"body":{"error":"Invalid Razorpay webhook signature"}}
```

Result: PASS for rejection of an invalid signature.

### Live maker-checker negative/positive governance test

Maker (`USER_A`): `founder@pawspace.in`
Checker (`USER_B`): `anjali.finance33@tkpetcare.in`
Refund case: `400be507-c005-48b7-9551-2ad1329777a1`

Maker request:

```json
{"status":201,"refundCaseId":"400be507-c005-48b7-9551-2ad1329777a1"}
```

Self-approval attempt by the same maker:

```json
{
  "status":409,
  "body":{
    "error":"Segregation of duties: the refund requester cannot approve their own refund",
    "code":"refund_self_approval_forbidden"
  }
}
```

Result: segregation is enforced, but the required contract was HTTP 403; actual is HTTP 409.

Independent checker approval:

```json
{
  "status":200,
  "eventId":"bdf17035-fa2b-43ee-9084-e9c5bcf5382b",
  "refundCaseId":"400be507-c005-48b7-9551-2ad1329777a1"
}
```

Result: PASS for distinct maker/checker approval.

## Transaction IDs

`order_id`: NOT GENERATED — staging failed before provider order creation.

`payment_id`: NOT GENERATED — Checkout could not start without an order.

`refund_id`: NOT GENERATED — there was no captured Razorpay payment to refund.

No IDs are invented or substituted with synthetic values.

## Additional exact-SHA contract findings

- Invalid webhook HMAC maps to HTTP 401.
- Valid duplicate webhook replay response uses `duplicate: true`; it does not expose the requested field name `duplicatePrevented: true`.
- Capture accounting code posts DR Gateway Clearing / CR Customer Collections.
- Booking refund self-approval is rejected with HTTP 409, not the requested HTTP 403.
- Subscription refund self-approval throws an ordinary error that is routed through the generic error handler, yielding HTTP 500 rather than the requested HTTP 403.

## Verdict

**FAIL — NOT READY for this certification suite.**

Blocking defects:
1. Staging D1 migration gap: `payment_intents` and `financial_outbox` are absent, causing `/api/payment-order` HTTP 500 and preventing real Test Mode order/payment/refund IDs.
2. Maker self-approval status contract mismatch: expected HTTP 403, actual booking refund API HTTP 409; subscription refund API maps the equivalent ordinary error to HTTP 500.
3. Duplicate webhook response contract mismatch: expected `duplicatePrevented: true`, implementation returns `duplicate: true`.

Because blocker #1 prevents a real payment, signed capture webhook, replay of that real event, and Razorpay refund, those portions remain unexecuted rather than falsely marked passed.
