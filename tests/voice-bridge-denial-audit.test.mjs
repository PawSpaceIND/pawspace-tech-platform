import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makeD1, freshSqlite, uatVoiceEnv } from "./helpers/voice-harness.mjs";

// ---------------------------------------------------------------------------
// A refused masked call has to leave a trace.
//
// lib/api-gateway.ts maps /api/communications/voice/bridge to `return null`, and that
// mapping is CORRECT: the customer and service_provider roles share no permission
// (customer: pricing.view, scheduling.book — service_provider: bookings.view,
// communications.call, ...), so no single gateway permission can admit both parties the
// feature exists to connect. But authorizeApiRequest returns a `public` actor on null,
// and auditApiResponse skips a null permission or a public actor — so the gateway records
// nothing for this path at all.
//
// That made the route the only possible recorder, and it recorded only success. A provider
// walking booking ids hunting for one with an open service window — exactly the abuse a
// number-masking feature must resist — produced 403s and not one audit row.
//
// Driven on a real host: a preview host would mint a superuser actor holding ["*"] and make
// every assertion here vacuous.
// ---------------------------------------------------------------------------

installWorkersHooks("__VBDA_DB__", "__VBDA_ENV__");
const HOST = "https://ops.pawspace.example";
const serverAuth = await import("../lib/server-auth.ts");

const ROLES = {
  service_provider: ["bookings.view", "scheduling.view", "communications.call", "communications.message", "self_service.view"],
  customer: ["pricing.view", "scheduling.book"],
};

async function fresh() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__VBDA_DB__ = db;
  globalThis.__VBDA_ENV__ = uatVoiceEnv();
  await serverAuth.ensureSecurityTables(db);
  const now = Date.now();
  for (const [role, permissions] of Object.entries(ROLES)) {
    sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,?)").run(role, role, role, JSON.stringify(permissions), now);
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").run(`USR-${role}`, `${role}@pawspace.in`, role, role, now, now);
  }
  // A booking whose service window is OPEN, so the refusal under test is the ownership check
  // rather than the window — otherwise this would pass for the wrong reason.
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,status TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,primary_phone TEXT)");
  sqlite.exec("CREATE TABLE canonical_providers (id TEXT PRIMARY KEY,phone TEXT)");
  sqlite.exec("CREATE TABLE provider_work_orders (booking_id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-1','CUST-1','PRV-OWNER','assigned')").run();
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUST-1','+919000000001')").run();
  sqlite.prepare("INSERT INTO canonical_providers VALUES ('PRV-OWNER','+919000000002')").run();
  sqlite.prepare("INSERT INTO provider_work_orders VALUES ('BK-1','PRV-OWNER','accepted')").run();
  return { sqlite, db };
}

async function post(body, role) {
  const route = await import("../app/api/communications/voice/bridge/route.ts");
  const response = await route.POST(new Request(`${HOST}/api/communications/voice/bridge`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(role ? { "oai-authenticated-user-email": `${role}@pawspace.in` } : {}) },
    body: JSON.stringify(body),
  }));
  return { status: response.status };
}

const auditRows = (sqlite) =>
  sqlite.prepare("SELECT actor_email,action,resource_id,outcome FROM security_audit_events WHERE action='communications.voice.bridge' ORDER BY created_at").all();

// --- VBDA-01 --------------------------------------------------------------
test("VBDA-01: a provider refused ownership of the booking is recorded, with the booking they tried", async () => {
  const { sqlite } = await fresh();
  const result = await post({ bookingId: "BK-1", idempotencyKey: "probe-1" }, "service_provider");
  assert.equal(result.status, 403, "an unlinked provider must not reach the dial");

  const rows = auditRows(sqlite);
  assert.equal(rows.length, 1, "the refusal must be recorded exactly once");
  assert.equal(rows[0].outcome, "denied");
  assert.equal(rows[0].resource_id, "BK-1", "the audit has to name the booking that was probed, or it cannot show enumeration");
  assert.equal(rows[0].actor_email, "service_provider@pawspace.in");
});

// --- VBDA-02 --------------------------------------------------------------
// Enumeration is a PATTERN. One recorded refusal is not enough if the next nine vanish.
test("VBDA-02: repeated probing across booking ids leaves one row per attempt", async () => {
  const { sqlite } = await fresh();
  for (let index = 0; index < 5; index += 1) {
    await post({ bookingId: `BK-${index}`, idempotencyKey: `probe-${index}` }, "service_provider");
  }
  const rows = auditRows(sqlite);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows.map((row) => row.resource_id), ["BK-0", "BK-1", "BK-2", "BK-3", "BK-4"]);
  assert.ok(rows.every((row) => row.outcome === "denied" || row.outcome === "rejected"));
});

// --- VBDA-03 --------------------------------------------------------------
// The audit must not become a way to change the answer. A refusal stays a refusal.
test("VBDA-03: auditing a denial does not alter the status the caller receives", async () => {
  const { sqlite } = await fresh();
  const result = await post({ bookingId: "BK-1", idempotencyKey: "probe-x" }, "service_provider");
  assert.equal(result.status, 403);
  assert.equal(auditRows(sqlite).length, 1);
});

// --- VBDA-04 --------------------------------------------------------------
// Nothing is attributed to an identity that was never established.
test("VBDA-04: an anonymous caller is refused and attributed to nobody", async () => {
  const { sqlite } = await fresh();
  const result = await post({ bookingId: "BK-1", idempotencyKey: "anon-1" }, null);
  assert.ok(result.status >= 400, "anonymous must be refused");
  assert.equal(auditRows(sqlite).length, 0, "there is no identity to attribute this attempt to");
});
