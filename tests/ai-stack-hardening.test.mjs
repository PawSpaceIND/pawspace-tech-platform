import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// The AI libs import each other with extensionless specifiers ("./ai-governance"), which tsc and the
// bundler resolve but Node's native ESM loader (under --experimental-strip-types) does not. This
// test-only resolve hook appends .ts on failure so the real, unmodified sources execute directly.
// Same pattern as tests/customer-offers.test.mjs (registerHooks on Node >=22.15, register fallback).
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const aiRoute = read("app/api/ai-intelligence/route.ts");
const aiPage = read("app/team/ai/page.tsx");
const orchestratorSource = read("lib/ai-conversation-orchestrator.ts");
const governanceSource = read("lib/ai-governance.ts");

const statementsOf = (source) => [...source.matchAll(/\.prepare\(\s*(["'`])([\s\S]*?)\1/g)].map((match) => match[2]);

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        sqlite.prepare(sql).run(...args);
        return { success: true, meta: {} };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return { prepare: (sql) => statement(sql, []), batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; } };
}

const staffActor = { email: "staff@test", name: "Staff", roleCode: "superuser", permissions: ["*"], developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: "staff@test" };

const connectedProvider = {
  status: "connected",
  provider: "test_provider",
  modelRef: "test-model-1",
  async generate() { return { text: "Your booking is confirmed and the provider is on schedule.", provider: "test_provider", modelRef: "test-model-1", latencyMs: 5, confidence: 0.9 }; },
};

async function freshStack() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const orchestrator = await import("../lib/ai-conversation-orchestrator.ts");
  const rollout = await import("../lib/ai-audience-rollout.ts");
  const governance = await import("../lib/ai-governance.ts");
  const c360 = await import("../lib/customer-360.ts");
  await orchestrator.ensureAiConversationOrchestrator(db); // real conversation + AI DDL via the real import chain
  await governance.ensureAiGovernance(db);
  // Owning DDL for canonical/CRM tables the 360 context reads (extracted, never guessed).
  for (const source of [read("lib/customer-account.ts"), read("app/api/canonical-bookings/route.ts"), read("app/api/revenue-crm/route.ts")]) {
    for (const sql of statementsOf(source)) if (/^\s*CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql)) sqlite.exec(sql);
  }
  const now = Date.now();
  const seedCustomer = (id, name, phone) =>
    sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, "blr", name, phone, null, null, "customer_app", "{}", now, now);
  const seedBooking = (id, customerId, service, amount, start, end) =>
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, `ik-${id}`, customerId, "[]", "[]", "blr", "blr-east", service, `${service}-pkg`, `${service} package`, `grp-${id}`, "prov-1", start, end, "confirmed", "customer_app", amount, "INR", "{}", "test", now, now);
  const seedThread = (id, customerId) =>
    sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(id, customerId, null, null, null, "open", null, null, now, now);
  const seedInbound = (id, threadId, customerId, text) =>
    sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,booking_id,lead_id,ticket_id,direction,channel,purpose,template_key,payload_json,status,provider,provider_reference,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, threadId, customerId, null, null, null, "inbound", "chat", "customer_message", "inbound_freeform", JSON.stringify({ text }), "received", null, null, `ik-${id}`, "{}", customerId, now, now);
  return { sqlite, db, orchestrator, rollout, governance, c360, seedCustomer, seedBooking, seedThread, seedInbound };
}

// ---------------------------------------------------------------------------
// Task 1 — claims vs computation: heuristics are deterministic and labeled.
// ---------------------------------------------------------------------------
test("intent confidence is a deterministic labeled heuristic, not a fabricated model score", async () => {
  const { classifyAiIntent } = await import("../lib/ai-conversation-orchestrator.ts");
  const first = classifyAiIntent("I want a refund, I was charged twice");
  const second = classifyAiIntent("I want a refund, I was charged twice");
  assert.deepEqual(first, second, "same input must always produce the same decision (no randomness)");
  assert.equal(first.confidenceBasis, "keyword_heuristic_sandbox", "the score carries its basis");
  assert.equal(first.intent, "refund_review");
  assert.equal(first.policyRisk, true);
});

