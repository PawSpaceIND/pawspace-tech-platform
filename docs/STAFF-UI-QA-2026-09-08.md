# Staff UI continuation — 8 September 2026

## Verified on staging

- User-supplied Founder session is valid. `/me` reports no employee linkage; this is not an authentication failure.
- `/team` resolves the Founder role and permission-filtered workspace links.
- The Revenue & CRM link navigates to `/team/sales` and renders records. Navigation is asynchronous; initial unchanged accessibility state was not a failed link.
- `/team/voice` loads its environment, ledger and read-only audit. Calling and retry controls are disabled under current approval settings. No calls or staff-record mutations were made during this review.
- Existing ledger contains two entries counted as production carrier calls. Audit of `VCALL-C69095BF-D84` shows September 5 explicit UAT consent, UAT mode and provider acceptance, with no callback received. This is historical carrier activity, not evidence that the current deployment enables calling. The second record has not been individually audited. Preserve the evidence; do not relabel it as simulated.

## Local fix

- Staging login now resolves the signed-in server role before choosing the landing route. Management and associates go to `/team`; staff service providers retain `/me`.
- Signed-in workspace link uses the same role mapping.
- Unlinked employee state includes an escape link to the permission-protected team workspace. No employee records or authorization rules changed.

## Verification

- Typecheck passed.
- Build and artifact validation passed.
- 12 focused staff routing, staging authentication, team overview and runbook tests passed using the test harness's local-preview flag and sandbox environment.
- Initial test command omitted `PAWSPACE_LOCAL_PREVIEW=on`; the team overview auth test returned 401 as designed. Rerun with the harness flag passed; no auth bypass was added.

## Remaining

These changes are local, not yet deployed. Post-deployment role-routing verification, complete staff/partner interaction review and the booking gaps in GUEST-BOOKING-PROGRESS.md remain open. Voice carrier/environment labels need clarification without hiding historical real-carrier activity. No blanket all-modules-ready or production-ready claim is supported by this review.
