# PawSpace Readiness Ledger — single source of truth

**The rule, for any agent (human, Claude, ChatGPT, or otherwise) working on this repo:**

1. **Before starting work on a module or task**, search this file for it first. If it's already
   ✅ or 🔧, don't retest it from scratch — read the evidence, and only act if you have a specific,
   new reason to doubt it (e.g. a subsequent commit touched that exact file).
2. **After finishing work**, update this file in the *same commit* (or the next one): status,
   what was actually verified, and the real commit SHA. A task is never "done" here without a
   real passing execution test or a specific commit reference — no vibes-based closure.
3. **If you find a real bug**, note it here even after fixing it, so nobody re-discovers and
   re-fixes the same thing, and so there's a record of what actually shipped wrong.
4. **When in doubt whether someone else already covered a module, check `git log --oneline -- <path>`
   first.** Commit messages in this repo have been written specifically to make this checkable.

Legend: ✅ verified clean (real execution, no bug found) · 🔧 bug found, fixed, and verified ·
🟡 partial (see notes) · ⬜ not started · 🚫 blocked on external creds/human/infra, cannot code-close.

---

## Reconciliation against ChatGPT's latest readiness plan (received 2026-08-11)

ChatGPT's plan was written against `main@fd6af2a`. As of this ledger, `main` has moved
significantly past that point (see `git log --oneline fd6af2a..HEAD`). Specific corrections:

| ChatGPT's item | ChatGPT's status | Actual status | Evidence |
|---|---|---|---|
| P0-1: Release CI self-certification | "Task 1, not yet started" | ✅ **Already done** | commit `3ae1724` "Make main self-certifying in release CI" |
| P0-3: Pricing Control → real booking quotes | "Task 3, not started" | 🟡 **Partially done** | Grooming single-pet: 🔧 done, commit `0f19efe`. Grooming multi-pet, Training, Boarding, Sitting: ⬜ still open |
| P1-6: Subscription Control → real Subscription Wallet | "not started" | ✅ **Already verified clean** | `lib/subscription-wallet.ts` (existed since commit `74152f3`, predates this session) — real execution tested by Claude: reserve/consume/release, capacity limits, double-spend prevention, pause-entitlement enforcement all correct. **Recommend ChatGPT does not re-test the core lib file** — if P1-6 means a *different* gap (e.g. a UI/API layer not yet wired to it), that's real and open, but the wallet logic itself is not the gap. |
| Food/Taxi/Walking "Gates 1-5" certification | "closed" (their commits) | Needs reconciling | Claude independently verified Food's core quote-to-order flow clean (real inventory, idempotency, quote expiry, quantity limits, coupon-block) — **check whether "Gates 1-5" covers the same ground or different ground** (e.g. Gates 1-5 might be UI/permission gates, not the business logic Claude tested) before assuming full overlap or zero overlap. |
| AI evaluation security gate | "closed" (their commit `22694b7`/`45f1434`) | Needs reconciling | Claude verified real AI safety guarantees early this session (AI cannot issue refunds/capture payments/release payouts/etc., all `approval_gated` confirmed under real execution) — likely the same ground, but not 100% confirmed identical scope. |

**Net effect:** of ChatGPT's 10 "P0/P1, can close today" items, at least 2 are already fully done
and 2 more need a quick scope-check rather than a full re-test. Recommend re-running ChatGPT's
plan against current `main`, not `fd6af2a`, before assigning today's work.

---

## Foundation

| Item | Status | Evidence |
|---|---|---|
| Release CI self-certifies exact `main` SHA | ✅ | commit `3ae1724` |
| Core auth/permission/ownership layer (`platform-security.ts`, `server-auth.ts`, `identity-binding.ts`) | ✅ | Real execution: wildcard/exact-match permissions, malformed-permission-data handling, cross-customer/cross-provider ownership attacks correctly denied, unverified identity bindings correctly rejected. No code changes needed. |

## Booking / payment / invoice / cancellation / payout — all 6 verticals

