# PawSpace Integration Readiness Register

## Status

**Pre-live integration register. PRODUCTION READY = FALSE.**

This document separates five different states that must never be conflated:

1. **Code boundary exists** — adapter/API/webhook code is present.
2. **Sandbox configured** — non-production credentials are installed.
3. **Sandbox verified** — real provider sandbox traffic has passed end-to-end tests.
4. **Production configured** — production credentials/configuration exist but are not necessarily approved for traffic.
5. **Controlled-live verified** — production integration has passed a deliberately bounded live test with monitoring, reconciliation and rollback/kill-switch evidence.

A module is not production-ready merely because an environment variable exists or an adapter compiles.

## Required fields for every integration

Every external integration must track:

- integration ID
- business capability
- vendor/provider
- owner
- backup owner
- environment: none / sandbox / production
- code-boundary status
- credential status
- secret-storage location/reference (never raw secret in repo)
- inbound webhook/callback URL
- signature/auth verification
- outbound idempotency key strategy
- inbound replay/deduplication strategy
- retry policy
- dead-letter/failure queue
- timeout policy
- rate-limit handling
- reconciliation source
- monitoring/alerts
- audit/event logging
- data/privacy classification
- production kill switch
- last verified test date
- test evidence reference
- open blocker
- readiness state

Allowed readiness states:

- `not_started`
- `code_ready`
- `sandbox_setup_required`
- `sandbox_ready_for_test`
- `sandbox_verified`
- `production_setup_required`
- `production_ready_for_controlled_test`
- `controlled_live_verified`
- `blocked`
- `not_applicable`

Only `controlled_live_verified` is acceptable for a required production integration at public launch.

---

# Register

## INT-PAY-01 — Customer payment gateway

**Capability:** payment authorization/capture, payment status webhooks, refunds/reconciliation

**Current repo evidence:** Razorpay sandbox webhook code exists. It requires an event ID and signature, verifies the HMAC, hashes the payload, sends normalized events to the payment reconciliation engine and is explicitly locked to sandbox unless production launch approval changes the payment environment. The sandbox webhook secret is runtime configuration, not repository data.

**Current readiness:** `code_ready`

**Owner:** Finance + Engineering

**Required before sandbox verification:**
- sandbox account/keys/webhook secret
- sandbox callback registered with provider
- test booking/payment metadata includes canonical booking ID
- payment/refund webhook event matrix

**Mandatory tests:**
- valid signature accepted
- invalid signature rejected
- missing event ID rejected
- duplicate event does not double-apply money state
- out-of-order events do not corrupt booking/payment truth
- unknown booking is quarantined/unmatched, never silently attached
- partial/full refund reconciliation
- provider amount/currency matches canonical expectation
- webhook 5xx/retry path
- manual replay path
- reconciliation report from gateway -> booking payment -> Finance ledger

**Production blockers:** live keys, production webhook secret, approved payment/refund policy, controlled money test, alerting and Finance reconciliation sign-off.

---

## INT-PAY-02 — Provider/customer payouts

**Capability:** partner/provider payouts, approved refunds where gateway/API payout rail is required

**Current readiness:** `production_setup_required`

**Owner:** Finance

**Required architecture:**
- canonical payout instruction generated only from approved settlement/refund truth
- maker/checker approval
- outbound idempotency key
- provider payout reference
- callback/status polling
- failed/reversed payout handling
- beneficiary verification state
- reconciliation ledger
- kill switch

**Mandatory tests:** duplicate payout request, rejected beneficiary, provider timeout, provider accepts then callback is delayed, reversal/failure, reconciliation mismatch, period lock interaction.

No real payout may be sent during ordinary UAT.

---

## INT-COMMS-01 — WhatsApp

**Capability:** transactional and consented CRM messaging

**Expected provider boundary in current repo:** WATI credential readiness is already checked by the system integration control.

**Current readiness:** `sandbox_setup_required` until real credential/delivery evidence is recorded.

**Owner:** CRM/CX + Engineering

**Mandatory tests:**
- consent required for marketing outreach
- transactional template eligibility
- template/provider error surfaced
- delivery/read/failure status callback
- duplicate callback safe
- opt-out suppression
- quiet-hours/frequency caps where applicable
- retry/dead-letter
- thread/customer/booking linkage
- no raw provider/customer private number leakage across roles

**Kill switch:** disable outbound provider adapter while preserving queued canonical communication records.

---

## INT-COMMS-02 — SMS

**Capability:** OTP/transactional/status messaging where approved

**Current repo evidence:** runtime readiness checks exist for SMS API key and sender ID.

**Current readiness:** `sandbox_setup_required`

**Owner:** CRM/CX + Engineering

**Mandatory tests:** provider acceptance, delivery/failure callback if supported, invalid recipient, rate limit, retry, duplicate-send idempotency, consent/transactional classification, cost monitoring.

---

## INT-COMMS-03 — Email

