/**
 * P1 RUNTIME CLOSURE TEST — AI cannot perform governed money or booking mutations.
 *
 * The AI surface (POST /api/ai-tools) exposes a registry of tools. The six high-impact ones —
 * refund.issue, payment.capture, payout.release, price.override, provider.assign, campaign.activate —
 * are mode:"approval_gated": prepareAiToolExecution refuses them for EVERY caller with
 * {status:"approval_required", executed:false, autonomousExecution:false} and writes nothing. Booking
 * mutations (booking.request) never touch canonical_bookings or capture money — they create a governed
 * unified_case that a human works, and only after an explicit second-step confirmation.
 *
 * This drives the REAL route handler over a real D1, as a REAL verified customer session (the "AI acting
 * for a customer" path), on a NON-LOCALHOST host so resolveActor cannot hand out a development-preview
 * superuser. No localhost shortcut, no source-regex — it invokes POST and reads the response + the DB.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__AIGOV_DB__", "__AIGOV_ENV__");

const HOST = "https://app.pawspace.in";
const CUSTOMER = "CUS-AI-1", PHONE = "+919000000777";

async function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__AIGOV_DB__ = db;
  globalThis.__AIGOV_ENV__ = {};
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: PHONE,
    subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified",
    actorId: "test", reason: "AI governance test",
  });
  return { sqlite, db };
}

async function customerCookie(db) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: PHONE,
    subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified",
    actorId: "test", reason: "session mint",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: CUSTOMER,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const post = (cookie, body) => new Request(`${HOST}/api/ai-tools`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const count = (sqlite, sql) => { try { return sqlite.prepare(sql).get().c; } catch { return 0; } };

// The six approval-gated money/booking-authority tools, each with an intent the tool actually permits
// (so the request clears the intent/channel checks and is refused on the MODE gate, not earlier).
const GATED = [
  { tool: "refund.issue", intent: "refund_review" },
  { tool: "payment.capture", intent: "booking_create" },
  { tool: "payout.release", intent: "support" },
  { tool: "price.override", intent: "service_info" },
  { tool: "provider.assign", intent: "booking_create" },
  { tool: "campaign.activate", intent: "coupon" },
];

for (const { tool, intent } of GATED) {
  test(`AI is refused the money/booking-authority tool "${tool}" — approval_required, nothing executed or written`, async () => {
    const { sqlite, db } = await freshDb();
    const cookie = await customerCookie(db);
    const { POST } = await import("../app/api/ai-tools/route.ts");
    const res = await POST(post(cookie, { action: "prepare", toolCode: tool, threadId: "th-1", customerId: CUSTOMER, intent, channel: "chat", idempotencyKey: `idem-${tool}` }));
    assert.equal(res.status, 200, `handler must respond, not error: ${res.status}`);
    const { data } = await res.json();
    assert.equal(data.status, "approval_required", `${tool} must be approval-gated`);
    assert.equal(data.executed, false, `${tool} must not execute`);
    assert.equal(data.autonomousExecution, false, `${tool} must never be autonomous`);
    // The refusal is BEFORE any persistence: no execution-request row exists for a gated tool.
    assert.equal(count(sqlite, `SELECT COUNT(*) c FROM ai_tool_execution_requests WHERE tool_code='${tool}'`), 0, `${tool} must persist no execution request`);
    // And no money/booking state was mutated.
    assert.equal(count(sqlite, "SELECT COUNT(*) c FROM canonical_bookings"), 0, "no booking created");
    assert.equal(count(sqlite, "SELECT COUNT(*) c FROM booking_payments"), 0, "no payment captured");
  });
}

test("CONTROL: a read tool DOES execute (the surface is not refusing everything)", async () => {
  const { db } = await freshDb();
  const cookie = await customerCookie(db);
  const { POST } = await import("../app/api/ai-tools/route.ts");
  const res = await POST(post(cookie, { action: "prepare", toolCode: "service_catalogue.read", threadId: "th-1", customerId: CUSTOMER, intent: "service_info", channel: "chat" }));
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.equal(data.status, "completed", "a read tool executes");
  assert.equal(data.executed, true);
  assert.equal(data.autonomousExecution, false, "even a read is never labelled autonomous");
});

test("CONTROL: booking.request creates a GOVERNED CASE, never a canonical booking or a money capture", async () => {
  const { sqlite, db } = await freshDb();
  const cookie = await customerCookie(db);
  const { POST } = await import("../app/api/ai-tools/route.ts");
  // Step 1: prepare -> confirmation_required (202), executed:false.
  const prep = await POST(post(cookie, { action: "prepare", toolCode: "booking.request", threadId: "th-1", customerId: CUSTOMER, intent: "booking_create", channel: "chat", idempotencyKey: "bk-1", arguments: { request: "Please book grooming Saturday" } }));
  assert.equal(prep.status, 202, "a mutation requires an explicit second-step confirmation");
  const prepData = (await prep.json()).data;
  assert.equal(prepData.executed, false, "prepare never executes the mutation");
  assert.equal(prepData.status, "confirmation_required");
  // Step 2: explicit confirm -> executes into a governed case, NOT a booking.
  const conf = await POST(post(cookie, { action: "confirm", requestId: prepData.requestId }));
  assert.equal(conf.status, 200);
  const confData = (await conf.json()).data;
  assert.equal(confData.executed, true, "the governed case is created on explicit confirmation");
  assert.equal(confData.autonomousExecution, false);
  // The invariant: a booking request never becomes a booking or a payment; it becomes a human-worked case.
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM canonical_bookings"), 0, "AI never writes canonical_bookings");
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM booking_payments"), 0, "AI never captures money");
  assert.equal(count(sqlite, "SELECT COUNT(*) c FROM unified_cases WHERE source_type='ai_tool_request'"), 1, "exactly one governed case was created for a human to work");
});
