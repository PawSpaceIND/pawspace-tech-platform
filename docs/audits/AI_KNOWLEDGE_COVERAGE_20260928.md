# PawSpace AI knowledge coverage — implementation batch 1

Date: 28 September 2026. Base: `89d483d971b1ca1ceeaeb96bbff91898168081f2`.
Scope: approved knowledge retrieval, conservative policy-enquiry handling, source coverage and draft staging. This is not a deployment, active-content publication or telephone readiness certificate.

## Implemented

- Reused the existing 41-card Maya library and added 24 focused, amount-free articles: **65 required topic cards**. Corrected five overbroad existing cards about payment, reminders, multi-pet pricing, coat advice and account benefits. No live tariff or promised refund timeframe was invented.
- Replaced the fixed first-1600-character result with Unicode-aware, synonym-normalised passage retrieval. Short sources and suitable bounded sections retain full wording/restrictions; source/version/hash and offsets accompany results. Active/effective/visibility filters remain. This is lexical/synonym retrieval, **not** a deployed semantic-vector index or multilingual speech certification. Overlong unstructured paragraphs are withheld rather than silently clipped.
- Added a shared, conservative information-only classifier for refund/complaint/change process questions. Actual disputes, incidents, explicit human requests and safety concerns retain their original handling. Information-only turns cannot execute model-proposed mutations, even through a sales specialist. Existing pending offers are not invalidated by a policy enquiry.
- Fast voice now reads the approved public knowledge source. Grooming catalogue context includes description, tax-inclusive flag, slot duration and effective dates where present. The agent must not confuse the voice prepaid checkout capability with a company-wide pay-after-service prohibition. Final amounts and eligibility still require the applicable live quote.
- Added authenticated `GET /api/ai-business-configuration?mode=coverage`, showing required/active/source-matched topics and nine unresolved owner-decision groups. Article presence cannot turn `knowledgeComplete` or `customerReady` true; live tool and audio acceptance remain explicitly unverified.
- Added authenticated same-origin `POST /api/ai-business-configuration` with `action=stage_knowledge_library`. It creates review drafts only and is idempotent for identical valid public policy drafts. No approval/activation is performed. Owner-only questions are not customer retrieval content.
- Preserved all **100 questions** from section 22 of the master reference as `tests/fixtures/pawspace-knowledge-question-bank.json`. These are labelled **not_run**; a question inventory is not 100 passed model answers.

## Source authority

Primary content reference: `PawSpace_Maya_Master_Knowledge_Base_2026-09-26.md`, version 1.0, 23 sections, source snapshot `dc83d37f49ca8d2d861b21877b3f541bcb9acd20`. Entire 1,108-line reference read. Its dated numeric examples and unresolved policies are **not** automatically approved current facts. The owner-only activation register remains outside the customer collection.

Expansion provenance: master sections 03–08 for grooming/training, 09–12 for stays/walking, 13–15 for taxi/food/specialists, 16–21 for account/payment/policy/handoff boundaries; section 22 supplies the question inventory. Existing `lib/maya-knowledge-base.ts`, pricing catalogue and grounded runtime were inspected before reuse.

## Verification

- **631/631** AI and voice regression tests passed on Node **22.16.0** using the normal module-hook path.
- **217/217** selected new/existing knowledge, policy and presentation tests passed on the loader-hook fallback path (`PAWSPACE_FORCE_LOADER_HOOK=1`).
- New tests execute the real shared orchestrator across voice/chat/WhatsApp, real grounded-provider composition and actual SQLite-backed source lifecycle. External model responses are stubbed for these tests; **these are not live-model call results**.
- Cases cover the exact failed demo enquiries, active disputes, requested humans, malicious mutation envelopes, tail-of-document answers, retained restrictions, Unicode search, private/future/expired/draft exclusion and draft-only staging.
- Full lint: zero errors; existing repository warnings remain. Typecheck and the final verified build both passed; the Worker/hosting artifact validation passed.
- Nine protected-source manifests were updated only for the four intentionally changed implementation paths after verifying their original hashes against the base commit. No protected entry/assertion was removed. A controlled mutation of the runtime source was rejected by the unchanged Inbox protection test, then restored before commit.

## Owner decisions still required

See `lib/ai-knowledge-owner-decisions.ts` for exact questions: payment modes, quote adjustments, active subscription terms, training socialisation, service-specific refund/change policies, stay/walking units, centre/support information, verified food labels and specialist offerings. These are review questions, not published promises.

## Release boundaries and next gate

No calls to any handset, no carrier requests, no paid-provider tests, no bookings/payments/refunds, no customer identity changes, no production or staging deployment, and no active knowledge publication are part of this batch. The separate duplicate tester contact remains unchanged.

Before acceptance: review the source changes, pass CI, deploy the exact approved revision to staging, publish only reviewed content through the existing lifecycle, then rerun the original five detailed synthetic audio scenarios and the larger held-out bank. The original five have **not** been rerun against this branch. Do not label the prior 3/5 result as 5/5 or infer 100% knowledge from 65 cards.