**Capability:** invoices, receipts, service confirmations, support and permitted CRM

**Current readiness:** `not_started` / provider selection and adapter evidence required.

**Owner:** CRM/CX + Finance for statutory documents

**Mandatory tests:** template rendering, attachment/document access, bounce/complaint handling, unsubscribe/consent where applicable, retry, idempotency, SPF/DKIM/DMARC operational readiness when production domains are introduced.

---

## INT-COMMS-04 — Push notifications

**Capability:** customer/provider app push

**Current readiness:** `not_started`

**Owner:** Product + Engineering

**Mandatory tests:** device token lifecycle, expired token, duplicate notification prevention, deep-link authorization, user preference/consent, provider outage, observability.

---

## INT-VOICE-01 — Exotel / telephony

**Capability:** outbound/inbound calls, call records, provider callback events, recordings only where law/policy permits

**Current repo evidence:** the system integration control checks for Exotel API key, token and SID. Credential presence alone does not prove call tracking.

**Current readiness:** `sandbox_setup_required`

**Owner:** Sales/CX + Engineering

**Required canonical objects:**
- call attempt ID
- customer/lead/ticket reference
- agent identity
- masked/from/to references
- provider call SID/reference
- direction
- started/answered/ended timestamps
- disposition
- callback/webhook history
- recording metadata/access state when explicitly enabled
- consent/compliance status

**Mandatory tests:**
- click-to-call/outbound API
- inbound mapping
- no-answer/busy/failed
- provider callback replay
- call disposition required where workflow needs it
- recording inaccessible to unauthorized roles
- CRM activity linkage
- duplicate callbacks safe
- number masking and audit

**Production blockers:** approved recording/retention/consent policy, live number/configuration, webhook verification, monitored pilot.

---

## INT-MAPS-01 — Maps/geocoding/routing

**Capability:** addresses, geocoding, ETA, route/distance, service-zone decisions

**Current readiness:** `production_setup_required`

**Owner:** Operations + Engineering

**Required controls:**
- provider abstraction
- canonical address + lat/lng provenance
- geocode confidence
- route request ID
- cache policy
- service-zone/geofence version
- provider-error/degraded state
- cost/rate-limit monitoring
- kill switch / manual fallback

**Mandatory tests:** invalid address, ambiguous address, no route, rate limit, timeout, stale cached result, zone-boundary case, provider outage, route re-check before time-sensitive assignment.

Taxi-specific work remains out of the active implementation priority unless explicitly resumed.

---

## INT-GPS-01 — Provider location / GPS evidence

**Capability:** arrival/route/service evidence, late-provider detection and operational recovery

**Current readiness:** `production_setup_required`

**Owner:** Operations + Safety + Engineering

**Required controls:**
- consent/legal basis state
- session/booking ownership
- timestamp + accuracy
- source/provider/device trust state
- spoof/unverified state where applicable
- retention policy
- access control
- late/ETA event generation
- customer visibility rules
- outage/degraded workflow

UAT route samples must remain clearly marked non-production/unverified until a production location source is connected and proven.

---

## INT-MEDIA-01 — Private object storage

**Capability:** service media, incident evidence, invoice/payslip/document storage

**Current readiness:** `production_setup_required`

**Owner:** Engineering + Security

**Required controls:**
- private bucket/container
- opaque object IDs
- short-lived signed upload/download grants
- exact customer/booking/document ownership
- MIME/size/hash constraints
- encryption
- retention/deletion
- access audit
- backup/restore where required
- provider-level public-access prevention

**Mandatory tests:** unauthorized access, expired link, wrong booking/document binding, oversized/wrong MIME, revoked object, retention expiry, deleted customer/document workflow.

---

## INT-MEDIA-02 — Malware/content scanning

**Capability:** trust state for uploaded files/media

**Current readiness:** `production_setup_required`

**Owner:** Security + Engineering

**Required states:** pending -> clean / blocked / failed / quarantined.

An application user must never be allowed to self-mark its own upload as scanned/clean.

---

## INT-BANK-01 — Bank feed / reconciliation

**Capability:** settlement/bank transaction ingestion and Finance reconciliation

**Current repo state:** Finance is import-ready; live bank feed is not proven.

**Current readiness:** `production_setup_required`

**Owner:** Finance

**Mandatory tests:** duplicate transaction import, same amount/different reference, reversal, unmatched item, split/many-to-one matching, locked period, re-import idempotency, source checksum and reconciliation report.

---

## INT-ACCT-01 — Accounting platform

**Capability:** Tally / Zoho Books / selected production accounting target

**Current repo state:** export readiness exists; production connector acknowledgement is not proven.

**Current readiness:** `production_setup_required`

**Owner:** Finance + CA/Accounting

**Mandatory tests:** versioned mapping, balanced export, duplicate export/retry, rejected record, target acknowledgement, period totals, source-ID drilldown, reversal/credit note, no mutation of canonical Finance truth by external target.

