import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__GROOM_PROVIDER_DB__", "__GROOM_PROVIDER_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => {
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : row;
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes || 0) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

async function providerCookie(db, providerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp",
    principalType: "identity_subject",
    principalKey: `provider:${providerId}`,
    subjectType: "provider",
    subjectId: providerId,
    verificationState: "verified",
    actorId: "journey-test",
    reason: "authenticated Grooming provider journey closure",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id),
    identitySource: "partner_otp",
    principalType: "identity_subject",
    principalKey: String(binding.principal_key),
    subjectType: "provider",
    subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function setup() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__GROOM_PROVIDER_DB__ = db;
  globalThis.__GROOM_PROVIDER_ENV__ = {};

  const now = Date.now();
  sqlite.exec(`
    CREATE TABLE canonical_customers (
      id TEXT PRIMARY KEY, city_id TEXT NOT NULL, name TEXT NOT NULL,
      primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT,
      source TEXT NOT NULL DEFAULT 'customer_app', consent_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE canonical_pets (
      id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT NOT NULL,
      species TEXT NOT NULL, breed TEXT, vaccination_status TEXT NOT NULL DEFAULT 'not_provided',
      source_pet_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE canonical_bookings (
      id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL,
      pet_ids_json TEXT NOT NULL, source_pet_ids_json TEXT NOT NULL, city_id TEXT NOT NULL,
      zone_id TEXT NOT NULL, service_code TEXT NOT NULL, package_code TEXT NOT NULL,
      package_name TEXT NOT NULL, schedule_group_id TEXT NOT NULL UNIQUE, provider_id TEXT NOT NULL,
      scheduled_start TEXT NOT NULL, scheduled_end TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'confirmed',
      channel TEXT NOT NULL DEFAULT 'customer_app', total_amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'INR', pricing_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE provider_work_orders (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, schedule_group_id TEXT NOT NULL,
      provider_id TEXT NOT NULL, provider_name TEXT NOT NULL, provider_model TEXT NOT NULL,
      service_code TEXT NOT NULL, scheduled_start TEXT NOT NULL, scheduled_end TEXT NOT NULL,
      occurrence_count INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'assigned',
      assignment_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE booking_payments (
      id TEXT PRIMARY KEY, booking_id TEXT NOT NULL UNIQUE, customer_id TEXT NOT NULL,
      amount REAL NOT NULL, amount_due_now REAL NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
      method TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL,
      gateway TEXT NOT NULL DEFAULT 'uat_sandbox', idempotency_key TEXT NOT NULL UNIQUE,
      detail_json TEXT NOT NULL DEFAULT '{}', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
  `);

  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run("CUS-GROOM-1", "blr", "Ananya Sharma", "9999900601", null, "ananya@example.test", "customer_app", "{}", now, now);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("PET-GROOM-1", "CUS-GROOM-1", "Milo", "dog", "Labrador", "vaccinated", "SRC-MILO", now, now);

  const insertBooking = sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertBooking.run("BK-GROOM-JOURNEY", "ik-groom-journey", "CUS-GROOM-1", JSON.stringify(["PET-GROOM-1"]), JSON.stringify(["SRC-MILO"]), "blr", "blr-east", "grooming", "dog-basic", "Bath & Basic", "GRP-GROOM-JOURNEY", "PRV-GROOM-A", "2026-08-22T04:30:00.000Z", "2026-08-22T06:30:00.000Z", "confirmed", "customer_app", 1899, "INR", "{}", "customer:CUS-GROOM-1", now, now);
  insertBooking.run("BK-GROOM-OTHER", "ik-groom-other", "CUS-GROOM-1", JSON.stringify(["PET-GROOM-1"]), JSON.stringify(["SRC-MILO"]), "blr", "blr-east", "grooming", "dog-basic", "Bath & Basic", "GRP-GROOM-OTHER", "PRV-GROOM-B", "2026-08-22T07:30:00.000Z", "2026-08-22T09:30:00.000Z", "confirmed", "customer_app", 1899, "INR", "{}", "customer:CUS-GROOM-1", now, now);

  const insertWork = sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertWork.run("WO-GROOM-JOURNEY", "BK-GROOM-JOURNEY", "GRP-GROOM-JOURNEY", "PRV-GROOM-A", "Arun Groomer", "full_time", "grooming", "2026-08-22T04:30:00.000Z", "2026-08-22T06:30:00.000Z", 1, "assigned", "{}", now, now);
  insertWork.run("WO-GROOM-OTHER", "BK-GROOM-OTHER", "GRP-GROOM-OTHER", "PRV-GROOM-B", "Bala Groomer", "full_time", "grooming", "2026-08-22T07:30:00.000Z", "2026-08-22T09:30:00.000Z", 1, "assigned", "{}", now, now);

  const insertPayment = sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
  insertPayment.run("PAY-GROOM-JOURNEY", "BK-GROOM-JOURNEY", "CUS-GROOM-1", 1899, 0, "INR", "cash", "pay_after_service", "created", "uat_sandbox", "pik-groom-journey", "{}", now, now);
  insertPayment.run("PAY-GROOM-OTHER", "BK-GROOM-OTHER", "CUS-GROOM-1", 1899, 0, "INR", "cash", "pay_after_service", "created", "uat_sandbox", "pik-groom-other", "{}", now, now);

  return { sqlite, db };
}

