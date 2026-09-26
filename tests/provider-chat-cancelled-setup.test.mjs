/**
 * Staging: the Pet Sitting workspace polls GET /api/provider-chat every 7 s, and the route answered
 * Cloudflare's "Worker threw exception" (500, error 1101) for sit_neha.
 *
 * Root cause: the route's schema guard (ensureTrustSafetyTables -> lib/d1-ensure-once.js) cached the
 * FIRST request's in-flight setup promise per isolate and handed it to every later request. The Workers
 * runtime cancels a request's unfinished I/O when the request goes away (a navigation, an aborted poll),
 * and a cancelled promise never settles, so every later chat request on that isolate waited on it until
 * the runtime killed the hung request. The same shared-promise shape sat in the finance bootstrap that
 * worker/index.ts awaits before every API request.
 *
 * Reproduced here with a D1 binding whose trust-and-safety setup batch never settles for the first
 * request (exactly what a cancelled request leaves behind), then a second request on the same binding.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installAiHooks, freshAiDb, seedCustomer } from "./helpers/ai-harness.mjs";
installAiHooks();
const { ensureCommunicationTables } = await import("../lib/communication-engine.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { GET } = await import("../app/api/provider-chat/route.ts");
const finance = await import("../lib/financial-runtime-bootstrap.ts");
const financeSchema = await import("../lib/financial-runtime-schema.ts");

const never = () => new Promise(() => {});
const within = (promise, ms = 2000) => Promise.race([promise, new Promise((resolve) => setTimeout(() => resolve("timeout"), ms))]);

/** The same D1 binding, except that while `stalled` matches a batch, that batch never settles (a cancelled request's I/O). */
function stallable(inner) {
  let stalled = null;
  const wrap = (statement, sql) => ({ __sql: sql, __inner: statement, bind: (...values) => wrap(statement.bind(...values), sql), first: (...args) => statement.first(...args), run: () => statement.run(), all: () => statement.all() });
  const db = {
    prepare: (sql) => wrap(inner.prepare(sql), sql),
    batch: (items) => stalled && items.some((item) => stalled.test(String(item.__sql || ""))) ? never() : inner.batch(items.map((item) => item.__inner ?? item)),
    exec: (sql) => inner.exec(sql),
  };
  return { db, stall: (pattern) => { stalled = pattern; } };
}

async function sitterWorld() {
  const { sqlite, db } = freshAiDb({ PAWSPACE_DEPLOYMENT_ENV: "e2e" });
  seedCustomer(sqlite, "CUS-SIT-CHAT", "Nandini Rao", "9876500011");
  await ensureCommunicationTables(db);
  const now = Date.now();
  // A Pet Sitting booking: its assignment lives on canonical_bookings (no grooming provider_work_orders row).
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,package_name,status,scheduled_start,scheduled_end,total_amount,provider_id) VALUES ('BK-SIT-CHAT','CUS-SIT-CHAT','pet_sitting','Home Visit','confirmed','2026-10-01T05:30:00.000Z','2026-10-01T06:30:00.000Z',399,'sit_neha')").run();
  sqlite.prepare("INSERT INTO communication_threads (id,customer_id,booking_id,status,created_at,updated_at) VALUES ('THREAD-BOOKING-BK-SIT-CHAT','CUS-SIT-CHAT','BK-SIT-CHAT','open',?,?)").run(now, now);
  sqlite.prepare("INSERT INTO communication_messages (id,thread_id,customer_id,direction,channel,purpose,template_key,payload_json,status,idempotency_key,policy_json,created_by,created_at,updated_at) VALUES ('MSG-SIT-CHAT','THREAD-BOOKING-BK-SIT-CHAT','CUS-SIT-CHAT','inbound','chat','transactional','customer_caregiver_chat',?,'received','sit-chat-1','{}','customer',?,?)").run(JSON.stringify({ text: "Bruno eats at 7" }), now, now);
  const identitySource = "provider_otp", principalType = "identity_subject", principalKey = "provider:sit_neha", subjectType = "provider";
  const binding = await upsertIdentityBinding(db, { identitySource, principalType, principalKey, subjectType, subjectId: "sit_neha", verificationState: "verified", actorId: "test", reason: "Sitter chat regression" });
  const session = await issuePlatformSession(db, { bindingId: String(binding.id), identitySource, principalType, principalKey, subjectType, subjectId: "sit_neha" });
  const cookie = `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}`;
  const request = () => new Request("https://pawspace.test/api/provider-chat?bookingId=BK-SIT-CHAT&providerId=sit_neha", { headers: { cookie } });
  return { sqlite, db, request };
}

test("a sitter's chat read answers even after an earlier request was cancelled mid schema setup", async (t) => {
  const world = await sitterWorld();
  t.after(() => world.sqlite.close());
  const binding = stallable(world.db);
  globalThis.__AI_DB__ = binding.db;
  // Request 1 is cancelled while the trust-and-safety tables are being ensured: its batch never settles.
  binding.stall(/trust_safety_events/);
  void GET(world.request());
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Request 2 on the same isolate and binding: it must not inherit request 1's unsettled promise.
  binding.stall(null);
  const response = await within(GET(world.request()));
  assert.notEqual(response, "timeout", "GET /api/provider-chat hung behind a cancelled request's schema setup (staging: Worker threw exception)");
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  assert.equal(body.data.bookingId, "BK-SIT-CHAT");
  assert.equal(body.data.messages[0].payload.text, "Bruno eats at 7");
  assert.equal(typeof body.data.messages[0].createdAt, "number", "the chat client reads createdAt, which the route returns");
});

test("the per-request finance bootstrap never makes a later request wait on a cancelled one", async (t) => {
  const { sqlite, db } = freshAiDb();
  t.after(() => sqlite.close());
  finance.resetFinancialRuntimeSchemaForTests();
  const binding = stallable(db);
  binding.stall(/CREATE TABLE IF NOT EXISTS payment_intents/);
  void finance.ensureFinancialRuntimeSchema(binding.db);
  void financeSchema.ensureFinancialRuntimeTables(binding.db);
  await new Promise((resolve) => setTimeout(resolve, 20));
  binding.stall(null);
  assert.notEqual(await within(finance.ensureFinancialRuntimeSchema(binding.db).then(() => "settled")), "timeout", "worker/index.ts awaits this before every API request");
  assert.notEqual(await within(financeSchema.ensureFinancialRuntimeTables(binding.db).then(() => "settled")), "timeout");
  finance.resetFinancialRuntimeSchemaForTests();
});

test("the chat client reads the route's createdAt and survives a non-JSON error page", async () => {
  const { readFileSync } = await import("node:fs");
  const client = readFileSync(new URL("../app/mobile-app/caregiver-conversation.tsx", import.meta.url), "utf8");
  assert.match(client, /createdAt:Number\(m\.createdAt\?\?m\.created_at\)/);
  assert.match(client, /await r\.json\(\)\.catch\(/, "an HTML 500 page must become a readable retry message, not a JSON parse error");
});
