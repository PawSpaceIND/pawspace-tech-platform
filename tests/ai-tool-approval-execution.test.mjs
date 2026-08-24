/**
 * Executed evidence that the AI cannot take a high-impact action on its own.
 *
 * The existing proof for this was `tests/ai-tool-registry.test.mjs`, which asserts that the strings
 * "refund.issue" and "approval_gated" appear in `lib/ai-tool-registry.ts`. That passes if the two
 * words sit in a comment and the gate is gone. These cases call the real `prepareAiToolExecution` and
 * `confirmAiToolExecution` against a real SQLite-backed D1, then assert on the rows that exist - and,
 * for every refusal, on the rows that do NOT.
 *
 * The eight high-impact actions come from `forbiddenAutonomousActions` rather than a list retyped
 * here, so adding a ninth forbidden action fails this suite until it has a gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer, staffActor, customerActor, NOW } from "./helpers/ai-harness.mjs";

installAiHooks();

const { forbiddenAutonomousActions } = await import("../lib/ai-governance.ts");
const registry = await import("../lib/ai-tool-registry.ts");

async function world() {
  const { sqlite, db } = freshAiDb();
  await registry.ensureAiToolRegistry(db);
  seedCustomer(sqlite, "CUS-1", "Asha", "9876500001");
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,package_name,status,scheduled_start,scheduled_end,channel,total_amount,currency,created_at,updated_at) VALUES ('BKG-1','CUS-1','grooming','GRM-BASIC','Basic groom','confirmed','2026-09-01T10:00:00Z','2026-09-01T11:00:00Z','chat',899,'INR',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_code,package_name,status,scheduled_start,scheduled_end,channel,total_amount,currency,created_at,updated_at) VALUES ('BKG-OTHER','CUS-2','grooming','GRM-BASIC','Basic groom','confirmed','2026-09-02T10:00:00Z','2026-09-02T11:00:00Z','chat',899,'INR',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,lead_id,ticket_id,status,assigned_to,sla_due_at,created_at,updated_at) VALUES ('THREAD-1','CUS-1',NULL,NULL,NULL,'open','ai',NULL,?,?)").run(NOW, NOW).changes;
  return { sqlite, db };
}
const rows = (sqlite, sql) => sqlite.prepare(sql).all();

// ---------------------------------------------------------------------------
// Approval gating
// ---------------------------------------------------------------------------
test("every autonomous action the governance layer forbids has a registered approval gate", async () => {
  const { db } = await world();
  const snapshot = await registry.aiToolRegistrySnapshot(db, { actor: staffActor, customerId: "CUS-1", intent: "support", channel: "chat" });
  for (const action of forbiddenAutonomousActions) {
    const code = registry.HIGH_IMPACT_TOOL_FOR_ACTION[action];
    assert.ok(code, `forbidden action "${action}" has no approval-gated tool code - the AI can be asked for it by another name`);
    assert.ok(snapshot.highImpactApprovalGated.includes(code), `${code} is not reported as approval-gated`);
  }
});

test("each high-impact tool is refused for execution, writes no request row, and is never permitted", async () => {
  for (const action of forbiddenAutonomousActions) {
    const code = registry.HIGH_IMPACT_TOOL_FOR_ACTION[action];
    const { sqlite, db } = await world();
    // Ask with an intent the tool actually accepts, so the refusal is the approval gate and not an
    // intent mismatch that would have refused any tool.
    const intents = { "refund.issue": "refund_review", "payment.capture": "booking_create", "payout.release": "support", "price.override": "service_info", "provider.assign": "booking_create", "campaign.activate": "coupon", "communication.send": "support", "customer.merge": "support" };
    const result = await registry.prepareAiToolExecution(db, {
      actor: staffActor, toolCode: code, threadId: "THREAD-1", customerId: "CUS-1",
      intent: intents[code], channel: "chat", arguments: { amount: 500 }, idempotencyKey: `high-impact-${code}`,
    });
    assert.equal(result.status, "approval_required", `${code} did not require approval`);
    assert.equal(result.executed, false);
    assert.equal(result.autonomousExecution, false);
    assert.deepEqual(rows(sqlite, "SELECT id FROM ai_tool_execution_requests"), [],
      `${code} left an execution request row behind - an approval-gated tool must not even be queued by the AI`);
  }
});

test("a full-permission founder actor cannot execute an approval-gated tool either", async () => {
  // "*" satisfies every staff permission check in the registry, so if approval gating were expressed
  // as a permission it would be bypassed here. It is expressed as a mode, which nothing can hold.
  const { sqlite, db } = await world();
  const result = await registry.prepareAiToolExecution(db, {
    actor: { ...staffActor, permissions: ["*"] }, toolCode: "refund.issue", threadId: "THREAD-1",
    customerId: "CUS-1", intent: "refund_review", channel: "chat", arguments: {}, idempotencyKey: "founder-refund",
  });
  assert.equal(result.status, "approval_required");
  assert.deepEqual(rows(sqlite, "SELECT id FROM ai_tool_execution_requests"), []);
});

// ---------------------------------------------------------------------------
// Forbidden and invalid tool calls
// ---------------------------------------------------------------------------
test("an unregistered tool code is refused", async () => {
  const { sqlite, db } = await world();
  for (const code of ["database.drop", "refund.issue.v2", "", "service_catalogue.read ", "__proto__"]) {
    await assert.rejects(
      registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: code, threadId: "THREAD-1", customerId: "CUS-1", intent: "support", channel: "chat", arguments: {} }),
      /AI tool is not registered/, `tool code ${JSON.stringify(code)} was not refused`);
  }
  assert.deepEqual(rows(sqlite, "SELECT id FROM ai_tool_execution_requests"), []);
});

test("a registered tool is refused for an intent or a channel it is not registered for", async () => {
  const { db } = await world();
  const wrongIntent = await registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "customer_bookings.read", threadId: "THREAD-1", customerId: "CUS-1", intent: "coupon", channel: "chat", arguments: {} }).catch(error => error);
  assert.ok(wrongIntent instanceof Response, "an intent mismatch must be a 403, not a silent allow");
  assert.equal(wrongIntent.status, 403);

  const wrongChannel = await registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "customer_bookings.read", threadId: "THREAD-1", customerId: "CUS-1", intent: "booking_status", channel: "sms", arguments: {} }).catch(error => error);
  assert.ok(wrongChannel instanceof Response);
  assert.equal(wrongChannel.status, 403);
});

test("arguments that try to set a server-authoritative value are refused before anything runs", async () => {
  const { sqlite, db } = await world();
  for (const field of ["price", "total", "totalAmount", "provider", "providerId", "walletBalance", "refundAmount", "paymentStatus", "payoutAmount", "discountAmount"]) {
    await assert.rejects(
      registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "quote.request", threadId: "THREAD-1", customerId: "CUS-1", intent: "booking_create", channel: "chat", arguments: { packageCode: "GRM-BASIC", [field]: 1 } }),
      new RegExp(`Authoritative field ${field} must be resolved server-side`), `${field} was accepted from the model`);
  }
  assert.deepEqual(rows(sqlite, "SELECT id FROM ai_tool_execution_requests"), []);
});

test("a quote is computed from the catalogue and cannot be steered by out-of-range arguments", async () => {
  const { db } = await world();
  const ok = await registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "quote.request", threadId: "THREAD-1", customerId: "CUS-1", intent: "booking_create", channel: "chat", arguments: { packageCode: (await import("../lib/grooming-governance.ts")).groomingCatalogue.find(item => item.active).code, petCount: 1 } });
  assert.equal(ok.status, "completed");
  assert.equal(ok.result.serverAuthoritative, true);
  assert.equal(ok.result.liveMoney, false);

  for (const petCount of [0, -1, 5, 999]) {
    await assert.rejects(
      registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "quote.request", threadId: "THREAD-1", customerId: "CUS-1", intent: "booking_create", channel: "chat", arguments: { packageCode: "GRM-BASIC", petCount } }),
      /pet count must be between 1 and 4|Active governed package not found/);
  }
});

test("a mutation without an idempotency key is refused rather than executed once per attempt", async () => {
  const { sqlite, db } = await world();
  await assert.rejects(
    registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "case.create", threadId: "THREAD-1", customerId: "CUS-1", intent: "support", channel: "chat", arguments: { title: "Help" } }),
    /Idempotency key is required for every AI tool mutation/);
  assert.deepEqual(rows(sqlite, "SELECT id FROM ai_tool_execution_requests"), []);
});

// ---------------------------------------------------------------------------
// Confirmation, idempotency and persistence
// ---------------------------------------------------------------------------
test("a mutation waits for explicit confirmation, then executes exactly once however often it is replayed", async () => {
  const { sqlite, db } = await world();
  const request = { actor: staffActor, toolCode: "case.create", threadId: "THREAD-1", customerId: "CUS-1", intent: "support", channel: "chat", arguments: { title: "Groomer was late", description: "Customer reported a late arrival" }, idempotencyKey: "case-once" };

  const first = await registry.prepareAiToolExecution(db, request);
  assert.equal(first.status, "confirmation_required");
  assert.equal(first.executed, false);
  assert.deepEqual(rows(sqlite, "SELECT id FROM unified_cases"), [], "nothing is created before the customer confirms");

  // Replaying the same prepare must not produce a second pending request.
  const replayed = await registry.prepareAiToolExecution(db, request);
  assert.equal(replayed.duplicatePrevented, true);
  assert.equal(replayed.requestId, first.requestId);
  assert.equal(rows(sqlite, "SELECT id FROM ai_tool_execution_requests").length, 1);

  const confirmed = await registry.confirmAiToolExecution(db, { actor: staffActor, requestId: first.requestId });
  assert.equal(confirmed.status, "completed");
  assert.equal(confirmed.executed, true);
  assert.equal(rows(sqlite, "SELECT id FROM unified_cases").length, 1, "exactly one case exists");

  const reconfirmed = await registry.confirmAiToolExecution(db, { actor: staffActor, requestId: first.requestId });
  assert.equal(reconfirmed.duplicatePrevented, true);
  assert.equal(rows(sqlite, "SELECT id FROM unified_cases").length, 1, "a replayed confirmation must not create a second case");
});

test("a customer cannot drive a tool against another customer's data", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-2", "Bala", "9876500002");
  const asha = customerActor(sqlite, "CUS-1");

  const crossCustomer = await registry.prepareAiToolExecution(db, { actor: asha, toolCode: "customer_bookings.read", threadId: "THREAD-1", customerId: "CUS-2", intent: "booking_status", channel: "chat", arguments: {} }).catch(error => error);
  assert.ok(crossCustomer instanceof Error || crossCustomer instanceof Response, "reading another customer's bookings must fail");

  // And a booking id from another customer is refused even under the caller's own customer scope.
  await assert.rejects(
    registry.prepareAiToolExecution(db, { actor: asha, toolCode: "booking_status.read", threadId: "THREAD-1", customerId: "CUS-1", intent: "booking_status", channel: "chat", arguments: { bookingId: "BKG-OTHER" } }),
    /Authorized canonical booking not found/);
});

test("the confirmation actor is checked, so one customer cannot confirm another's pending mutation", async () => {
  const { sqlite, db } = await world();
  seedCustomer(sqlite, "CUS-2", "Bala", "9876500002");
  const asha = customerActor(sqlite, "CUS-1");
  const bala = customerActor(sqlite, "CUS-2");
  const pending = await registry.prepareAiToolExecution(db, { actor: asha, toolCode: "case.create", threadId: "THREAD-1", customerId: "CUS-1", intent: "support", channel: "chat", arguments: { title: "Mine" }, idempotencyKey: "asha-case" });
  assert.equal(pending.status, "confirmation_required");

  const stolen = await registry.confirmAiToolExecution(db, { actor: bala, requestId: pending.requestId }).catch(error => error);
  assert.ok(stolen instanceof Response || stolen instanceof Error);
  assert.deepEqual(rows(sqlite, "SELECT id FROM unified_cases"), [], "the mutation must not run for the wrong actor");
});

// ---------------------------------------------------------------------------
// Audit evidence
// ---------------------------------------------------------------------------
test("audit rows carry the decision and a hash, never the arguments themselves", async () => {
  const { sqlite, db } = await world();
  const CANARY = "CANARY-customer-said-something-private";
  const prepared = await registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "case.create", threadId: "THREAD-1", customerId: "CUS-1", intent: "support", channel: "chat", arguments: { title: "Complaint", description: CANARY }, idempotencyKey: "audit-case" });
  await registry.confirmAiToolExecution(db, { actor: staffActor, requestId: prepared.requestId });

  const audits = rows(sqlite, "SELECT event_type,detail_json FROM ai_tool_audit_events ORDER BY created_at");
  assert.ok(audits.length >= 3, `expected the full decision trail, got ${audits.map(a => a.event_type).join(", ")}`);
  assert.deepEqual(audits.map(a => a.event_type), ["confirmation_requested", "explicitly_confirmed", "executed_mutation"]);
  for (const audit of audits) {
    assert.ok(!audit.detail_json.includes(CANARY), `argument text leaked into the ${audit.event_type} audit row: ${audit.detail_json}`);
  }
  const hashed = audits.find(a => a.event_type === "confirmation_requested");
  assert.match(JSON.parse(hashed.detail_json).argumentsHash, /^[0-9a-f]{64}$/, "the audit trail identifies the arguments by hash");
});

test("the same arguments hash to the same value and different arguments do not", async () => {
  // The audit trail's only handle on what was approved is this hash. If it collided across different
  // arguments, an approval for one thing would evidence an approval for another.
  const { sqlite, db } = await world();
  const run = async (args, key) => {
    const prepared = await registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "case.create", threadId: "THREAD-1", customerId: "CUS-1", intent: "support", channel: "chat", arguments: args, idempotencyKey: key });
    return sqlite.prepare("SELECT arguments_hash FROM ai_tool_execution_requests WHERE id=?").get(prepared.requestId).arguments_hash;
  };
  const a = await run({ title: "One", description: "same" }, "hash-a");
  const b = await run({ title: "One", description: "same" }, "hash-b");
  const c = await run({ title: "Two", description: "same" }, "hash-c");
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("a canonical-service rejection is recorded as a failure rather than silently swallowed", async () => {
  const { sqlite, db } = await world();
  // A reschedule request naming a booking that is not this customer's: the registry accepts the
  // prepare (the booking id is only read at execution) and the canonical service refuses it.
  const prepared = await registry.prepareAiToolExecution(db, { actor: staffActor, toolCode: "booking_reschedule.request", threadId: "THREAD-1", customerId: "CUS-1", intent: "booking_change", channel: "chat", arguments: { bookingId: "BKG-OTHER", request: "move to Friday" }, idempotencyKey: "reschedule-foreign" });
  assert.equal(prepared.status, "confirmation_required");
  await assert.rejects(registry.confirmAiToolExecution(db, { actor: staffActor, requestId: prepared.requestId }), /Authorized canonical booking not found/);

  const row = sqlite.prepare("SELECT status,policy_decision FROM ai_tool_execution_requests WHERE id=?").get(prepared.requestId);
  assert.equal(row.status, "failed");
  assert.equal(row.policy_decision, "canonical_service_rejected");
  const audit = rows(sqlite, "SELECT event_type FROM ai_tool_audit_events").map(a => a.event_type);
  assert.ok(audit.includes("canonical_service_rejected"), `the rejection is not in the audit trail: ${audit.join(", ")}`);
});
