# Provider onboarding integrated UAT

## Boundary

This is an engineering and staff-UAT runbook. `PRODUCTION READY = FALSE`.

Do not connect production KYC, production e-sign, external AI/model traffic, marketplace admission, order eligibility, or live money while running this document.

## Canonical happy-path scenario

1. Create an application for a vertical and jurisdiction with an active onboarding policy.
2. Upload only secure document references for every policy-required document. Confirm raw identity bytes are not present in application/event responses.
3. Submit the application and create the UAT verification record. Confirm the adapter remains `not_connected` unless a separately approved sandbox provider is configured.
4. Exercise a `manual_review_required` verification. Confirm quiz scoring remains blocked until authorized staff explicitly clear the manual review to `verified`.
5. Use an Ops-approved 20-question quiz version. Complete one passing attempt and confirm deterministic server score and exact quiz version reference.
6. Move the application to interview. Schedule the configured interview duration (default 15 minutes) with an Ops assignee. Confirm overlapping interviews for that assignee are rejected.
7. Save interview notes. Optionally save an AI summary draft with provider/model provenance. Confirm the AI draft does not alter the human decision field.
8. Record an explicit human `approved` decision with notes and actor audit.
9. Create the SLA from the frozen onboarding policy. Confirm the agreement pins active legally approved content ID, version and locale, and that e-sign remains UAT/disconnected.
10. Record provider UAT acceptance from `/partner/onboarding`. Confirm acceptance is derived from the provider identity session and no live e-sign execution occurred.
11. Complete provider/business/services/service areas/languages/package/facility/reference profile fields and upload policy-required media through secure file references.
12. Evaluate activation. Confirm every prerequisite is visible and any unsupported policy requirement blocks eligibility.
13. Run UAT activation only after all checks pass. Confirm the canonical provider capacity record is `uat_ready`, `live=0`, `marketplaceLive=false`, and `orderEligible=false`.
14. Edit a safe post-activation profile field and confirm audit. Edit services/service area and confirm re-review; service-area change must flag reverification and keep provider non-live.

## Negative scenarios

- Missing policy-required document blocks submission.
- `not_connected`, `failed`, or `manual_review_required` verification blocks qualification.
- Draft/unapproved quiz cannot be scored.
- Quiz result below review threshold cannot advance to interview.
- AI interview summary cannot approve or reject.
- SLA cannot be created before human approval.
- SLA cannot use non-legal or non-active legal content.
- Missing required profile/media data blocks activation.
- Unknown activation requirement blocks rather than being silently skipped.
- UAT activation never creates an active/live provider.
- Protected identity/compliance fields cannot be changed through the post-activation profile edit endpoint.

## Staff control-room evidence

Open `/team/provider-onboarding` with a staff identity that has `settings.manage`. For each test application capture:

- application ID and frozen policy reference;
- verification and quiz state;
- interview assignee/duration/outcome;
- SLA version/locale/adapter state;
- profile/media counts;
- deterministic activation checklist;
- audit trail for state transitions and post-activation edits.

Use `/control/provider-onboarding` to prepare only UAT fixtures: locale, draft/review/approved/active onboarding policy and legally approved localized content. Keep verification adapters `not_connected` unless a separately approved sandbox adapter is being exercised.

## Provider-facing truthfulness

Use `/partner` as the canonical Partner UAT entry and `/partner/onboarding` for identity-scoped provider onboarding. Provider self-service is implemented and must derive provider ownership from `/api/identity-session`; the browser must not choose another provider ID.

The legacy `/partner-app` surface is a quarantined synthetic regression prototype only. It must not be used as evidence of provider verification, approval, SLA acceptance, activation, marketplace availability, earnings, payouts, ratings, or live booking eligibility.

The canonical Partner UAT path must continue to show `marketplace live = No`, `order eligible = No`, `live money = No`, and `PRODUCTION READY = FALSE` unless a separate controlled-live approval explicitly changes those boundaries.

## Closure rule

An exact-head green CI makes this slice engineering-ready. It is UAT-closed only after staff and provider-role testers run the scenarios above and retain the evidence. Production activation remains a separate security/privacy/legal/integration/pilot decision.
