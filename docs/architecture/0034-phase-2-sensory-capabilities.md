# PawSpace Phase 2 — Advanced AI Capabilities & Sensory Expansion

**Architecture status:** Approved / documentation frozen
**Target:** Atlas Multi-Agent System
**Operating model:** AI / Human / Hybrid simultaneously
**Principle:** Models may reason and propose. Atlas tools and canonical services decide and execute.
**Migration status:** `0034` D1 migration is intentionally **NOT executed** until the Phase 1 `gce_budget_envelopes` dependency is merged and live.

## 1. Phase 2 Architecture Decision

Phase 2 adds four sensory/cognitive capability suites:

1. **Infinite Memory** — durable semantic customer/pet memory.
2. **Vision Intelligence** — document extraction and service-quality verification.
3. **Autonomous Operational Voice** — urgent provider dispatch by voice.
4. **Dynamic Yield Management** — bounded customer surge + provider incentive calculation.

These are extensions of Atlas, not independent AI services.

```text
Founder / Staff UI
        |
Vertical Heads
Sales | Ops | Finance | Escalation | HR
        |
        v
+-----------------------------------------+
|          ATLAS TOOL GATEWAY             |
| Auth / RBAC                             |
| Customer + Pet scope                    |
| GCE goals / constraints                 |
| Budget envelopes                        |
| Idempotency                             |
| Approval rules                          |
| Platform kill switches                  |
| Audit                                   |
+-------------------+---------------------+
                    |
       +------------+-------------+-------------+-------------+
       |                          |             |             |
 Vector Memory                Vision QC      Voice        Yield
       |                          |             |             |
 D1 + Vectorize          Claude Vision      Exotel       Pricing
 Secure Facts            R2 / Media         Twilio*      Finance
       |                          |             |             |
       +--------------------------+-------------+-------------+
                                  |
                     Canonical PawSpace Services
```

`*` Twilio is an optional second adapter, not another business-logic path.

## 2. Platform Physics — Non-Negotiable Invariants

### PHYS-01 — Dual Mode

Every Phase 2 capability MUST be callable from both human and agent paths:

```text
Human UI -> Atlas Tool Gateway -> Canonical Service
AI Head  -> Atlas Tool Gateway -> Canonical Service
```

There must never be an AI-only bypass such as direct AI writes to D1, Razorpay, Exotel, Vectorize, CRM, or pricing tables.

### PHYS-02 — Authority stays server-side

Models cannot authoritatively supply base price, provider payout, final surge price, phone number to dial, assigned provider, vaccination validity state, payout amount, customer balance, or finance ledger state.

### PHYS-03 — No weakening existing high-impact controls

These remain separately governed:

```text
price.override
payout.release
payment.capture
refund.issue
provider.assign
communication.send
```

`vision.qa.verify` may resolve quality eligibility but MUST NOT call `payout.release`. `finance.yield.calculate_surge` may persist a bounded yield decision but MUST NOT invoke `price.override`.

### PHYS-04 — Credential-like memory is never vector memory

Ordinary behavioral facts such as "Bruno is afraid of autos" may be semantically indexed. Credential/access information such as a gate code, lockbox code, or credential-like instruction MUST NOT be embedded or stored in Vectorize metadata. Such facts are automatically routed to encrypted Secure Context Facts and revealed only at an authorized operational boundary.

## 3. Capability Suite A — Infinite Vector Memory

### 3.1 Storage architecture

```text
Conversation / Staff Action
          |
          v
 memory.vector.store
          |
          v
 Secret / PII Classifier
       /          \
ordinary fact    access secret
    |                |
    v                v
Encrypted D1     Secure Facts D1
    |
sanitized embedding
    |
Vectorize
```

D1 is authoritative. Vectorize contains vector ID, embedding, and non-secret filtering metadata only. It does not contain the canonical plaintext record.

Recommended embedding model: `@cf/baai/bge-m3`, 1024 dimensions, cosine metric.

Vector partitioning uses environment namespaces such as `production` and `staging`; customer and pet isolation is enforced with indexed metadata filters (`customer_id`, `pet_id`) before semantic retrieval. A namespace per customer is prohibited.

### 3.2 Vectorize configuration

```bash
npx wrangler vectorize create pawspace-atlas-memory-v1 \
  --dimensions=1024 \
  --metric=cosine
```

```toml
[[vectorize]]
binding = "ATLAS_MEMORY_VECTOR"
index_name = "pawspace-atlas-memory-v1"
```

Create metadata indexes before production ingestion:

```bash
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=customer_id --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=pet_id --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=memory_type --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=sensitivity --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=status --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=service_code --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=city_id --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=expires_at --type=number
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=source_channel --type=string
npx wrangler vectorize create-metadata-index pawspace-atlas-memory-v1 --property-name=embedding_version --type=string
```

