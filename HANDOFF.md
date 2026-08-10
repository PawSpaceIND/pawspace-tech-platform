# PawSpace Tech Platform — Handoff Notes

**Repo:** https://github.com/PawSpaceIND/pawspace-tech-platform
**Main branch, current commit as of this handoff:** `72f5365`
**Written:** August 2026, after an extended engineering + testing session with Claude.

If you're picking this up cold: clone the repo, check out `main`, and everything
described below is already in the source tree — no separate files, no zip
needed. This document exists so you don't have to re-derive what's already been
checked, and so you know exactly what hasn't been.

---

## 1. What this session actually did

Two kinds of work happened, and it matters which is which:

1. **Real verification** — writing small standalone scripts that call the
   actual production functions (not mocks) against a real in-memory SQLite
   database, and checking the real output. This is the only way any of the
   "confirmed working" claims below should be trusted. A big early finding
   was that **the existing 622-test suite in `tests/*.test.mjs` does not
   execute any application code** — every one of those tests is a static
   regex check against source text. They're useful for catching accidental
   text/copy regressions, but they will not catch a runtime bug, a missing
   database table, a broken button, or bad business logic. Don't mistake
   "622/622 passing" for "verified working" anywhere in this repo's history.
2. **UI dead-button fixes** — a systematic pass wiring up buttons that had no
   `onClick` handler at all, across every customer- and partner-facing screen.

## 2. Real bugs found and fixed, with proof

All of these were reproduced with a failing real-execution script first, then
fixed, then re-verified passing, before being committed. None of them would
ever have been caught by the static test suite.

| Commit | What was broken | Blast radius |
|---|---|---|
| `f503214` | Grooming (and 4 of 6 verticals) had **no invoice-issuance code at all** — the table existed, nothing ever wrote to it | Every completed booking in 5/6 verticals never got invoiced |
| `a225483` | `boarding-finance-governance.ts` queried `b.amount_due_now` and `b.payment_status` — columns that don't exist on `canonical_bookings` | Every Boarding cancellation/date-change/reconciliation action would crash immediately |
| `a73bcff` | `provider-commission-governance.ts`: an INSERT had 16 value tokens for 15 declared columns (one stray extra `?`) | Would break commission-based payouts for **every vertical**, the first time any commission provider's booking was ever synced |
| `df8beaa` | `gst-accounting.ts`: `finance_close_periods` table was referenced by `locked()` (called at the top of every invoice/adjustment/vendor-tax action) but never created anywhere | Would break GST invoicing entirely, from the very first invoice issued |
| `0ce1dc6` | `scheduling_assignment_decisions` / `scheduling_rules` — the tables behind the **one shared scheduling engine every vertical's booking flow depends on** — only exist via a Drizzle migration, unlike every other table in the codebase which self-provisions at runtime via `CREATE TABLE IF NOT EXISTS`. No fallback if migrations are ever skipped (fresh preview branch, rebuilt D1 instance, rollback) | Would break the entire booking pipeline platform-wide in any un-migrated environment |

## 3. What's been verified clean by real execution (no bugs, confirmed working)

- Booking creation (quote → govern) for all 6 verticals, including host/provider
  eligibility matching
