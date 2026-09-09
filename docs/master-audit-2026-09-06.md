# PawSpace — Master End-to-End System Audit & Invariant Verification

**Date:** 2026-09-06
**Scope:** `pawspaceind/pawspace-tech-platform` — full platform, adversarial code + logic audit
**Baseline audited:** `main` @ `27d1f380` (verified still current against `ff00a5fe`; the audited surfaces were untouched by the intervening voice-dispatch merge)
**Method:** executable regression suites run on `main`, corroborated by independent file:line inspection. Every verdict is backed by a suite that runs the real handler against an in-memory D1, or by a quoted guard in production code — not source-text grep alone.

---

## Executive verdict

| Vector | Verdict | Basis |
|---|---|---|
| **Concurrency / TOCTOU guards (P0–P4)** | ✅ PASS (1 out-of-scope gap → fixed, see ①) | All authoritative status transitions are compare-and-swap + HTTP 409; `lifecycle-toctou-guards` 11/11 |
| **C6** — no refund on delivered service ("double loss") | ✅ PASS | `audit-criticals-regression` C6 + C6b green; all 7 verticals block |
| **H6** — refund ceiling vs *collected*, not billed | ✅ PASS | H6 + H6b green; `Math.min(expected, capturedCurrent)` |
| **H4** — provider can't adjudicate own dispute | ✅ PASS | H4/H4b/H4c green; non-vacuous (drives real GET/POST from a non-localhost origin) |
| **H2** — async assignment errors caught & redacted | ✅ PASS on anchored route; residual leak in a sibling route → fixed (③) | H2 green |
| **Haptik** webhook / outbound hardening | ✅ PASS (HMAC / SSRF / redirect / timeout all present) | behavioral HMAC test; SSRF/redirect/timeout in code |
| **Fast2SMS** transport | ✅ POST-secure + token fail-closed; missing timeout → fixed (②) | behavioral POST test |
| **D1 migration safety** | ✅ PASS | all payment/accounting DDL is `IF NOT EXISTS` / PRAGMA-guarded |