No plaintext memory text is stored as Vectorize metadata.

## 4. Capability Suite B — Claude Vision

Add a provider boundary so PawSpace does not bind business logic directly to Anthropic:

```ts
interface VisionProvider {
  analyse(input: {
    assetIds: string[];
    task: "vaccination_document" | "service_completion";
    schemaVersion: string;
  }): Promise<VisionResult>;
}
```

Primary implementation: `AnthropicVisionProvider`.

Preferred flow:

```text
canonical media asset ID
       ↓
authorization
       ↓
R2/service-media fetch
       ↓
bounded image validation
       ↓
base64 image block
       ↓
Claude Vision
```

The model never receives an arbitrary URL supplied by an agent.

### 4.1 `vision.document.parse`

Initial production document type: `pet_vaccination_booklet`.

```text
Uploaded vaccination booklet
          ↓
service_media_assets
          ↓
vision.document.parse
          ↓
Claude Vision extraction
          ↓
strict JSON validation
          ↓
identity/date validation
       /            \
high confidence     uncertain
      |               |
      v               v
CRM vaccination    Ops/HR review
record update      queue
```

Auto-application requires pet identity match, readable document, identifiable vaccination, valid ISO dates, no contradictory pages, and field confidence >= 0.95. Otherwise the result is `review_required`.

### 4.2 `vision.qa.verify`

Use the existing `service_completion_visual_verification` completion-finance gate rather than creating a parallel payout gate.

```text
Provider marks service completed
          ↓
before + after approved media
          ↓
vision.qa.verify
          ↓
Claude Vision
          ↓
Deterministic QA policy
   /          |          \
PASS       UNCERTAIN     FAIL
 |             |           |
verified    awaiting       rejected
 |           review          |
 v                          v
finance accrual         case / Ops
eligible                escalation
```

Checks may include required before/after photos, pet identity consistency, service evidence, visible safety anomaly, injury/irritation concern, unsafe restraint, completion quality evidence, duplication/tampering indicators, and package-specific evidence requirements.

Claude output is evidence, not finance authority. Final states are `verified`, `rejected`, or `review_required`. Money release remains separately governed.

## 5. Capability Suite C — Autonomous Voice Dispatch

Reuse PawSpace's provider-neutral telephony boundary and existing Exotel support. A future Twilio adapter implements the same interface.

```text
Head of Ops
    |
ops.voice.dispatch
    |
Atlas Gateway
    |
Validate active booking
Validate assigned provider
Validate incident trigger
Validate contact policy
Validate call frequency
Validate voice kill switch
    |
TelephonyProvider
   /        \
Exotel     Twilio
   \        /
 AgentStream / Media Stream
        |
 Voice AI Runtime
```

The AI MUST NOT supply a phone number. It supplies only a booking and reason code; Atlas resolves the active booking, currently assigned provider, governed contact, and approved carrier.

Example allowed input:

```json
{
  "bookingId": "BK-123",
  "reasonCode": "provider_late_checkin"
}
```

Example late-Walker flow:

```text
Walker check-in expected 09:00
        ↓
No check-in
        ↓
09:15 threshold reached
        ↓
Ops signal
        ↓
Head of Ops
        ↓
ops.voice.dispatch
        ↓
Server independently confirms lateness
        ↓
Exotel call
```

This tool is operational only and must not become a marketing dialler.

## 6. Capability Suite D — Dynamic Yield Management

Build on PawSpace's existing surge engine. Preserve its stale-signal fail-safe and extreme-weather safety suspension. Wrap it with GCE budget authority, Founder yield policy, finance margin validation, and provider incentive calculation.

```text
                HEAD OF OPS
                     |
        +------------+------------+
        |            |            |
     Demand       Weather      Capacity
        |            |            |
        +------------+------------+
                     |
              ops_yield_signals
                     |
                     v
                 HEAD FINANCE
                     |
         finance.yield.calculate_surge
                     |
         +-----------+------------+
         |                        |
 Customer multiplier      Provider bonus
         |                        |
         +-----------+------------+
                     |
              ATLAS PHYSICS
                     |
          +----------+----------+
          |          |          |
      GCE budget   Margin     Founder
      envelope     floor      ceiling
          |          |          |
          +----------+----------+
                     |
               Yield Decision
```

AI proposals are advisory. Atlas computes the applied customer multiplier as the minimum of AI proposal, signal-derived recommendation, service hard cap, and Founder policy cap.

Provider bonus is limited by requested bonus, Founder bonus ceiling, GCE budget remaining, and available margin headroom. Margin headroom is calculated only from canonical customer price, provider payout, GST, Razorpay fees, governed variable cost, and mandatory margin floor.

Extreme weather behavior:

