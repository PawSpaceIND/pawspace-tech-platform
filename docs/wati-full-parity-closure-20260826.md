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
- [x] conversation list/detail and mutation controls honor the canonical lead-assignment scope
- [ ] reassignment and round-robin tested
- [ ] masked phone remains masked without explicit permission
- [x] cross-team/cross-city conversation negatives, including forged inbox ownership
- [ ] founder/superuser protected-role rules remain intact

Conversation scope closure uses `lead_assignments` as current authority and active
`lead_assignment_policies` only for legacy leads without a current assignment. Active
`lead_assignment_memberships` supplies employee/team/service/city scope;
`communication_threads.assigned_to` is explicitly not an authorization source. The same policy is
executed for inbox list/detail, assignment/status/inbound writes, WhatsApp control actions, and AI
handoff detail/queue. Runtime proof: `tests/conversation-row-authorization.test.mjs`.

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

### G. WATI-style inbox productivity
- [ ] governed quick replies / canned replies with variables and optional approved media
- [ ] conversation tags for support/operational classification and analytics
- [ ] canonical contact attributes for customer-specific facts used by personalization and automation; do not duplicate canonical customer/CRM truth
- [ ] search/filter by owner, queue, status, tag, channel, lead/customer/booking identifiers
- [ ] unread/favourite or equivalent priority controls without changing canonical thread ownership
- [ ] transcript/export action with RBAC, masking and audit
- [ ] agent identity/display-name policy for human replies
- [ ] optional operator assists such as translation and audio transcription must remain assistive and auditable, never an authorization bypass

### H. Rule automation and no-response sequences
- [ ] rule builder contract with explicit trigger -> filters -> actions semantics
- [ ] working-hours / out-of-office and welcome-message rules
- [ ] keyword/default-action compatibility for deterministic bot entry points
- [ ] time-delay/timer actions with durable idempotent scheduling
- [ ] customer-no-response trigger differentiates template/non-template/all-message cases
- [ ] PawSpace lead follow-up sequence supports configurable steps; initial business profile is `10m -> 30m -> 3h`
- [ ] remaining sequence steps cancel immediately on customer reply
- [ ] remaining sequence steps also cancel on human takeover, opt-out, completed booking, ineligible offer/discount, or send-policy failure
- [ ] sequence execution rechecks consent, 24-hour window/template requirements, quiet hours, dedupe and frequency caps at send time
- [ ] exactly-once/idempotent execution across scheduler retries and duplicate webhook delivery
- [ ] routing actions include last assignee / explicit team / round-robin where permitted by PawSpace access rules
- [ ] webhook/tool actions are allow-listed, signed/authenticated where applicable, auditable and fail closed

### I. WhatsApp interactive capture
- [ ] list/reply-button messages supported through governed message contracts where Meta allows them
- [ ] WhatsApp Flows assessed for lead qualification, booking detail capture, surveys and feedback
- [ ] Flow submissions validate schema, identity and idempotency before writing canonical CRM/customer/booking data
- [ ] Flow responses never create a parallel customer/order store; canonical customer, lead and booking remain the source of truth

## Tracked parity items that do not block Phase 1 staff UAT

These capabilities exist in current WATI product families and are intentionally tracked so PawSpace does not lose them, but they are not Phase 1 blockers unless the business explicitly promotes them into scope:

- **Campaign/broadcast expansion** — bulk/promotional sending stays disabled in Phase 1; any later enablement must use the existing governed consent, audience, maker-checker, frequency, quiet-hour and opt-out controls.
- **Catalog / commerce / WhatsApp orders** — useful for product-led commerce such as Fresh Food, but service bookings continue through PawSpace canonical booking logic; no duplicate order ledger.
- **Multiple WhatsApp numbers** — future-ready number/channel identity, number-specific routing rules, webhook isolation and per-number analytics; not required for the initial single-number UAT.
- **WhatsApp Calling** — tracked as a later channel. PawSpace's existing governed voice/telephony architecture remains separate; WhatsApp Calling must not bypass voice permissions, consent, recording or audit rules.
- **Additional channels** — Instagram, Facebook Messenger, RCS, SMS, TikTok and website chat can later feed the same canonical conversation/customer layer, but WhatsApp remains the Phase 1 execution boundary.
- **External connectors / public APIs** — expose only governed, least-privilege endpoints and webhooks after internal contracts are stable; production tokens and live mutation remain outside this closure.

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
- quick-reply RBAC/media/variable validation and audit
- tag vs contact-attribute ownership and leakage tests
- rule trigger/filter/action evaluation
- working-hours / OOO boundary tests
- no-response `10m -> 30m -> 3h` sequence scheduling, cancellation and exactly-once retry proof
- WhatsApp Flow submission schema/identity/idempotency proof if Flows are enabled for UAT
- associate/manager/founder access matrix and row-level leakage tests
- Meta/Google lead ingestion + conversion-feedback simulator tests
- analytics reconciliation against canonical source rows
- existing Web/Backend/Typecheck/Lint/D1/Artifact/production-readiness gates
- master zero-gap audit
- exact-SHA staging deployment and authenticated smoke pack

## Closure rule

A green UI or a successful Meta API call is not sufficient. This project may be marked `READY FOR STAFF UAT` only when the exact candidate SHA has no unresolved review threads, all protected checks pass, zero-gap audit passes, staging certification passes, production delivery remains disabled, and the evidence document contains the exact workflow run IDs and blocker assertion summary.
