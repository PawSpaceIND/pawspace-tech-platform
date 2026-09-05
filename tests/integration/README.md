# Sandbox contract integration suites

These are the only tests in this repo that talk to a third party's server. They exist to prove the one
thing no local suite can: **that the provider still behaves the way our code assumes.**

```bash
npm run test:integration
```

With no credentials configured that command exits **green**, having run nothing, and prints exactly why
for each provider. That is the intended behaviour — see *Why these skip instead of failing* below.

## What each suite covers

| Suite | Outbound (real network) | Inbound (real key material) |
|---|---|---|
| `razorpay-sandbox.contract.test.mjs` | creates real sandbox orders, asserts paise fidelity and the notes correlation, pins the provider's real 4xx error shape, issues a real payment link | verifies a `payment.captured` body signed with the real sandbox webhook secret through `verifyRazorpayRawBody`, and three ways it must fail |
| `idfy-sandbox.contract.test.mjs` | submits a real sandbox verification task, asserts the response still carries the fields `mapStatus` reads | drives `applyIdfyCallback` — tampered signature refused 401, correctly signed gets past verification, stale-but-valid refused |
| `meta-graph-sandbox.contract.test.mjs` | resolves the test phone number, lists templates and asserts every status the API returns is one `normalizeMetaTemplateStatus` understands | verifies an `x-hub-signature-256` body signed with the real app secret, plus the subscribe-handshake contract |

## Required configuration

Presence is checked before any network call, and no value is ever printed — a configured secret is
reported as the first 8 hex of its SHA-256, which distinguishes "rotated" from "wrong" and discloses
nothing.

**Razorpay** — `RAZORPAY_KEY_ID_SANDBOX`, `RAZORPAY_KEY_SECRET_SANDBOX`, `RAZORPAY_WEBHOOK_SECRET_SANDBOX`
**IDfy** — `IDFY_API_KEY`, `IDFY_ACCOUNT_ID`, `IDFY_URL`, and `IDFY_WEBHOOK_SECRET` for the inbound leg
**Meta** — `META_WHATSAPP_UAT_ACCESS_TOKEN`, `META_WHATSAPP_PHONE_NUMBER_ID`, `META_WHATSAPP_WABA_ID`,
`META_WHATSAPP_APP_SECRET`, and `META_WHATSAPP_VERIFY_TOKEN` for the handshake test

## Why these skip instead of failing

A suite that reaches someone else's server can go red for reasons that have nothing to do with the
change under review: an expired key, a provider maintenance window, an egress rule. Wired into the
Release gate, that turns every unrelated outage into a blocked merge and trains people to re-run until
green — which is how a real failure gets clicked past.

So the default is **skip with a diagnosis**, and the preflight distinguishes the three states that need
different responses:

| Reason | What it means | Where to look |
|---|---|---|
| `credentials_absent` | the variables are not set here | your shell, or the CI secret store |
| `credentials_rejected` | a real 401/403 from the provider | rotate the key; check test vs live |
| `endpoint_unreachable` | DNS, TLS, firewall or timeout — the cause chain is unwrapped into the log | network route, proxy |

`PAWSPACE_SANDBOX_TESTS_STRICT=true` inverts it: skips become failures. Use it in a pipeline whose job
*is* to assert the sandboxes are wired, where a skip is the thing you want to hear about.

These suites are deliberately **not** part of `npm test`. That glob is `tests/*.test.mjs`, which cannot
reach a subdirectory, so Release CI stays deterministic and offline. To run them on a schedule, add a
separate workflow with the secrets attached — not a job on the release gate.

## The local contract test was kept, on purpose

`tests/payment-provider-contract.test.mjs` is **not** a mock. It drives the same
`lib/razorpay-client.ts` over real HTTP against a loopback server that speaks Razorpay's wire protocol,
which is how it can exercise what a live sandbox will not produce on demand: HTTP 429 and 503, a
mid-body timeout, an oversized response, a malformed success. Deleting it in favour of these suites
would trade deterministic coverage of our error handling for a dependency on a third party's uptime.
The two are complementary — that one proves our half, these prove theirs.

## Known limits, stated rather than discovered later

- **Razorpay will not originate a webhook for a bare order.** A genuine inbound callback needs a
  payment completing in hosted checkout, which needs a browser and a test card. `RZP-05` therefore
  verifies the inbound contract with real key material but originates the request locally; `RZP-06`
  creates a real ₹1 sandbox payment link and logs its URL, which is the handoff to that human step.
- **WhatsApp Cloud API has no sandbox host.** The test surface is `graph.facebook.com` with a test WABA
  and token, so nothing about the host makes a run safe. The Meta suite is read-only by design and
  **never sends a message** — a send delivers a real WhatsApp to a real handset. It validates the
  preconditions sends actually fail on (sender identity, template approval) instead.
- **IDfy's environment is whatever `IDFY_URL` points at.** There is no hostname check that can tell
  sandbox from production, so the configured URL is printed in the preflight for every run.
- A green run proves the contracts held *at that moment*. It is evidence about the provider, not a
  substitute for the executed local suites.
