# PawSpace — Architecture, MongoDB/AWS Integration & Migration Plan

**Status:** design (approved direction: *design first*, then build expiry+journey, marketing engine, security hardening in parallel).
**Owner decision needed at the marked ⏳ points before the corresponding build starts.**

---

## 1. The two realities we are reconciling

| | New system (this repo) | Live production (4 years) |
|---|---|---|
| Runtime | Cloudflare Workers (edge) | AWS |
| Data store | Cloudflare **D1 (SQLite / SQL)** | **MongoDB (documents)** |
| Frontend | Next.js (vinext) | existing app |
| State | greenfield, test data | real customers, pets, bookings, payments |

The new system already contains the intelligence the old app lacks: canonical booking/payment state, CRM + SLA, finance/accrual, wallet, AI assistant + voice, the App-to-Revenue funnel, ₹300 recovery, customer targeting ("2-lakh" module). **The goal is to bring that intelligence to the existing 4-year customer base without asking anyone to re-download or re-register.**

The hard truth to design around: **D1 is SQL, MongoDB is documents**, and the business logic in this repo calls SQL inline (`db.prepare(...)`) in ~100 modules. A naïve "just swap the database" is not a small change. This plan avoids a risky big-bang rewrite.

---

## 2. Recommended architecture — Integration bridge, then converge

**Recommendation: keep the new system on its current runtime for now, make MongoDB a first-class integrated source of record via a bridge, and converge deliberately — not a big-bang replatform.**

```
                 ┌─────────────────────────────┐
   Existing app  │      EXISTING MongoDB        │  (system of record for
   (AWS, live) ──┤  customers · pets · bookings ├─  existing customers today)
                 └──────────────┬──────────────┘
                                │  (2) sync bridge
                   ┌────────────┴─────────────┐
                   │   INTEGRATION LAYER       │  ← new, thin, the ONLY place
                   │  MongoDB ⇄ canonical_*    │    that knows both schemas
                   └────────────┬─────────────┘
                                │
                 ┌──────────────┴──────────────┐
   New system    │   Canonical store (D1 now)   │  (intelligence: CRM, finance,
   (Cloudflare)  │  + all modules in this repo  │   funnel, AI, targeting…)
                 └─────────────────────────────┘
```

### Why a bridge, not a rewrite (yet)
- The new logic is **live-tested and fast to iterate** on its current stack. Freezing it to do a 100-module SQL→Mongo port would stall everything you just built.
- A bridge lets existing customers light up **immediately** (identity match by phone), which is the actual business goal.
- It creates **one seam** (the integration layer) that owns both schemas, instead of scattering Mongo knowledge across the codebase.
- Convergence (if you later want a single AWS+Mongo stack) becomes a controlled Phase 3, informed by real usage — not a guess made today.

### The three viable end-states (pick the convergence target later)
1. **Bridge, indefinitely** — Cloudflare/D1 stays the intelligence layer; MongoDB stays the app's store; the bridge keeps them in sync. Lowest effort, two runtimes.
2. **Converge onto AWS + MongoDB** — introduce a repository/DAO layer, port canonical_* to MongoDB collections, deploy the JS/TS logic on AWS (ECS/Lambda behind API Gateway). One stack; largest effort. The bridge becomes the migration tool.
3. **Converge onto Cloudflare, MongoDB as SoR** — Workers reach MongoDB Atlas (Data API / driver over HTTPS) as the store; drop D1. Keeps the edge runtime, unifies data.

> ⏳ **Decision (later, not blocking):** which end-state. This plan makes Phases 0–2 identical for all three, so we don't need it to start.

---

## 3. Data mapping & identity reconciliation

The integration layer maps existing MongoDB documents ⇄ canonical tables. **Identity is matched on normalized phone (E.164, last-10)** — the same key `customer-360`/merge already uses, so existing dedup logic applies.

| Canonical (new) | Existing MongoDB (assumed — confirm in discovery) | Match key |
|---|---|---|
| `canonical_customers` | `users` / `customers` | phone |
| `canonical_pets` | `pets` | ownerId → phone |
| `canonical_bookings` | `bookings` / `orders` | bookingId + phone |
| `booking_payments` | `payments` / `transactions` | paymentId / orderId |
| `customer_grooming_subscriptions` | `subscriptions` / `plans` | subscriptionId |
| `crm_contacts` / `lead_work_items` | (likely none — new) | phone |

> ⏳ **Discovery required:** we do **not** have your real MongoDB schema. Step 1 of the build is a read-only schema discovery (collections, field names, indexes, volume) to replace the "assumed" column above with the real one. Nothing writes to Mongo until that's mapped and reviewed.

