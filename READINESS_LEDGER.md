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
- Canonical Customer account/app data (ChatGPT P0-4) — not yet checked by Claude
- Promotions backend + Marketing automation execution (ChatGPT P1-8) — not yet checked by Claude
- Founder BI → canonical analytics/P&L (ChatGPT P1-9) — partially adjacent to the manager/founder
  dashboard Claude built, but not confirmed identical scope — check before starting
- Real scheduler/worker boundary, independent of page loads (ChatGPT P1-10) — not yet checked

## Cannot be code-closed by either agent (genuinely needs external creds/human/infra)

- Real Razorpay, WhatsApp, Exotel, Maps, KYC, MFA — sandboxed by design, need live credentials
- Monitoring, backup/restore, penetration testing — infrastructure, not code
- Real human browser/device QA — nobody has opened the live app and clicked through it, this
  entire engagement, by either agent
- Live deployment URL confirmation — same reason
