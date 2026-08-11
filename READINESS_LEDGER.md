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

## Marketing / SEO / public site (built by other session, not tested by Claude)

- Premium marketing/SEO pages, breed guides, landing pages, testimonials — built by other session.
- One real issue caught and fixed by that same session: testimonials wrongly attributed to a
  different business entirely (commit `4e6f772`) — correctly caught and pulled fast.
- Claude has not independently tested this cluster; not this session's focus.

## Still open — genuinely not started, not a duplicate-risk

- Pricing Control wiring for: Grooming multi-pet, Training, Boarding, Pet Sitting (⬜)
- Canonical Customer account/app data (ChatGPT P0-4) — not yet checked by Claude
- Partner availability + profile truth (ChatGPT P1-5) — not yet checked by Claude
- Promotions backend + Marketing automation execution (ChatGPT P1-8) — not yet checked by Claude
- Founder BI → canonical analytics/P&L (ChatGPT P1-9) — partially adjacent to the manager/founder
  dashboard Claude built, but not confirmed identical scope — check before starting
- Real scheduler/worker boundary, independent of page loads (ChatGPT P1-10) — not yet checked
- `ai-business-configuration.ts`, `ai-web-chat-adapter.ts`, `revenue-mission-control.ts`,
  `revenue-mission-command-center.ts`, `revenue-leadership-reporting.ts`,
  `revenue-opportunity-governance.ts` — never independently execution-tested by Claude

## Cannot be code-closed by either agent (genuinely needs external creds/human/infra)

- Real Razorpay, WhatsApp, Exotel, Maps, KYC, MFA — sandboxed by design, need live credentials
- Monitoring, backup/restore, penetration testing — infrastructure, not code
- Real human browser/device QA — nobody has opened the live app and clicked through it, this
  entire engagement, by either agent
- Live deployment URL confirmation — same reason