```text
availability = suspended_for_safety
customer surge = 0
provider bonus = 0
```

Stale signal behavior:

```text
customer multiplier = 1.00x
provider bonus = 0
status = neutral_fallback
```

Missing Founder-approved GCE budget behavior: `policy_blocked`. There is no silent default budget.

## 7. Exact Phase 2 D1 Migration (DESIGN ONLY — DO NOT EXECUTE YET)

Recommended migration path: `drizzle/0034_phase2_sensory_capabilities.sql`.

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS atlas_tool_execution_context (
  request_id TEXT PRIMARY KEY,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('human','agent','system')),
  vertical_head TEXT CHECK(vertical_head IS NULL OR vertical_head IN ('sales','ops','finance','escalation','hr')),
  caller_agent_id TEXT,
  gce_goal_id TEXT,
  gce_budget_envelope_id TEXT,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(request_id) REFERENCES ai_tool_execution_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS atlas_execution_context_correlation_idx ON atlas_tool_execution_context(correlation_id, created_at);

CREATE TABLE IF NOT EXISTS atlas_vector_memories (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pet_id TEXT,
  memory_type TEXT NOT NULL CHECK(memory_type IN ('behavior','preference','safety','service_instruction','household_context')),
  sensitivity TEXT NOT NULL DEFAULT 'standard' CHECK(sensitivity IN ('standard','restricted')),
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  wrapped_dek_b64 TEXT NOT NULL,
  encryption_key_version TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  vector_id TEXT NOT NULL UNIQUE,
  vector_namespace TEXT NOT NULL,
  embedding_model TEXT NOT NULL,
  embedding_dimensions INTEGER NOT NULL CHECK(embedding_dimensions > 0),
  embedding_version TEXT NOT NULL,
  vector_sync_status TEXT NOT NULL DEFAULT 'pending' CHECK(vector_sync_status IN ('pending','ready','failed','delete_pending')),
  source_type TEXT NOT NULL,
  source_ref TEXT,
  source_channel TEXT,
  service_code TEXT,
  city_id TEXT,
  confidence REAL NOT NULL DEFAULT 1.0 CHECK(confidence >= 0 AND confidence <= 1),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded','revoked')),
  valid_from INTEGER NOT NULL,
  expires_at INTEGER,
  supersedes_memory_id TEXT,
  created_by_actor TEXT NOT NULL,
  created_by_mode TEXT NOT NULL CHECK(created_by_mode IN ('human','agent','system')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK(expires_at IS NULL OR expires_at > valid_from),
  FOREIGN KEY(supersedes_memory_id) REFERENCES atlas_vector_memories(id)
);
CREATE INDEX IF NOT EXISTS atlas_vector_memories_customer_pet_idx ON atlas_vector_memories(customer_id,pet_id,status,expires_at);
CREATE INDEX IF NOT EXISTS atlas_vector_memories_sync_idx ON atlas_vector_memories(vector_sync_status,updated_at);

CREATE TABLE IF NOT EXISTS atlas_vector_sync_outbox (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('upsert','delete')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','completed','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  next_attempt_at INTEGER,
  leased_until INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(memory_id) REFERENCES atlas_vector_memories(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS atlas_vector_sync_pending_unique_idx ON atlas_vector_sync_outbox(memory_id, operation) WHERE status IN ('pending','processing');

CREATE TABLE IF NOT EXISTS atlas_secure_context_facts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pet_id TEXT,
  booking_id TEXT,
  fact_type TEXT NOT NULL CHECK(fact_type IN ('gate_code','lockbox_code','access_instruction','credential_like')),
  scope_type TEXT NOT NULL CHECK(scope_type IN ('customer','property','booking')),
  scope_id TEXT NOT NULL,
  ciphertext_b64 TEXT NOT NULL,
  iv_b64 TEXT NOT NULL,
  wrapped_dek_b64 TEXT NOT NULL,
  encryption_key_version TEXT NOT NULL,
  blind_hash TEXT NOT NULL,
  reveal_policy TEXT NOT NULL CHECK(reveal_policy IN ('provider_dispatch_only','ops_only')),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','revoked','expired')),
  expires_at INTEGER NOT NULL,
  created_by_actor TEXT NOT NULL,
  created_by_mode TEXT NOT NULL CHECK(created_by_mode IN ('human','agent','system')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS atlas_secure_context_scope_idx ON atlas_secure_context_facts(customer_id,booking_id,status,expires_at);

CREATE TABLE IF NOT EXISTS atlas_memory_access_events (
  id TEXT PRIMARY KEY,
  object_kind TEXT NOT NULL CHECK(object_kind IN ('vector_memory','secure_fact')),
  object_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('store','retrieve','reveal','revoke')),
  purpose TEXT NOT NULL CHECK(purpose IN ('customer_interaction','provider_dispatch','case_resolution','sales_followup','ops_review')),
  booking_id TEXT,
  actor_id TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('human','agent','system')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS atlas_memory_access_object_idx ON atlas_memory_access_events(object_kind,object_id,created_at);

CREATE TABLE IF NOT EXISTS atlas_vision_jobs (
  id TEXT PRIMARY KEY,
  tool_code TEXT NOT NULL CHECK(tool_code IN ('vision.document.parse','vision.qa.verify')),
  purpose TEXT NOT NULL CHECK(purpose IN ('vaccination_document','service_completion')),
  customer_id TEXT,
  pet_id TEXT,
  booking_id TEXT,
  provider_id TEXT,
  source_asset_ids_json TEXT NOT NULL,
  model_provider TEXT NOT NULL,
  model_name TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  output_schema_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('processing','verified','rejected','review_required','failed')),
  decision TEXT,
  confidence REAL CHECK(confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  result_json TEXT,
  provider_request_id TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_by_actor TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('human','agent','system')),
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS atlas_vision_jobs_booking_idx ON atlas_vision_jobs(booking_id,tool_code,created_at);

CREATE TABLE IF NOT EXISTS crm_pet_vaccinations (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  pet_id TEXT NOT NULL,
  vaccine_name TEXT NOT NULL,
  administered_on TEXT,
  expires_on TEXT,
  validity_status TEXT NOT NULL CHECK(validity_status IN ('valid','expired','unknown')),
  source_asset_id TEXT NOT NULL,
  vision_job_id TEXT,
  extraction_confidence REAL NOT NULL CHECK(extraction_confidence >= 0 AND extraction_confidence <= 1),
  verification_status TEXT NOT NULL CHECK(verification_status IN ('auto_verified','human_verified')),
  verified_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(vision_job_id) REFERENCES atlas_vision_jobs(id)
);
CREATE INDEX IF NOT EXISTS crm_pet_vaccinations_pet_expiry_idx ON crm_pet_vaccinations(pet_id,expires_on);

CREATE TABLE IF NOT EXISTS service_completion_visual_verification (
  booking_id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'awaiting_visual_verification',
  before_media_id TEXT,
  after_media_id TEXT,
  vision_provider TEXT,
  vision_reference TEXT,
  score REAL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS atlas_vision_qa_findings (
  id TEXT PRIMARY KEY,
  vision_job_id TEXT NOT NULL,
  booking_id TEXT NOT NULL,
  finding_code TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('info','warning','critical')),
  passed INTEGER NOT NULL CHECK(passed IN (0,1)),
  confidence REAL NOT NULL CHECK(confidence >= 0 AND confidence <= 1),
  evidence_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  FOREIGN KEY(vision_job_id) REFERENCES atlas_vision_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ops_voice_dispatches (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  reason_code TEXT NOT NULL CHECK(reason_code IN ('provider_late_checkin','provider_no_show_risk','urgent_route_change','customer_access_issue')),
  trigger_snapshot_json TEXT NOT NULL,
  transport_provider TEXT,
  provider_call_id TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','dialing','ringing','connected','completed','no_answer','busy','failed','policy_blocked')),
  policy_decision TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('human','agent','system')),
  requested_by_actor TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS ops_voice_dispatch_booking_idx ON ops_voice_dispatches(booking_id,status,created_at);

CREATE TABLE IF NOT EXISTS ops_yield_signals (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL,
  city_id TEXT NOT NULL,
  service_code TEXT NOT NULL,
  signal_type TEXT NOT NULL CHECK(signal_type IN ('demand','weather','capacity','supply_drop')),
  payload_json TEXT NOT NULL,
  source_system TEXT NOT NULL,
  observed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  verification_status TEXT NOT NULL CHECK(verification_status IN ('verified','rejected')),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_yield_signals_latest_idx ON ops_yield_signals(zone_id,service_code,signal_type,observed_at DESC);

CREATE TABLE IF NOT EXISTS finance_yield_policies (
  id TEXT PRIMARY KEY,
  service_code TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK(version > 0),
  status TEXT NOT NULL CHECK(status IN ('draft','active','retired')),
  max_customer_multiplier_bps INTEGER NOT NULL CHECK(max_customer_multiplier_bps >= 10000 AND max_customer_multiplier_bps <= 30000),
  max_provider_bonus_bps INTEGER NOT NULL CHECK(max_provider_bonus_bps >= 0 AND max_provider_bonus_bps <= 10000),
  require_bonus_budget_for_customer_surge INTEGER NOT NULL DEFAULT 1 CHECK(require_bonus_budget_for_customer_surge IN (0,1)),
  decision_ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK(decision_ttl_seconds >= 60 AND decision_ttl_seconds <= 900),
  gce_budget_envelope_id TEXT NOT NULL,
  effective_from INTEGER NOT NULL,
  effective_to INTEGER,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(service_code,zone_id,version),
  FOREIGN KEY(gce_budget_envelope_id) REFERENCES gce_budget_envelopes(id)
);

CREATE TABLE IF NOT EXISTS finance_yield_decisions (
  id TEXT PRIMARY KEY,
  service_code TEXT NOT NULL,
  city_id TEXT NOT NULL,
  zone_id TEXT NOT NULL,
  policy_id TEXT NOT NULL,
  gce_budget_envelope_id TEXT NOT NULL,
  signal_snapshot_json TEXT NOT NULL,
  base_price_paise INTEGER NOT NULL CHECK(base_price_paise >= 0),
  proposed_customer_multiplier_bps INTEGER NOT NULL,
  applied_customer_multiplier_bps INTEGER NOT NULL,
  quoted_price_paise INTEGER NOT NULL CHECK(quoted_price_paise >= 0),
  proposed_provider_bonus_bps INTEGER NOT NULL,
  applied_provider_bonus_bps INTEGER NOT NULL,
  provider_bonus_paise INTEGER NOT NULL CHECK(provider_bonus_paise >= 0),
  projected_margin_paise INTEGER NOT NULL,
  projected_margin_bps INTEGER NOT NULL,
  required_margin_paise INTEGER NOT NULL,
  budget_reserved_paise INTEGER NOT NULL CHECK(budget_reserved_paise >= 0),
  decision TEXT NOT NULL CHECK(decision IN ('applied','clamped','neutral_fallback','suspended_for_safety','policy_blocked')),
  reason_codes_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  valid_until INTEGER NOT NULL,
  created_by_actor TEXT NOT NULL,
  source_mode TEXT NOT NULL CHECK(source_mode IN ('human','agent','system')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(policy_id) REFERENCES finance_yield_policies(id),
  FOREIGN KEY(gce_budget_envelope_id) REFERENCES gce_budget_envelopes(id)
);
CREATE INDEX IF NOT EXISTS finance_yield_decisions_active_idx ON finance_yield_decisions(zone_id,service_code,valid_until);

CREATE TABLE IF NOT EXISTS finance_yield_budget_reservations (
  id TEXT PRIMARY KEY,
  yield_decision_id TEXT NOT NULL UNIQUE,
  gce_budget_envelope_id TEXT NOT NULL,
  amount_paise INTEGER NOT NULL CHECK(amount_paise >= 0),
  status TEXT NOT NULL CHECK(status IN ('reserved','committed','released')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY(yield_decision_id) REFERENCES finance_yield_decisions(id),
  FOREIGN KEY(gce_budget_envelope_id) REFERENCES gce_budget_envelopes(id)
);
```

**Phase 1 dependency:** `gce_budget_envelopes` must exist before this migration is activated. If the GCE migration is not yet in the target branch, Phase 2 must be stacked behind Phase 1 rather than inventing another budget source.

## 8. Atlas Invocation Envelope

Gateway-owned metadata:

```json
{
  "requestId": "AITREQ-...",
  "sourceMode": "agent",
  "actorId": "atlas-head-ops",
  "verticalHead": "ops",
  "channel": "voice",
  "idempotencyKey": "ops-voice:BK-123:late-checkin:20260911",
  "correlationId": "CORR-...",
  "gceGoalId": "GCE-GOAL-...",
  "gceBudgetEnvelopeId": "GCE-BUDGET-..."
}
```

Human UI calls set `sourceMode=human`; agent calls set `sourceMode=agent`. Everything below the gateway is identical.

## 9. Exact Atlas Tool Schemas

### 9.1 `memory.vector.store`

```json
{
  "code": "memory.vector.store",
  "mode": "mutation",
  "canonicalService": "atlas-vector-memory",
  "intents": ["memory_context"],
  "channels": ["whatsapp", "chat", "voice"],
  "confirmationRequired": false,
  "idempotencyRequired": true,
  "staffPermissions": ["customers.manage"],
  "description": "Persist durable customer or pet behavioral context. Credential-like content is automatically diverted to encrypted secure context and is never vectorized.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "customerId": {"type": "string", "minLength": 1, "maxLength": 128},
      "petId": {"type": ["string", "null"], "maxLength": 128},
      "memoryType": {"type": "string", "enum": ["behavior","preference","safety","service_instruction","household_context"]},
      "content": {"type": "string", "minLength": 1, "maxLength": 2000},
      "serviceCode": {"type": ["string", "null"], "maxLength": 64},
      "cityId": {"type": ["string", "null"], "maxLength": 64},
      "expiresAt": {"type": ["integer", "null"], "minimum": 0},
      "confidence": {"type": "number", "minimum": 0, "maximum": 1},
      "sourceRef": {"type": ["string", "null"], "maxLength": 256}
    },
    "required": ["customerId","petId","memoryType","content","serviceCode","cityId","expiresAt","confidence","sourceRef"]
  },
  "outputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "memoryId": {"type": "string"},
      "storageClass": {"type": "string", "enum": ["vector_memory","secure_fact"]},
      "indexed": {"type": "boolean"},
      "status": {"type": "string", "enum": ["stored","pending_index"]}
    },
    "required": ["memoryId","storageClass","indexed","status"]
  }
}
```

### 9.2 `memory.vector.retrieve`

```json
{
  "code": "memory.vector.retrieve",
  "mode": "read",
  "canonicalService": "atlas-vector-memory",
  "intents": ["memory_context"],
  "channels": ["whatsapp", "chat", "voice"],
  "confirmationRequired": false,
  "idempotencyRequired": false,
  "staffPermissions": ["customers.manage"],
  "description": "Retrieve semantically relevant authorized customer or pet context. Secure access credentials are never returned into LLM context.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "customerId": {"type": "string", "minLength": 1, "maxLength": 128},
      "petId": {"type": ["string", "null"], "maxLength": 128},
      "query": {"type": "string", "minLength": 1, "maxLength": 1000},
      "purpose": {"type": "string", "enum": ["customer_interaction","provider_dispatch","case_resolution","sales_followup","ops_review"]},
      "bookingId": {"type": ["string", "null"], "maxLength": 128},
      "topK": {"type": "integer", "minimum": 1, "maximum": 5}
    },
    "required": ["customerId","petId","query","purpose","bookingId","topK"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "results": {"type": "array", "maxItems": 5, "items": {"type": "object", "properties": {"memoryId":{"type":"string"},"memoryType":{"type":"string"},"content":{"type":"string"},"semanticScore":{"type":"number"},"confidence":{"type":"number"},"expiresAt":{"type":["integer","null"]}}, "required": ["memoryId","memoryType","content","semanticScore","confidence","expiresAt"]}},
      "secureContextAvailable": {"type": "boolean"}
    },
    "required": ["results","secureContextAvailable"]
  }
}
```

### 9.3 `vision.document.parse`

```json
{
  "code": "vision.document.parse",
  "mode": "mutation",
  "canonicalService": "atlas-vision-document",
  "intents": ["document_verification"],
  "channels": ["chat"],
  "confirmationRequired": false,
  "idempotencyRequired": true,
  "staffPermissions": ["customers.manage","people.manage"],
  "description": "Parse an authorized PawSpace media asset as a pet vaccination booklet and conditionally update canonical CRM vaccination facts after deterministic validation.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "customerId": {"type": "string", "minLength": 1, "maxLength": 128},
      "petId": {"type": "string", "minLength": 1, "maxLength": 128},
      "documentAssetId": {"type": "string", "minLength": 1, "maxLength": 128},
      "documentType": {"type": "string", "enum": ["pet_vaccination_booklet"]}
    },
    "required": ["customerId","petId","documentAssetId","documentType"]
  },
  "outputSchema": {
    "type": "object",
    "properties": {
      "visionJobId": {"type": "string"},
      "decision": {"type": "string", "enum": ["applied","review_required","rejected"]},
      "vaccinations": {"type": "array", "items": {"type": "object", "properties": {"name":{"type":"string"},"administeredOn":{"type":["string","null"]},"expiresOn":{"type":["string","null"]},"confidence":{"type":"number","minimum":0,"maximum":1}}, "required": ["name","administeredOn","expiresOn","confidence"]}},
      "canonicalRecordsUpdated": {"type": "integer", "minimum": 0}
    },
    "required": ["visionJobId","decision","vaccinations","canonicalRecordsUpdated"]
  }
}
```

### 9.4 `vision.qa.verify`

```json
{
  "code": "vision.qa.verify",
  "mode": "mutation",
  "canonicalService": "service-completion-finance",
  "intents": ["quality_verification"],
  "channels": ["chat"],
  "confirmationRequired": false,
  "idempotencyRequired": true,
  "staffPermissions": ["grooming.manage","providers.manage"],
  "description": "Evaluate canonical approved before/after completion media for a booking and resolve the existing visual-completion gate without releasing money.",
  "inputSchema": {"type":"object","additionalProperties":false,"properties":{"bookingId":{"type":"string","minLength":1,"maxLength":128}},"required":["bookingId"]},
  "outputSchema": {
    "type": "object",
    "properties": {
      "visionJobId": {"type":"string"},
      "bookingId": {"type":"string"},
      "decision": {"type":"string","enum":["verified","rejected","review_required"]},
      "score": {"type":"number","minimum":0,"maximum":1},
      "financeGate": {"type":"string","enum":["eligible","blocked","awaiting_review"]},
      "findings": {"type":"array","items":{"type":"object","properties":{"code":{"type":"string"},"severity":{"type":"string","enum":["info","warning","critical"]},"passed":{"type":"boolean"},"confidence":{"type":"number","minimum":0,"maximum":1}},"required":["code","severity","passed","confidence"]}}
    },
    "required": ["visionJobId","bookingId","decision","score","financeGate","findings"]
  }
}
```

### 9.5 `ops.voice.dispatch`

```json
{
  "code": "ops.voice.dispatch",
  "mode": "mutation",
  "canonicalService": "voice-telephony-provider",
  "intents": ["ops_dispatch"],
  "channels": ["chat","voice"],
  "confirmationRequired": false,
  "idempotencyRequired": true,
  "staffPermissions": ["communications.call"],
  "description": "Place a policy-bounded operational voice call to the provider currently assigned to an active booking. The caller cannot supply a telephone number.",
  "inputSchema": {
    "type": "object",
    "additionalProperties": false,
    "properties": {
      "bookingId": {"type":"string","minLength":1,"maxLength":128},
      "reasonCode": {"type":"string","enum":["provider_late_checkin","provider_no_show_risk","urgent_route_change","customer_access_issue"]},
      "incidentCaseId": {"type":["string","null"],"maxLength":128},
      "language": {"type":"string","enum":["auto","en-IN","hi-IN","kn-IN","ta-IN","te-IN"]}
    },
    "required": ["bookingId","reasonCode","incidentCaseId","language"]
  },
  "outputSchema": {
    "type":"object",
    "properties": {
      "dispatchId":{"type":"string"},
      "callRef":{"type":"string"},
      "providerCallId":{"type":["string","null"]},
      "transportProvider":{"type":"string"},
      "status":{"type":"string","enum":["queued","dialing","policy_blocked"]},
      "policyDecision":{"type":"string"}
    },
    "required": ["dispatchId","callRef","providerCallId","transportProvider","status","policyDecision"]
  }
}
```

### 9.6 `finance.yield.calculate_surge`

```json
{
  "code": "finance.yield.calculate_surge",
  "mode": "mutation",
  "canonicalService": "finance-yield-management",
  "intents": ["yield_management"],
  "channels": ["chat"],
  "confirmationRequired": false,
  "idempotencyRequired": true,
  "staffPermissions": ["finance.manage"],
  "description": "Calculate and persist a short-lived dynamic-yield decision using server-owned demand, weather, capacity, commercial, GCE-budget and margin data. AI proposals are ceilings requested, never authoritative prices or payouts.",
  "inputSchema": {
    "type":"object",
    "additionalProperties":false,
    "properties": {
      "serviceCode":{"type":"string","minLength":1,"maxLength":64},
      "zoneId":{"type":"string","minLength":1,"maxLength":64},
      "objective":{"type":"string","enum":["balance_demand","restore_supply","weather_pressure"]},
      "proposedCustomerMultiplierBps":{"type":["integer","null"],"minimum":10000,"maximum":30000},
      "proposedProviderBonusBps":{"type":["integer","null"],"minimum":0,"maximum":10000}
    },
    "required": ["serviceCode","zoneId","objective","proposedCustomerMultiplierBps","proposedProviderBonusBps"]
  },
  "outputSchema": {
    "type":"object",
    "properties": {
      "yieldDecisionId":{"type":"string"},
      "decision":{"type":"string","enum":["applied","clamped","neutral_fallback","suspended_for_safety","policy_blocked"]},
      "basePricePaise":{"type":"integer"},
      "quotedPricePaise":{"type":"integer"},
      "recommendedCustomerMultiplierBps":{"type":"integer"},
      "appliedCustomerMultiplierBps":{"type":"integer"},
      "appliedProviderBonusBps":{"type":"integer"},
      "providerBonusPaise":{"type":"integer"},
      "projectedMarginBps":{"type":"integer"},
      "requiredMarginPaise":{"type":"integer"},
      "gceBudgetEnvelopeId":{"type":"string"},
      "budgetReservedPaise":{"type":"integer"},
      "reasonCodes":{"type":"array","items":{"type":"string"}},
      "validUntil":{"type":"integer"}
    },
    "required": ["yieldDecisionId","decision","basePricePaise","quotedPricePaise","recommendedCustomerMultiplierBps","appliedCustomerMultiplierBps","appliedProviderBonusBps","providerBonusPaise","projectedMarginBps","requiredMarginPaise","gceBudgetEnvelopeId","budgetReservedPaise","reasonCodes","validUntil"]
  }
}
```

## 10. Vertical Head Capability Matrix

| Vertical Head | New capabilities |
|---|---|
| Sales | `memory.vector.store`, `memory.vector.retrieve` |
| Ops | memory store/retrieve, `vision.document.parse`, `vision.qa.verify`, `ops.voice.dispatch` |
| Escalation | memory store/retrieve |
| HR | controlled `vision.document.parse` |
| Finance | `finance.yield.calculate_surge` |
| Founder / Human Staff | same tools through corresponding RBAC permissions |

Agent identity is established by Atlas authentication. A model cannot self-assert a role and gain permissions.

## 11. Required Control-Plane Extension

```ts
export const AUTONOMOUS_BOUNDED_MUTATIONS = new Set<AiToolCode>([
  "memory.vector.store",
  "vision.document.parse",
  "vision.qa.verify",
  "ops.voice.dispatch",
  "finance.yield.calculate_surge"
]);
```

Execution classes:

```text
READ
  -> authorization

