# PawSpace WATI Full-Parity Closure — 26 August 2026

Base `main`: `2f3963ea201220e6933e4589bb18025fc926b6ff`

Branch: `closure/wati-full-parity-20260826`

Release boundary: **staging/UAT only until every blocker below is machine-tested and audited. Production WhatsApp delivery, production marketing sends, and live ad-account mutation remain disabled.**

## Outcome

PawSpace operates a first-party WhatsApp customer-operations platform with WATI-style inbox, templates, deterministic chatbot flows, PawSpace AI, human handoff, user/team access, lead routing, governed marketing, attribution/conversion feedback, analytics, audit, and failure/retry controls integrated with canonical customers, CRM, bookings, payments, communications and PawSpace AI.

## Five product screens

1. **Shared Inbox** — `/team/customer-experience`
   - all / WhatsApp / unassigned / human-owned / my queue filters
   - governed human reply composer
   - assignment, takeover and resume-AI controls
   - service-window/template-required state
   - customer/lead/booking/ticket/consent context
   - complete message/delivery/audit history

2. **WhatsApp Templates & Campaigns** — `/team/whatsapp/templates`
   - draft utility/authentication/marketing templates
   - variables, language, preview and validation
   - Meta submission/sync/approval/rejection lifecycle
   - approved-template selection for governed sends
   - marketing-consent audience suppression, opt-out, dedupe, frequency and quiet-hour controls

3. **Bot / AI Automation Studio** — `/team/whatsapp/automation`
   - explicit mode per queue/entry point: `human_only`, `chatbot_only`, `ai_assistant`
   - deterministic chatbot flows and qualification questions
   - AI profile, prompt policy, approved knowledge, intent catalogue and tools
   - confidence thresholds, disallowed actions, escalation rules and kill switch
   - human takeover stops automation; authorized resume re-evaluates policy before AI continues

4. **Users, Teams & Lead Access** — `/team/users` or existing canonical access-control surface
   - founder/admin/manager/associate role controls
   - team/city/queue scopes
   - assigned-lead/assigned-conversation access where required
   - full-phone access only through explicit permission
   - reassignment, round-robin and audit
   - no cross-team/cross-city lead leakage

5. **WhatsApp / Marketing Analytics** — `/team/whatsapp/analytics`
   - leads, first-response SLA, conversations, bot resolution, AI containment, human handoff
   - sent/delivered/read/replied/failed template and message metrics
   - opt-outs and consent suppression
   - bookings, conversion and revenue attribution
   - source/campaign/UTM breakdown
   - Meta/Google conversion export status, retries and reconciliation
   - agent/queue performance

## Mandatory end-to-end flow

`Meta/Google lead -> canonical CRM lead/contact -> explicit WhatsApp consent -> approved first-response template -> customer inbound -> router -> chatbot OR AI OR human -> qualification -> governed quote/booking/tool calls -> human handoff when required -> booking/payment outcome -> attribution fact -> Meta/Google conversion feedback -> analytics/reconciliation`

## Baseline already present on main

- canonical WATI-style shared inbox UI
- canonical conversation threads/messages/assignment/status
- phone masking by permission
- Meta WhatsApp webhook verification/parsing/status handling
- webhook idempotency and STOP/opt-out persistence
- governed initial WhatsApp lead trigger and consent evidence
- Meta template sync and allow-listed UAT dispatch
- PawSpace AI versioned profile/prompt/knowledge/intents, rollout state and kill switch
- governed marketing campaigns/audience snapshots/holdouts/maker-checker
- role/permission catalogue and security audit ledger

## Blockers that must close before staff human UAT

### A. Shared Inbox execution
- [ ] governed operator text reply endpoint; direct client bypass impossible
- [ ] allowed attachment/media reply contract if supported in phase
- [ ] resume-AI action with explicit authorization + audit
- [ ] `my conversations` / team queue semantics
- [ ] SLA and assignment ownership enforced server-side, not UI-only
- [ ] service-window rules tested at boundary and outside 24h

### B. Template lifecycle
- [ ] create/update draft template records
- [ ] category/language/components/variable validation
- [ ] submit-to-Meta adapter in UAT and deterministic simulator fallback
- [ ] sync approval/rejection state
- [ ] only approved template may be externally dispatched
- [ ] marketing template requires explicit marketing consent
- [ ] opt-out always suppresses sends
- [ ] dedupe/idempotency/frequency/quiet-hour controls

### C. Chatbot vs AI routing
- [ ] per-queue/entry-point mode: human/chatbot/AI
- [ ] deterministic chatbot state machine
- [ ] AI inbound reply orchestration actually invokes the approved assistant configuration
- [ ] no auto-send when human-owned
- [ ] customer asks for human -> immediate handoff
- [ ] low confidence/tool failure/unknown knowledge -> handoff
- [ ] complaints/refunds/payment disputes/safety/medical -> mandatory handoff
- [ ] AI cannot invent price, slot, availability or completion state
- [ ] AI may only use allow-listed read/write tools with governed confirmation

### D. Users / lead access
- [ ] team/city/queue scope model
- [ ] row-level lead access for associate/manager roles
- [ ] conversation list/detail honors the same scope
- [ ] reassignment and round-robin tested
- [ ] masked phone remains masked without explicit permission
- [ ] cross-team/cross-city negative tests
- [ ] founder/superuser protected-role rules remain intact

### E. Meta/Google leads and conversion feedback
- [ ] source metadata persisted for Meta/Google leads
- [ ] inbound lead idempotency and dedupe
- [ ] lead-created and qualified states linked to canonical customer/thread
- [ ] booking/payment conversion facts map back to source/campaign/click identifiers when present
- [ ] Meta conversion adapter with UAT/simulator mode
- [ ] Google Ads conversion adapter with UAT/simulator mode
- [ ] retry/dead-letter/idempotency and reconciliation
- [ ] no live ad-account mutation during closure

### F. Analytics and reports
- [ ] canonical WhatsApp funnel metrics
- [ ] template delivery funnel
- [ ] bot/AI/human containment and handoff
- [ ] first response / resolution SLA
- [ ] queue/agent/team performance
- [ ] opt-out/consent suppression
- [ ] booking/revenue attribution
- [ ] Meta/Google feedback success/failure/retry
- [ ] date range + export with role checks

## Mandatory automated test gate

No staff human UAT until all applicable tests are green on the exact candidate SHA:

- unit tests for routing/template/consent/access/conversion logic
- API authorization and cross-origin negatives
- Meta webhook signature/idempotency/status/opt-out
- 24-hour service-window boundary tests
- chatbot-only path
- AI path with approved grounding
- human-only path
- human takeover + resume path
- low-confidence and forbidden-action handoff
- marketing consent/opt-out/frequency/quiet-hour suppression
- associate/manager/founder access matrix and row-level leakage tests
- Meta/Google lead ingestion + conversion-feedback simulator tests
- analytics reconciliation against canonical source rows
- existing Web/Backend/Typecheck/Lint/D1/Artifact/production-readiness gates
- master zero-gap audit
- exact-SHA staging deployment and authenticated smoke pack

## Closure rule

A green UI or a successful Meta API call is not sufficient. This project may be marked `READY FOR STAFF UAT` only when the exact candidate SHA has no unresolved review threads, all protected checks pass, zero-gap audit passes, staging certification passes, production delivery remains disabled, and the evidence document contains the exact workflow run IDs and blocker assertion summary.
