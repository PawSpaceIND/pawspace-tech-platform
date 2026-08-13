/**
 * GET /api/booking-operations — the provider read boundary.
 *
 * The handler resolved no actor at all. Any caller the gateway let through could pass any bookingId and
 * receive that booking's operational events, the message sent to its customer, its rebooking case and
 * its refund case: amount, reason, and the internal address that requested it. A provider reading a
 * rival's job also read a named VIP customer and a CX complaint.
 *
 * Authenticated as the REAL roles through the workspace identity path, following
 * tests/package-upgrade-security-boundary.test.mjs. NOT the development-preview host: that resolves a
 * superuser holding "*", which would pass every check by construction and prove nothing.
 *
 * Every seeded value below is distinctive, so a leak is identified by the specific string that escaped
 * rather than by an array length. The cross-provider assertions check the response BODY for those
 * strings, because "refused" has to mean the data did not come back, not merely that a status changed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOPGET_DB__", "__BOPGET_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const sqlite = new DatabaseSync(":memory:");
globalThis.__BOPGET_DB__ = makeD1(sqlite);
globalThis.__BOPGET_ENV__ = {};
const route = await import("../app/api/booking-operations/route.ts");

/** Values that must never cross the provider boundary. Each is unique to Booking B. */
const SECRET_B = {
  reason: "Traffic on Outer Ring Road",
  customer: "CUS-VIP",
  message: "Your provider is running about 30 minutes late.",
  refundReason: "service complaint - groomer was rude",
  requestedBy: "cx@pawspace.test",
  refundAmount: 7500,
  rebookReason: "customer asked to move to Saturday",
};
const SECRET_A = { reason: "Provider A own note - late start", customer: "CUS-A" };

const ACTORS = {
  providerA: { email: "provider.a@pawspace.test", role: "service_provider", providerId: "PRV-A" },
  providerB: { email: "provider.b@pawspace.test", role: "service_provider", providerId: "PRV-B" },
  manager: { email: "manager@pawspace.test", role: "manager", providerId: null },
  admin: { email: "admin@pawspace.test", role: "admin", providerId: null },
  associate: { email: "associate@pawspace.test", role: "associate", providerId: null },
  unprovisioned: { email: "nobody@pawspace.test", role: null, providerId: null },
  disabled: { email: "suspended.provider@pawspace.test", role: "service_provider", providerId: "PRV-A", status: "suspended" },
};

const get = (actor, bookingId) => route.GET(new Request(`https://app.pawspace.test/api/booking-operations?bookingId=${bookingId}`, {
  headers: { "oai-authenticated-user-email": actor.email },
}));

/** Runs the request and returns status plus the raw body text, so leaks are searchable. */
async function read(actor, bookingId) {
  const response = await get(actor, bookingId);
  const body = await response.text();
  return { status: response.status, body, json: (() => { try { return JSON.parse(body); } catch { return null; } })() };
}

async function seed() {
  // One bootstrap POST lets the route create its own tables, so the fixture cannot disagree with
  // production about their shape.
  await route.POST(new Request("https://app.pawspace.test/api/booking-operations", {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": ACTORS.providerA.email },
    body: JSON.stringify({ bookingId: "BOOTSTRAP", providerId: "PRV-A", action: "running_late", reason: "bootstrap only" }),
  })).catch(() => {});
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,provider_id TEXT,service_code TEXT,package_name TEXT,status TEXT,total_amount REAL,pricing_json TEXT DEFAULT '{}',scheduled_start TEXT,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_identity_links (email TEXT PRIMARY KEY, provider_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', verified_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  const now = Date.now();
  for (const table of ["canonical_bookings", "provider_identity_links", "app_users", "booking_operational_events", "booking_customer_notifications", "booking_rebooking_cases", "booking_refund_cases"]) {
    sqlite.exec(`DELETE FROM ${table}`);
  }
  for (const actor of Object.values(ACTORS)) {
    if (!actor.role) continue;
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(`U-${actor.email}`, actor.email, actor.email, actor.role, actor.status ?? "active", now, now);
    if (actor.providerId) sqlite.prepare("INSERT INTO provider_identity_links (email,provider_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)").run(actor.email, actor.providerId, now, now);
  }
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-A',?,'PRV-A','grooming','Standard groom','confirmed',5000,'{}','2026-09-01T09:00:00.000Z',?)").run(SECRET_A.customer, now);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('BK-B',?,'PRV-B','grooming','Standard groom','confirmed',9000,'{}','2026-09-02T09:00:00.000Z',?)").run(SECRET_B.customer, now);

  // Booking B: identifiable rows in all four sensitive tables.
  sqlite.prepare("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES ('EV-B','BK-B','PRV-B','running_late',?,30,'{}','provider.b@pawspace.test',?)").run(SECRET_B.reason, now);
  sqlite.prepare("INSERT INTO booking_customer_notifications (id,booking_id,customer_id,channel,template_code,message,status,event_id,created_at) VALUES ('NT-B','BK-B',?,'whatsapp','running_late',?,'queued','EV-B',?)").run(SECRET_B.customer, SECRET_B.message, now);
  sqlite.prepare("INSERT INTO booking_rebooking_cases (id,booking_id,source_event_id,status,reason,eligible_at,created_at,updated_at) VALUES ('RB-B','BK-B','EV-B','offered',?,?,?,?)").run(SECRET_B.rebookReason, now, now, now);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,payment_id,amount,reason,status,requested_by,created_at,updated_at) VALUES ('RF-B','BK-B','PAY-B',?,?,'requested',?,?,?)").run(SECRET_B.refundAmount, SECRET_B.refundReason, SECRET_B.requestedBy, now, now);
  // Booking A: one distinctive row of its own, so "own data returned" is also a positive assertion.
  sqlite.prepare("INSERT INTO booking_operational_events (id,booking_id,provider_id,event_type,reason,impact_minutes,detail_json,actor_id,created_at) VALUES ('EV-A','BK-A','PRV-A','running_late',?,10,'{}','provider.a@pawspace.test',?)").run(SECRET_A.reason, now);
}