### Sync design
- **Inbound (Mongo → canonical), read-only first:** batch backfill + incremental via **change streams** (preferred) or a polled `updatedAt` cursor. Idempotent upserts keyed by phone/id (the codebase's `INSERT … ON CONFLICT` pattern maps cleanly).
- **Outbound (canonical → Mongo):** write-back of *new* signals (leads, funnel stage, ₹300 entitlements, targeting scores) so the existing app/ops see them. Behind a feature flag, **off until reviewed** — same fail-closed discipline as every external integration here.
- **Conflict rule:** existing Mongo fields are authoritative for existing entities during Phase 1–2; canonical is authoritative for net-new entities (leads/funnel/finance). Documented per-collection.

---

## 4. AWS deployment shape (when we deploy there)

- **Compute:** the logic is standard TS. Containerize (ECS Fargate) or Lambda behind **API Gateway**; Next.js frontend on Amplify/S3+CloudFront. (If staying on Cloudflare, Workers reach Atlas via the driver/Data API — no AWS compute needed.)
- **Data:** MongoDB **Atlas on AWS** (same region/VPC peering) or self-managed on EC2. Prefer Atlas for backups, encryption, change streams.
- **Networking:** private VPC, VPC peering/PrivateLink to Atlas, no public DB.
- **Secrets:** AWS **Secrets Manager + KMS** (replaces the current env-var secrets); nothing in the repo.

---

## 5. Migration & cutover — phased, reversible

| Phase | What | Risk | Reversible? |
|---|---|---|---|
| **0. Discovery** | Read-only: map real Mongo schema, volumes, indexes. Produce the field-level mapping doc. | none (read-only) | n/a |
| **1. Shadow import** | Backfill Mongo → canonical (read-only). Existing customers now recognized in the new system. Reconciliation report (counts match). | low | yes (drop canonical) |
| **2. Dual-run** | New signals (leads, funnel, ₹300, targeting) written to canonical; write-back to Mongo behind a flag. Old app unchanged. | medium | yes (flag off) |
| **3. Convergence** | Execute the chosen end-state (§2). Repository layer or runtime move; cut traffic over with backfill + reconciliation. | high | staged rollback |

Each phase ends with a **reconciliation report** (row counts, sampled record diffs) before the next begins. No customer is ever asked to re-download — Phase 1 makes them present in the new system automatically.

---

## 6. How the three parallel builds fit this plan (so none is wasted)

All three write only to **canonical_\*** tables, which the bridge syncs — so they are forward-compatible with every end-state.

- **Expiry (per-plan) + journey tracking** — extends existing `subscription-wallet` expiry to be **configurable per plan** and to cover **training + all services**; adds **pet-profile-created** and **enquiry-by-service** journey events to the App-to-Revenue funnel, and feeds pre-booking leads into the **targeting ("2-lakh") module**. *D1-native, bridge-syncable. Start now.*
- **Marketing automation engine** — ingest **Google Ads + Meta + SEO + contact-us** leads (via the available **Supermetrics connector**) → auto-coupon → route to Sales/voice with a computed **pitch** → report. Built on the same lead/funnel canon. *Biggest net-new; starts after the journey events exist (it consumes them).*
- **Security review + hardening** — run the code security review on the branch; stage the Cloudflare/AWS edge controls (§7). *Independent; can run immediately.*

---

## 7. Security posture & hardening (honest)

**Not "100%" — no honest system claims that.** Current **app-layer** security is genuinely strong: RBAC permissions, HMAC-signed identity assertions, OTP (customer/partner), platform sessions, same-origin write guards, per-customer ownership checks, idempotency, maker-checker governance, audit logging, fail-closed external adapters, **no secrets in the repo**.

**Recommended add-ons (edge/infra — where the real gaps are):**
- **Cloudflare:** WAF, DDoS/Shield, rate limiting, **Turnstile** on OTP + contact forms (abuse/bots), Access for staff tools.
- **AWS:** WAF + Shield, **Secrets Manager + KMS**, encryption at rest + **field-level encryption for PII**, VPC isolation, IAM least-privilege, GuardDuty.
- **Data/compliance:** **India DPDP Act** consent handling (consent gating already exists), backups/DR, dependency scanning, and a **third-party pen test** before go-live.
- **Process:** run `/security-review` on each PR; secret-scanning in CI.

---

## 8. Immediate next steps

1. **Security review now** — run the review on the current branch; log findings.
2. **Build: expiry (per-plan) + journey events** — extends what's live; syncs cleanly later.
3. **Mongo discovery (read-only)** — map the real schema so Phase 1 can be scoped. *Requires a read-only Atlas connection string or an exported schema/sample — shared via your secrets manager, never pasted in chat.*
4. **Marketing engine** — after journey events land.

> Guardrail unchanged: the live production app, live provider accounts, and production data are never disturbed. Every integration is fail-closed and switched on only in isolated staging first.
