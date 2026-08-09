# Provider onboarding PO4 + PO5 engineering UAT

Status: engineering/UAT lane only. **PRODUCTION READY = FALSE.**

This checklist validates the human interview, agreement, profile/media and deterministic UAT activation controls added on top of the PO1-PO3 and PO6-PO7 provider onboarding foundation.

## PO4 — Ops interview and human decision

1. Move an application to `interview` only after verification is explicitly `verified` and the approved 20-question quiz result is `passed` or `needs_review`.
2. Schedule an Ops interview. Confirm duration is read from the frozen onboarding policy; default configuration remains 15 minutes.
3. Attempt an overlapping interview for the same Ops assignee. Confirm it is rejected.
4. Attempt to complete the interview as someone other than the assigned Ops interviewer. Confirm it is rejected.
5. Complete the interview with durable notes.
6. Save an AI-assisted summary draft with provider/model provenance. Confirm the summary stays a draft and does not change `human_decision`.
7. Record each human decision path: `approved`, `review`, and `rejected`. Confirm actor, decision notes and timestamp are auditable and only the human decision controls advancement.

## PO5 — SLA / agreement

1. Confirm the frozen policy references an SLA template/content key.
2. Confirm the resolved content is an active `legal` localization. Legal content activation itself remains governed by PO7 legal-use approval.
3. Create an agreement and confirm it pins agreement version, template ref, content ID, content version and locale.
4. Confirm adapter environment is `uat`, `externalConnected=false`, and no live e-sign request occurs.
5. Record provider acceptance in UAT and confirm an immutable acceptance reference is stored. This is not production e-sign execution.

## PO5 — Profile and media

1. Save provider display name, business name/details, services, service areas, languages, package details, facility details and submitted references.
2. Confirm onboarding references/testimonials are stored as submitted references and are not presented as fabricated customer reviews.
3. Upload secure file references for provider photo, home photo, facility photo, business photo and reference evidence.
4. Confirm home/facility media is classified `sensitive_location`, reference material is `sensitive_reference`, and uploads default to `publish_approved=0`.
5. Confirm raw media bytes or identity material are not written to audit/event details.

## PO5 — Deterministic activation

1. Run activation evaluation with verification incomplete. Confirm blocked.
2. Run with quiz not qualified. Confirm blocked.
3. Run without completed/approved interview. Confirm blocked.
4. Run without explicit `human_decision=approved`. Confirm blocked.
5. Run without accepted SLA. Confirm blocked.
6. Run without required profile fields/media from the frozen jurisdiction/vertical policy. Confirm blocked.
7. Add an unsupported activation-policy requirement. Confirm the checklist fails closed rather than silently ignoring it.
8. Once all checks pass, invoke UAT activation. Confirm a canonical provider ID is reused/created in provider capacity governance with `live=0` and status `uat_ready`.
9. Confirm application becomes `activated_uat`, while `marketplaceLive=false`, `orderEligible=false`, and `productionReady=false`.

## Post-activation editing

1. Edit an allowlisted presentation field such as display name. Confirm audit captures before/after and reason.
2. Edit service or service-area details. Confirm the provider enters `post_activation_review`, provider capacity is held with `live=0` / `uat_review`, and service-area edits flag reverification.
3. Attempt to edit identity, compliance, KYC, human-decision or other protected onboarding fields through the profile edit action. Confirm rejected.

## Production boundary

Passing this UAT does **not** enable production marketplace admission. Production remains separately gated on real KYC/e-sign provider contracts and credentials, legal/privacy/security review, staff UAT/pilot evidence, production media/privacy controls, and an explicit production activation mechanism. No live money movement or autonomous AI approval is part of this slice.
