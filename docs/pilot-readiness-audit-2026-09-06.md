# PawSpace — Ten-Dimension Pilot-Readiness Audit

**Date:** 2026-09-06 · **Base commit:** `767ca73e` · **Method:** ten independent adversarial audits,
each required to *execute* the code path rather than read it. Every finding below is labelled
EXECUTION-VERIFIED (a probe ran the real handler and the output is quoted) or CODE-READING-ONLY.

**Overall verdict: NOT READY for a public pilot. Ready for supervised internal testing only, and
not with real customer personal data until the DPDP items below are closed.**

The engineering core is genuinely strong in the places that were built deliberately — the Razorpay
webhook receiver, `lib/voice-safe-fetch.ts`, `readBoundedRequestText`, `safeEqual`, the reservation
partial-unique-index pattern, and `safeFailureDetail()` are all correct, first-rate implementations.
The recurring failure mode is not absence of a control; it is **a correct control that exists in one
module and was not reused in its siblings.** That is a good position to be in: most fixes below are
mechanical reuse, not design work.

---

## Scoreboard

| # | Dimension | Verdict |
|---|---|---|
| 1 | Operational readiness (backups, RPO, alerting) | ⚠️ Partial |
| 2 | Money correctness (payments, refunds, settlement) | ⚠️ Partial — 3 fixed this cycle |
| 3 | Authorization / RBAC | ✅ Strong — boundaries hold under probe |
| 4 | Concurrency & races | ⚠️ Partial — 1 fixed this cycle |
| 5 | Business-logic integrity | ⚠️ Partial |
| 6 | Test integrity | ⚠️ **Preview-host trap is the headline risk** |
| 7 | Schema & migrations | ❌ **10 financial tables never applied** |
| 8 | External integrations | ⚠️ Partial — Razorpay strong, others not |
| 9 | Frontend / UX | ❌ **NOT READY** |
| 10 | PII & DPDP 2023 compliance | ❌ **NOT COMPLIANT** |

---

## P0 — blocks any pilot with real users or real money

### P0-1 · Ten financial tables exist only in `drizzle/`, which no workflow applies
Schema audit. The `drizzle/` directory declares ten financial tables that no deploy workflow ever
migrates. Production therefore does not have them. Any code path that writes to one fails at runtime.
Foreign keys are likewise never enforced in production.
**Fix:** decide the single source of truth for schema (the `ensure*Tables` runtime creators, or
drizzle) and make the deploy pipeline apply it. Do not run both.

### P0-2 · `lib/crm-pipeline-forecast.ts:112` — INSERT has 17 columns and 18 values
Schema audit. This statement can never succeed; the code path is dead on every invocation.

### P0-3 · DPDP 2023 — consent is manufactured by the server, not collected from the person
Privacy audit, CODE-READING-ONLY but unambiguous. `canonical_customers.consent_json` is written as a
hardcoded literal `{"serviceUpdates":true,"marketing":false}` at every booking
(`app/api/walking-bookings/route.ts:25`, `taxi-bookings:21`, `sitting-bookings:53`,
`canonical-bookings:469`, `food-orders:5`) and as `'{}'` at OTP signup (`lib/customer-otp.ts:56`).
`customer_contact_preferences.service_consent` defaults to `1`. There is **no customer-facing consent
surface anywhere** — the only writers are staff routes. Every downstream "consent verified" check in
the communication stack is therefore reading a value the customer never gave.
This is the most serious privacy finding because it silently invalidates controls that do work.

### P0-4 · DPDP 2023 — four of six data-principal rights have no code at all
| Obligation | Status |
|---|---|
| Erasure (§12(3)) | No `DELETE FROM canonical_customers / canonical_pets / customer_addresses / crm_contacts` exists. `data.delete` permission is required by zero routes. |
| Export / access (§11) | `customers.export` is referenced by zero routes. |
| Breach notification (§8(6)) | Zero code. Named as open in the readiness ledger itself. |
| Retention / deletion (§8(7)) | No time-based purge. `lib/background-scheduler.ts:43` runs 24 sweeps; none is a retention job. |
| Named DPO / grievance channel (§13, §10) | No privacy policy page, no grievance route, no contact. |

### P0-5 · Frontend — NOT READY for a human tester
Frontend audit, browser-verified. `/mobile-app` renders a **blank screen**. A floating action button
covers the "Confirm booking" control. Care-plan data entered by the customer is silently discarded.
~250 "UAT"/"sandbox" strings are visible on customer-facing screens. There is **no `error.tsx` and no
`loading.tsx` anywhere in the app** — any thrown error is a white page. Pasting a `+91`-prefixed phone
number produces a wrong number.

