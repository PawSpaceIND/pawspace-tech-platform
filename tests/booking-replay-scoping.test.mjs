import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__REPLAY_DB__", "__REPLAY_ENV__");

function makeD1(sqlite, controller) {
  const statement = (sql, args) => ({
    sql, args,
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      if (controller.beforeBookingWrite && list.some((item) => /^INSERT INTO canonical_bookings\b/.test(item.sql))) {
        const hook = controller.beforeBookingWrite;
        controller.beforeBookingWrite = null;
        hook();
      }
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const item of list) out.push(await item.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const BOOKING_DDL = [
  "CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,provider_id TEXT NOT NULL,provider_name TEXT NOT NULL,provider_model TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,occurrence_count INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'assigned',assignment_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE walking_sessions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,occurrence_number INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',handover_status TEXT NOT NULL DEFAULT 'pending',completion_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE taxi_trips (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,origin_label TEXT NOT NULL,destination_label TEXT NOT NULL,route_code TEXT NOT NULL,synthetic_distance_km REAL NOT NULL,estimated_duration_minutes INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',vehicle_id TEXT,pickup_verification_status TEXT NOT NULL DEFAULT 'pending',dropoff_verification_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)",
  "CREATE TABLE scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];

const START = "2026-11-20T09:00:00.000Z", END = "2026-11-20T10:00:00.000Z";
const OWNER = "CUS-REPLAY-OWNER", OTHER = "CUS-REPLAY-OTHER", PROVIDER = "PRV-REPLAY";

async function stack(controller = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite, controller);
  globalThis.__REPLAY_DB__ = db;
  globalThis.__REPLAY_ENV__ = {};
  for (const ddl of BOOKING_DDL) sqlite.exec(ddl);
  return { sqlite, db };
}

async function customerCookie(db, customerId, phone) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_app", principalType: "phone", principalKey: phone,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "test", reason: "booking replay isolation test",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "customer_app", principalType: "phone",
    principalKey: String(binding.principal_key), subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

function body(route, customerId, key, group) {
  const common = {
    idempotencyKey: key, scheduleGroupId: group,
    customer: { id: customerId, name: "Authenticated customer", primaryPhone: "+919000000001" },
    pets: [{ sourceId: "pet-1", name: "Rex", species: "dog" }],
    cityId: "blr", zoneId: "blr-central", scheduledStart: START, scheduledEnd: END,
    provider: { id: PROVIDER, name: "Assigned provider", model: "full_time" },
    totalAmount: 500, amountDueNow: 0,
    payment: { method: "upi", mode: "pay_after_service", detail: "sandbox" },
  };
  if (route === "walking") return { ...common, walkingQuoteId: "WQ-1", packageCode: "walking-30", packageName: "Walk", walkCount: 1, weekdays: [] };
  if (route === "taxi") return { ...common, taxiQuoteId: "TQ-1", routeCode: "taxi-city", originLabel: "Home", destinationLabel: "Clinic" };
  if (route === "canonical") return { ...common, serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Sitting", payment: { ...common.payment, status: "created" }, pricing: { discount: 0 } };
  return { ...common, sittingQuoteId: "SQ-1", packageCode: "home-visit", packageName: "Sitting" };
}

async function post(route, cookie, payload) {
  const handler = await import(`../app/api/${route}-bookings/route.ts`);
  const response = await handler.POST(new Request(`https://uat.pawspace.in/api/${route}-bookings`, {
    method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(payload),
  }));
  return { status: response.status, body: await response.json() };
}

function seedBooking(sqlite, route) {
  const bookingId = `BK-${route.toUpperCase()}-OWNER`, key = `KEY-${route.toUpperCase()}`, group = `GROUP-${route.toUpperCase()}`;
  const service = route === "walking" ? "dog_walking" : route === "taxi" ? "pet_taxi" : "pet_sitting";
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(bookingId, key, OWNER, "[]", "[]", "blr", "blr-central", service, "package", "Package", group, PROVIDER, START, END, "confirmed", "customer_app", 500, "INR", "{}", "customer:test", 1, 1);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,1,'assigned','{}',1,1)")
    .run(`WO-${route}`, bookingId, group, PROVIDER, "Provider", "full_time", service, START, END);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,0,'INR','upi','sandbox','created','uat_sandbox',?,'{}',1,1)")
    .run(`PAY-${route}`, bookingId, OWNER, 500, `PAYKEY-${route}`);
  if (route === "walking") sqlite.prepare("INSERT INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,1,?,?,'scheduled',1,1)").run("WALK-1", bookingId, group, "RES-WALK-1", PROVIDER, START, END);
  if (route === "taxi") sqlite.prepare("INSERT INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,8,45,?,?,'scheduled',1,1)").run("TRIP-1", bookingId, group, "RES-TAXI-1", PROVIDER, "Home", "Clinic", "taxi-city", START, END);
  return { bookingId, key, group };
}

for (const route of ["canonical", "walking", "taxi", "sitting"]) {
  test(`${route}: an authenticated customer cannot replay another customer's booking`, async () => {
    const { sqlite, db } = await stack();
    const seeded = seedBooking(sqlite, route);
    const cookie = await customerCookie(db, OTHER, `+91910000000${route.length}`);
    const before = sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n;
    const result = await post(route, cookie, body(route, OTHER, seeded.key, `NEW-${route}`));
    assert.equal(result.status, 409);
    assert.equal(result.body.data, undefined);
    assert.ok(!JSON.stringify(result.body).includes(seeded.bookingId));
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, before);
  });

  test(`${route}: the owning authenticated customer still receives an idempotent replay`, async () => {
    const { sqlite, db } = await stack();
    const seeded = seedBooking(sqlite, route);
    const cookie = await customerCookie(db, OWNER, `+91920000000${route.length}`);
    const result = await post(route, cookie, body(route, OWNER, seeded.key, seeded.group));
    assert.equal(result.status, 200);
    assert.equal(result.body.data.bookingId, seeded.bookingId);
    assert.equal(result.body.data.customerId, OWNER);
    assert.equal(result.body.data.duplicatePrevented, true);
  });

  test(`${route}: an authenticated customer cannot consume another customer's scheduling group`, async () => {
    const { sqlite, db } = await stack();
    const group = `RESERVED-${route}`;
    sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'governed','[]',?,'assigned','test','test',1)").run(group, PROVIDER);
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,NULL,'assigned','{}',1)")
      .run(`RES-${route}`, group, PROVIDER, route === "walking" ? "dog_walking" : route === "taxi" ? "pet_taxi" : "pet_sitting", "blr", "blr-central", OWNER, "[]", START, END);
    const cookie = await customerCookie(db, OTHER, `+91930000000${route.length}`);
    const result = await post(route, cookie, body(route, OTHER, `FRESH-${route}`, group));
    assert.equal(result.status, 409);
    assert.equal(result.body.data, undefined);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 0);
  });
}