/** Fails if ANY value that belongs to Booking B appears in the body. */
function assertNoLeakOfB(label, body) {
  for (const [field, value] of Object.entries(SECRET_B)) {
    assert.ok(!body.includes(String(value)), `${label}: leaked Booking B's ${field} (${value})`);
  }
}

test("own provider reads its own booking", async () => {
  await seed();
  const a = await read(ACTORS.providerA, "BK-A");
  assert.equal(a.status, 200, `Provider A -> Booking A must be 200, got ${a.status}: ${a.body.slice(0, 160)}`);
  assert.ok(a.body.includes(SECRET_A.reason), "Provider A must see its own operational event");

  const b = await read(ACTORS.providerB, "BK-B");
  assert.equal(b.status, 200, `Provider B -> Booking B must be 200, got ${b.status}`);
  assert.ok(b.body.includes(SECRET_B.reason), "Provider B must see its own operational event");
  assert.ok(b.body.includes(String(SECRET_B.refundAmount)), "and its own refund case");
});

test("THE BOUNDARY: Provider A cannot read Provider B's booking", async () => {
  await seed();
  const result = await read(ACTORS.providerA, "BK-B");
  console.error(`Provider A -> Booking B : HTTP ${result.status} :: ${result.body.slice(0, 180)}`);
  assert.notEqual(result.status, 200, `Provider A must be refused Booking B, got HTTP ${result.status}`);
  assert.equal(result.status, 403, `the refusal must be a 403, got ${result.status}`);
  assertNoLeakOfB("Provider A -> Booking B", result.body);
});

test("THE BOUNDARY, other direction: Provider B cannot read Provider A's booking", async () => {
  await seed();
  const result = await read(ACTORS.providerB, "BK-A");
  console.error(`Provider B -> Booking A : HTTP ${result.status}`);
  assert.equal(result.status, 403, `Provider B must be refused Booking A, got ${result.status}`);
  assert.ok(!result.body.includes(SECRET_A.reason), "Provider B must not see Provider A's operational event");
});

test("privileged staff keep cross-booking access", async () => {
  // Securing the route must not break Ops. manager and admin hold bookings.manage/providers.manage.
  await seed();
  for (const actor of [ACTORS.manager, ACTORS.admin]) {
    for (const booking of ["BK-A", "BK-B"]) {
      const result = await read(actor, booking);
      assert.equal(result.status, 200, `${actor.role} -> ${booking} must remain 200, got ${result.status}: ${result.body.slice(0, 140)}`);
    }
  }
  const managerOnB = await read(ACTORS.manager, "BK-B");
  assert.ok(managerOnB.body.includes(SECRET_B.refundReason), "a manager legitimately sees the refund case");
});

test("an associate is refused, and that is the recorded decision", async () => {
  // associate holds bookings.view but is not a provider identity and has no booking assignment to be
  // scoped by. No client in this repository performs this GET, so there is no associate consumer to
  // preserve. Documented as a decision rather than resolved by granting global booking read.
  await seed();
  const result = await read(ACTORS.associate, "BK-B");
  console.error(`associate -> Booking B : HTTP ${result.status}`);
  assert.equal(result.status, 403, `an associate must not read an arbitrary booking, got ${result.status}`);
  assertNoLeakOfB("associate -> Booking B", result.body);
});

test("unprovisioned and suspended identities are refused", async () => {
  await seed();
  const unknown = await read(ACTORS.unprovisioned, "BK-B");
  console.error(`unprovisioned -> Booking B : HTTP ${unknown.status}`);
  assert.notEqual(unknown.status, 200, `an identity with no app_users row must be refused, got ${unknown.status}`);
  assertNoLeakOfB("unprovisioned -> Booking B", unknown.body);

  const suspended = await read(ACTORS.disabled, "BK-A");
  console.error(`suspended provider -> Booking A : HTTP ${suspended.status}`);
  assert.notEqual(suspended.status, 200, `a suspended account must be refused, got ${suspended.status}`);
  assert.ok(!suspended.body.includes(SECRET_A.reason), "a suspended provider must not read its former booking");
});

test("a missing booking is a 404, not an ownership oracle", async () => {
  await seed();
  const result = await read(ACTORS.providerA, "BK-DOES-NOT-EXIST");
  assert.equal(result.status, 404, `an unknown booking must 404, got ${result.status}`);
});

test("ownership is established BEFORE the sensitive tables are read", async () => {
  // Not a source assertion: the four tables are dropped, so any query against them throws. A handler
  // that authorised first refuses with 403; one that queried first would surface a 500 instead.
  await seed();
  for (const table of ["booking_operational_events", "booking_customer_notifications", "booking_rebooking_cases", "booking_refund_cases"]) {
    sqlite.exec(`DROP TABLE IF EXISTS ${table}`);
  }
  const result = await read(ACTORS.providerA, "BK-B");
  console.error(`query-order probe (sensitive tables dropped) -> HTTP ${result.status} :: ${result.body.slice(0, 120)}`);
  assert.equal(result.status, 403, `the refusal must happen before those tables are touched, got ${result.status}`);
  await seed();
});
