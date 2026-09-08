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

## Support-notification increment — 9 September 2026

A connected failure was found after the review-to-case fix: the staff alert sweep enqueued `chat` notices, but the generic dispatcher dead-lettered that channel. The customer menu and header bell also displayed placeholder notifications. The two overdue-case templates now have an internal inbox delivery path; other unsupported transports retain their existing fail-closed behavior.

- The sweep links each notice to its case and booking. The dispatcher claims due work, rechecks policy, current service-update consent, case ownership/context and whether the breach remains actionable. Resolved, responded or otherwise stale notices are suppressed.
- Inbox availability, delivery event and outbox completion commit atomically. An injected delivery-event write failure rolls back availability; a retry delivers once. Internal delivery is reported separately and never claims an external send or customer read.
- The authenticated customer route exposes only delivered support notices and a safe field projection, with deterministic pagination. Queued, scheduled, suppressed and other customers' notices are excluded. The gateway routes to customer ownership checks.
- The account menu and header bell open the inbox. Fake counts were removed. The dialog has loading, empty, error, retry, pagination, request timeout and native modal focus handling.

| Stage | Evidence |
|---|---|
| Frontend → API → DB → case | Executed in the local app browser: sandbox OTP sign-in, Completed activity, one-star rating, visible success. The completed booking was directly seeded; no payment capture was attempted. |
| Case → notification → customer UI | The same local DB case was given a fixture overdue timestamp. Real staff-alert sweep and dispatcher functions were invoked locally: one queued notice, one internal delivery, zero external sends/errors. Reopening the real inbox rendered the notice for `B-QA-INBOX`. |
| Auth, gateway and recovery | The connected route suite executes real route and gateway policy code on transactional SQLite. It verifies wrong-owner/anonymous rejection, invalid cursor, rollback/retry, replay, opt-out after enqueue, stale resolved-case suppression, future scheduling and 52 same-timestamp records across two pages. |
| Browser failure | Stopping the local preview produced an error with a Retry control. Restarting Vite reloaded the page; successful retry without reload is not claimed. A standalone Playwright regression was added but could not launch because macOS denied the Chromium Mach port. Browser evidence above used the Codex app browser. |
| Admin, finance, analytics | The existing connected test continues through Operations case visibility, customer 360, case escalation/closure and CX counters. Payment rows and money totals remain unchanged. |
| Hosted execution | Open. No deployed scheduler cadence, external notification provider, load/reconnect or hosted payment-lock evidence. |

Validation: 62 selected tests passed with no failures or skips. Build/artifact validation and typecheck were rerun for the final source. These overlap previous selections and are not additive unique test counts. Previously dead-lettered notices are not automatically replayed by this change. General customer/provider chat, other notification types, real-time inbox refresh and external delivery remain open. A separate local request to `/api/order-notifications` returned 403 for the demo customer; that independent notification surface remains to be investigated.

## Order-notification access and acknowledgement increment

The separate `/api/order-notifications` 403 found during the local demo is fixed by explicitly routing to its customer ownership checks. GET no longer runs the platform-wide sweep; that sweep remains wired to the background scheduler. Customer responses omit internal payloads and transport errors. Unread counts cover the customer's full inbox, even when the response is limited. Read acknowledgements reject cross-origin requests and preserve the first read timestamp on retry. The UI now exposes load/read failures and retry controls instead of silently claiming an empty inbox.

Evidence: the real gateway policy, notification emitter, customer route and transactional SQLite adapter are exercised together. Tests verify duplicate event handling, customer isolation, anonymous rejection, cross-origin refusal, missing-notification 404, stable repeat acknowledgement, no GET-triggered messages/alerts, unread counts beyond the returned page and no payment writes. 18 selected tests passed; build/artifact validation and typecheck passed. The local app browser reused its sandbox customer session and opened the real order inbox without the earlier permission failure.

This closes the observed access/read-side-effect defects, not the complete order-notification flow. External delivery reconciliation, general chat transport, older-item UI pagination, sign-in changes without reload, all booking event sources and deployed scheduler evidence still require work. No live send or financial transaction was performed.

## Older order updates and sign-in recovery

The order inbox now uses a validated `(created_at, id)` cursor with a supporting customer index. Newer/older controls expose all pages rather than stranding older unread records behind the first 30 items. Reading an item refreshes the current page and preserves the first acknowledgement timestamp. Invalid limits/cursors return 400. Identity is rechecked after customer OTP completion, focus/visibility changes, storage invalidation and periodically; owner checks prevent delayed responses from updating a different customer's inbox. Requests have a ten-second timeout, and session invalidation clears prior customer state.

Evidence: 18 selected tests pass, now including cursor traversal, equal-timestamp ordering, acknowledgement during pagination, validation failures and the previous ownership/finance invariants. Build/artifact validation and typecheck pass. In the local browser, 32 directly seeded notices produced two pages; the oldest was acknowledged, the counter fell to 31, and Newer returned to the first page. The database showed the persisted read timestamp. After expiring only the local QA customer's session, the guest app hid the widget, and real sandbox OTP sign-in restored the widget and count without another reload.

A Playwright sign-in/paging UI regression was added with explicitly mocked notification responses; standalone execution remains unverified because the previously observed macOS browser-launch restriction persists. Adversarial delayed-response identity races, all sign-in clients, external transport and deployed scheduler behavior remain open. Browser pagination fixtures did not create outbox or finance writes.