CONFIRMABLE SAFE MUTATION
  -> authorization
  -> confirmation
  -> idempotency
  -> canonical service

AUTONOMOUS BOUNDED MUTATION
  -> authorization
  -> deterministic policy proof
  -> idempotency
  -> canonical service

APPROVAL-GATED
  -> human/governed approval remains mandatory
```

## 12. Required Runtime Integration

Sales runtime retrieves customer/pet memory before substantive interaction and stores only high-confidence durable behavioral facts. Greetings, transient requests, and speculation are not stored.

Ops dispatch retrieves `provider_dispatch` memory before assignment/provider instructions. Safe examples include behavioral and service instructions. Access secrets are attached only at the secure dispatch boundary and never entered into LLM context.

Escalation retrieves prior preferences, incidents, and behavioral context before case handling so customers do not repeatedly explain the same operational facts.

## 13. Failure Modes

All four suites are fail-closed:

- **Vectorize unavailable:** authoritative D1 record remains; sync is pending/failed; retrieval does not invent memory.
- **Claude unavailable:** Vision job becomes `review_required`; CRM is not auto-updated; completion finance remains blocked.
- **Exotel/Twilio unavailable:** dispatch becomes failed; no fake completed-call state.
- **Weather/capacity stale:** multiplier = `1.00x`, provider bonus = `0`.
- **Budget authority unavailable:** yield = `policy_blocked`.
- **Margin validator failure:** yield = `policy_blocked`; no pricing decision published.

## 14. Required P0 Certification Tests

### Memory
- Customer A can never retrieve Customer B vectors.
- Pet filtering is enforced before semantic result use.
- Revoked/expired memories never return.
- Gate codes never enter Vectorize.
- D1/Vectorize partial-failure recovery is idempotent.
- Repeated stores do not duplicate durable facts.

### Vision
- Model cannot choose arbitrary image URL.
- Wrong customer's media is denied.
- Malformed vaccination dates do not update CRM.
- Low-confidence extraction becomes review.
- Missing before/after photo blocks QA.
- Uncertain QA keeps finance blocked.
- Vision success does not invoke `payout.release`.

### Voice
- AI cannot provide arbitrary phone number.
- Provider must belong to booking.
- Fifteen-minute late trigger is independently verified.
- Duplicate dispatch key generates only one call.
- Voice emergency switch stops outbound call.
- Provider webhook verification remains admitted.
- Operational dispatch cannot become marketing.

### Yield
- Stale data produces exactly `1.00x`.
- Extreme weather suspends service.
- Proposal greater than service cap is clamped.
- Proposal greater than Founder cap is clamped.
- Provider bonus cannot exceed GCE remaining budget.
- Provider bonus cannot breach margin floor.
- Simultaneous yield requests cannot overspend one envelope.
- Expired yield decisions cannot affect a quote.
- AI cannot submit base price or provider payout.
- `price.override` remains approval-gated.
- `payout.release` remains approval-gated.

## 15. Final Phase 2 Architecture

```text
                         FOUNDER
                           |
                  Goal & Context Engine
                           |
      +--------------------+--------------------+
      |                    |                    |
    SALES                 OPS                FINANCE
      |                    |                    |
 Vector Memory       Vector Memory          Yield
                     Vision QC
                     Voice Dispatch
                           |
                      ESCALATION
                           |
                     Vector Memory
```

The intended operating model is:

```text
AI THINKS
AI OBSERVES
AI REMEMBERS
AI RECOMMENDS
AI CAN EXECUTE BOUNDED OPERATIONS

BUT

ATLAS AUTHORIZES
GCE LIMITS
CANONICAL SERVICES DECIDE
FINANCE PHYSICS ENFORCES
FOUNDER CONTROLS THE CEILING
AUDIT RECORDS EVERYTHING
```

Phase 2 is therefore architecturally frozen but deliberately held behind Phase 1. **Do not execute `0034` until Phase 1 `gce_budget_envelopes` is merged, migrated, and live.**