| Vertical | Status | Notes |
|---|---|---|
| Grooming | ✅ (+ 2 real bugs found & fixed) | Full quote→govern→booking→payment→invoice verified early this session. Later found & fixed: (1) customer app's real booking flow submitted a packageCode that matched nothing in the server catalogue — every real booking would have been rejected (commit `9c79f99`); (2) Pricing Control now genuinely affects live bookings for single-pet case (commit `0f19efe`) |
| Boarding | ✅ | Verified early this session (boarding-finance-governance bug found & fixed same day: phantom columns queried) |
| Training | ✅ | Verified early this session; training-finance.ts (payout/earnings holding logic) separately re-verified later, clean |
| Pet Sitting | ✅ | Verified early this session |
| Dog Walking | ✅ | Verified early this session |
| Pet Taxi | ✅ | Verified early this session |
| Food | ✅ | Real quote-to-order flow re-verified this session: inventory reservation, idempotency, quote expiry, quantity limits, coupon-block. Clean. |
| Funeral-Memorial | 🔧 | Was silently enabling all 3 service types by default with no price configured — fixed |
| Relocation | 🔧 | Quotes could be issued before any document verification — fixed |

## Payroll / GST / Finance

| Item | Status | Notes |
|---|---|---|
| Payroll engine | ✅ | Verified early this session |
| GST/Accounting | ✅ | Verified early this session, `finance_close_periods` table bug found & fixed |
| Scheduling engine (shared across verticals) | ✅ | Bug found & fixed (missing self-provisioning tables) |
| Provider commission/payout | 🔧 | Real bug found & fixed (stray extra `?` in INSERT) |
| `grooming-payment-reconciliation.ts` (Razorpay webhook handling, signature verification, variance detection, refunds) | ✅ | Real execution: dedup, out-of-order events, amount-mismatch detection, refund lifecycle, unmatched-event flagging. Clean. |
| `training-finance.ts` (trainer earnings held vs paid based on real captured payment) | ✅ | Real execution: held→earned transition proven correct as payment catches up |
| `partner-settlement-governance.ts` | 🔧 | Real bug found & fixed: no function anywhere could ever clear the `policy_status` gate — every settlement would be permanently stuck |
| `sales-productivity-governance.ts` | 🔧 | **Severe**: `saveSalesProductivityPolicy` crashed on every single call (misaligned NULL violated a NOT NULL constraint) — fixed |

## AI safety

| Item | Status | Notes |
|---|---|---|
| AI cannot issue refunds/capture payments/release payouts/override prices/assign providers/activate campaigns | ✅ | Real execution, all confirmed `approval_gated` |
| AI conversation orchestrator (Customer 360 context, handoff routing) | ✅ | Verified early this session |
## Lead management (built + verified this session, not pre-existing)

| Item | Status | Notes |
|---|---|---|
| Auto-assignment (workload-balanced, fallback queue, continuity) | 🔧 | 2 real bugs found & fixed: activation crashed on the exact create→activate flow; a failed reassignment could permanently orphan a lead with no owner |
| SLA escalation clocks | ✅ | Real execution, business-hours aware |
| Automatic SLA reassignment (was event-only before) | 🔧 built | Now genuinely executes, not just flags — commit `fd6af2a` |
| RNR-count auto-reassignment (3 RNRs/48h → next person) | 🔧 built | commit `6193b8e` |
| Rep daily-closure gate (3.5h talk time + all leads touched) + manager escalation | 🔧 built | commit `c0f9e99` |
| Outbound batch assignment (N leads at a time) | 🔧 built | commit `3fb3952` |
| RNR contact policy (was capped at 3, needed 4) | 🔧 | Fixed to match the explicit real business rule |
| Callback reminder system | 🔧 built by ChatGPT/other session | commit `df9c41c` — not duplicated by Claude |

## Incentive engines (built + verified this session)

| Item | Status | Notes |
|---|---|---|
| Groomer incentive engine | 🔧 built | Verified against real July sheet numbers exactly. One later bug found & fixed (crashed for any real high-performing groomer) |
| Trainer incentive engine | 🔧 built | Verified against exact stated example (₹1,60,000 → ₹4,000) |
| Sales/Telesales incentive engine | 🔧 built | Verified against real published rate sheets exactly, including a caught modeling issue (non-monotonic monthly tiers) |
| Manager/founder dashboard | 🔧 built | Real org-structure scoping (same relationship Payroll/HR already trusts), honest about classification confidence |

## Provider onboarding (verified this session, pre-existing code)

