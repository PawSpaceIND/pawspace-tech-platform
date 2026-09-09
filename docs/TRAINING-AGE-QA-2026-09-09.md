# Training age eligibility — internal UAT

## Implemented

- Shared calendar-age rules: puppy programmes below six months; adult programmes at six months or above. Valid DOB takes priority over age bands; invalid/future DOB is not guessed.
- Saved dog ownership and distinct identity checks, including source aliases. One to four dogs; mixed or unknown ages can choose assessment, not an unsuitable age-specific programme.
- Authenticated eligibility preflight before the client attempts sandbox capture. Canonical booking independently rechecks saved profiles after reservation/quote validation and before booking ledger writes.
- Customer package filtering and age-suitable recommendation badge. Suggested Meet & Greet times no longer claim confirmed availability.
- Existing booking replay, city/zone and governed quote refusal ordering preserved.

## Evidence

- Local browser: synthetic customer, saved two-year-old QA Buddy; adult package list shown, puppy programme absent; package screen rendered at mobile width. No booking submitted and no live SMS/payment triggered.
- Executable checks cover exact six-month boundaries, month ends, invalid dates, mixed ages, foreign/duplicate pet identifiers, authenticated gateway access and refusal before capture.
- Broader regression failures were investigated: updated preflight request-sequence expectations and filtered-package copy checks; retained city/quote refusal order; corrected stale inbox/handoff assertions; isolated the scheduling test inspector port from the running preview.

## Still not claimed complete

- Payment-first, schedule-later entitlement flow. Current programme booking still requires reserved sessions.
- Universal guest browsing with final-step OTP across every service.
- Comprehensive taxi configuration/distance pricing and all-module human acceptance.
- Mobile Meet & Greet typography/density needs further refinement.
- Photo/media upload remains deferred. No production activation or physical native-device certification in this change.

Final local validation: typecheck and verified build passed. Fresh complete test run: 4,716 passed, zero failed, zero skipped (244 seconds), using the repository's sandbox/local-preview/service-discovery fixture settings. Staging deployment is tracked separately; local success is not a deployment claim.
