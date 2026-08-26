# PawSpace WhatsApp AI Customer Operations

Status: **Phase 1 foundation started on 26 August 2026**
Release boundary: **UAT/sandbox only; production delivery remains disabled**

## 1. Product outcome

PawSpace will operate its own WhatsApp customer-operations workspace, integrated with the existing Customer App, CRM, Admin, canonical bookings, communications outbox and PawSpace AI. It replaces the PawSpace-specific operating dependency on a WATI-style inbox and automation layer; it does not replace WhatsApp or Meta's Business Platform.

The first supported journey is:

`lead captured -> explicit WhatsApp consent -> approved first-response template -> customer reply -> PawSpace AI qualification -> governed booking request or human handoff`

This project is not a marketing campaign system. Phase 1 does not include bulk messaging, promotional broadcasts, customer-list uploads for outreach or autonomous win-back activity.

## 2. Non-negotiable business rules

1. A CRM/lead-sheet row is the system trigger, but it is not permission to message.
2. The first WhatsApp message requires explicit channel consent, stored evidence and an approved Meta template.
3. No consent, prior opt-out, ambiguous identity, missing template approval or disabled provider results in a visible staff fallback. The lead is never lost.
4. Exactly one first-response workflow may exist for a lead. Retries reuse the same idempotency key and message.
5. The first message is an enquiry response, never marketing. It contains no discount, promotion or unapproved price claim.
6. Customer replies attach to the same lead-linked canonical conversation and open the WhatsApp customer-service window.
7. AI may answer service questions and collect requirements. Price, availability and booking statements must come from governed PawSpace tools.
8. Refunds, payments, cancellations, provider assignment, KYC, payout, discounts and other high-impact actions remain approval-gated.
9. Customer request for a human, low confidence, policy risk, complaint, refund/payment dispute, safety issue or provider error creates a human handoff.
10. Human takeover stops AI replies until an authorised user resumes AI.
11. STOP/opt-out immediately suppresses further WhatsApp automation and cannot be silently overwritten by a later staff entry.
12. Every consent, trigger, message, provider callback, AI turn, tool request, handoff and staff action is auditable.

## 3. Architecture decision

The implementation reuses the existing PawSpace control planes:

| Responsibility | Existing PawSpace authority |
| --- | --- |
| Lead and owner | `crm_contacts`, `lead_work_items` |
| Customer identity | `canonical_customers` |
| Consent | `customer_contact_preferences` plus immutable WhatsApp lead evidence |
| Conversation/inbox | `communication_threads`, `communication_messages` |
| Reliable delivery | `communication_outbox`, retry and dead-letter ledgers |
| WhatsApp UAT | signed webhook and `whatsapp-uat-adapter` |
| AI | conversation orchestrator, provider adapter and tool registry |
| Human takeover | AI handoff ledger and Customer Experience queue |
| Staff access | existing RBAC, masking and security audit |

No second CRM, customer store, inbox, AI stack or message ledger will be introduced.

## 4. Lead-trigger state machine

| State | Meaning | Required next action |
| --- | --- | --- |
| `processing` | A single worker owns the trigger | Complete policy checks |
| `blocked` | Consent absent, opted out or lead/contact mismatch | Staff follows up through an allowed channel |
| `identity_review` | Phone maps to conflicting customers | Authorised identity resolution |
| `setup_required` | Approved template/provider configuration missing | Complete Meta/UAT setup; retry governed trigger |
| `queued` | One template message is in the canonical outbox | Provider dispatch in controlled UAT |
| `delivered/read` | Provider callback confirmed delivery | Await customer response |
| `replied` | Customer reply received | AI orchestration begins |
| `human_owned` | AI stopped and CX owns the thread | Human resolves or explicitly resumes AI |
| `closed` | Lead converted, declined, opted out or resolved | No further automatic contact |

## 5. Identity policy

- Normalise the WhatsApp number before matching.
- A CRM contact ID with a different canonical phone is a conflict, not an update.
- One phone matching multiple canonical customers opens review.
- One exact existing customer is linked; no duplicate customer is created.
- With no match, the CRM contact becomes the initial canonical lead/customer identity.
- Inbound transport identity must agree with any claimed customer ID.
- Ambiguity never selects the first database row.