### P0-6 · Provider surfaces leak raw customer phone, email and doorstep address
Privacy audit, EXECUTION-VERIFIED against the real handlers with a real `service_provider` actor.
- `app/api/partner-grooming-jobs/route.ts:45,64` returns `detail_json` — an unbounded staff-written
  blob — verbatim, two fields after correctly masking the phone.
- `app/api/grooming-lifecycle/route.ts:34` returns three `SELECT *` blobs including raw
  `detail_json`.
Probe output: masked `"+91 ••••••5678"` in one field, `"called customer on +919812345678"`,
`"meera.subject@example.com"` and the full street address in the next. The confirmed first-party
writer is `app/api/assisted-orders/route.ts:66` (`consentReference`, free text, validated only as
`length>=5`). Staff email addresses (`actor_id`) go out on the same responses.
**Fix:** field-allowlist both provider responses. This is live exposure to external contractors.

### P0-7 · Four decisions awaiting the founder (product semantics, not defects)
1. Founder auto-provision — should the first sign-in mint a superuser?
2. Production OTP path — currently returns 503; what is the launch behaviour?
3. `pay_balance` in production — enable or gate?
4. Sign-off to move the statutory `DELETE`s (now patched, see below) into the filing workflow.

---

## P1 — fix before a pilot; three are already fixed on `fix/audit-p1-remediation`

### ✅ FIXED · C3 · Statutory `DELETE` ran before the source read
`lib/tcs-governance.ts`, `lib/tds-governance.ts`. Both recompute paths deleted the period's
`tcs_collections` / `tds_deductions` rows *before* reading their source table. A failed source read
left the filing period silently empty. **Now:** the read runs first; the `DELETE` only follows a
successful one. An absent source table still recomputes to empty (legitimate); an existing table whose
read throws now refuses and preserves the rows.

### ✅ FIXED · H9 · A WhatsApp template hiccup halted payment reconciliation
`worker/index.ts`. A template-verification exception `throw`n before the scheduled fan-out stopped
every sweep behind it — including `runRazorpayOrderOutboxSweep`,
`runRazorpaySettlementReconciliationSweep` and `runSubscriptionScheduledMaintenance`. With no alerting,
this was silent. **Now:** the block is scoped to the two WhatsApp senders only. The guard's intent —
never dispatch an unverified template — is preserved exactly.

### ✅ FIXED · H1 · Admin reassign could create a double-booking in its own recovery path
`app/api/uat-scheduling/route.ts`. The rollback restored a released reservation with a bare `UPDATE`;
another booking could take the slot in between. **Now:** the precondition lives inside the writing
statement (`UPDATE … WHERE NOT EXISTS overlapping active reservation`), and a refused restore returns
`409 SLOT_LOST_DURING_REASSIGN` instead of reporting the reservation as left in place.

### P1-4 · Haptik outbound `fetch` has no timeout, no size bound, no URL validation
`lib/haptik-outbound-client.ts:23`. EXECUTION-VERIFIED: the probe reached
`http://169.254.169.254/latest/meta-data/iam/security-credentials/` **with the Haptik bearer token
attached**, the fetch was still hanging after 2503 ms with no deadline, and a 12 MB response was
buffered whole. Same class: `EXOTEL_SUBDOMAIN` is interpolated unvalidated into the host at
`lib/voice-bridge-governance.ts:170` and `lib/voice-telephony-provider.ts:149`, both carrying Basic
credentials, neither setting `redirect:"error"`.
**Fix:** route these through `assertSafeVoiceUrl` / `lib/voice-safe-fetch.ts`, which is already
excellent and already in the repo. `lib/razorpay-client.ts:66-75` is the model.

### P1-5 · Meta WhatsApp bypasses the consent / quiet-hours / frequency engine end to end
`lib/whatsapp-uat-adapter.ts:43-45` writes `communication_messages` + `communication_outbox` directly
and never calls `enqueueCommunication`. `lib/communication-outbox-dispatcher.ts` explicitly excludes
WhatsApp (`WHERE m.channel<>'whatsapp'`). The three actual senders — including the **live production
path** `lib/meta-whatsapp-dispatch.ts:2` — never call `enforceCommunicationDispatchPolicy`.
`lib/interakt-whatsapp.ts:24` does call it, so the platform knows the gate is required.
**Effect:** marketing WhatsApp can be sent at 02:00 IST, unlimited times per week, on the live path.

