# PawSpace V2 — human-test launch pass evidence (2026-09-21)

Branch `fix/v2-human-test-launch-20260921` (PR #960). This folder records the fix-and-verification pass that
follows the 2026-09-20 V2 end-to-end test report.

## Application SHAs in this pass

| SHA | What it carries |
| --- | --- |
| `f87e345` | V2-045 Relocation: explicit country, age and size instead of hidden fixture defaults |
| `89d4732` | Five launch blockers: Revenue CRM schema collision, Launch essentials 401, Business 360 500 on a fresh D1, seeded manager without organisational scope, leave request 500, Employee AI silent failure |
| `ad4c56e` | Subscription-wallet import regression the frozen suite caught in 89d4732 |
| `92c2c29` | Booking Command Center stream returns governed 401/403 instead of 500 (EMP-15 / V2-052); test-only key literals removed from new test files |
| `475682a` | Lead governance refusals answered as governed 4xx, retention callbacks work on the staging table shape, honest CRM chat statuses, Employee AI draft retention and audit, customer copy for signed-out web chat |
| `3e5cd76` | Customer-facing Pet Taxi pricing refusal, pet vaccination label |
| `920cd84` | Pet Taxi booking replay returns the first response's trip contract |

## Contents

- `records/launch-backlog-additions.json` — register entries V2-045 onward, paste-ready for the launch backlog
- `records/relocation-v2045-browser-f87e345.json`, `records/launch-blocker-repairs-browser-89d4732.json` — browser proof runs
- `verification/` — the launch verification pass: per-area findings (`customer`, `partner`, `ai-crm`, `employee`), human summaries, per-screen/per-role matrices, and the brief the pass ran under
- `screenshots/` — curated screenshots: the V2-045 and repair proofs, plus the P0/P1 evidence from the verification pass
- `logs/` — frozen full-suite summaries and the staging deploy/certification summary

## Validation ledger

| Gate | SHA | Result |
| --- | --- | --- |
| Frozen full suite | `89d4732` | Discarded: aborted mixed-tree run (5351 ok / 5 not ok, all one import regression). Log summary retained in `logs/`. |
| Frozen full suite | `ad4c56e` | 6,450 tests, 0 failures, 0 skipped, 611 s |
| Staging deploy + certification | `ad4c56e` | Run 35609497578 success — CERTIFIED 28/28, LIVE version = `ad4c56e`, rollback reference recorded, SMS smoke disabled |
| Automated human sweep (staging) | — | Not runnable for a PR-branch SHA: the workflow only runs from `main` and requires the SHA to be contained in `main`. Run it after merge. |
| Frozen full suite | `a69cdd7` | 6,544 tests, 0 failures, 0 skipped, 942 s |
| Staging deploy + certification | `a69cdd7` | Run 35634442129 succeeded and certified the commit at the staging URL |
| Browser E2E personas (CI) | `469edbb` | **Failed** — `e2e/customer-booking.spec.ts:421`, Confirm booking stayed disabled after a payment-mode switch. Real defect, logged as V2-082 and fixed in `b1f4d39`; the red run is kept as found, not relabelled. |
| Frozen full suite | `b1f4d39` | 6,547 tests, 0 failures, 0 skipped, 925 s |
| Browser E2E personas (CI) | `b1f4d39` | Run 35647702969 **success** — the red case above passes |
| Staging deploy + certification | `b1f4d39` | Run 35649768568 **success** — exact-SHA checkout verified clean, D1 migrations applied, isolation certified before any D1 write, PII-safe Sentry delivery verified, staff directory and human-UAT provider roster loaded, deploy certified; every live-SMS and live-OTP step skipped as required by `sms_smoke=disabled`. Evidence artifact 10660889872. |
| Frozen full suite | `32ae834` | 6,553 tests, 0 failures, 0 skipped, 928 s |
| CodeQL | `32ae834` | **Still 1 new high alert.** The js/code-injection sink removed at `32ae834` was not it. Rule unreadable from this sandbox — see OPEN_ITEMS.md. |

## Boundaries

- Every browser result in this folder was produced against a **local build of the exact SHA**. The isolated staging
  host is not reachable from the sandbox that produced this branch (network policy), so staging carries the CI
  certification only, not these browser journeys.
- Sandbox QA data only. No production deployment, real payment, real dispatch, statutory filing or auth bypass.
- Placeholder documents are not real uploads; internal synthetic captures are not gateway captures. Where the media
  adapter is not connected, the evidence says `objectStored=false`.
- The full capture set for the verification pass is 917 screenshots (~407 MB) and is not committed. The findings
  records carry the request/response bodies, durable rows and screenshot paths; the P0/P1 images are in
  `screenshots/`.
