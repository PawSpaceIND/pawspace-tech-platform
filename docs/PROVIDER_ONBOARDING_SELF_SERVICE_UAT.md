# Provider onboarding self-service UAT

## Purpose

Validate the provider-facing identity-scoped onboarding pass after the integrated staff engineering flow. This is UAT only. `PRODUCTION READY = FALSE`.

## Preconditions

- Use a verified platform identity assertion that resolves to subject type `provider`.
- Exchange it through `/api/identity-session` and retain the HttpOnly provider session cookie.
- Use an active provider onboarding policy and an approved 20-question quiz version for the selected vertical/jurisdiction.
- Production KYC, live e-sign and marketplace admission remain disconnected.

## Scenarios

1. **Identity ownership** — create a draft from `/partner/onboarding`. Confirm `provider_id` is derived from the provider session and cannot be supplied or changed by the browser.
2. **Cross-provider tampering** — attempt to read or mutate another provider's application ID. Expect rejection; no data from the other provider is returned.
3. **Documents** — add secure UAT document references. Confirm provider snapshots expose metadata/classification but never raw document file references.
4. **Submission** — submit only after the active policy's required document types are present. Confirm the policy and quiz version are frozen on the application.
5. **Verification boundary** — confirm the provider cannot mark KYC verified, clear manual review, or supply a verification result. Staff/integration remains authoritative.
6. **Qualification** — after verification is explicitly `verified`, render the approved frozen 20-question quiz. Confirm correct-answer keys are absent from the browser payload. Submit all 20 answers and verify deterministic scoring.
7. **Quiz version tampering** — submit an approved quiz ID that differs from the application's frozen quiz version. Expect rejection.
8. **Interview boundary** — show the configured 15-minute Ops interview status read-only. Confirm provider cannot schedule, complete, or decide the interview.
9. **Human decision** — verify only the staff workflow can approve/reject/request review. AI summaries never become decision authority.
10. **Agreement** — after human approval and staff SLA creation, display the active legal content/version and allow explicit UAT acceptance. Acceptance identity must be derived from the provider session.
11. **Profile and media** — save provider/business/service-area/language/package details and secure media references. Home/facility media remain sensitive and unpublished by default.
12. **Activation boundary** — confirm the provider cannot invoke activation or activation evaluation. Staff deterministic activation may create only UAT capacity state with `live=0`.
13. **Post-activation editing** — edit permitted profile fields with a reason. Service-area/compliance-sensitive changes must trigger re-review/reverification and preserve `live=0`.
14. **Truthfulness** — provider UI must always show marketplace live = No and order eligible = No in this UAT slice.

## Required evidence

Capture provider subject ID, application ID, frozen policy/quiz version, document metadata, verification status, quiz score/result, interview status/outcome, human decision, agreement version/acceptance, profile/media metadata, post-activation audit result, and staff activation checklist. Do not capture raw identity document contents or sensitive media URLs in the UAT evidence pack.

## Explicitly out of scope

- production KYC provider calls
- production e-sign calls
- public marketplace admission
- order eligibility
- live payments or payouts
- autonomous AI approval/rejection

Exact-head green CI means engineering-ready only. Staff execution of this runbook is required before calling provider self-service UAT-closed.
