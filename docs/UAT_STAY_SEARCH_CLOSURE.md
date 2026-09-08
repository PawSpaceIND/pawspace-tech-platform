# Stay search recovery and host evidence

## Reproduced journey

On combined candidate 0ca9c8658dd5b770755eb9a59ab09fb1579a9d9e, a disposable customer signed in through the sandbox OTP UI, opened Boarding, and saved a vaccinated dog. Map verification failed because the local maps service was unconfigured. Despite that failure, `See available homes` advanced to host selection. No request could run without a resolved location, so the page remained in a checking state, while the empty placeholder profile displayed home/KYC/background/capacity verification badges.

## Repair

- Both stay flows require a verified, serviceable address, valid dates and a selected pet before advancing to matching.
- Boarding search identity includes city, zone, stay window, care duration, pet IDs and species. Previously, changing location could reuse hosts from the old zone while the new request was pending.
- A selected host must still exist in the current verified result set before its profile or the next action is available. Placeholder or stale profiles are hidden.
- Boarding catalogue/quote requests have a 15-second fetch/body deadline and readable malformed-response errors. A failed host lookup offers retry.

Eleven focused tests passed, including location/date/pet invalidation, missing and unverified hosts, unsuccessful HTTP responses, unreadable responses and timeouts. Typecheck passed. Browser recheck showed the saved pet persisted and the action disabled with “Verify a service address to continue.”

## Limits and next work

No complete boarding journey is claimed: maps integration prevented reaching a verified address, and no check-in/out or money movement occurred. This is partial C13 evidence. Configured integration and complete host/customer paths remain required.

Code inspection also found static sitter profiles, ratings and simulated conversation copy in the shared Pet Sitting view. That is a separate unresolved customer-trust gap and must be replaced with governed provider discovery and actual communication state before certification. This patch does not claim to repair it.
