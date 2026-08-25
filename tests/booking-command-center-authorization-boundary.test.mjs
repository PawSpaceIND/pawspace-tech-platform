import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__BOOKING_COMMAND_DB__", "__BOOKING_COMMAND_ENV__");

const ORIGIN = "https://app.pawspace.in";
const MANAGER_EMAIL = "manager.booking-command@pawspace.in";
const PROVIDER_EMAIL = "provider.booking-command@pawspace.in";
const BOOKING_ID = "BK-COMMAND-PRIVATE-1";
const CUSTOMER_ID = "CUS-COMMAND-PRIVATE-1";
const PROVIDER_ID = "PRO-COMMAND-PRIVATE-1";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      const results = [];
      for (const item of items) results.push(await item.run());
      return results;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__BOOKING_COMMAND_DB__ = db;
  globalThis.__BOOKING_COMMAND_ENV__ = {};

  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-COMMAND-MANAGER", MANAGER_EMAIL, "manager"],
    ["USR-COMMAND-PROVIDER", PROVIDER_EMAIL, "service_provider"],
  ]) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?)")
      .run(id, email, role, role, now, now);
  }

  // An authorized manager initializes the route-owned schema before the privacy assertions.
  const initialized = await call(MANAGER_EMAIL);
  assert.equal(initialized.reachedRoute, true);
  assert.equal(initialized.response.status, 200);

  const start = new Date(now + 86_400_000).toISOString();
  const end = new Date(now + 90_000_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(CUSTOMER_ID, "blr", "Private Customer Name", "+919999111122", "+919999333344", "private.customer@example.test", "test", "{}", now, now);
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run("PET-COMMAND-PRIVATE-1", CUSTOMER_ID, "Private Pet", "dog", "Indie", "verified", "SRC-PET-COMMAND-1", now, now);
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(BOOKING_ID, "IDEM-COMMAND-1", CUSTOMER_ID, JSON.stringify(["PET-COMMAND-PRIVATE-1"]), JSON.stringify(["SRC-PET-COMMAND-1"]), "blr", "blr-east", "grooming", "grooming-basic", "Basic Grooming", "GROUP-COMMAND-1", PROVIDER_ID, start, end, "confirmed", "customer_app", 1200, "INR", "{}", MANAGER_EMAIL, now, now);
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("WO-COMMAND-1", BOOKING_ID, "GROUP-COMMAND-1", PROVIDER_ID, "Private Provider Name", "commission", "grooming", start, end, 1, "assigned", "{}", now, now);
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("PAY-COMMAND-1", BOOKING_ID, CUSTOMER_ID, 1200, 1200, "INR", "card", "prepaid", "captured", "sandbox", "PAY-IDEM-COMMAND-1", "{}", now, now);

  return { sqlite, db };
}

async function throughGateway(request) {
  const env = { DB: globalThis.__BOOKING_COMMAND_DB__, ...globalThis.__BOOKING_COMMAND_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

function requestFor(email) {
  return new Request(`${ORIGIN}/api/booking-command-center`, {
    method: "GET",
    headers: email ? { "oai-authenticated-user-email": email } : {},
  });
}

async function call(email) {
  const request = requestFor(email);
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const route = await import("../app/api/booking-command-center/route.ts");
  return { reachedRoute: true, response: await route.GET(request) };
}

function businessCounts(sqlite) {
  return {
    customers: Number(sqlite.prepare("SELECT COUNT(*) count FROM canonical_customers").get().count),
    pets: Number(sqlite.prepare("SELECT COUNT(*) count FROM canonical_pets").get().count),
    bookings: Number(sqlite.prepare("SELECT COUNT(*) count FROM canonical_bookings").get().count),
    workOrders: Number(sqlite.prepare("SELECT COUNT(*) count FROM provider_work_orders").get().count),
    payments: Number(sqlite.prepare("SELECT COUNT(*) count FROM booking_payments").get().count),
  };
}

test("service_provider cannot open the platform-wide Booking Command Center", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const result = await call(PROVIDER_EMAIL);

  assert.equal(result.reachedRoute, false, "assigned-job access must not open the platform-wide command center");
  assert.equal(result.response.status, 403);
  const body = await result.response.text();
  for (const secret of [BOOKING_ID, CUSTOMER_ID, PROVIDER_ID, "Private Customer Name", "+919999111122", "private.customer@example.test", "PAY-COMMAND-1"]) {
    assert.ok(!body.includes(secret), `the refusal must not disclose ${secret}`);
  }
  assert.deepEqual(businessCounts(sqlite), before, "a denied read must not mutate business persistence");
});

test("the route independently refuses service_provider access if gateway composition is bypassed", async () => {
  const { sqlite } = await world();
  const before = businessCounts(sqlite);
  const route = await import("../app/api/booking-command-center/route.ts");
  const response = await route.GET(requestFor(PROVIDER_EMAIL));

  assert.equal(response.status, 403);
  const body = await response.text();
  assert.ok(!body.includes(BOOKING_ID));
  assert.ok(!body.includes("Private Customer Name"));
  assert.deepEqual(businessCounts(sqlite), before);
});

test("manager retains the complete Booking Command Center view", async () => {
  const { sqlite } = await world();
  const result = await call(MANAGER_EMAIL);

  assert.equal(result.reachedRoute, true);
  assert.equal(result.response.status, 200);
  const body = await result.response.json();
  assert.equal(body.bookings.length, 1);
  assert.equal(body.bookings[0].id, BOOKING_ID);
  assert.equal(body.bookings[0].customer_name, "Private Customer Name");
  assert.equal(businessCounts(sqlite).bookings, 1);
});
