# Provider Onboarding PO1-PO3 Engineering UAT

**PRODUCTION READY = FALSE.**

This evidence contract covers the engineering/UAT foundation for canonical provider applications, document/verification boundaries, and deterministic qualification. It does not enable production KYC, production AI generation, e-sign, public activation, live money, or autonomous provider acceptance.

## Scenario 1 — policy-bound application
1. Activate a PO6 onboarding policy for a test vertical and jurisdiction.
2. Create an application with basic provider information and locale.
3. Confirm the application freezes the resolved policy reference.
4. Confirm submission fails when the jurisdiction policy requires document types that have not been uploaded.
5. Add secure upload references for the required document types and submit.
6. Confirm application/event history records actor, from/to status, and timestamps.

## Scenario 2 — document and verification boundary
1. Confirm document records store only secure file references and classify identity material as `sensitive_identity`.
2. Start verification using a configured adapter key.
3. Confirm the engineering adapter reports `environment = uat`, `status = not_connected`, and no external provider call occurs.
4. Record `manual_review_required`; confirm qualification remains blocked.
5. Have an authorized staff reviewer explicitly clear the manual review to `verified`.
6. Confirm a failed verification cannot progress to quiz qualification.

## Scenario 3 — Quiz Studio governance
1. Prepare exactly 20 questions from approved interview/SOP/safety source references.
2. Each question has a stable `questionId`, answer options, and canonical `correctAnswerId`.
3. AI/model metadata may be attached to the generated draft, but the version remains `draft` and cannot auto-publish.
4. Have Ops explicitly approve the exact quiz version.
5. Confirm an unapproved quiz cannot be scored for an applicant.

## Scenario 4 — deterministic qualification
1. Use an application whose verification status is explicitly `verified`.
2. Submit answers against the exact approved 20-question version.
3. Confirm scoring is server deterministic and uses the configured pass threshold.
4. Confirm outcomes are only `passed`, `needs_review`, or `did_not_meet_quiz_threshold`.
5. Confirm the quiz result is not a final provider approval/rejection decision.
6. Confirm the application can move to interview only after a `passed` or `needs_review` quiz result.

## Scenario 5 — 15-minute interview handoff
1. Generate an interview guide from the applicant's quiz misses/weak competencies.
2. Confirm the guide duration is 15 minutes.
3. Confirm the output identifies `human_ops` as final decision authority.
4. PO4 will own interview booking, notes, human decision and any AI-assisted summary.

## Exit criteria
- exact-head CI green
- no production KYC or external AI traffic required
- no raw identity document payloads stored in onboarding tables
- policy/document/verification/quiz prerequisites fail closed
- exact quiz version and score are auditable
- AI-generated quiz content requires human approval before use
- provider acceptance/activation remains outside this gate

Staff UAT evidence is still required before PO1-PO3 are called UAT-closed.