test("no AI surface in scope uses Math.random or invents trends", () => {
  for (const [name, source] of [["route", aiRoute], ["governance", governanceSource], ["orchestrator", orchestratorSource], ["team page", aiPage]]) {
    assert.doesNotMatch(source, /Math\.random/, `${name} must not fabricate numbers`);
  }
});

test("API response and team page both label confidence as sandbox heuristic / staff-reported", () => {
  assert.match(aiRoute, /confidenceBasis:"sandbox_heuristic_or_staff_reported_not_model_computed"/);
  assert.match(aiPage, /not model-computed/);
  assert.match(aiPage, /sandbox heuristic/);
});

test("permission mapping: GET=reports.view, writes=customers.manage", () => {
  const getBody = aiRoute.slice(aiRoute.indexOf("export async function GET"), aiRoute.indexOf("export async function POST"));
  const postBody = aiRoute.slice(aiRoute.indexOf("export async function POST"));
  assert.match(getBody, /authorize\(request,"reports\.view"\)/);
  assert.match(postBody, /authorize\(request,"customers\.manage"\)/);
});

// ---------------------------------------------------------------------------
// Task 3 — insight numbers derive exactly from seeded bookings.
// ---------------------------------------------------------------------------
test("real execution: prepare_customer_context numbers derive exactly from seeded bookings", async () => {
  const { sqlite, db, governance, c360, seedCustomer, seedBooking } = await freshStack();
  seedCustomer("CUS-AI-1", "Insight Customer", "9999900101");
  seedBooking("BK-G1", "CUS-AI-1", "grooming", 1349, "2026-08-01T05:00:00.000Z", "2026-08-01T07:00:00.000Z");
  seedBooking("BK-B1", "CUS-AI-1", "boarding", 4500, "2026-08-05T05:00:00.000Z", "2026-08-08T05:00:00.000Z");
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,category,priority,subject,detail,owner,manager,sla_due_at,status,escalation_level,customer_status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-AI-1", "CUS-AI-1", "Service quality", "high", "Late provider", "Provider late", "CX", "Mgr", Date.now(), "open", 0, "We received your request", "test", Date.now(), Date.now());

  const [record] = await c360.buildCustomer360(db, "CUS-AI-1");
  const context = governance.deriveCustomerAiContext(record);
  assert.equal(context.bookingCount, 2, "bookingCount = exactly the seeded bookings");
  assert.deepEqual([...context.services].sort(), ["boarding", "grooming"], "services = exactly the seeded service codes");
  assert.equal(context.openTicketCount, 1, "openTicketCount = exactly the seeded open ticket");
  assert.equal(context.lastServiceAt, "2026-08-08T05:00:00.000Z", "lastServiceAt = the latest seeded scheduled end");

  // The route uses this exact derivation (no inline duplicate), and the persisted snapshot matches it.
  assert.match(aiRoute, /deriveCustomerAiContext\(record\)/);
  const stored = await governance.createAiContext(db, { actorEmail: "staff@test", customerId: "CUS-AI-1", scope: ["customer_summary"], context });
  const row = sqlite.prepare("SELECT context_json FROM ai_context_snapshots WHERE id=?").get(stored.id);
  assert.deepEqual(JSON.parse(row.context_json), JSON.parse(JSON.stringify(context)), "persisted context = derived context, nothing added");
});

// ---------------------------------------------------------------------------
// Task 2 — conversation isolation between customers.
// ---------------------------------------------------------------------------
async function twoCustomers() {
  const stack = await freshStack();
  stack.seedCustomer("CUS-A", "Customer A", "9999900201");
  stack.seedCustomer("CUS-B", "Customer B", "9999900202");
  stack.seedBooking("BK-A-1", "CUS-A", "grooming", 1349, "2026-08-01T05:00:00.000Z", "2026-08-01T07:00:00.000Z");
  stack.seedBooking("BK-B-1", "CUS-B", "boarding", 4500, "2026-08-05T05:00:00.000Z", "2026-08-08T05:00:00.000Z");
  stack.seedThread("THR-A", "CUS-A");
  stack.seedThread("THR-B", "CUS-B");
  stack.seedInbound("MSG-A-1", "THR-A", "CUS-A", "booking status please");
  stack.seedInbound("MSG-B-1", "THR-B", "CUS-B", "booking status please");
  await stack.rollout.setAiRolloutStage(stack.db, { stage: "customers", actorEmail: "staff@test" });
  return stack;
}

