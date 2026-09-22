# AI area — Employee AI (Chat + Voice in /mobile-app) and staff AI screens

Server http://127.0.0.1:8793 (API checks via http://localhost:8793 so Secure cookies are sent — same server). Chromium, Pixel 7 / iPhone 14 / desktop. Scripts: `$S/pw/ai-0{1..6}-*.mjs` (+ `ai-common.mjs`, `db.mjs`). Evidence: `$S/evidence/ai/<step>/` (70 screenshots + result.json per step). Machine-readable findings: `$S/findings/ai.json` (23 entries).

## Passed (driven in the browser)
- **Access matrix** (AI-P01/P02/P03): founder and both managers get the "AI" tab on Pixel 7, iPhone 14 and desktop; workspace shows actor name/role, capabilities, 6 CRM customers. sales1 (`app_users.role_code=associate`), associate, groomer (service_provider), finance → 403 + no tab; guest → 401; customer OTP and partner OTP sessions → 403 + no tab. No 500s. Cross-origin POST → 403 "Cross-origin write blocked"; bad action/missing fields → 400. Matches `defaultRoles` (chat = customers.manage + communications.message).
- **Customer context** (AI-P04): dropdown/context card update; threads and messages carry the selected customer id.
- **Real chat turn** (AI-P05/E01): "What grooming packages can I offer this customer and what is the price?" → *"I'm routing this conversation to a PawSpace team member so it can be handled safely."* with meta `handoff · human_handoff · provider_unavailable`; intent service_info 0.92 (keyword_heuristic_sandbox), provider `not_connected`. No prices fabricated, no crash. Rows written to communication_messages (idempotency_key, created_by founder), communication_threads, ai_conversation_turns, ai_conversation_sessions (provider_status not_connected), ai_turn_reservations, ai_handoffs, ai_web_chat_events, ai_suggestions, security_audit_events (`mobile.employee_ai.bootstrap` / `.chat`).
- **No duplicates** (AI-P06): double-click Send → 1 POST; same idempotencyKey twice → second `duplicatePrevented:true`, one message row; same key for another customer → 403.
- **No money actions** (AI-P07): "Refund 500 rupees…" → `handoff · blocked_high_impact · refund_payment_dispute`, queued to finance-cx; "Capture the pending payment" / "Cancel booking … and refund" → refused 409 (thread owned by staff). All refund/payment/booking tables unchanged; approval-gated tool table never even created.
- **Handoff** (AI-P08): "I need to talk to a human" → `customer_requested_human`; /team/ai/handoff lists it; seeded UATD-TH-1 (Return to AI → resumed) and UATD-TH-3 (Take over → staff_active → Return to AI → resumed) plus an employee-AI thread round-tripped with 200s, matching ai_handoffs/thread/event rows; AI chat works again after return.
- **Voice gating** (AI-P/E02): State line shows the exact reason, Start voice disabled (force-click no-op), ticket POST 409 + audited `voice.ai_browser_test.ticket blocked`, ws without ticket refused (503 readiness gate; carrier stream 401; plain GET 426), manager 403.
- **Network loss** (AI-P09): aborted send leaves no row; retry with a new key succeeds once.
- **Staff screens** (AI-P10/P11): /team/ai (Approve works; safety suite 11/0), /team/ai/configuration (4 readiness conditions; kill switch off→on audited), /team/ai/rollout (staff_only→off→staff_only; customers never touched), /team/ai/analytics, /team/voice, /team/voice/ai-test, /chat and /v2/chat (public knowledge answers without prices; founder told to sign in as customer; customer turn handed off; 409 rendered as alert with text kept). No page errors, no app 5xx.

## Environment-gated (not defects) — exact reasons
- **AI provider** (AI-E01): `/team/ai/configuration` → "✗ Model provider connected — PAWSPACE_AI_PROVIDER_API_KEY is not configured - no external AI provider is connected and every conversation goes to a human"; other 3 conditions ✓ (profile/policy active, rollout Staff only, no kill switch). Staging: `deploy-staging.yml` passes `PAWSPACE_AI_PROVIDER_API_KEY` as an optional secret — unset means identical fail-closed behaviour there.
- **AI Voice browser harness** (AI-E02): readiness `enabled:false, reason:"Cloudflare Workers AI binding (AI) is not configured"` (local `wrangler.e2e.json` strips `ai`). Untestable locally: mic permission prompt, start/stop session, STT→AI→TTS, listening/speaking/error states, ticket 401/reuse-409 paths. Staging needs: `wrangler.toml [ai] binding="AI"` (present), `PAWSPACE_VOICE_ENV=uat` + `PAWSPACE_VOICE_UAT_AI_SELF_TEST_APPROVED=true` (set by `scripts/stage-config.mjs`), HTTPS origin (ticket refuses http with 409), `PAWSPACE_UAT_SIGNING_KEY` ≥ 32 chars.
- **Outbound calling / carrier self-test** (AI-E03): "Voice calling is not approved for this environment (set PAWSPACE_VOICE_UAT_APPROVED="true")" and "AI voice self-test requires exactly one PAWSPACE_VOICE_UAT_ALLOWLIST recipient" — neither var is set by stage-config.mjs, so staging is the same unless configured.

## Defects
| ID | Sev | Class | Title |
|---|---|---|---|
| AI-D01 | **P1** | UI | Employee AI chat silently swallows failures: after any handoff, POST returns 409 "AI replies are paused while the conversation is owned by staff" (and on network loss) — the user bubble appears, textarea is cleared, no reply, no alert. `error` state is only rendered in the pre-bootstrap "denied" branch of `employee-ai-mobile.tsx`. /chat and /v2/chat render the same 409 correctly. Locally every first turn hands off (no provider), so the copilot looks dead after one message per customer. |
| AI-D02 | P2 | UI | "AI" bottom-nav tab wraps to a second row outside the 5-column nav bar on all viewports (`.phone>nav` = repeat(5,1fr), 70px). |
| AI-D03 | P2 | wiring | Manager: bootstrap says `capabilities.voice:true` (communications.call) but readiness needs settings.manage → panel shows unexplained "Voice request refused". |
| AI-D04 | P2 | backend | 409-refused turns persist the inbound message row but write no `mobile.employee_ai.chat` audit row (10 message rows vs 7 audit rows). |
| AI-D05 | P2 | data | Employee AI threads use CRM contact ids (`UATD-CUS-n-CRM`) instead of canonical ids → handoff queue shows them as "C•••••", separate from the customer's canonical threads. |

## Observations
- AI-O01: keyword classifier turns any staff message containing "staff"/"person"/"agent" into an immediate human handoff.
- AI-O02: location welcome splash hides the nav ~8-9 s when geolocation is unanswered.
- AI-O03: floating ◐/♢ buttons overlap the V2 bottom nav on iPhone (outside area).
- AI-O04: harness — Secure cookies not sent by Playwright request context over 127.0.0.1; use localhost.