See `GST_ACCOUNTING_UAT_SPEC.md`.

---

## INT-TAX-01 — GST/statutory filing boundary

**Capability:** statutory review/export or selected filing integration

**Current readiness:** `production_setup_required`

**Owner:** Finance + CA

No live filing is allowed merely because API credentials exist.

**Prerequisites:** approved legal entities/registrations, tax classifications, invoice/credit-note engine, tax ledger, Finance close, CA sign-off.

**Mandatory tests:** draft package, reconciliation, validation error, corrected superseding package, acknowledgement, duplicate filing prevention, kill switch/manual fallback.

---

## INT-MKT-01 — Google Ads

**Capability:** paid acquisition spend/campaign status/conversion attribution

**Current readiness:** `production_setup_required`

**Owner:** Marketing + Finance/Analytics

**Required controls:** campaign human approval, budget cap, account/customer ownership, conversion-ID mapping, spend ingestion, attribution timestamp/source, API quota handling, kill switch that prevents new spend/changes.

---

## INT-MKT-02 — Meta Ads

Same governance as Google Ads: no autonomous campaign activation or spend from AI/CRM automation; production credentials and controlled budget test required.

**Current readiness:** `production_setup_required`

---

## INT-ANALYTICS-01 — GA4 / web-app analytics

**Capability:** product/marketing event analytics

**Current readiness:** `production_setup_required`

**Owner:** Product + Marketing + Analytics

**Required controls:** event dictionary/version, consent/privacy rules, no sensitive PII in analytics payloads, canonical IDs via approved pseudonymous strategy, test/debug property, data-quality monitoring, attribution reconciliation.

---

## INT-AI-01 — External AI provider

**Capability:** governed assistance/summarisation/classification/suggestions

**Current platform contract:** external provider is not considered connected by default; autonomous refunds, pricing, payments, payouts, outbound contact, destructive customer merge, provider assignment and campaign activation remain prohibited.

**Current readiness:** `production_setup_required`

**Owner:** Product + Security + Engineering

**Required controls:**
- approved provider/model list
- minimum-necessary context builder
- sensitive-field policy
- retention/training policy
- prompt/model/version logging
- confidence/evaluation
- human review for governed actions
- timeout/fallback
- cost/rate limits
- safety evaluation
- kill switch

**Mandatory tests:** prompt injection/data exfiltration resistance, wrong-customer context denial, low-confidence review, provider outage, replay/idempotency for suggested tasks, audit reconstruction.

---

## INT-AUTH-01 — Production identity / access provisioning

**Capability:** employee/customer/provider identity, MFA/session/access lifecycle

**Current readiness:** `production_setup_required`

**Owner:** Security + Engineering

**Required controls:** joiner/mover/leaver, MFA for privileged roles, session expiry/revocation, role provisioning, founder protection, access review, break-glass audit, customer/provider ownership mapping.

---

## INT-OBS-01 — Monitoring / alerting / error tracking

**Capability:** detect production failures before customers/Finance discover them manually

**Current readiness:** `production_setup_required`

**Owner:** Engineering

Required coverage: API/server errors, webhook failures, queue/dead-letter growth, payment mismatches, communication failures, scheduler failures, latency, external-provider health, backup failures, authentication anomalies and controlled alert routing.

---

## INT-BACKUP-01 — Backup / restore

**Capability:** database/object/document recoverability

**Current readiness:** `production_setup_required`

**Owner:** Engineering + Security

Production readiness requires evidence of an actual restore rehearsal, not merely a configured backup schedule.

---

# Integration verification protocol

For each required integration before public launch:

### Stage 1 — Code contract
- adapter exists
- permissions and ownership are server-enforced
- secrets are environment-managed
- provider is not treated as canonical business truth

### Stage 2 — Sandbox setup
- real sandbox account/configuration
- callback/webhook endpoints registered
- credentials rotation owner recorded
- sandbox/live clearly separated

### Stage 3 — Sandbox verification
- positive flow
- invalid authentication/signature
- duplicate/replay
- out-of-order callback where relevant
- timeout
- provider 4xx/5xx
- rate limit
- retry/dead-letter
- reconciliation
- observability

### Stage 4 — Production setup review
- least-privilege production credentials
- correct production endpoint/domain
- alerting enabled
- kill switch tested
- rollback/fallback documented
- business owner approves controlled test

### Stage 5 — Controlled live verification
- minimum-risk bounded live transaction/event
- canonical system record captured
- provider record captured
- webhook/callback captured
- reconciliation successful
- customer/provider effect verified where applicable
- Finance/Security/Operations sign-off as required

Only after Stage 5 may a required integration be marked `controlled_live_verified`.

# Launch rule

A production launch readiness dashboard must consume this register's statuses (or their future database representation) and block approval when a P0 required integration is below its required stage.

**Credential presence is never enough. Code presence is never enough. A successful API response alone is never enough.**