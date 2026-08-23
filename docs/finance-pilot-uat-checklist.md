# Finance / GST / Payroll — human pilot UAT checklist

A pack for a Finance reviewer and a CA to run a controlled round and sign it off. Every row is filled in
by the person running the round, from what the system actually returns — not copied from an expectation.

**This pack never touches production money.** No live GST filing, no production bank transfer, no real
payroll payout, no real customer charge. If any step appears to require one, stop and record it as
blocked rather than proceeding.

---

## 0. Round identity

| Field | Value | Filled by |
|---|---|---|
| Release SHA under test | | Engineering |
| Release CI run number + result | | Engineering |
| Test period (`YYYY-MM`) | | Finance |
| Legal entity id | | Finance |
| GST registration id | | Finance |
| Environment | UAT / sandbox only | Engineering |
| Date of round | | Finance |

## 1. Actors

Maker and checker **must be two different people**. The system refuses self-approval; this pack exists
partly to see that refusal happen.

| Role | Name | Login email | Permission held |
|---|---|---|---|
| Finance maker | | | `finance.manage` |
| Finance checker | | | `finance.manage` |
| Finance viewer (negative test) | | | `finance.view` only |
| Payroll approver | | | |
| CA / statutory reviewer | | | |

## 2. Payment → invoice → journal → GST

| Step | Reference to record | Expected | Actual | Pass |
|---|---|---|---|---|
| Booking created | booking id | — | | ☐ |
| Booked amount | ₹ | matches quote shown to customer | | ☐ |
| Payment captured (sandbox) | payment id / provider ref | status `captured` | | ☐ |
| **Collected** amount | ₹ | may be **less** than booked on a split or deposit | | ☐ |
| Invoice issued | invoice id | | | ☐ |
| Journal posted | journal group id | **debits = credits** | | ☐ |
| GST output recorded | tax ledger ref | | | ☐ |

> **Booked, collected, refunded and net are four different numbers.** If any two are equal here, confirm
> that is genuinely true for this booking rather than the surface collapsing them.

## 3. Refund → reconciliation

| Step | Reference | Expected | Actual | Pass |
|---|---|---|---|---|
| Cancellation raised | | | | ☐ |
| Refund case | refund id | ≤ **collected**, never ≤ booked | | ☐ |
| Refund attempt above collected | | **refused** | | ☐ |
| Accounting reversal | journal id | reversal, never a deletion | | ☐ |
| Net after refund | ₹ | collected − refunded | | ☐ |

## 4. Replay / idempotency

| Step | Expected | Actual | Pass |
|---|---|---|---|
| Re-submit the same payment event | exactly one financial effect | | ☐ |
| Re-submit the same refund event | exactly one financial effect | | ☐ |
| Re-post the same payroll run | absorbed; journal line count unchanged | | ☐ |
| Re-generate the same accounting export | same export run, same checksum | | ☐ |

## 5. GST maker/checker

| Step | Reference | Expected | Actual | Pass |
|---|---|---|---|---|
| Maker generates monthly package | package id | status `draft`, `prepared_by` = maker | | ☐ |
| **Maker attempts to approve own package** | | **refused**; still `draft`; no review event | | ☐ |
| Checker approves without a reference | | **refused** | | ☐ |
| Checker approves with reference | approval ref | `reviewed`, `reviewed_by` = checker | | ☐ |
| Annual return before 12 months reviewed | | **refused** | | ☐ |
| Annual return after 12 months reviewed | annual id | approved by a **different** actor | | ☐ |

## 6. Payroll → Finance

| Step | Reference | Expected | Actual | Pass |
|---|---|---|---|---|
| Payroll run id | | status approved / payment_prepared | | ☐ |
| Account mappings configured | approval ref | all required keys mapped | | ☐ |
| Journal posted | journal group id | debits = credits | | ☐ |
| Accounts used | | only **configured** accounts — no fallback | | ☐ |
| Re-post the same run | | absorbed, no second group | | ☐ |
| **Failed banking transmission** | | must **NOT** mark anyone paid | | ☐ |

## 7. Period lock

| Step | Expected | Actual | Pass |
|---|---|---|---|
| Lock the period | locked | | ☐ |
| Attempt payroll posting | **refused**, no journal lines | | ☐ |
| Attempt bank reconciliation | **refused** | | ☐ |
| Attempt expense/bill approval | **refused** | | ☐ |

## 8. Controlled sandbox handoffs

Record the sandbox reference for each. **None of these is a live filing or a live transfer.**

| Handoff | Sandbox reference | `sandboxOnly` | `externalSubmission` | Pass |
|---|---|---|---|---|
| Statutory export | | must be `true` | must be `false` | ☐ |
| Bank reconciliation — exact match | | `matched_uat` | transmission `0` | ☐ |
| Bank reconciliation — **deliberate mismatch** | | `exception_uat`, **not** success | | ☐ |
| Accounting export | export id + checksum | `productionPost: false` | status `generated` | ☐ |
| Export acknowledgement | ack reference | requires explicit reference | | ☐ |

## 9. Authorization

| Check | Expected | Actual | Pass |
|---|---|---|---|
| Anonymous → any Finance surface | refused | | ☐ |
| `finance.view` actor → a `finance.manage` mutation | **403**, nothing written | | ☐ |
| Refused mutation | writes **no** audit event | | ☐ |
| Successful mutation | audit names the **real** actor | | ☐ |

## 10. Surface truth

| Check | Expected | Actual | Pass |
|---|---|---|---|
| Finance control figures | counted from records | | ☐ |
| Anything unsourced | reads **"Not connected"**, not a number | | ☐ |
| Integration labels | match the registry; nothing reads "live" unless verified | | ☐ |
| Ledger balance | computed; an unbalanced book **says so** | | ☐ |

---

## Sign-off

| | Name | Date | Signature |
|---|---|---|---|
| Finance maker | | | |
| Finance checker | | | |
| CA / statutory reviewer | | | |
| Engineering witness | | | |

**Result:** ☐ Passed ☐ Passed with exceptions ☐ Failed

**Exceptions raised (issue numbers):**

**Confirmed during this round:** no production deployment · no live GST filing · no production bank
transfer · no real payroll payout · no real customer charge.
