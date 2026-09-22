# ai-crm — AI / chat / bot / CRM-leads launch verification (PR #960, ad4c56e)

Server http://127.0.0.1:8793 (browser + API via http://localhost:8793, same server). Chromium Pixel 7 / iPhone 14 / desktop.
Scripts: `$S/launch/ai-crm/01-employee-ai.mjs, 01b-welcome-nav.mjs, 02-customer-chat.mjs, 02b-staff-takeover.mjs, 03-crm-leads.mjs, 03b-crm-governance.mjs, 03c-governance-conversion.mjs, 03d-sla-conversion.mjs, 03e-conversion.mjs` (+ `db.mjs` read-only sqlite, copies of `helpers.mjs`/`ai-common.mjs`).
Evidence: `$S/launch/evidence/ai-crm/<script>/` (screenshots + result.json). Findings: `ai-crm.json` (36 entries), matrix `ai-crm-matrix.csv`.
Counts: 5 fixed-verified · 10 still-open · 7 new defects (2 P1, 0 P0) · 9 passes · 3 env-gated · 1 owner-decision · 1 not-retested. No page errors; the only 5xx seen were deterministic governance 500s (R12) and `/api/booking-command-center/stream` (EMP-15, outside my area).

## Prior findings
| Prior | Status | Evidence |
|---|---|---|
| AI-D01 / P1-08 (409 swallowed) | **fixed-verified** — inline alert "AI replies are paused while the conversation is owned by staff" on Pixel 7 + iPhone 14; network loss shows an alert; retry works | 01-employee-ai/founder-04-turn2-409.png, founder-05-network-loss.png |
| AI-D02 (AI tab wraps) | **fixed-verified** — 6-column nav, all buttons inside | founder-01-nav.png, manager-01-nav.png |
| AI-D03 (manager "Voice request refused") | still-open P2 — 403 alert, no reason, capabilities.voice still true | manager-02-voice.png |
| AI-D04 (no audit for 409 turns) | still-open P2 — 2 message rows vs 1 chat audit row on THREAD-96626B5C-48C | result.json |
| AI-D05 (C••••• queue rows) | still-open P2 — 3 masked rows for UATD-CUS-n-CRM | queue-01.png, queue-02-masked-panel.png |
| AI-E01/E02/E03 | env-gated — provider not_connected; Workers AI binding missing; allow-list/approval unset (exact strings recorded in R07) | voice-selftest-01.png, voice-console-01.png |
| ORCH-1 (nav hidden until welcome done) | still-open P3 — for AI-enabled staff the nav is display:grid under the welcome (`app/prototype-convergence.css:18` exempts `nav[data-employee-ai=enabled]`); only the fixed splash covers it; associate nav is display:none | 01b-welcome-nav/* |
| AI-O02 (welcome splash 6–9 s) | still-open P2 | 01b-welcome-nav/result.json |
| EMP-07 (assignment/SLA 500, no policy) | **still-open, raised to P1** — every validation refusal is a 500; no UI; policy city must substring-match the contact area ("Bangalore"), the CRM city id "blr" never matches; with a matching policy the whole flow works (P07) | 03b/03c/03d result.json |
| P1-02 (revenue-crm 500 / due callbacks) | **fixed-verified for reads** (200 for founder/manager/sales; table repaired additively) — but writes are broken: see D01 | 03-crm-leads/F-01-crm.png |
| sticky opt-out | **fixed-verified** — Opt-out closes the lead, prefs opt_out=1, "Do not contact — opted out"; Interested/WhatsApp afterwards cannot reopen | 03b/F-02-crm-detail-optout.png |
| EMP-02 / EMP-11 | **fixed-verified** — sales manager works /crm (+Add lead 201); out-of-scope modules show honest scope denials | 03-crm-leads/S-01, S-05, J-01 |
| EMP-09 (CRM search) | still-open P2 — phone/name search "0 shown" (API returns the contact), illegible detail tiles, Appearance pill overlaps CTA | 03b/F-01-crm-search-phone.png |
| EMP-10 (/team/whatsapp 404) | still-open P2 | 03-crm-leads/F-07-team-whatsapp.png |
| EMP-14 (/team/sales 22k px) | still-open P2 | 03-crm-leads/S-06-team-sales.png |
| SW-024 (CX 409 probes) | still-open P3, reduced to one probe per selected thread with an honest "Non-WhatsApp conversation" note | 02b/F-04-cx-thread-A.png |
| AI-P06/P08/P11 (replay, handoff, /chat) | pass again (R10, R11) | 02/02b screenshots |

## New defects
- **AICRM-D01 P1 backend** — `schedule_callback` → 409 `D1_ERROR: NOT NULL constraint failed: lead_callbacks.phone` on the drizzle-0021 table shape (what staging applies); the governed INSERT omits phone/source/requested_by. Retention callbacks cannot be created, dueCallbacks stays empty, raw D1 text reaches the client.
- **AICRM-D02 P1 wiring (owner decision)** — after a web-chat handoff and staff Take over there is no channel to reply to the customer: no reply control on /team/ai/handoff, CX composer is staff-note only, conversation-control human_reply 409 "not a WhatsApp thread", crm/chat send_message 400; /chat and /v2/chat never read thread history. Customer only ever sees "I'm routing this conversation to a PawSpace team member…".
- AICRM-D03 P3 — /api/crm/chat send_message returns HTTP 400 with `ok:true`.
- AICRM-D04 P3 — Employee AI network-loss alert says "Failed to fetch"; composer cleared on failure.
- AICRM-D05 P3 — crm_contacts.owner shows a queue code ("cx-ai-handoff") and does not follow lead assignment.
- AICRM-D06 P3 — guest POST to authenticated chat gets the staff "staging sign-in has expired" copy (API only).
- AICRM-D07 P3 — Customer 360 does not surface the web lead or its chat thread.

## Passed (driven end to end)
Employee AI first-turn honest handoff + 409 alert (founder, manager); associate 403 + no tab; handoff lifecycle customer web chat → queue → Take over → Return to AI → bot resumes; seeded + employee threads round-trip; idempotent replay (same key, even with different text); ownership boundary (customer B 403 on A's thread/key/queue/360; guest 401); /v2/chat account-mode 409 alert with text kept; callback request honest ("received … does not confirm a call"); public knowledge without prices + ai_web_leads capture; /contact lead 201 + replay 200 duplicatePrevented + tamper 409; CRM Add lead 201 (sales manager); lead conversation → handoff queue with lead_id; sticky opt-out; Revenue CRM reads for all roles; daily target save; lead routing + SLA clocks with a matching policy (assign/replay/accept/reassign/start/record all idempotent and audited).

## Environment gates (not defects)
AI provider key absent (staff: provider_unavailable; customers: rollout_gated because stage=staff_only); Workers AI binding absent (browser mic 409); PAWSPACE_VOICE_UAT_ALLOWLIST / PAWSPACE_VOICE_UAT_APPROVED unset (carrier self-test 409, calling disabled, callback dial blocked); HAPTIK_API_KEY unset (503); WhatsApp UAT webhook secret unset (503); PAWSPACE_COMMUNICATION_ENV unset locally so crm/chat simulate_inbound is 403 (staging sets uat); WhatsApp AI lead automation setup_required / consent-gated.

## Owner decisions
1. Customer rollout stage for launch (every customer turn is currently handed off as rollout_gated).
2. Human contact channel + customer copy for web-chat handoffs (D02).
3. Lead-routing policy key (free-text city label vs CRM city_id) and an assignment UI (R12).
4. Employee-AI thread identity: CRM contact id vs canonical customer id (R05).

## Untested / not exercised
Lead → booking conversion (booking API needs the customer app's scheduling reservation; I published grooming package dog-basic via PATCH /api/pricing-control reason "UAT publish" — staging needs the same); real AI answers; voice STT/TTS and ticket reuse paths; WhatsApp inbound and Haptik flows; take-over of a real WhatsApp thread (none exist locally); the "Create test booking →" test-lab control on /crm (not clicked).
Sandbox governance rows I created (read-only otherwise): assignment policies LAP-A2C26359-D3F, LAP-A03C5038-F5A; SLA policies SLAP-4E2454E7-DDC, SLAP-62BE7BBA-931; members sales1/sales2; leads CU-71628/LEAD-1790001487758 (opted out), CU-be35d107…/LEAD-b0fba372…, LEAD-db5f5911… (E2E-CUS-UI-001); daily target 250000.