async function listJobs(cookie, providerId) {
  const { GET } = await import("../app/api/partner-grooming-jobs/route.ts");
  const response = await GET(new Request(`https://uat.pawspace.in/api/partner-grooming-jobs?providerId=${encodeURIComponent(providerId)}`, { headers: { cookie } }));
  return { status: response.status, body: await response.json() };
}

async function lifecycle(cookie, action) {
  const { POST } = await import("../app/api/grooming-lifecycle/route.ts");
  const response = await POST(new Request("https://uat.pawspace.in/api/grooming-lifecycle", {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({ bookingId: "BK-GROOM-JOURNEY", action }),
  }));
  return { status: response.status, body: await response.json() };
}

test("authenticated groomer sees the correct assigned booking with minimized customer contact data", async () => {
  const { db } = await setup();
  const cookie = await providerCookie(db, "PRV-GROOM-A");
  const result = await listJobs(cookie, "PRV-GROOM-A");

  assert.equal(result.status, 200);
  assert.equal(result.body.jobs.length, 1);
  assert.equal(result.body.jobs[0].bookingId, "BK-GROOM-JOURNEY");
  assert.equal(result.body.jobs[0].providerId, "PRV-GROOM-A");
  assert.equal(result.body.jobs.some((job) => job.bookingId === "BK-GROOM-OTHER"), false, "provider A must never receive provider B's booking");
  assert.equal(result.body.jobs[0].customer.name, "Ananya");
  assert.equal(result.body.jobs[0].customer.maskedPhone, "+91 ••••••0601");
  assert.equal(result.body.jobs[0].pets[0].name, "Milo");
  const serialized = JSON.stringify(result.body);
  assert.equal(serialized.includes("9999900601"), false, "raw customer phone must not reach the provider payload");
  assert.equal(serialized.includes("Ananya Sharma"), false, "full customer name must not reach the provider payload");
  assert.equal(serialized.includes("ananya@example.test"), false, "customer email must not reach the provider payload");
});

test("authenticated groomer can accept, start journey, arrive, and start service with synchronized canonical state", async () => {
  const { sqlite, db } = await setup();
  const cookie = await providerCookie(db, "PRV-GROOM-A");
  const steps = [
    ["accept", "assigned", "booking_assigned"],
    ["on_the_way", "on_the_way", "booking_on_the_way"],
    ["arrived", "arrived", "booking_arrived"],
    ["start_service", "in_service", "booking_in_service"],
  ];

  for (const [action, expectedStatus, expectedEvent] of steps) {
    const result = await lifecycle(cookie, action);
    assert.equal(result.status, 200, `${action} should succeed: ${JSON.stringify(result.body)}`);
    assert.equal(String(result.body.data.booking.status), expectedStatus);
    assert.equal(String(result.body.data.booking.work_order_status), expectedStatus);

    const booking = sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-GROOM-JOURNEY'").get();
    const work = sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id='BK-GROOM-JOURNEY'").get();
    assert.equal(booking.status, expectedStatus, `${action} must update canonical booking status`);
    assert.equal(work.status, expectedStatus, `${action} must update provider work-order status`);

    const event = sqlite.prepare("SELECT event_type,actor_id FROM booking_lifecycle_events WHERE booking_id=? AND event_type=? ORDER BY occurred_at DESC LIMIT 1").get("BK-GROOM-JOURNEY", expectedEvent);
    assert.equal(event.event_type, expectedEvent, `${action} must emit its lifecycle event`);
    assert.equal(event.actor_id, "provider:PRV-GROOM-A", `${action} event must be attributable to the authenticated provider`);
  }

  const actions = sqlite.prepare(`SELECT action,outcome FROM security_audit_events WHERE resource_id='BK-GROOM-JOURNEY'
    ORDER BY CASE action
      WHEN 'grooming.accept' THEN 1
      WHEN 'grooming.on_the_way' THEN 2
      WHEN 'grooming.arrived' THEN 3
      WHEN 'grooming.start_service' THEN 4
      ELSE 99 END`).all();
  assert.deepEqual(actions.map((row) => [row.action, row.outcome]), [
    ["grooming.accept", "completed"],
    ["grooming.on_the_way", "completed"],
    ["grooming.arrived", "completed"],
    ["grooming.start_service", "completed"],
  ]);
});

test("another authenticated provider cannot list or mutate the groomer's booking", async () => {
  const { sqlite, db } = await setup();
  const otherCookie = await providerCookie(db, "PRV-GROOM-B");

  const list = await listJobs(otherCookie, "PRV-GROOM-A");
  assert.equal(list.status, 403);

  const mutation = await lifecycle(otherCookie, "on_the_way");
  assert.equal(mutation.status, 403);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-GROOM-JOURNEY'").get().status, "confirmed");
  assert.equal(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id='BK-GROOM-JOURNEY'").get().status, "assigned");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_lifecycle_events WHERE booking_id='BK-GROOM-JOURNEY'").get().c, 0);
});