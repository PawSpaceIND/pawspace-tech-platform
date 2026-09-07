# PawSpace AI runtime: privacy, retention and retrieval

Status: normative engineering policy for the current AI runtime.

## 1. Provider privacy boundary

Every external text-model request MUST pass through `lib/ai-provider-adapter.ts`. The adapter applies `sanitizeAiProviderText()` immediately before provider transmission. New features must not call Anthropic or another external text model directly.

The provider-boundary sanitizer removes direct identifiers and sensitive structured fields that are not required to answer the request. Product/service facts, canonical prices and non-sensitive catalogue data may remain. A feature-specific redactor may reduce data further, but it may not replace the provider-boundary control.

## 2. Runtime governance

External AI execution is conditional on runtime business configuration and kill switches. Grounded channel runtimes require active configuration. The low-level provider boundary independently checks global/channel/intent/provider/model kill switches before network access.

The provider boundary also enforces D1-backed request/token budgets, optional estimated-spend budgets and a provider/model circuit breaker. Production must not bypass the runtime-control database.

## 3. AI context retention

`ai_context_snapshots` are ephemeral authorization/context objects, not durable customer records.

- Minimum TTL: 5 minutes.
- Default TTL: 15 minutes.
- Maximum TTL: 60 minutes.
- Once `expires_at` is reached, the context is invalid for use.
- The Cloudflare scheduled worker physically deletes expired context rows on its existing five-minute cadence through `purgeExpiredAiContexts()`.
- Context payloads must remain `minimum_necessary`; extending the TTL above 60 minutes requires a code and policy change, not an environment override.

## 4. Conversation and voice transcripts

Canonical `communication_messages` and `ai_voice_segments` are operational communication records, not ephemeral AI prompt snapshots. They may be needed for customer support, consent evidence, dispute handling, call-quality review and CRM history. This remediation therefore does **not** silently delete them on the short AI-context TTL.

Any bulk transcript deletion/anonymisation schedule must be implemented under the canonical communications/data-retention policy so legal, support and consent requirements are applied consistently across human and AI messages. AI features must not create a second, longer-lived copy merely for model convenience.

External model prompts are not persisted in the provider runtime-control tables; those tables store request/control metadata and token/cost accounting only.

## 5. Retrieval architecture

The intended production retrieval architecture today is **D1-backed canonical/approved retrieval**, not a vector store.

Grounded AI reads:

1. server-owned relational catalogue data for current service/package facts and prices;
2. approved, active PawSpace knowledge records with public visibility for customer-facing knowledge;
3. customer-scoped canonical context assembled by the conversation orchestrator; and
4. governed read-only tools for allowed intents.

This design is deliberate: high-impact facts such as price, availability, booking/payment state and policy must remain authoritative and relational rather than similarity-selected.

There is currently no production embedding client or vector index. Vector retrieval should be introduced only if measured semantic-recall failures justify it. If added, vector results must remain a candidate-discovery layer: every customer-facing factual claim still has to resolve to an approved/current canonical source before use.

## 6. Vector adoption gate

A vector store is not required for pilot certification. Add one only after an evaluation set demonstrates a material recall gap that approved D1 keyword/relational retrieval cannot meet. Any vector proposal must define source-version invalidation, deletion propagation, tenant/customer isolation, PII handling, evaluation thresholds and a canonical-source verification step.