### P1-6 · Ten outbound provider modules have no request deadline at all
Zero `AbortController` in `meta-whatsapp-dispatch.ts`, `meta-whatsapp-media-ingestion.ts`,
`meta-whatsapp-media.ts`, `meta-whatsapp-template-verification.ts`, `meta-whatsapp-uat-dispatch.ts`,
`whatsapp-production-runtime.ts`, `address-autocomplete.ts`, `haptik-outbound-client.ts`,
`crm-email-sync.ts`, `report-export-runtime.ts`. Meta dispatch is saved by `recoverStaleClaims`
(5-minute reclaim, verified channel-agnostic); Haptik has no such backstop and strands the row
`pending` forever while blocking its own retry (`lib/haptik-outbound-governance.ts:36`).

### P1-7 · Four webhook receivers buffer an unbounded request body before checking the signature
`app/api/whatsapp/meta-webhook/route.ts:15`, `app/api/whatsapp-uat-webhook/route.ts:22`,
`app/api/email-provider-webhook/route.ts:28`, `app/api/razorpay-webhook/route.ts:80`.
`app/api/communication-provider-callback/route.ts:9` pre-checks `content-length`, which a chunked body
walks straight through (probe: 40 MB buffered, heap +40 MB, before the 413 fired). All are
gateway-allowlisted and reachable with no credential. `readBoundedRequestText` already exists and
three routes use it correctly.

### P1-8 · Exotel Basic auth binds to nothing and downgrades away the HMAC freshness window
`lib/voice-telephony-provider.ts:71-77`. EXECUTION-VERIFIED: a Basic-authenticated callback with an
attacker-chosen body verified `true`; the same body one year later verified `true`; dropping the
signature header to force the Basic path bypassed the freshness window entirely. The Basic password
*is* `EXOTEL_WEBHOOK_SECRET` and is transmitted on every callback, so one captured proxy log yields
permanent unrestricted forging. The compare itself is correctly constant-time.
**Fix:** given Exotel genuinely cannot HMAC, add a per-request `CallSid` freshness/nonce check.

### P1-9 · Test integrity — the preview-host trap
`lib/development-preview.ts` grants superuser `["*"]` on `localhost` / `127.0.0.1` / `terminal.local`,
and `npm test` runs with `PAWSPACE_LOCAL_PREVIEW=on`. 185 tests pass **only because of that flag**.
They are not testing the authorization they appear to test. Roughly 30% of the 4245-test suite is
load-bearing; deleting the past-start booking rule reddens exactly one test.

### P1-10 · An Exotel dial timeout permanently mis-records a call that actually connected
`lib/voice-bridge-governance.ts:236-241`. If the 12 s abort fires after the request reached the
carrier, the call proceeds but is recorded `failed`, and the carrier's later callbacks cannot correct
it because every transition requires `status IN ('initiated','bridged')`. The partial unique index
then no longer blocks a second bridge — two concurrent masked calls between the same two people.

### P1-11 · OTP codes stored in plaintext beside raw phone numbers, never purged
`lib/customer-otp.ts:22,31` and `lib/partner-otp.ts:14`. Consumed rows are only flagged, never
deleted, and no sweep exists. Result: an indefinitely growing plaintext table of every phone number
that ever attempted sign-in, with the live credential beside it. Closed by the P0-4 retention sweep.

---

## P2 — fix before scale, not before pilot

- **P2-1** `lib/purpose-based-access.ts` declares `fullAddressWindowHours:24` and two other windows but
  **no provider-facing route imports it**; `app/api/grooming-route/route.ts:14` hands over the full
  address under its own hand-rolled state set. Editing the governed policy config changes nothing
  where the doorstep is actually disclosed.
- **P2-2** No recording announcement on either voice path. `validateVoiceScript`
  (`lib/voice-outbound-governance.ts:120-131`) tests `/automated|recorded|assistant|bot/` as an **OR**,
  so the seeded disclosure passes without ever mentioning recording. The masked-bridge path has no
  script at all. No deletion or expiry capability exists for recordings the platform caused to be made.