test("real execution: a turn's AI context contains only that customer's data", async () => {
  const { sqlite, db, orchestrator } = await twoCustomers();
  const result = await orchestrator.orchestrateAiTurn(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-A", inputMessageId: "MSG-A-1", idempotencyKey: "turn-a-1", channel: "chat", provider: connectedProvider });
  assert.equal(result.duplicatePrevented, false);
  assert.equal(result.turn.outcome, "draft_review_required");
  const snapshot = sqlite.prepare("SELECT customer_id,context_json FROM ai_context_snapshots WHERE id=?").get(result.turn.contextId);
  assert.equal(snapshot.customer_id, "CUS-A");
  assert.match(snapshot.context_json, /BK-A-1/, "customer A's own booking is in A's context");
  assert.doesNotMatch(snapshot.context_json, /BK-B-1|CUS-B/, "customer B's data must never appear in A's context");
});

test("real execution: a message cross-wired onto another customer's thread is rejected", async () => {
  const { sqlite, db, orchestrator, seedInbound } = await twoCustomers();
  // Corrupt/malicious canonical row: message claims customer B but sits on A's thread.
  seedInbound("MSG-X-1", "THR-A", "CUS-B", "booking status please");
  await assert.rejects(
    () => orchestrator.orchestrateAiTurn(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-B", inputMessageId: "MSG-X-1", idempotencyKey: "turn-x-1", channel: "chat", provider: connectedProvider }),
    /thread does not belong to this customer/,
    "thread ownership is verified against the thread row, not just the message row"
  );
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM ai_conversation_turns").get().c, 0, "no turn is recorded for the rejected attempt");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM ai_context_snapshots").get().c, 0, "no AI context is built for the rejected attempt");
});

