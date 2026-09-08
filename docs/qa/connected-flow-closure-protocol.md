# Connected-flow closure protocol

This is the controlling acceptance standard for the master QA audit. Module tests and screen checks are supporting evidence; they cannot independently close a flow.

Every flow must be traced through:

**Frontend → API → validation/business logic → DB transaction → event/webhook → notification → admin visibility → ledger/finance → analytics → failure/recovery.**

## Required evidence for every flow

| Stage | Required proof |
|---|---|
| Frontend | Real user action, identity/role, input and displayed result. Exercise loading, refusal, failure and retry states. A source scan is traceability only, not browser execution. |
| API | The actual request/response from that action, including authorization, ownership, input validation and duplicate submission behavior. Calling a library directly does not prove this boundary. |
| Business logic | Expected state transition and versioned/configured policy, including refusal cases and concurrent changes. Record the actual approved values; do not silently activate draft policies. |
| DB transaction | Inspect the resulting records and links. Inject a failure between writes, prove rollback, then retry and prove exactly one logical result. The test adapter must implement transactions. |
| Event/webhook | Trace the committed event to its consumer using booking/payment/customer/message IDs. Test invalid signatures where applicable, redelivery, out-of-order events and interruption after commit. |
| Notification | Verify recipient, consent, quiet hours, caps, template, outbox, delivery status and retry/DLQ behavior. Queued is not delivered. A simulated provider response must be labeled. |
| Admin visibility | Read the actual staff endpoint and UI under the intended role. Confirm the same entity, current status, context, ownership, SLA and actionable errors. A row existing in a different table is insufficient. |
| Ledger/finance | Reconcile booking/payment/refund/custody/invoice/points as applicable, using exact monetary units. Prove replay cannot duplicate financial effects. For a non-financial flow, verify that financial records remain unchanged rather than silently skipping this stage. |
| Analytics | Read the real reporting path and reconcile counts, statuses and money to the authoritative records. Check duplicate events, cancellation and refund treatment. |
| Failure/recovery | Demonstrate where the failure is visible, who or what retries, and how consistency is restored. Cover network timeout, rejected provider response, database failure, duplicate action and interrupted processing where relevant. |

Each flow record must include its source commit, runtime, policy version, test identity, inputs, expected result, correlation IDs, artifacts at each stage, fault injected, recovery result and remaining gaps. Do not put credentials or customer personal data in evidence artifacts.

Use these stage labels: **executed**, **simulated boundary**, **source traced only**, **blocked**, **not verified**, or **not applicable with proof**. A flow is **closed** only when all required stages have execution evidence and recovery is demonstrated. Missing stages keep the flow open regardless of aggregate test pass percentage.

## Flow inventory for sequential execution

| Flow | Connected scenario |
|---|---|
| F01 WhatsApp | Inbound message/media → authenticated ingestion → conversation → automation/staff handoff → reply outbox → provider receipt → inbox/analytics → retry and opt-out. |
| F02 Booking chat | Customer booking → validated reservation/payment boundary → committed booking/conversation → provider notification → customer/provider exchange → offline support routing → staff override. |
| F03 CX handling | Incoming conversation → profile/booking linkage → assignment → staff reply/internal note → SLA escalation → staff visibility → reporting → reassignment/recovery. |
| F04 Lead intake | External source → webhook/authentication → deduplication/intent/score → lead and assignment → callback/notification → sales UI → conversion attribution → analytics → failed-source retry. |
| F05 Sales follow-up | New/untouched lead or missed call → SLA/cadence → action queue → message/call → response/callback/payment → sales/admin state → revenue attribution → suppression/recovery. |
| F06 Cross-sell | Pet/service history → eligibility/recommendation → suppression → offer/action → communication → accepted booking → collection/attribution → analytics → stale recommendation recovery. |
| F07 Win-back | Service-specific inactivity → approved policy → offer/points/discount authority → capped communication → returning booking → redemption/finance → campaign measurement → retries/suppression. |
| F08 Retention | Payment failure, complaint or subscription signal → real telemetry → risk score → governed intervention → communication/staff queue → retained/cancelled outcome → finance/analytics → recovery. |
| F09 Discovery | Customer location/date/pet filters → search API → policy/availability → selected quote/reservation → confirmed booking → notifications/ops → finance/analytics → stale-capacity recovery. |
| F10 Review recovery | Completed service → review UI/API → ownership/eligibility → review and low-rating case transaction → notification/escalation → provider/admin visibility → unchanged money unless a separate governed refund → reporting → rollback/retry. |
| F11 Complaint/refund | Complaint intake → case/priority/SLA → staff action → refund authority/ledger when applicable → customer notification → resolved/closed state → metrics → rejection/reopening/recovery. |
| F12 Admin change | Authorized CRUD/configuration UI → scoped API → validation/transaction/audit → affected downstream behavior → notification/operations → pricing/finance impact → analytics → conflict/rollback. Repeat for every requested entity. |
| F13 Operations | Booking/provider/payment event → live delivery → command center alerts → authorized operator action → lifecycle/notification → finance/reporting → reconnect, stale state and failed-action recovery. |

## Current evidence limitation

`tests/cross-module-journey-gate.test.mjs` explicitly creates bookings and simulated captures directly in its database. Its downstream checks remain useful, but it is **not** proof of frontend/API/webhook delivery. Its adapter now uses BEGIN/COMMIT/ROLLBACK, with an injected duplicate-write failure proving rollback and successful retry. Seven tests pass after this change.

The master report's open modules remain open. No module becomes closed merely because this protocol or the improved downstream test adapter exists. Initial connected-flow inspection also found that the Booking Command Center reads `customer_experience_tickets`, whereas newly created low-rating support cases are stored in `unified_cases`; that admin API visibility boundary is remediated by the connected review/support increment below; browser visibility and notification evidence remain open.

## Connected review/support increment

The customer Activity star control calls `/api/booking-rating`; configured service reviews use `/api/service-review`. Both are now exercised through their real route handlers with a customer session, then the real Booking Command Center handler with a staff identity, on the same transactional SQLite-backed D1 adapter.

| Boundary | Evidence in this increment |
|---|---|
| Customer frontend | Source traced to Activity's rating control. Load failure is now visible with retry. Browser execution still open. |
| API and validation | Both real POST handlers execute; authenticated ownership is used; duplicate submissions return 409. Customer access to the Operations read is refused. Full Worker gateway/browser transport is not exercised by these route-handler tests. |
| Transaction | Booking rating, provider score, recovery case and case audit event share a batch. An injected provider-score write failure rolls back the rating and case; retry succeeds. Service reviews retain their transaction coverage. |
| Event and recovery | Real case creation event, repeated SLA sweep with one escalation, resolve and close operations executed. |
| Notification | External notification delivery remains unverified; the case SLA sweep explicitly reports no automatic external notification. This stage is open. |
| Admin | Booking Command Center API returns the same case ID in its ticket feed, with priority and SLA projection. Browser rendering is open. |
| Customer visibility | Customer 360 open count includes the complaint and falls to zero after closure. |
| Finance | Booking payment rows and analytics money totals remain unchanged by rating/escalation/resolution. Gateway capture is fixture data, not a real provider transaction. |
| Analytics | Company CX open count reflects both ticket stores and reaches zero after case closure. Closed cases are no longer counted as open in Operations, customer counts or CX analytics. |

Validation: 117 selected tests passed; build/artifact validation and typecheck passed. The added customer-to-Operations authorization assertion is included in the final connected-flow rerun. This increment does not close the flow while browser, notification and deployed checks remain open.
