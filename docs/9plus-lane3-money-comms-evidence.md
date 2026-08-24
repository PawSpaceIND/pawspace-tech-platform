# 9+ Closure — Lane 3 Money and Communications Evidence

**Branch:** `closure/9plus-lane3-money-comms`  
**Starting and synced `main`:** `a95ed7adbbf513ed78e4b88b22afa38ce3b5c940`  
**Open PRs at start:** none  
**Safety boundary:** sandbox/UAT only; no merge, production deployment, live charge, filing, bank transfer or payout.

## Verdict

Lane 3 is materially stronger and its internal D1 money, Finance, payroll, CRM and reminder controls
have executable coverage. It is **not honestly 9+/10 overall yet** because this execution environment
has no Razorpay sandbox credentials, WATI credentials, or selected SMS/email provider credentials.
Consequently, no actual-provider traffic or reference is claimed. Provider-dependent rows below remain
blocked until credentials and allow-listed test recipients are supplied to an isolated UAT deployment.

The prior post-service QR defect is closed in code: the provider path now calls Razorpay's sandbox
`/v1/payment_links` boundary and persists a request only after Razorpay returns a `plink_...` identifier
and an HTTPS checkout URL. The request binds booking, canonical payment and customer IDs, exact INR
subunits, rejects partial payment, remains sandbox-only, and cannot mark a payment captured. The signed
raw-body webhook remains the only capture authority.

## Score matrix

| Capability | Score | Executed evidence | Remaining blocker |
|---|---:|---|---|
| Payment integrity and D1 reconciliation | 8.7/10 | Order/link contracts, raw-body signature gate, capture/failure/refund events, replay idempotency, binding, refund ceiling, unmatched queue, split settlement and provider failure matrix pass | Actual Razorpay sandbox order/link/refund/webhook references unavailable without UAT keys/webhook secret |
| Finance, GST and accounting projection | 9.3/10 | Booked/collected/refunded/net decomposition, invoice/tax/journal execution, maker-checker, evidence reference, immutable correction paths, locked periods, deterministic export checksum/replay and Finance RBAC pass | Entity policy/account mapping and human Finance sign-off; no live filing by design |
| Payroll, incentives and settlement | 9.2/10 | Versioned calculation, maker-checker, configured-only Finance accounts, balanced posting, idempotent inclusion/reversal, sandbox bank batch/reconciliation and lock refusal pass | Approved statutory policy/account mappings and sandbox banking endpoint if selected; no payout by design |
| CRM and Revenue Mission | 9.2/10 | Capture/assignment/RNR/duplicate handling, canonical payment conversion, refund/cancellation reversal, attribution, cases and achieved-vs-pipeline separation pass | Business UAT of staff workflow and approved SLA/forecast policy |
| Reminders and lifecycle governance | 9.0/10 | Consent, opt-out, unknown-marketing-consent refusal, quiet hours, cap, retry/backoff, dead letter and duplicate suppression execute in D1 | Actual channel provider traffic blocked |
| WhatsApp | 7.0/10 | Canonical outbox, signed callback, identity review, consent/session/template/kill switch and callback idempotency pass | WATI/LimeChat/Meta UAT credential and allow-listed recipient traffic absent |
| SMS | 6.0/10 | Provider-neutral outbox/callback/retry contract and not-configured truth pass | Provider not selected/configured; no provider invented |
| Transactional email | 6.0/10 | Provider-neutral outbox/callback/retry contract and not-configured truth pass | Provider not selected/configured; no provider invented |

## Executed D1 evidence

The targeted Lane 3 command executed 252 tests against the repository's D1-compatible SQLite harness:

```text
tests 252 · pass 252 · fail 0
```

Coverage includes:

- Payment: customer/booking/order binding, capture amount/currency checks, failed payments, refunds,
  refund overage refusal, duplicated and asymmetric provider notifications, unmatched exceptions,
  split balances, reconciliation and canonical revenue attribution.
- Finance/GST: real calculated surfaces, authorization denials, balanced journals, separate money
  decomposition, statutory maker/checker, approval evidence, deterministic checksummed exports,
  idempotent replay, accounting acknowledgements and locked-period refusal.
- Payroll/incentives: configured account mapping only, balanced posting, immutable payroll snapshots,
  maker/checker, one-time incentive inclusion, capped reversals, sandbox-only bank batches and failed/
  mismatched reconciliation that never reports paid.
- CRM/Revenue: lead persistence, assignment and attempt history, duplicate customer detection, canonical
  payment conversion, cancellation/refund revenue reversal, owner-window attribution, RNR, Customer 360,
  opportunity suppression and pipeline/forecast isolation from achieved revenue.
- Communications/reminders: consent source, opt-out, unknown consent, quiet-hour/frequency policy,
  concurrent enqueue idempotency, retry/backoff, dead-letter terminal state, provider callback replay,
  WhatsApp session/template rules and no false external-delivery claim.

The new payment-link fault matrix separately executed 7 provider-boundary cases: accepted creation,
missing credentials, live-environment refusal, HTTP 400/429/500/503, and network failure. Every failed
case remained `connected:false` and produced no collectable truth.

## Actual sandbox-provider evidence

| Provider/channel | Credential presence in this execution | Sanitized reference | Result |
|---|---|---|---|
| Razorpay sandbox API | Missing | None | `configuration_required`; no request sent |
| Razorpay sandbox webhook | Missing | None | Actual signed provider callback blocked |
| WhatsApp (configured catalogue: LimeChat / Meta; WATI readiness detector exists) | Missing | None | `configuration_required`; no recipient contacted |
| SMS | Provider not selected/configured | None | `not_configured`; never represented as delivered |
| Transactional email | Provider not selected/configured | None | `not_configured`; never represented as delivered |

No synthetic value in automated tests is listed as an actual provider reference.

## Required UAT follow-up controls

1. Add Razorpay **test-mode** key ID, key secret and distinct sandbox webhook secret to the isolated UAT
   environment; never copy live credentials or enable the live-capture approval flag.
2. Use an allow-listed PawSpace test customer to create the order and post-service link, pay with a
   Razorpay test method, deliver captured/failed/refunded callbacks, replay one callback, force an
   unmatched event, and retain sanitized `order_`, `plink_`, `pay_`, `rfnd_` and event references.
3. Confirm the selected WhatsApp provider and configure its UAT credentials/webhook secret. Send only
   to allow-listed staff numbers and retain accepted, delivered and rejected callback references.
4. Select SMS and transactional-email providers. Until then the provider-neutral adapters must remain
   `configuration_required`; no simulator result may be called delivered.
5. Run the Finance pilot checklist against those provider events and obtain Finance/checker evidence.

## Release gates

- Targeted Lane 3 D1 suite: **252/252 passed**.
- Full `npm test`, typecheck, lint, build, exact-head Release CI: recorded in the PR after execution.
- Merge: **not performed**.
- Production deployment: **not performed**.
