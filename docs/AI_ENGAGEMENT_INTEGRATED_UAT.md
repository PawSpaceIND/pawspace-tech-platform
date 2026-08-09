# PawSpace AI Engagement Platform — Integrated UAT Closure

Status: **engineering UAT candidate**

Production status: **PRODUCTION READY = FALSE**

This document closes the engineering-level integrated UAT step after Gates 1–9. It does not authorize production WhatsApp, telephony, external model traffic, live money movement, or autonomous high-impact AI actions.

## Certified architecture

All supported customer channels reuse one canonical conversation/orchestration path:

`channel adapter -> communication_threads / communication_messages -> AI orchestrator -> approved context / knowledge -> governed tool registry -> canonical PawSpace APIs -> response or governed human handoff`

The UAT contract rejects parallel channel-specific customer truth or a second AI action stack.

## Integrated UAT scenarios

The cumulative branch must retain permanent regression evidence for these scenarios:

1. **WhatsApp UAT**
   - signed, replay-resistant inbound webhook
   - canonical customer identity resolution
   - canonical thread/message persistence
   - shared orchestrator invocation with `channel: whatsapp`
   - outbound policy represented through the canonical communications outbox
   - provider kill switch and staff fallback
   - no production external delivery

2. **Web/App chat UAT**
   - anonymous mode limited to approved public knowledge and governed lead capture
   - authenticated mode requires canonical customer ownership
   - shared orchestrator invocation with `channel: chat`
   - same canonical thread may continue into staff handoff
   - no anonymous customer-data access or tool execution

3. **Voice UAT**
   - explicit consent boundary
   - STT/TTS/telephony abstractions remain disconnected by default
   - canonical transcript segments persist as communication messages
   - shared orchestrator invocation with `channel: voice`
   - barge-in, outcome, reconnect/failure state and live-agent transfer are represented
   - governed live-agent transfer preserves the same canonical thread

4. **Governed action safety**
   - booking/change/cancellation tools require canonical authorization and explicit confirmation
   - refund, payment, payout, price override, provider assignment and campaign activation remain approval-gated/non-autonomous
   - authoritative commercial state is server-owned
   - all mutations are idempotent and audited

5. **Human handoff continuity**
   - escalation reason, confidence and bounded context/transcript summary are persisted
   - staff takeover pauses AI replies
   - return to AI is an explicit governed action
   - no parallel active AI/staff ownership on the same thread

6. **Evaluation and security**
   - prompt injection/jailbreak signals
   - PII minimization/redaction
   - cross-customer isolation
   - approved-knowledge freshness
   - groundedness / unsupported-claim checks
   - tool authorization and high-impact blocking
   - consent/quiet-hour boundaries
   - multilingual regression markers
   - replay/provider-failure instrumentation

7. **Analytics truth**
   - channel/intent volume, handoff/containment, latency/token/cost metadata, voice outcomes and delivery status come from canonical records
   - explicit CSAT only; inferred sentiment is not CSAT
   - first-response/resolution metrics remain unavailable until attribution is supportable
   - canonical booking linkage does not claim causal AI conversion
   - no static/demo KPI truth

## Engineering acceptance rule

The integrated UAT step is closed only when:

- the cumulative exact-head pull-request CI is green;
- all existing Gate 1–9 regression contracts remain green;
- the integrated contract test in `tests/ai-integrated-uat-closure.test.mjs` is green;
- production boundaries remain fail-closed/disconnected.

## Explicitly outside this closure

The following remain separate production-readiness work and are not implied by engineering UAT closure:

- provider contracts and approved production credentials;
- privacy/legal/security approval;
- production webhook/domain configuration;
- real-device WhatsApp and telephony UAT;
- production model/provider evaluation sign-off;
- load, reliability, backup/restore and observability evidence;
- controlled Bengaluru pilot evidence;
- Integration Readiness controlled-live approval.

Until those items are separately evidenced, **PRODUCTION READY = FALSE**.