**No PASS-breaking defect was found in any of the five core vectors.** The residual items are one medium concurrency gap in an admin-only module, one medium missing-timeout on the SMS path, and two low-severity staff/UAT error-message leaks. Items ①–④ below are **remediated** on branch `claude/master-audit-residual-hardening` (this document's companion change).

---

## 1. Lifecycle concurrency & atomic guards (P0–P4) — ✅ PASS

Every vertical shares one helper pair: `assertLifecycleClaim(result)` throws `staleLifecycleConflict()` → **HTTP 409** when `meta.changes !== 1`. Every *authoritative* status UPDATE pins the prior status in its `WHERE` clause **and** feeds its result to that check. Verified UPDATE-by-UPDATE across all five verticals — **zero unguarded authoritative transitions**.

- `boarding-stay-lifecycle.ts:43` — `SET status='in_progress' … WHERE id=? AND status='confirmed' AND check_in_status!='complete'`
- `walking-lifecycle.ts:41` — `SET status='in_progress' … WHERE id=? AND status='assigned'`
- `taxi-lifecycle.ts:37` — trip + booking `complete_trip` both status-pinned
- `sitting-lifecycle.ts:29`, `training-session-lifecycle.ts:60` — same shape
- `financial-lifecycle.ts` uses a valid **version/lease** CAS (`advancePaymentState` :291 — `WHERE id=? AND state=? AND version=?`) and has a **real executable race test** (`financial-lifecycle-executable-concurrency.test.mjs` fires 20 concurrent claims via `Promise.all`, asserts exactly one winner).

Non-authoritative cascade tables (`scheduling_reservations`, `scheduling_assignment_decisions`, `provider_work_orders`, `provider_assignment_offers`) are updated by key without a CAS, but only ever after the authoritative CAS on the same request has already succeeded — so a stale caller is rejected before reaching them.

`tests/lifecycle-toctou-guards.test.mjs`: **11/11 green**.

**Test-quality note (see finding ⑤):** the dedicated TOCTOU suite is a source-text grep (26 `readFile` + `assert.match`, no DB) — it proves the guards are *written*, not that a losing racer actually receives a 409. The financial module is the only lifecycle with an executable concurrency test.

---

## 2. Financial ledger, refunds & accounting (C6, H6, D1) — ✅ PASS

**C6** — all seven verticals block a refund on a delivered/completed booking, on the **approve** path (the original C6 bug was request-pre-delivery → approve-post-delivery):

| Vertical | Guard |
|---|---|
| Sitting | `sitting-finance-governance.ts:64` — `if(status==="completed")throw …409` |
| Boarding | `boarding-finance-governance.ts:62–63` — completed **and** `check_in_status==='complete'` |
| Walking / Taxi / Food | `["cancelled","completed"/"delivered"].includes(status)` block + in-progress sub-state block |
| Training | pro-rata basis `captured_less_pro_rata_used` — a delivered session's value is never refundable |
| Grooming | completed-cancel diverted to a dispute case (409 `dispute_case_opened`) |

Executable proof: **AUDIT-C6** flips a booking to `completed` in SQLite then calls `approve_cancel` → asserts 409, booking stays completed, `sitting_refund_ledger` count `=== 0`. C6b confirms an undelivered booking *can* still cancel (non-vacuous).

**H6** — `grooming-payment-reconciliation.ts:322`: `refundCeiling = Math.min(expected, capturedCurrent)` where `capturedCurrent` is the actual `captured_amount`. AUDIT-H6 seeds `captured=1000, billed=4000`, refunds 4000 → flagged `refund_overage`, variance ≈ 3000. Correct: measured against **collected**, not billed.

**D1** — no raw `CREATE TABLE` anywhere; payment/accounting init is `CREATE TABLE IF NOT EXISTS` in `db.batch`, column adds are PRAGMA-guarded with duplicate-column tolerance (`finance-accounts.ts:88`), backfills use `INSERT OR IGNORE`. Existing transaction rows are safe.

---

## 3. Parent / provider / assignment (H4, H2) — ✅ PASS

**H4** — `booking-cancellation-case/route.ts:40` `requireStaff()` gates both the read (`:48`) and adjudication (`:72`). `service_provider` holds `bookings.view` (the route's permission) but is **not** in `STAFF_ROLES` → 403. Load-bearing: the governance layer exempts the `proceed` decision from `opsStopPermissions`, so without `requireStaff` a provider could adjudicate a complaint against themselves. Tests drive the real route from origin `app.pawspace.in` (avoiding the localhost superuser grant) — non-vacuous.

**H2** — `uat-scheduling/route.ts:127` `return await operateAssignment(...)` inside `try/catch`; the catch converts SQLite constraint→409, busy→503, else `authError()` (redacts all non-governed errors). AUDIT-H2 makes the *async* read inside `operateAssignment` throw and asserts a 409 `Response` (not a rejection, no raw text).

**Residual (LOW):** `assisted-orders/route.ts` GET/POST returned raw `error.message` on the non-`Response` branch — staff-only + `testOnly` UAT, so not an unauthenticated leak, but the same H2 anti-pattern. **Fixed (③).**

---

## 4. External integrations — ✅ PASS

**Haptik** — all four present. Inbound (`app/api/haptik/route.ts`): HMAC-SHA1 over the **raw** body (`x-hub-signature`, format-checked, constant-time compare, 401 on mismatch, 503 if secret unset), behaviorally tested. Outbound (`haptik-outbound-client.ts`): HTTPS-only + host allowlist + private/loopback/CGNAT/IPv6 IP blocking (SSRF), `redirect:"error"`, and a 2500 ms `AbortController` timeout. The inbound path is exempt from gateway session auth (`api-gateway.ts:15`), so the HMAC check is its sole authentication — and it is present and correct.

**Fast2SMS** — `sms-test-provider.ts` uses the modern `bulkV2` **POST** with the key in the `Authorization` header and recipient/message in the form body (nothing sensitive in the URL); token is fail-closed. **Residual (MEDIUM):** the outbound `fetch` had no timeout — a hung gateway connection could stall the OTP request path. **Fixed (②).**

**Payment webhook (Razorpay)** — corroborating evidence for the E2E collection leg: `financial-lifecycle.ts:208` `verifyRazorpayRawBody` does HMAC-SHA256 over the **raw** body with `constantTimeHexEqual`, fails closed when body/signature/secret is missing, throws on mismatch, and adds replay protection via `payload_sha256` dedup.

---

## 5. End-to-end lifecycle trace

Parent booking intent (`canonical-bookings`) → voice-dispatch / AI routing (`voice-outbound`, `voice-provider-webhook`) → auto-payment collection (`payment-order`, `razorpay-webhook` — HMAC + replay-dedup) → provider assignment & acceptance (`uat-scheduling` `operateAssignment` — awaited, redacted; the `*-lifecycle.ts` accept transitions — status-pinned CAS + 409) → service execution (lifecycle check_in/start → complete, each a CAS) → accounting / ledger reconciliation (`*-finance-governance.ts`, `finance-accounts.ts`, `payment-reconciliation` — idempotent DDL, H6 ceiling) → cancellation / refund (C6 delivered-block across all verticals). Every stage that mutates authoritative state does so through a compare-and-swap or an HMAC-verified, replay-protected boundary.

---

## Ranked residual findings

| # | Sev | Finding | Status |
|---|---|---|---|
| ① | MEDIUM | `whatsapp-template-lifecycle.ts` submit/reconcile/pause: read-then-blind-update TOCTOU (no prior-status pin, no `changes` check). Admin-operated, low concurrency. | ✅ Fixed |
| ② | MEDIUM | `sms-test-provider.ts` Fast2SMS `fetch` had no timeout — a hung connection stalls the OTP path. | ✅ Fixed |
| ③ | LOW | `assisted-orders/route.ts` GET/POST leaked raw `error.message` on the non-`Response` branch (staff-only UAT). | ✅ Fixed |
| ④ | LOW | `training-cancellation/route.ts` placed a caught `error.message` into the client-visible `referral.reason`. | ✅ Fixed |
| ⑤ | TEST-QUALITY | `lifecycle-toctou-guards.test.mjs` is source-text grep, not an executable race. Add real race tests per vertical, mirroring `financial-lifecycle-executable-concurrency.test.mjs`. | Open (recommended) |
| ⑥ | TEST-QUALITY | Haptik SSRF/redirect/timeout only source-grepped. Add a behavioral test calling `isAllowedHaptikOutboundUrl` with a private-IP / non-allowlisted / `http://` URL. | Open (recommended) |
| ⑦ | HARDENING | Grooming completed-cancel block is policy-config-driven (`change_lock_statuses_json`), unlike the other five hard-coded guards. Add an unconditional `completed → dispute-only` assertion. | Open (defense-in-depth) |
| ⑧ | HARDENING | Training C6 relies on pro-rata math, not a status block. Add an explicit "reject approval when all sessions delivered" guard in `approveTrainingCancellation`. | Open (defense-in-depth) |

---

## Remediation detail (①–④, this branch)

**① WhatsApp template CAS** — `lib/whatsapp-template-lifecycle.ts` (`submit`/`reconcile`/`pause`). The authoritative `whatsapp_uat_templates` UPDATE now pins the expected prior status (`… AND status IN ('draft','rejected')` / `='submitted'` / `='approved'`) and the code asserts exactly one row changed, raising a 409 otherwise. The companion `whatsapp_template_lifecycle` projection runs first in the batch, gated on the same prior status via an `EXISTS` sub-select, so a losing racer's transaction is a no-op on **both** statements before the 409 — preserving the original batch atomicity. The friendly pre-check ("Only draft or rejected templates may be submitted") is retained for the ordinary stale case.

**② Fast2SMS timeout** — `lib/sms-test-provider.ts`. The outbound POST is now bounded by a `FAST2SMS_TIMEOUT_MS = 4000` `AbortController`; the timer is cleared in a `finally`, and an abort surfaces as the existing transport-class `Fast2SmsProviderError` (fail-safe, no behavior change on the happy path).

**③ Assisted Orders redaction** — `app/api/assisted-orders/route.ts`. The non-`Response` branch of both GET and POST catches now routes through `authError(...)`, which logs the raw error server-side and returns a redacted body. The existing `Response` passthrough behavior is unchanged.

**④ Training referral reason** — `app/api/training-cancellation/route.ts`. The referral-consequence catch now stores a fixed `"Referral cancellation consequence requires review"` in the client-visible `referral.reason` and logs the raw error server-side only.

**Validation:** `tsc --noEmit` clean for all four files (the only typecheck errors are a pre-existing, environment-only missing `@playwright/test` in `e2e/`); the directly-affected suites (`whatsapp-template-lifecycle-execution`, `sms-test-provider`, `backend-otp-hardening`) and the full regression suite remain green.
