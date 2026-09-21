# PawSpace V2 — fix and verification pass, 2026-09-21

Branch `fix/v2-human-test-launch-20260921`, pull request #960. This is the record of what was tested,
what was repaired, and what is still open. It supersedes nothing: the 2026-09-20 end-to-end report
remains the baseline, and every finding here carries its prior id where one exists.

## 1. What was done

A four-area browser verification pass ran against a local build of `ad4c56e`, one server and one
database per area, driving customer, provider, staff and AI journeys as real personas. Its findings
became the work list. Thirty-seven register entries (V2-045 to V2-081) were opened, repaired and
covered by executable regressions. A thirty-eighth, V2-082, was opened afterwards when the required
Browser E2E personas job went red on `469edbb` and turned out to be a real customer-facing defect
rather than CI noise. The final commit is `b1f4d39`.

## 2. Verification pass, by area

| Area | Records | Passed | Fixed and verified | Still open | Environment-gated | Owner decision | Not retested |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Customer | 57 | 20 | 5 | 10 + 13 new defects | 5 | 2 | 2 |
| Partner and provider | 55 | 16 | 3 | 10 + 12 new defects | 5 | 4 | 5 |
| Employee and staff | 41 | 12 | 8 | 9 + 5 new defects | 2 | — | 5 |
| AI, chat and CRM | 36 | 9 | 5 | 10 + 7 new defects | 3 | 1 | 1 |

Per-finding detail, with request and response bodies, durable rows and screenshot paths, is in
`verification/<area>.json`; the human summaries are `verification/<area>.md`, and the per-screen,
per-role matrices are `verification/<area>-matrix.csv`.

Two employee-area findings are recorded as still open against the build they were tested on and were
already repaired in later commits: the lead assignment and SLA five-hundreds (repaired in `475682a`)
and the Booking Command Center stream (repaired in `92c2c29`). Both are confirmed fixed in the final
browser pass below.

## 3. What was repaired

Thirty-seven entries, every one with an executable regression test. The register is
`records/launch-backlog-additions.json`. In outline:

- **Relocation.** Country, age and size are explicit and required; nothing is substituted. Milestones
  complete from the governed action that satisfies them. Refusals say what actually failed. The quote
  re-issue is idempotent and the staff list refreshes.
- **Money and payment honesty.** A coupon dropped by switching payment mode blocks confirmation
  instead of booking at full price. A pay-after-service request refuses in plain words when the
  sandbox gateway is absent. Re-booking a finished slot is refused rather than answered with the
  finished booking. Captured payments no longer read as pending.
- **Recovery paths.** The booking and payment page renders the booking itself rather than only a
  gateway error. Payment_pending bookings have a way back to payment. Fresh Food orders appear in
  Activity and the account, and a double tap no longer crashes the confirmation.
- **Refusals instead of five-hundreds.** Lead assignment and SLA, the Booking Command Center stream,
  leave requests, payroll payment preparation, grooming decline replays, sitter, taxi and training
  lifecycle checks all answer governed four-hundreds naming the precondition.
- **Truthful surfaces.** Service-proof photos say what was actually kept when storage is not
  connected. A declined assignment reads as awaiting reassignment to both provider and customer.
  Booking times are labelled India time. Customers no longer see internal labels or a server secret.
- **Staff console.** CRM search finds what the server found, the WhatsApp section index exists, the
  sales list pages, and the AI voice panel is not offered to a role that cannot open it.

## 4. Validation

| Gate | Commit | Result |
| --- | --- | --- |
| Frozen full suite | `ad4c56e` | 6,450 tests, 0 failures |
| Frozen full suite | `ab4d03e` | 6,539 tests, 4 failures — all repository gates, listed in `logs/` |
| Frozen full suite | `a69cdd7` | **6,544 tests, 0 failures, 0 skipped**, 942 s |
| Staging deploy and certification | `ad4c56e` | Run 35609497578, certified 28 of 28 |
| Staging deploy and certification | `a69cdd7` | Run 35634442129 **succeeded**; certified at the staging URL, evidence artifact 10655658700 |
| Browser verification | `a69cdd7` | `records/final-browser-verification-a69cdd7.json` |
| Browser E2E personas (CI) | `469edbb` | **Failed**, 1 of 13 — `e2e/customer-booking.spec.ts:421`. Recorded as found; see V2-082 below. |
| Frozen full suite | `b1f4d39` | **6,547 tests, 0 failures, 0 skipped**, 925 s |
| Browser E2E personas (CI) | `b1f4d39` | Run 35647702969 **success** |

The four failures at `ab4d03e` were mine and are fixed in `a69cdd7`: a table declared two ways, a
library import that broke the plain test loader, agent worktrees tripping the credential scan, and
the static-test ratchet. The ratchet was not raised; its detector now follows test helpers, which
revealed eleven suites that always executed product code, and the new source-only tests were
converted to execute their modules. The budget was lowered from 165 to 156.

## 5. Final browser verification on `a69cdd7`

Customer: Activity carries Fresh Food orders and Relocation inquiries; times read "Wed, 23 Sept,
12:22 pm IST"; the Relocation form requires age, size and destination country; the sign-in reports a
returning customer so the name field is not asked for again; the taxi refusal names no server secret.

Staff: the WhatsApp section index renders; the sales list is 3,072 pixels with a show-more control,
down from 22,771; CRM search for a real phone number returns "1 shown" where it returned "0 shown";
Revenue CRM, Launch essentials, Business 360 and the Booking Command Center stream all answer 200;
a lead assignment refusal answers 404 "Lead not found" where it answered 500.

## 5a. V2-082, found by CI after the verification pass closed

The required Browser E2E personas job went red on `469edbb`: one of thirteen cases,
`e2e/customer-booking.spec.ts:421`, timed out with `Confirm booking` stuck at
`<button disabled aria-disabled="true">`. It reproduced identically on a local build of the same SHA,
so it was not CI noise.

The cause was the CUST-L-D06 money-honesty guard meeting a case it was not written for. That guard
drops a coupon's governed quote whenever the commercial terms change and blocks Confirm until a fresh
quote exists, so a booking can never be created at full price while the screen still claims a
discount. Correct — but a new customer's welcome coupon **auto-applies** in `CouponField` without them
ever typing it, and switching payment mode is an ordinary action. The result was a customer blocked at
the last step of the funnel, told to "reapply it above" a code they never chose.

The block is unchanged. `CouponField` now fetches the fresh governed quote for the dropped code itself
instead of waiting to be asked. The server still decides the discount for the new terms; if the coupon
no longer qualifies it is cleared with a reason and the total shown is honestly full price. A new
`keepGuardArmed` option keeps the caller's guard armed while that request is in flight, because
blanking the code there is the original CUST-L-D06 blindness and would unblock Confirm against the
stale quote.

Evidence: the failing case reproduced red then green locally; the full chromium persona set 13/13;
`tests/coupon-payment-mode-reapply-guard.test.mjs` 8/8 with three added cases covering the wiring, the
in-flight window and the no-longer-eligible path; the frozen full suite at `b1f4d39` 6,547/0; and CI
run 35647702969 green on the same commit.

The red run at `469edbb` is left in the ledger as it happened.

## 6. Still open

`OPEN_ITEMS.md` is the honest list: external setup nobody in the build can supply, ten owner
decisions that are policy rather than code, verification only a human on staging can close, and two
repository gates that need a maintainer. Human-test launch is not claimed complete while those stand.
