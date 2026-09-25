# PawSpace V2 Training audit and combined Grooming repair candidate

Date: 25 September 2026. Scope: V2 customer Training and the same canonical record in V2 trainer workflows; Grooming findings retain their earlier IDs. This is NOT an end-to-end release certificate.

## Staging records created

- Meet & Greet: `PS-UAT-MUH7N9YY-A12A`, INR 500 prepaid, 3 October 10:00-11:00 IST, trainer `uatcap_train_east`, work order `WO-69F1154C`, payment `PAY-9376888C`.
- Starter split: `PS-UAT-MUH85PS1-1763`, INR 3,500 total / INR 1,750 due, 10 and 17 October 10:00-11:00 IST, selected trainer `train_kiran`, work order `WO-3D296510`, payment `PAY-0FF869EA`.
- Existing audit customer: `CUS-OTP-89214D05FE9E6C1DF354A09A`. Address count stayed two; both new bookings reused its saved service doorstep.
- No Training gateway payment was opened/captured. The payment button was tool-blocked. Unpaid trainer acceptance correctly returned HTTP 409 / `training_payment_required`.

## Training observations

| ID | Finding | Candidate disposition |
|---|---|---|
| T01 | Pro offers 16 sessions, scheduler refuses above 12 | Training cap 16; other services unchanged; integer validation retained |
| T02 | Weekly Pro calendar ends after 105 days despite 93-day validity | Explicit cadence plus preview and canonical reservation validity checks |
| T03 | Payment screen omitted reference/trainer/dates; URL had no booking ID; reload lost checkout | Persist booking ID immediately; resumable hold; visible care summary |
| T04 | Saved address worked but full doorstep was hidden in customer review | Show canonical saved address and management link |
| T05 | Time fixed at 10:00; full programme calendar absent before purchase | Explicit IST time and full calendar preview |
| T06 | Fifth dog selectable before server rejection | UI maximum four; server protection unchanged |
| T07 | Sticky checkout area intercepted selection clicks | In-flow review and scroll margins |
| T08 | Absent attendance/safe-area facts treated as true | Defaults false; restore only explicit true |
| T09 | Trainer timestamps used device timezone; money lost paise | Explicit IST and two-decimal display |
| T10 | Progress controls default to 7 and replace zero with 7 | Open; paid-session runtime retest and explicit unassessed state required |
| T11 | Prepaid coupons exist in backend contract but not V2 form | Open; approved-coupon UI and redemption audit required |

15 programme/payment quote selections matched. Thirteen could enable reservation on the selected dates; both Pro modes were blocked by T01. Two actual Training bookings were created, not fifteen. Two-to-four-dog Starter quotes retained the published total while duration scaled to 120/180/240 minutes; no new per-dog price policy was invented. Cats were excluded. Past dates and empty pet selection were refused.

Trainer login used the normal disclosed staging OTP. The assigned Meet was visible. Requests for another trainer's sessions, Training Finance and GST each returned 403. Existing earnings shown in the trainer account belong to earlier fixtures, not these unpaid bookings.

## Grooming findings addressed in the same candidate

G-F01 callback destination contract; G-F02 default address prefill/reuse without changing the preferred address; G-F05 full-duration review labels; G-F07 explicit assisted pet subset; G-F09 unchecked assisted authority and blank evidence reference; G-F20 duplicate IST labels.

These are candidate code fixes, NOT deployed closures. The single-pet assisted-order 500 (G-F08) remains separate. No unrelated customer data or existing duplicate addresses were deleted. No application source in the original agent worktree was edited.

## Unclosed Grooming/shared findings

G-F03 deferred customer option; G-F04 subscription purchase/redemption; G-F06 assignment/SLA configuration; G-F08 assisted-order backend failure; G-F10 scoped finance filters; G-F11 actual bank import; G-F12 persistent review actions; G-F13 GST UI wiring; G-F14 invoice entity/registration ownership; G-F15 collection queue; G-F16 settlement visibility; G-F17 Grooming partner earnings; G-F18 raw due-now consistency; G-F19 booking-aware V2 support; G-F21 real exports; G-F22 evidence-based period close; G-F23 non-static finance intelligence; G-F24 full-population totals; G-F25 paise in shared finance; G-F26 approved package inclusions.

The combined register therefore carries all 26 Grooming findings plus 11 Training findings: 37 total, 15 with local candidate changes and 22 still open. Zero items are claimed deployed/verified end to end.

## Verification and limits

- Before fixes: 342 focused existing regressions passed.
- Added executable regressions reproduced the 16-session cap, scoped callback failure and changed address default before correction.
- 28 focused new/related regression cases passed after correction, including real in-memory route execution for Pro creation with 16 sessions and rejection of the out-of-validity weekly calendar.
- Local V2 browser render used intercepted API fixtures, clearly separate from live staging evidence. It showed the saved address, rejected weekly Pro, and rendered sixteen six-day visits. This is not real payment/booking evidence.
- TypeScript verification passed. The bounded ESM Worker artifact build passed.
- Initial full run: 7,258 pass / 23 fail. Missing pinned native runtime, missing build artifact, presentation-only source fingerprints, and an old test expecting default replacement were investigated. Matching workerd was restored; build generated; only intended source fingerprints were refreshed; default-preservation expectation now checks both retained addresses and unchanged preferred address.
- Subsequent full run: 7,278 pass / 3 source-fingerprint failures while final Training render cleanup was applied. The final frozen candidate is being rerun; exact final results must be attached before any merge.
- Historical presentation fingerprints were not removed or relaxed. `grooming-training-20260925-contract-rebaseline.json` records old/new hashes for explicitly changed sources and the assisted-booking semantic contract. Unrelated protections remain.

No live-money payment, refund, payout, tax filing or deployment was performed. Before/after photos are excluded; required evidence gates were not bypassed. Paid trainer journey, GPS, start/progress/completion, customer closure, balance collection, invoices, commercial terms and GST require remaining acceptance evidence. Training lead creation/conversion was not independently completed. Missing invoices for unpaid or unfinished test bookings are not called defects.

## Evidence

Remote evidence: `Documents/PawSpace-audits/training-20260925/` on the authorized Mac. `TRAINING-AUDIT-SUMMARY.json`, `flow.jsonl`, `package-matrix.json`, `multipet-checks.json`, `trainer-permission-checks.json`, screenshots, build/typecheck/lint and test logs are retained. Prior Grooming evidence stays in `Documents/PawSpace-audits/grooming-20260925/`.

Retain the two future Training holds for retest and release them through the normal staging workflow afterward. Re-read server state before retrying payment or fulfilment. Do not promote this candidate as all-fixes-closed merely because a local suite passes.