- The full booking → payment → invoice chain, run end to end for Boarding
- Cancellation/refund request + approval logic for all 6 verticals, including
  segregation-of-duties (same person can't approve their own action) and
  idempotency
- The provider commission/payout engine end to end, including the two-level
  approval workflow and segregation of duties
- Ops/recovery: replacement-provider assignment for Walking, correctly
  preserving completed sessions while only reassigning pending ones
- Incident reporting → acknowledge → resolve lifecycle
- Payroll: salary structure → compensation assignment → calculate → review →
  approve → sandbox payment batch, with real maker/checker enforcement
- GST/Accounting: entity → registration → tax policy → classification →
  invoice, with correct real tax math and period-locking
- Attendance & leave management: worked-minutes calculation, exception
  detection, leave balance validation
- The incentive engine: scheme → calculation → approval → dispute → reversal,
  with correct payroll integration
- **AI safety guarantees, proven not assumed**: tried to make the AI tool
  registry issue a refund and capture a payment directly — both are
  structurally blocked (`approval_gated`, `executed: false`, no exceptions).
  Also proved: `refund.issue`, `payment.capture`, `payout.release`,
  `price.override`, `provider.assign`, and `campaign.activate` are *all*
  permanently approval-gated — AI cannot autonomously execute any of these,
  ever.
- AI conversation orchestrator: real intent classification, real Customer 360
  context pulled per turn, correct handoff routing, AI correctly paused while
  staff owns a conversation thread

## 4. The dead-button audit (commits `2e24d9a` through `72f5365`)

Started from ~60 buttons across ~15 customer/partner-facing files that had no
`onClick` handler at all — i.e. did nothing when clicked. Found using a small
JSX-aware scanner (now committed at `tools/button-audit/`, see its README for
usage). Every one of the ~60 is now resolved: either wired to a genuinely real
action, or given an honest, sandbox-aware acknowledgment matching the tone
each file had already established elsewhere (never a fabricated fake success
state). A handful were confirmed as *correctly designed already* and
deliberately left alone — see the scanner's README for the specific list and
why.

**To re-run this audit or extend it to more files:**
```bash
bash tools/button-audit/run-full-scan.sh
```

## 5. What is explicitly NOT done / still open

Ranked roughly by what I'd tackle first if continuing this:

1. **Real device/browser QA.** Nothing in this session clicked through the
   actual rendered UI in a browser. Every fix above was verified by reading
   the code, running `npm run build`, the test suite, and lint — not by
   opening the app and clicking. Human/browser testing is the next real gate.
2. **External integrations remain sandbox-only, by design, pending real
   credentials**: Razorpay (live payments/refunds), WhatsApp/SMS, Maps/GPS,
   push notifications. Code paths exist and are correctly gated; none of them
   have been (or should be) tested against a live provider yet.
3. **i18n / multi-language.** Only 2 files touch this at all. Not urgent for
   a single-city (Bengaluru) pilot, but a real gap before any multi-market
   expansion.
4. **Wishlist/favorites.** Doesn't exist. Zero occurrences in the codebase.
   Minor, cosmetic, nobody's asked for it.
5. **A handful of AI/Intelligence modules were not individually
   execution-tested this session**: Integration Readiness registry, Revenue
   Mission Control, Business Customization. (AI Conversation Orchestrator,
   AI Tool Registry, and — as a side effect of testing the tool registry —
   Unified Case Center *were* tested; see section 3.)
6. **Systematic re-scan for the "column doesn't exist" bug class.** Section 2
   shows this bug class was found repeatedly (3 separate times, in 3
   different files) via a manual/scripted grep for
   `canonical_bookings <alias>.<column>` patterns against the real 22-column
   schema. That scan was run and is clean as of `72f5365`, but it was a
   one-time pass, not automated — if more lib files get added or edited,
   re-run something equivalent. The exact approach: extract every
   `CREATE TABLE IF NOT EXISTS <name>` across the repo, extract every
   `<alias>.<column>` reference following a `<table> <alias>` join, and flag
   any column not in that table's real schema. Watch for false positives
   where the same short alias is reused as a plain JS variable elsewhere
   (happened twice — always read the surrounding code, don't trust the grep
   alone).

## 6. Operational notes

- **A GitHub PAT was used during this session to push directly to `main`**
  (the repo was made temporarily public for write access). **Revoke it** if
  it hasn't been already — it should not still be valid, but confirm.
  Token prefix used: `github_pat_11CK4ZIPQ0...` (full value was never
  persisted anywhere in this repo; it was only ever passed inline to `git
  remote set-url` and immediately reset back to the plain HTTPS URL after
  each push).
- Every commit in sections 2 and 4 has a detailed message explaining the
  reasoning, what was reproduced, and how it was verified — `git log` on any
  of the hashes above for the full story rather than re-deriving it.
- The backend (`backend/`) has its own `npm test` (28 tests) and
  `npm run typecheck` — both genuinely execute code (Fastify + an in-memory
  repository), unlike the frontend's static test suite. Both were passing as
  of `72f5365`.
- Full verification loop used throughout this session, recommended before any
  further commit:
  ```bash
  npm run build && node --test tests/*.test.mjs && npm run lint
  cd backend && npm run typecheck && npm test
  ```