| Item | Status | Notes |
|---|---|---|
| `provider-onboarding-configuration.ts` (multi-jurisdiction policy precedence, locale fallback, quiz-translation integrity) | ✅ | Real execution, all safeguards held |
| `provider-onboarding-self-service.ts` + `provider-onboarding-transactional.ts` (ownership enforcement, document gating, frozen quiz version, deterministic scoring) | ✅ | Real execution, all safeguards held |
| `provider-onboarding-human-activation.ts` (interview double-booking prevention, human decision authority, activation checklist, post-activation field protection) | ✅ | Real execution, all safeguards held — this is the most sophisticated file in the cluster |
| `provider-capacity-governance.ts` (real matching, unavailability blocking, offer expiry) | ✅ | Real execution, clean |

## Other verticals / modules verified clean this session (no bugs found)

- `revenue-intelligence.ts` (suppression safeguards, opportunity scoring, sort order) — ✅

## Modules with real bugs found & fixed this session (beyond the two listed above)

- `revenue-opportunity-governance.ts` — 🔧 **2 real bugs**: (1) `saveRevenueOpportunityPolicy`'s
  INSERT had 19 value tokens for 18 columns — a misplaced NULL pushed `created_by` (NOT NULL) to
  receive NULL, crashing every real policy creation; (2) the same `UNIQUE(policy_id,version)`
  version-history bug already found twice elsewhere this session. Both fixed and verified with
  real execution: consent/complaint/quiet-hours/frequency-cap suppression, idempotency, and
  cross-customer conversion-ownership checks all hold correctly. Commit `d2379db`.
- `ai-business-configuration.ts` — ✅ Real execution: global/channel-scoped kill switches correctly
  isolated from each other, real visibility-scoped knowledge retrieval (customer-facing queries
  never see internal-only content), full draft→review→approve→activate lifecycle held, honest
  `configurationRequired` signal before anything is set up.
- `ai-web-chat-adapter.ts` — ✅ Real execution: public knowledge search and anonymous lead capture
  are genuinely customer-data-free; `runAuthenticatedAiWebChat` correctly enforces real customer
  ownership before any authenticated turn (reuses the same `requireCustomerOwnership` primitive
  verified earlier this session), staff correctly bypass it by design.
- `revenue-mission-control.ts` — 🔧 **Real bug, same class found 3 times prior**:
  `UNIQUE(mission_id,config_version)` blocked the basic create-then-activate flow. Fixed. Also
  verified the delta-based collection/refund tracking directly — a partial capture followed by a
  full capture correctly records only the new delta, never double-counting; real scope isolation
  (city/service) holds. Commit `d7b311d`.
- `revenue-mission-command-center.ts`, `revenue-leadership-reporting.ts` — ✅ Real execution:
  honest `configuration_required` fallback with no fabricated figures when no mission exists;
  real snapshot immutability (a generated report does not retroactively change when more revenue
  is recorded afterward); real idempotency; delivery-status tracking correctly independent of the
  underlying metric truth.
- Partner app's Available/Offline toggle (ChatGPT P1-5) — 🔧 **real bug, self-disclosed in the
  code's own toast text**: `[available,setAvailable]=useState(true)` was pure local React state,
  never persisted anywhere - a provider tapping Offline saw the UI change but could still be
  assigned new jobs (`loadGovernedProviders()` has always correctly checked
  `provider_unavailability`; nothing ever wrote to it from this toggle). Added
  `setProviderAvailability()`, a real endpoint using the same `requireProviderOwnership` pattern
  already established elsewhere, and wired the real client toggle. Verified end to end: toggling
  offline genuinely removes real assignment eligibility, toggling back genuinely restores it,
  correctly scoped to only the provider who toggled. Commit `611e9cb`.

## Marketing / SEO / public site