for (const [route, reservationService, reservationCity, reservationZone] of [
  ["canonical", "pet_taxi", "blr", "blr-central"],
  ["sitting", "pet_taxi", "blr", "blr-central"],
  ["taxi", "pet_taxi", "maa", "maa-central"],
  ["walking", "dog_walking", "maa", "maa-central"],
]) {
  test(`${route}: scheduling service and location identity cannot be relabelled by the booking payload`, async () => {
    const { sqlite, db } = await stack();
    const group = `INTEGRITY-${route}`;
    sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'governed','[]',?,'assigned','test','test',1)").run(group, PROVIDER);
    sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,NULL,'assigned','{}',1)")
      .run(`RES-INTEGRITY-${route}`, group, PROVIDER, reservationService, reservationCity, reservationZone, OWNER, "[]", START, END);
    const cookie = await customerCookie(db, OWNER, `+91936000000${route.length}`);
    const result = await post(route, cookie, body(route, OWNER, `INTEGRITY-KEY-${route}`, group));
    assert.equal(result.status, 409);
    assert.equal(result.body.data, undefined);
    assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 0);
  });
}

test("sitting: reservation location cannot be relabelled by the booking payload", async () => {
  const { sqlite, db } = await stack();
  const group = "INTEGRITY-SITTING-LOCATION";
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'governed','[]',?,'assigned','test','test',1)").run(group, PROVIDER);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,NULL,'assigned','{}',1)")
    .run("RES-INTEGRITY-SITTING-LOCATION", group, PROVIDER, "pet_sitting", "maa", "maa-central", OWNER, "[]", START, END);
  const cookie = await customerCookie(db, OWNER, "+919360000099");
  const result = await post("sitting", cookie, body("sitting", OWNER, "INTEGRITY-KEY-SITTING-LOCATION", group));
  assert.equal(result.status, 409);
  assert.equal(result.body.data, undefined);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 0);
});