## 6. Consent policy

Phase 1 accepts these evidence sources:

- customer-selected checkbox on a PawSpace enquiry form;
- staff-recorded customer request with a call, message or written evidence reference;
- customer-initiated WhatsApp message.

Consent evidence stores the lead, contact, resolved customer, purpose `lead_response`, wording version, source, reference, actor and capture time. Marketing consent remains false. A previous opt-out wins over a new lead entry.

## 7. AI scope

Allowed:

- greet and identify the requested service;
- collect pet, city/pincode, preferred date and basic service requirements;
- answer approved PawSpace service questions from verified knowledge;
- call read-only pricing and capacity tools;
- create a booking request/draft;
- schedule a callback;
- summarise and hand over to staff.

Approval-gated or prohibited:

- charge, refund or alter a payment;
- cancel an in-progress service;
- promise an unavailable slot/provider;
- invent a price, discount or service policy;
- expose another customer's data;
- approve a provider, KYC document, media proof or payout;
- continue after human takeover or opt-out;
- operate as a general-purpose AI assistant.

## 8. Staff experience

The existing Customer Experience workspace is the shared inbox. Phase 1 adds lead-linked threads to it. The final operator experience must show:

- customer/lead identity, service, source, owner and SLA;
- WhatsApp window and template requirement;
- consent source/evidence and opt-out state;
- complete inbound/outbound history and delivery status;
- AI/human ownership and handoff reason;
- AI summary and collected qualification fields;
- reply, take-over, assign, await-customer, resolve and resume-AI actions;
- masked personal data according to role.

## 9. Delivery phases

### Phase 1A — implemented foundation

- explicit consent on public and CRM lead capture;
- idempotent lead-created trigger ledger;
- canonical identity resolution and ambiguity review;
- approved-template gate;
- lead-linked communication thread;
- existing shared inbox visibility;
- UAT-only outbox and signed inbound webhook;
- inbound reply reuses the lead-linked conversation.

### Phase 1B — next engineering slice

- direct Meta Cloud API sandbox adapter;
- Meta webhook payload parser and signature verification;
- template sync/approval dashboard;
- STOP/opt-out parsing from inbound messages;
- AI answer approval/auto-send policy by rollout stage;
- AI qualification fields and booking-request tool;
- visible AI/human ownership controls in the inbox.

### Phase 2

- booking, availability, payment-link and service-update workflows;
- queue routing, SLA analytics and agent performance;
- reschedule, complaint and governed cancellation cases;
- controlled production-number pilot.

### Phase 3

- visual automation builder, multiple numbers/departments and reusable workflows;
- optional multi-business onboarding only if PawSpace later chooses to sell the platform externally.

## 10. Release gates

No production activation until all are proven on the exact release SHA:

1. Approved template and verified WhatsApp Business Account.
2. Explicit consent, opt-out and quiet-hours tests.
3. Duplicate lead/retry creates one message only.
4. Phone conflict and cross-customer isolation tests.
5. Valid, invalid, stale and replayed webhook tests.
6. Delivery, read, failure, retry and dead-letter evidence.
7. AI low-confidence, unsafe action and provider-failure handoff.
8. Human takeover blocks AI; authorised resume restores it.
9. CRM, inbox, customer, booking and audit records remain consistent.
10. Real-device controlled UAT with allow-listed PawSpace numbers.

## 11. External dependencies and limitations

- Meta owns WABA approval, phone registration, template categorisation/approval, pricing, quality limits and enforcement.
- Business-initiated first contact cannot be treated as a free-form AI message.
- An AI response cannot guarantee a provider, slot, price or payment outcome without successful governed tool calls.
- The current code remains UAT-only and reports `externalDelivery: false` until provider credentials and controlled-live certification are completed.
- A complete commercial WATI clone would additionally require multi-tenant onboarding, tenant billing, embedded signup and per-business WABA administration; those are outside the PawSpace internal Phase 1 scope.