- **P2-3** Raw phone stored where a hash is already the proven pattern.
  `voice_call_sessions` does it right (`customer_phone_hash` + `last4`); `voice_call_orders.dial_number`
  stores the full E.164 *alongside* the key and last4 it already has. Same in `bot_call_dispositions`,
  four `haptik_*` tables, `ai_web_leads`, `relocation_enquiries`.
- **P2-4** `safeFailureDetail()` exists and is correct but is not reused —
  `lib/lifecycle-communications.ts:104-108` persists raw error text and six stack frames from a path
  whose only inputs are customer notification bodies. Same in `lib/subscription-billing.ts:27`,
  `lib/report-export-runtime.ts:136`.
- **P2-5** `app/api/haptik/route.ts:10` compares its shared secret with `!==` — the only inbound
  receiver not using `safeEqual`, on the repo's most privileged unauthenticated route (it writes CRM
  leads, creates bookings, records dispositions, triggers outbound WhatsApp).
- **P2-6** Bridge dedupe key is payload-hash-scoped
  (`lib/voice-bridge-governance.ts:278`), so appending one byte to a captured event mints unlimited new
  rows. State is not corrupted — the CAS guards hold — but the table grows without bound.
- **P2-7** `recording_ref` accepts an unvalidated, unbounded, attacker-supplied URL on any event in any
  session state (`lib/voice-bridge-governance.ts:288,295`). Nothing dereferences it today; the sibling
  module caps it at 500 chars and this one does not.
- **P2-8** `lib/communication-provider-boundary.ts:34` and `lib/voice-provider-adapter.ts:36` set an
  `AbortSignal` correctly then read the body with unbounded `response.text()`. The abort caps
  wall-clock, not memory.
- **P2-9** `lib/meta-whatsapp-media-ingestion.ts:17` buffers the whole body *then* checks its size,
  against a 100 MB document limit — an OOM before the check runs.
- **P2-10** Exotel/voice receivers answer `401` for an unconfigured secret where every peer answers
  `503`, making a misconfiguration indistinguishable from an attack in alerting.
- **P2-11** `lib/sms-test-provider.ts:36-45` and `lib/address-autocomplete.ts:64` put the message body
  and API key in the **query string**, where any upstream access log captures them.

---

## Deferred by decision

**H3 — provider accept overwrites ops recovery** (5 lifecycle files). Real, but the fix touches five
coupled state machines and needs a product decision about which actor wins. Deliberately not attempted
in this cycle.

---

## Verified correct — do not re-litigate

- **Razorpay webhook receiver** — HMAC, constant-time, payload-digest + event-id idempotency; four
  idempotency cases execution-verified; bad signature → 401 with zero rows written; passed sabotage.
- **`lib/voice-safe-fetch.ts`** — real IPv4/IPv6 range parsing, per-hop redirect revalidation,
  streaming caps. Genuinely excellent; the problem is only that half the boundaries don't use it.
- **`lib/razorpay-client.ts:66-75`** — the model implementation for validating a config-supplied base
  URL.
- **Every RBAC boundary probed holds.** A `service_provider` actor got 403 from `funeral-memorial`,
  `customer-360`, `crm`, `customer-data-reveal`, `boarding-ops`, `sitting-ops`, `pricing-control`.
  Cross-tenant provider reads are refused (`requireProviderOwnership`, `lib/server-auth.ts:88-95`).
- **`partner-job-feed` and `provider-workspace` are clean** — execution-verified, no PII leak.
- **`customer-360` enforces address precision correctly** (`route.ts:34,37`).
- **`voice_call_sessions` hashing is correct**, and the do-not-call register is checked twice, for both
  parties, before and immediately after session creation.
- **Opt-out is honoured** from inbound STOP and from voice.
- **`service-media` is well-scoped**; `assertServiceProofRef` is a genuinely strict gate.
- **No provider secret is logged, echoed in an error, written to a row, or returned in a response** —
  zero hits across `lib/` and `app/api/`.
- **Booking lifecycle events written by the Razorpay reconciler are curated, not the raw webhook body.**

---

## What changed in this cycle

Branch `fix/audit-p1-remediation` (base `767ca73e`), commit `85f412b7`:
C3, H9 and H1 closed, with `tests/audit-p1-remediation.test.mjs` (4 regression tests, each
sabotage-verified — reverting the production change reddens that test and only that test) and a
deliberate contract change to `tests/whatsapp-template-sync.test.mjs`, which had pinned H9's blast
radius as the contract.

**Suite: 4245 pass, 0 fail. `tsc --noEmit` clean.**