## Order communication delivery and status reconciliation

Ordinary order updates previously queued `chat` messages that the dispatcher rejected as unsupported. The dispatcher now recognizes only chat messages linked by idempotency key, customer and booking/order to an existing order notification. It claims due work, rechecks policy and current service-update consent, then commits the message, delivery event, outbox completion and order delivery projection together. It reports internal delivery separately from external delivery and does not claim a customer read. Unrelated chat messages retain their existing boundary.

The worker also reconciles order-notification delivery status from canonical communication status, including external receipt transitions. A queued snapshot no longer persists indefinitely after delivery/retry/suppression. Booking creation wording now says recorded, rather than incorrectly claiming confirmation regardless of booking/payment state.

39 selected tests passed after restoring the loopback permission needed by the provider contract harness. The connected journey injects a notification-projection write failure, verifies rollback/no delivery event, retries once, verifies replay prevention, tests post-enqueue opt-out and simulated external receipt reconciliation, and asserts no payment writes. Build/artifact validation and typecheck passed. The external receipt is simulated and the provider contract uses a loopback server; no real recipient or live payment was contacted. Previous dead letters, general customer/provider chat, deployed transport, and complete all-service event coverage remain open.

## Provider-chat replay authorization

The provider send path returned earlier message content for an idempotency key before checking current assignment or Trust & Safety status. Retries now pass the same current assignment and suspension checks as new sends, and the stored key must belong to that provider's chat activity and conversation. A reassigned provider cannot recover prior content through a replay; a new provider cannot reuse another sender's key.

Provider send/read assignment lookups also distinguish a genuinely absent legacy table from database errors. Store failures stop access instead of falling back to potentially stale canonical booking ownership.

11 focused tests passed, covering valid replay without duplicate activity, reassignment, suspension, another sender's key, assignment-store failure and existing provider communication boundaries. Build/artifact validation and typecheck passed. This is service/route-source evidence, not a complete customer-provider browser journey. Booking-created conversation wiring, provider chat UI, offline routing, staff takeover, payload visibility and measured real-time behavior remain open. No payment or external communication was performed.


## Atomic AI-to-staff handoff

Handoff requests, staff takeover and explicit AI resume now commit handoff state, assignment history, canonical thread ownership/SLA, audit events and optional orchestrator session state in one D1 batch. A conditional event claims each transition; all related writes depend on that event, so concurrent contenders cannot overwrite the winner. Failed session writes propagate and roll back instead of being swallowed. Request retries validate the thread/customer pair before returning an existing handoff.

29 selected tests passed, including six new executed transaction tests using a serialized, rollback-capable SQLite D1 adapter. Faults injected at the final session update leave the entire prior ownership state intact; removing the fault permits retry. Concurrent request/takeover/resume tests verify one active handoff/assignment, one transition event and conflict responses for losing transitions. The orchestrator remains blocked while queued or staff-owned and can reply after explicit successful resume. Build/artifact validation and typecheck passed.

This provides service/database/orchestrator evidence. Staff browser controls, deployed D1 races, messages already in flight at takeover, provider presence routing, customer-provider UI and complete module readiness remain open. No external message or finance transaction was performed.


### Broader regression follow-through

The broader run found that booking complaint projections sorted only inside each D1 chunk. The projection now sorts the combined result by creation time descending and ID, preserving deterministic ordering across large booking lists. A new executed regression spans more than two chunks and compares with a single SQL ordering. Two AI assertions were updated for the deliberate HTTP 400 validation response and removal of the non-atomic assignment helper. The gateway audit now separately recognizes the two route-authenticated customer inboxes; their ownership protection remains exercised by the connected suite.

50 selected checks passed (33 AI/chunk semantics, 7 gateway reachability, 10 connected journeys), with build/artifact validation and typecheck successful. The broader suite is still in progress; no full-suite or 95% readiness claim is made.


### Provider conversation read visibility

Provider GET now applies the Trust & Safety suspension/ban check used by sending, excludes queued/suppressed/failed messages and returns an explicit text projection rather than arbitrary stored payload fields. Text contact details are masked by the existing pure redactor. Private notes, nested finance/identity metadata and raw media URLs are not returned. This projection does not implement governed provider media delivery; that remains open along with audience-specific customer/staff threads, older-history pagination and browser chat wiring.

The new route regression failed before the fix because queued content was visible, then passed after it. Twelve focused provider/trust checks pass, with build/artifact validation and typecheck successful. The broader earlier run completed with 4,678/4,682 passing; all four failures were addressed with focused tests in the preceding increment. A fresh full-suite run is still required. No real communications or financial transactions were performed.


### Full regression baseline and AI replay access

Commit `1233a544` passed all 4,684 tests in the full local suite, with no failures or skips. This is automated local evidence and does not establish deployed or human-test readiness. The exact run is exported as `stabilization-full-suite-1233a544.log`.

Subsequent inspection reproduced a completed AI-turn replay returning another customer's record before authorization. Replays now validate the canonical input and current customer ownership, and the stored key must match customer, thread, message and channel. Retryable reservation claims also match those fields so a conflicting request cannot seize another turn's reservation. Valid replay remains idempotent. Forty-two selected executed AI/handoff checks pass, including wrong-customer/revoked access, changed-message/key conflicts and unchanged conflicting retry reservations; build/artifact validation and typecheck pass. These later changes have focused evidence, not a new full-suite run. Takeover during an in-flight model call remains under investigation.