test("a customer reusing a key on another service gets a conflict, not the wrong response bundle", async () => {
  const { sqlite, db } = await stack();
  const walking = seedBooking(sqlite, "walking");
  const cookie = await customerCookie(db, OWNER, "+919350000001");
  const result = await post("taxi", cookie, body("taxi", OWNER, walking.key, "NEW-TAXI-GROUP"));
  assert.equal(result.status, 409);
  assert.equal(result.body.data, undefined);
  assert.ok(!JSON.stringify(result.body).includes(walking.bookingId));
});

test("the write-boundary classifier recognizes SQLite and D1 uniqueness collisions only", async () => {
  const { isUniqueConstraintError } = await import("../lib/booking-replay-governance.ts");
  assert.equal(isUniqueConstraintError(new Error("UNIQUE constraint failed: canonical_bookings.idempotency_key")), true);
  assert.equal(isUniqueConstraintError(new Error("D1_ERROR: UNIQUE constraint failed")), true);
  assert.equal(isUniqueConstraintError(new Error("NOT NULL constraint failed: canonical_bookings.city_id")), false);
  assert.equal(isUniqueConstraintError(new Error("FOREIGN KEY constraint failed")), false);
  assert.equal(isUniqueConstraintError(new Error("database is unavailable")), false);
});

test("canonical write-boundary: a concurrent same-customer winner is returned as the replay", async () => {
  const controller = {};
  const { sqlite, db } = await stack(controller);
  const cookie = await customerCookie(db, OWNER, "+919400000001");
  const group = "GROUP-CANONICAL";
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'governed','[]',?,'assigned','test','test',1)").run(group, PROVIDER);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,NULL,'assigned','{}',1)")
    .run("RES-CANONICAL-RACE", group, PROVIDER, "pet_sitting", "blr", "blr-central", OWNER, "[]", START, END);
  controller.beforeBookingWrite = () => {
    seedBooking(sqlite, "canonical");
    throw new Error("UNIQUE constraint failed: canonical_bookings.idempotency_key");
  };
  const result = await post("canonical", cookie, body("canonical", OWNER, "KEY-CANONICAL", group));
  assert.equal(result.status, 200);
  assert.equal(result.body.data.bookingId, "BK-CANONICAL-OWNER");
  assert.equal(result.body.data.duplicatePrevented, true);
});

test("canonical write-boundary: a non-unique constraint defect is not disguised as a replay", async () => {
  const controller = {};
  const { sqlite, db } = await stack(controller);
  const cookie = await customerCookie(db, OWNER, "+919400000002");
  const group = "GROUP-CANONICAL-DEFECT";
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,'governed','[]',?,'assigned','test','test',1)").run(group, PROVIDER);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,1,1,NULL,'assigned','{}',1)")
    .run("RES-CANONICAL-DEFECT", group, PROVIDER, "pet_sitting", "blr", "blr-central", OWNER, "[]", START, END);
  controller.beforeBookingWrite = () => { throw new Error("NOT NULL constraint failed: canonical_bookings.city_id"); };
  const result = await post("canonical", cookie, body("canonical", OWNER, "KEY-CANONICAL-DEFECT", group));
  assert.equal(result.status, 500);
  assert.match(result.body.error, /NOT NULL constraint failed/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 0);
});
