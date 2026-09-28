# PR 1161 — review findings closure, 28 September 2026

This revision follows the merge hold on `f49f07c`. Main `d8ad4a321cc6277b072c82fb1297f4cad0af9dc4` was merged into the existing PR branch in `36b8412`, preserving #1160 business-verdict tests and #1159 repeat-groomer work. No other open PR's implementation was copied or overwritten.

## Three review findings addressed

1. **Current-policy wording — discussion 4122275322.** A complete standalone general-policy question such as “What is the refund policy currently?” or “What is the refund policy today?” now retains information-only classification. Temporal wording still blocks the exception for account-specific, mixed or incident reports. Existing financial-dispute, safety, human-request, injection and action checks remain. Tests include the exact review examples plus cancellation/complaint variants and mixed negative cases.
2. **Grooming catalogue effective dates — discussion 4122283590.** Normal and fast-voice grounding now share `currentGroomingCatalogue`. It enforces active state, valid date-only Pricing Control bounds and inclusive effective dates before the display limit. Future, expired, inactive and malformed-date rows do not enter these catalogue snapshots. The helper uses the existing ISO effective-day convention, not an invented payment/tax policy. A current catalogue snapshot is not a guaranteed future-date quote; booking-time revalidation remains required.
3. **Offer continuity — discussion 4122283581.** A conservative, read-only sales-question classifier preserves a pending offer for equipment, inclusions, duration, payment-method and similar informational enquiries. Such turns expose no proposal tools and cannot execute a model-proposed mutation or replace the offer. This includes the original enquiry-only payment demo. Changed or ambiguous booking terms deliberately supersede the prior offer before generation so a failed refresh cannot resurrect it. Provider failure during an information question retains the record but still creates the normal human handoff, which blocks confirmation while staff owns the thread. Expiry, ownership, current-price validation, explicit confirmation and idempotency checks are unchanged.

This is not a claim that a keyword classifier understands every possible phrasing. Unrecognised/ambiguous follow-ups retain conservative refresh handling rather than silently changing an offer's terms.

## Verification completed before push

- Node 22.16.0: **748/748** selected AI, voice, ElevenLabs, knowledge and degraded-read regressions passed; process exit 0.
- Forced loader-hook compatibility path: **127/127** selected policy, grounding, sales, founder-decision and protected-source tests passed; process exit 0. This overlaps the main selection and is not an additional unique-test total.
- Typecheck passed. Application build and Worker/hosting artifact validation passed.
- All three regressions were deliberately reintroduced one at a time in local source, and each corresponding executable suite failed. Files were restored byte-for-byte after every mutation. These mutation tests used disposable local records and simulated providers, not live accounts or paid calls.
- The source-coverage assertion now follows the extracted catalogue helper and checks both callers as well as all original service-table requirements. No service requirement was removed.
- Eighteen hash entries across nine protected-source manifests were refreshed only for the two intentionally modified, previously protected implementation paths after validating the previous hashes against the merged HEAD. Entries inherited from current main remain intact. No protected path or assertion was removed.

## Release boundaries

The founder-confirmed 70-card library, six business decisions, two pending implementation clarifications and remaining commercial/authorization questions are unchanged by this review-fix revision. No new voice payment mode, subscription collection milestone, refund rule or source-authority hierarchy is approved here.

Full tracked-Web verification and fresh exact-head GitHub CI are separate gates; their final results must be recorded after execution, not inferred from the selected suites. The previous green head is not the new revision's certificate.

No merge to main, deployment, active knowledge publication, customer/contact modification, payment operation, carrier request or handset call was performed for this revision. The five synthetic audio acceptance scenarios have not been rerun on this revision; they remain separate from code/CI verification.