test("real execution: requesting a turn against someone else's thread/message is rejected", async () => {
  const { db, orchestrator } = await twoCustomers();
  await assert.rejects(
    () => orchestrator.orchestrateAiTurn(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-B", inputMessageId: "MSG-B-1", idempotencyKey: "turn-x-2", channel: "chat", provider: connectedProvider }),
    /thread\/customer mismatch/
  );
});

test("real execution: a session row belonging to another customer can never be reused", async () => {
  const { sqlite, db, orchestrator } = await twoCustomers();
  // Simulate a corrupt legacy session: thread B's session points at customer A.
  sqlite.prepare("INSERT INTO ai_conversation_sessions (id,thread_id,customer_id,status,provider,model_ref,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run("AISES-POISON", "THR-B", "CUS-A", "ai_active", "not_connected", null, Date.now(), Date.now());
  await assert.rejects(
    () => orchestrator.orchestrateAiTurn(db, { actor: staffActor, threadId: "THR-B", customerId: "CUS-B", inputMessageId: "MSG-B-1", idempotencyKey: "turn-b-1", channel: "chat", provider: connectedProvider }),
    /session belongs to a different customer/
  );
});

test("real execution: conversation snapshot filters turns at the query level, not just by thread", async () => {
  const { sqlite, db, orchestrator } = await twoCustomers();
  await orchestrator.orchestrateAiTurn(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-A", inputMessageId: "MSG-A-1", idempotencyKey: "turn-a-2", channel: "chat", provider: connectedProvider });
  // Rogue row: a turn on A's thread stamped with customer B (bypassing the orchestrator).
  sqlite.prepare("INSERT INTO ai_conversation_turns (id,session_id,thread_id,customer_id,input_message_id,idempotency_key,channel,intent_code,intent_confidence,context_id,provider,model_ref,output_text,latency_ms,policy_decision,outcome,handoff_reason,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("AITURN-ROGUE", "AISES-X", "THR-A", "CUS-B", "MSG-B-1", "ik-rogue", "chat", "unknown", 0.2, "AICTX-X", "not_connected", null, "leaked text", 0, "human_handoff", "handoff", null, Date.now(), Date.now());

  const snapshot = await orchestrator.aiConversationSnapshot(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-A" });
  assert.ok(snapshot.turns.length >= 1);
  assert.ok(snapshot.turns.every((turn) => String(turn.id) !== "AITURN-ROGUE"), "a turn stamped with another customer never surfaces in this customer's snapshot");
  await assert.rejects(
    () => orchestrator.aiConversationSnapshot(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-B" }),
    /thread\/customer mismatch/,
    "customer B cannot read A's thread snapshot at all"
  );
  // Query-level guarantee: both snapshot queries scope by thread AND customer.
  assert.match(orchestratorSource, /FROM ai_conversation_turns WHERE thread_id=\? AND customer_id=\?/);
  assert.match(orchestratorSource, /FROM ai_conversation_sessions WHERE thread_id=\? AND customer_id=\?/);
});

// ---------------------------------------------------------------------------
// Handoff + review path (backs the team page's Approve/Reject buttons).
// ---------------------------------------------------------------------------
test("real execution: refund intent hands off to finance queue and pauses AI on the thread", async () => {
  const { sqlite, db, orchestrator, seedInbound } = await twoCustomers();
  seedInbound("MSG-A-2", "THR-A", "CUS-A", "I want a refund, I was charged twice");
  const result = await orchestrator.orchestrateAiTurn(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-A", inputMessageId: "MSG-A-2", idempotencyKey: "turn-a-refund", channel: "chat", provider: connectedProvider });
  assert.equal(result.turn.outcome, "handoff");
  const handoff = sqlite.prepare("SELECT customer_id,reason,queue_code,status FROM ai_handoffs WHERE thread_id=?").get("THR-A");
  assert.equal(handoff.customer_id, "CUS-A");
  assert.equal(handoff.reason, "refund_payment_dispute");
  assert.equal(handoff.queue_code, "finance-cx");
  // AI is paused on this thread while staff own it.
  seedInbound("MSG-A-3", "THR-A", "CUS-A", "booking status please");
  let paused = null;
  try {
    await orchestrator.orchestrateAiTurn(db, { actor: staffActor, threadId: "THR-A", customerId: "CUS-A", inputMessageId: "MSG-A-3", idempotencyKey: "turn-a-3", channel: "chat", provider: connectedProvider });
  } catch (error) {
    paused = error;
  }
  assert.ok(paused instanceof Response, "pause guard raises a 409 Response");
  assert.equal(paused.status, 409);
  assert.match(await paused.text(), /AI replies are paused/);
});

test("real execution: suggestion review is one-shot — the page's Approve/Reject cannot double-review", async () => {
  const { db, governance } = await freshStack();
  const context = await governance.createAiContext(db, { actorEmail: "staff@test", scope: ["customer_summary"], context: { note: "test" } });
  const suggestion = await governance.recordAiSuggestion(db, { contextId: context.id, type: "draft_response", content: { text: "hi" }, confidence: 0.8, requestedBy: "staff@test" });
  const reviewed = await governance.reviewAiSuggestion(db, { suggestionId: suggestion.id, decision: "approved", actorEmail: "staff@test", note: "Reviewed against canonical context" });
  assert.equal(reviewed.status, "approved");
  await assert.rejects(
    () => governance.reviewAiSuggestion(db, { suggestionId: suggestion.id, decision: "rejected", actorEmail: "staff@test", note: "Second attempt" }),
    /already reviewed/
  );
  // Page wiring: buttons post review_suggestion with a decision and a non-trivial note, then refresh.
  assert.match(aiPage, /action:"review_suggestion",suggestionId:id,decision,note/);
  assert.match(aiPage, /await load\(\)/);
});