Status as of this update: this cluster has now been actively worked and verified by a
Claude session working directly with the business owner (not just "built by other
session, untested" as the previous entry said).

| Item | Status | Notes |
|---|---|---|
| PR #57 (premium marketing/SEO, real photography) merged to main | ✅ | commit `f04373b` — clean merge, verified build + full suite before merging, not just accepted blind |
| PR #58 (partner mobile GPS UAT) merged to main | ✅ | commit `70716fb` — two stale pre-existing tests needed updating first (one required `getCurrentPosition`-only and no `watchPosition`, one required the old quarantine banner text); both updated to match the intentional new behavior, not silently overridden |
| 7 breed guide hero images (Beagle, German Shepherd, Golden Retriever, Labrador Retriever, Persian Cat, Shih Tzu, Indie Cat) | 🔧 | commit `b23bafe` — confirmed via the page template that 10/11 breed guides rendered **zero image**, not an AI placeholder as assumed going in. Pomeranian, Pug, Rottweiler still have no matching real photo — genuinely open, not forgotten |
| Fresh Food service page hero/trust images | 🔧 | commit `b23bafe` — page had no `image`/`trustImage` field at all before this |
| Dog Walking hero image, Boarding trust image | 🔧 | commit `b23bafe` — upgraded from generic/stock-sourced to real branded photos |
| Paid landing pages (19 total) — lead form was fake | 🔧 **real bug** | commit `8b8bd38` — form `action="/mobile-app"`, openly disclosed in the code as a Webflow-transfer demo, not wired to any real backend. Now posts to the same `/api/public-contact` CRM pipeline the real Contact page uses. **If any paid ad traffic was ever pointed at these pages before this commit, those leads went nowhere.** |
| 3 "Doorstep Vet" landing pages | 🔧 paused | commit `8b8bd38` — no vet service/booking engine exists anywhere in the platform (checked: not in premium-public-content.ts, no vet API route, no vet vertical in booking flow). Paused via a `paused` flag rather than deleted — `getMarketingLanding`/`generateStaticParams` skip them, direct URLs 404, index no longer lists them |
| Customer testimonials — wrong business initially used | 🔧 **caught and fixed same session** | commit `a2bee03` added reviews from "PawSpace - Home Pet Boarding" (HSR Layout, 3.1★/12 reviews) — owner confirmed this is a **different, unrelated business**, not this one. Fixed in `4e6f772` (reviews removed immediately) then `19a3b9a` (correct reviews added from the real listing, "PawSpace \| One-Stop Doorstep Pet-Care Platform", 4.5★/2,059 reviews, confirmed via owner-provided screenshots since this listing was not findable through available search tooling). **Lesson for any agent pulling real-world data (reviews, ratings, third-party listings) into this repo: verify the exact business identity before use — name collisions with unrelated businesses are real and easy to miss.** 7 real review excerpts now live, covering Pet Grooming, Cat Grooming, Dog Training, Pet Boarding, Pet Sitting, Pet Taxi. Still missing real reviews for Dog Walking, Fresh Food, Relocation — genuinely open. |
| Real PawSpace GMB rating is 4.5★/2,059 reviews | 🟡 noted, not fully reconciled | The business's real rating is solid, but not independently spot-checked against the specific quotes' authenticity beyond the owner-provided screenshots — reasonable trust level, not machine-verified |
| Stale root `layout.tsx` metadata ("PawSpace Grooming" title/description, used as fallback everywhere) | ⬜ open, deferred by owner | Not yet fixed — owner explicitly chose to prioritize other items first |
| Root domain `/` opens the Grooming booking flow directly, not `/discover` (the multi-vertical homepage linked as "Home" in nav) | ⬜ open question | Flagged to owner as a possible intentional design (ads/QR codes may point at Grooming directly) vs. oversight — not yet resolved either way |
| `grooming-integration-closure` branch (331 commits, 263 conflicts vs main) | ⬜ open | Restored after an accidental deletion mid-session (`git ref` recreated from cached SHA, no data lost) — still needs dedicated review, has not been attempted |

## Provider self-onboarding: real login was missing entirely (Claude, this session)

Investigated whether provider self-onboarding is "complete and launchable." Found a genuinely
fundamental gap beyond just unbranded UI: `app/careers` → "Start your application →" → 
`/partner/onboarding`, whose very first step calls `GET /api/identity-session` to check for an
existing session - **but nothing anywhere let a new applicant create one.** No login/OTP screen
existed under `/partner/*` at all. A brand-new applicant saw a raw 401 error with nowhere to go.

`lib/verified-identity-assertion.ts` already anticipated this (`identitySource:"partner_otp"`,
`subjectType:"provider"` were already valid, distinct from `"customer_otp"`/`"customer"`) - the
verification side was built, but nothing ever generated a `partner_otp` assertion.

Built `lib/partner-otp.ts` + `app/api/partner-otp/route.ts`, mirroring the real, working
`lib/customer-otp.ts` pattern exactly (same sandbox-code-returned-in-response approach, same
replay/attempt/expiry protections, no real SMS gateway - same honest sandboxed state as the
customer flow). Creates a real `canonical_providers` table (didn't exist before) on first
verified login. Built `app/partner/partner-login.tsx` (styled with the site's existing
premium-marketing theme) and wired `/partner/onboarding` to show it instead of a bare error
when no session exists.

**Real execution proof, not just static tests**: extended `tests/runtime-d1-worker.ts` to request
a real OTP, verify it with the real sandbox code, confirm a real `canonical_providers` row was
created, confirm the resulting session cookie genuinely authenticates `/api/identity-session` and
`/api/provider-onboarding-self-service` (both against real handlers, real D1), and confirm an
unauthenticated request is genuinely rejected with 401. This also caught a second real gap along
the way: `PAWSPACE_IDENTITY_ASSERTION_SECRET_UAT` was configured nowhere for this runtime-d1
worker config, meaning `verifyIdentityAssertion` - the function underlying **both** the customer
and provider OTP flows - had never actually been exercised end-to-end by any real-execution test
before this. Added the secret to `wrangler.runtime-d1.jsonc` (test-only value, 32+ chars, clearly
not a real secret) so this now runs for real on every CI run via the existing `runtime-d1` gate.

**Real infrastructure blocker found and correctly left unresolved, not routed around**: also
investigated real document/photo upload for KYC documents. Started building client-side image
compression + base64 storage, then found a pre-existing test
(`tests/provider-onboarding-transactional.test.mjs`, "PO2 stores secure document references")
that deliberately forbids storing base64/raw bytes in `provider_onboarding_documents` - a real,
intentional compliance boundary (sensitive KYC documents need dedicated, audited storage, not raw
bytes in a general D1 table). Reverted that approach rather than dodge the test. Real document
upload needs object storage (e.g. R2) provisioned first - this deployment's hosting config shows
`r2: null`, an infrastructure decision outside what either agent can do from here. Kept what's
real and non-conflicting: a genuine per-document list with an audit-logged staff "View" action
(previously staff only saw a meaningless count).

**Still open**: the branded, polished applicant-facing UI (currently still the bare
`PAWSPACE PARTNER · ONBOARDING UAT` dev-harness look, now at least reachable); self-service
interview scheduling was investigated and found to conflict with an existing, apparently
intentional design (Ops schedules based on their own calendar, not an open slot picker) - flagged
to the human rather than built against that design; real document/photo upload, blocked on R2
provisioning.

## Still open — genuinely not started, not a duplicate-risk

- **Pricing Control wiring for Grooming multi-pet, Training, Boarding, Pet Sitting — ChatGPT is
  actively working on this** on branch `agent/pricing-control-closure` (not yet merged to main as
  of this update). Reviewed both of its commits directly: `lib/grooming-pricing-code.ts` (a real,
  correctly-designed multi-pet package-code suffix helper, e.g. `dog-basic__2_pets`) and
  `lib/pricing-control-runtime.ts` (real seed data for all 4 verticals, cross-checked against the
  existing hardcoded catalogue - the multi-pet math matches exactly, e.g. `1649 × 2 = 3298`).
  Every seeded row is inserted `active:0` - nothing goes live just by seeding, matching the same
  safety principle used for Grooming single-pet. **Do not start a competing implementation of
  this - check the branch for updates before touching pricing wiring for these 4 items.**
- Canonical Customer account/app data (ChatGPT P0-4) — 🔧 **CLOSED as a combined Claude + ChatGPT closure.**
  Claude closed the real customer identity/login half with `lib/customer-otp.ts`,
  `app/api/customer-otp/route.ts` and the customer-app/session wiring (commits `3db2e69`, `9a006fc`),
  including real OTP request → verify → session resolution plus no-cookie/tampered-cookie rejection.
  ChatGPT closed the complementary canonical account-data half in PR #60, merged as `592dc407`:
  `lib/customer-account.ts` + `app/api/customer-account/route.ts` now provide ownership-enforced,
  idempotent profile/address/pet reads and writes over the canonical customer record; My Pets and
  Account no longer use hardcoded pets/fake saved-address data; Customer 360 reads the same canonical
  addresses/pets/profile. The pre-merge bug Claude flagged — own-customer auto-detection reading the
  nonexistent `actor.subjectId` — was fixed by resolving the verified platform session directly via
  `resolvePlatformSession`, preserving the existing ownership primitive rather than weakening auth.
  Real local D1 execution proved booking-created customer/pet → customer account read → profile,
  address and pet mutations → replay prevention → staff Customer 360 sees the same records, while
  existing booking/payment/work-order/invoice/reservation cardinalities remain singular. Expected
  account cardinalities were exactly 1 customer, 1 address, 2 pets and 3 mutation records after
  replay. PR Release CI #944 passed all five gates, then exact merged `main@592dc407` passed all five
  gates again in Release CI #945. **Do not re-test P0-4 unless a later commit touches these exact
  account/session/customer-360/runtime-D1 paths.**
- Promotions backend + Marketing automation execution (ChatGPT P1-8) — **DONE by Claude.**
  Confirmed precisely before building: the panel's own source was honestly self-disclosing
  ("PROMOTION CONTROL · NOT YET BUILT", `createPromotion` just notifying no backend existed; same
  for Automation Rules). Built `lib/promotion-governance.ts` (real lifecycle, margin-floor
  validation rejecting a discount that would breach it, real audience suppression reusing the exact
  Campaign pattern, real budget-cap enforcement on redemption, real holdout bucketing) and
  `lib/marketing-automation-rules.ts` (real rule definitions + enable/disable toggle, deliberately
  not an execution engine, matching the panel's own stated guardrails - rejects any attempt to
  configure autonomous execution outright). Wired both into `app/api/marketing-control/route.ts`
  and the real panel UI, replacing the fake "NOT YET BUILT" labels with accurate ones.
  **Also found and fixed a separate, unrelated real bug along the way**: the panel's campaign
  pause/complete button called `PATCH`, but no `PATCH` handler existed on the route at all - fully
  broken, with a misleading fallback error message. Added a real handler for both campaigns and
  promotions. Commit `85e2855`. Verified with real execution throughout; 638/638 tests, 0 lint
  errors, no dead buttons.
- Founder BI → canonical analytics/P&L (ChatGPT P1-9) — **CLOSED, reconciling two independent
  fixes for the same real gap.** A colleague's separate Claude session found and precisely scoped
  the gap first (a network issue prevented pushing their patch, so it was rebuilt here from their
  description and independently re-verified rather than trusted at face value), and then their
  patch landed separately once the network issue resolved - both fixes hit the same underlying bug:
  `app/control/business-intelligence-panel.tsx` had zero fetch calls anywhere - every number across
  all 6 tabs was a hardcoded static array, including fake customer names and fake payment IDs.
  Two real, already-built engines existed unused: `lib/pnl-reporting.ts` and
  `lib/company-analytics.ts` (both built and verified earlier this session).
  Reconciled the two approaches by comparing real data coverage, not by picking a side blindly: the
  version using `/api/company-analytics` + `/api/pnl-reporting` together surfaces genuinely more
  real data (bookings count, collected amount, and cancellation rate per vertical, plus customer
  repeat rate, all real and live) than the version using `/api/pnl-reporting` alone, which left
  those fields as "Not tracked yet" even though they are trackable via company-analytics - that
  session's version won the merge for the panel's data-wiring. Kept the other session's real,
  additive verification improvement regardless: the `tests/runtime-d1-worker.ts` E2E extension
  calling `generatePnlReport` against the real ₹1200 completed pet_sitting booking that scenario
  creates, asserting the P&L revenue line for that service/month correctly reflects it - this merged
  in cleanly with no conflict and strengthens the underlying engine's real test coverage regardless
  of which panel-wiring approach was kept. Also kept that session's confirmation that
  `/api/pnl-reporting` requires `finance.view` via the central gateway in `lib/api-gateway.ts` (not
  unauthenticated despite the route file itself having no visible auth check - enforcement is
  centralized in `worker/index.ts`).
  Direct cost, margin and repeat-rate per vertical still have no real source anywhere - honestly
  show "Not tracked yet" rather than fabricated numbers. A "⚠️ Demo data" banner remains on Accounts,
  Customers and Subscriptions tabs - no real backend exists for any of those yet.
  Caught a real dangling-reference bug during verification (this project's build does not catch it
  - confirmed earlier this session) before it could ship. Verified with real execution throughout:
  replicated the exact mapping logic against a realistic API response, fetched the actual `/control`
  page through the real built worker (200 OK, no fake numbers present), and ran the full merged test
  suite clean.
  **UPDATE, commit `a1f395a`**: Direct cost, margin and repeat-rate per vertical - the one
  remaining honest disclosure this entry called out - are now real for the verticals where a clean
  cost source genuinely exists. Investigated the landscape directly rather than assuming a single
  fix would cover all 4 verticals: `finance_journal_entries.vertical` is a dead column (hardcoded
  NULL at its only insertion point); Boarding and Pet Sitting have real, booking-level provider
  payout data; Training's payout data is provider/period-level only, not attributable to a specific
  booking; Grooming is incentive-based at groomer-month level with no clean per-booking figure at
  all. Built real cost/margin for Boarding and Sitting specifically, verified the critical safety
  property with real execution - partial payout coverage never silently produces a fake margin, it
  collapses to "not tracked" for that vertical/period until every eligible booking has a known
  payout. Training and Grooming honestly remain "not tracked" - no fabrication, no false
  consistency forced across verticals that aren't equally ready. Real per-vertical repeat rate is
  now computed for all 4 verticals uniformly (fully derivable from canonical_bookings alone).
  Also found and fixed a real bug while wiring this in: dead state left over from the earlier merge
  resolution referenced an undefined variable - would have been a real ReferenceError crash on
  mount, undetected by this project's build or any existing test. Fixed, then verified by actually
  rendering `/control` through the real built worker (200 OK, no error-boundary text).
  **UPDATE - all three tabs and Training cost now closed:**
  - **Subscriptions** (commit `e727e9d`): real segments from `customer_grooming_subscriptions` by
    real expiry proximity, real utilisation, real unused-credit liability from each subscription's
    own real per-session plan price - verified partial price coverage correctly shrinks the
    denominator rather than silently valuing an unpriced plan at zero.
  - **Customers** (commit `da0db3a`): real segment/risk/next-action built on the already-real
    `buildCustomer360`, all derived from real bookings/subscriptions - margin stays honestly null,
    since attributing vertical-level cost down to an individual customer whose orders may span
    multiple verticals would carry the same partial-coverage risk at a much finer grain. Found and
    fixed a real bug during verification: dead state from an earlier merge referenced an undefined
    variable, an undetected ReferenceError waiting to fire on mount.
  - **Accounts** (commit `0b12faf`): real receivable and real GST payable universally (from the
    genuinely shared `booking_invoices`/`booking_payments` tables, confirmed byte-identical schema
    across all 5 verticals that issue them) - real refund queue and real provider payable
    specifically for Boarding/Sitting/Taxi/Walking, the four verticals whose refund and settlement
    ledgers share an identical, safely-unionable schema. Training's different status vocabulary and
    Grooming's payment-reconciliation-based refunds were not forced into the same union.
  - **Training direct cost** (commit `2233b88`): the original "not achievable from data that exists
    today" scoping for Training was wrong - `training_session_earnings` (booking_id + gross_earning
    per completed session) had been missed by an incomplete search. Extended the same cost-
    attribution logic already proven for Boarding/Sitting to aggregate correctly across a training
    booking's multiple sessions, with the identical safety property re-verified: one session still
    pending a compensation rule marks the whole booking's cost unknown, never partially summed.
  **UPDATE, commit `31e6087`: Grooming direct cost/margin is now closed too**, resolving the
  "genuinely needs new architecture" scoping above. Found a real path anyway:
  `computeGroomerMonthlyIncentive()` already computes a real, booking-derived monthly incentive
  total against a real order-value total built from exactly the same real completed bookings.
  Built `lib/grooming-cost-attribution.ts` to allocate that real monthly total proportionally
  across the real bookings that contributed to it - a booking worth 40% of a groomer's monthly
  order value carries 40% of that groomer's real monthly incentive as its cost (incentive/bonus
  cost specifically, not base salary - the same honest scope as every other vertical's cost).
  Same safety property as every other cost guardrail this session: a groomer/month with no bracket
  configured is marked unknown, not silently zero; a groomer/month genuinely below the real
  eligibility threshold or that never hits the real daily order-count tier returns a real, computed
  zero - because that's what the incentive engine actually paid, not a data gap. Verified end to end
  against the real engine's own actual result for the same scenario (not an assumed expected value),
  and confirmed the real cost flows through the full `buildCompanyAnalytics` pipeline correctly.
  **All four verticals now have real direct cost, margin, and repeat rate. Every item on the
  original Founder BI gap list is closed.**
- Real scheduler/worker boundary, independent of page loads (ChatGPT P1-10) — 🔧 **CLOSED in PR #62.**
  Before this work, `worker/index.ts` had only `fetch()`, `vite.config.ts` had no cron trigger, and
  the staff-alert truth explicitly reported `backgroundSchedulerConfigured:false`; meanwhile the
  Revenue CRM GET path was still running reopening/SLA/ops/report/callback work as a page-load side
  effect. Added `lib/background-scheduler.ts` with persisted five-minute run slots, completed-run
  deduplication and retry-after-failure state; production `worker/index.ts` now has a real Cloudflare
  `scheduled()` handler and the existing programmatic Worker config now declares `*/5 * * * *`.
  The worker directly runs staff-alert/SLA governance, missed-callback sweeps, cold-lead reopening,
  legacy SLA escalation, overdue ops escalation and 19:00+ command reports, so page/API reads are no
  longer required for those jobs to execute (the old read-triggered calls remain only as an
  idempotent fallback). Staff-alert API truth now separately reports `schedulerProductionReady:true`
  while keeping `externalDelivery:false` / overall production readiness false until live external
  credentials exist. Real isolated D1 proof uses Wrangler's actual scheduled-event handler, not an
  HTTP imitation: a seeded cold lead reopened to cycle 1, an overdue SLA lead breached, overdue ops
  escalated to level 1, a due callback became missed, and exactly 3 daily/weekly/monthly command
  reports were generated; firing the identical scheduled event a second time left exactly one
  completed scheduler run with one attempt. Two test-harness issues were caught before green: a cron
  in the focused test config caused an unwanted startup event, and Wrangler's legacy `/__scheduled`
  path ignored the scheduled-time override; the regression now explicitly fires the documented
  `/cdn-cgi/handler/scheduled` endpoint. Implementation head `4a56ae4`; PR Release CI #953 passed all
  six gates including the new `Background scheduler D1` gate. **Do not re-test P1-10 unless a later
  commit touches `lib/background-scheduler.ts`, `worker/index.ts`, `vite.config.ts` or the scheduler
  D1 release gate.**
- **Production Readiness Truth contract + CI gate — CLOSED, commit `2f113d6`.** Investigated before
  building: `lib/integration-readiness.ts` already IS a mature version of exactly this contract - 24
  real integration entries, real credential-presence detection, a real 10-state readiness state
  machine, and `updateIntegrationReadiness()` already refuses `controlled_live_verified` without
  every evidence column genuinely verified plus an evidence + approval reference, and already
  refuses to store an actual secret value in `secret_reference`. Already wired to a real, env-reading
  API (`app/api/integration-readiness/route.ts`, `app/api/launch-readiness/route.ts`) and a real UI
  (`app/control/launch-readiness-panel.tsx`). Separately confirmed the exact real hard-lock
  architecture behind Razorpay/Maps/Identity: each is deliberately locked to sandbox in code (the
  adapters throw if their env-mode flag is ever set to anything but "sandbox"), so going live needs
  both real credentials AND a real live-mode code path that doesn't exist yet for any of them -
  explaining why the registry correctly shows `environment:"sandbox"` for all three, not a gap.
  The one real missing piece: nothing enforced any of this in CI. Added two gates: a static check
  that no code may hardcode `productionReady:true` as a literal (confirmed zero violations exist);
  and a real D1 regression proving the registry's own safety enforcement cannot be bypassed - a
  direct attempt to force `controlled_live_verified` without real evidence is genuinely rejected, a
  direct attempt to smuggle an actual secret value into `secret_reference` is genuinely rejected,
  real credential detection correctly reports Razorpay as missing with no env configured, and the
  registry's own `summary.productionReady` honestly computes `false`. Ran against the real
  wrangler/miniflare/D1 stack locally before wiring into CI, not just asserted it would work.
  **Genuinely still open, and correctly so - needs the user or ops, not more code:** branch
  protection (a GitHub repository setting, not a git operation - needs direct GitHub UI action or a
  token with Administration scope); actually obtaining and configuring live Razorpay/WhatsApp/
  Exotel/Maps/KYC credentials; production monitoring/alerting/backup-restore/penetration testing;
  full human/device UAT.

## Cannot be code-closed by either agent (genuinely needs external creds/human/infra)

- Real Razorpay, WhatsApp, Exotel, Maps, KYC, MFA — sandboxed by design, need live credentials
- Monitoring, backup/restore, penetration testing — infrastructure, not code
- Real human browser/device QA — nobody has opened the live app and clicked through it, this
  entire engagement, by either agent
- Live deployment URL confirmation — same reason