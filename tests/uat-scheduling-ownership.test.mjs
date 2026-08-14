/**
 * Can a signed-in customer reserve a slot in someone else's name?
 *
 * POST /api/uat-scheduling is gated on scheduling.book, which the `customer` role holds - correctly,
 * because a customer books their own appointments through it. But the reserve path read
 * input.customerId and input.petIds straight from the body and never compared either to the identity
 * making the call. So any customer could burn a provider's capacity for a different customer, and file
 * any pet under the booking. That is the QA-004 shape exactly: an identifier supplied by the caller,
 * trusted because the caller passed a permission check.
 *
 * The permission matrix next door cannot see this. Every caller here HOLDS scheduling.book; the
 * question is not whether they may book, it is whose booking it is. So this drives the real handler as
 * two different customers and one member of staff, and reads the row that lands.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__UATOWN_DB__", "__UATOWN_ENV__");

const HOST = "https://pawspace-staging.example.dev";
const NOW = Date.UTC(2026, 8, 1);
const START = "2026-09-10T10:00:00.000Z";
const END = "2026-09-10T13:00:00.000Z";  // grooming needs at least 120 minutes for one pet

let sqlite;

async function fresh() {
  sqlite = new DatabaseSync(":memory:");
  const db = createD1(sqlite);
  globalThis.__UATOWN_DB__ = db;
  globalThis.__UATOWN_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test" };

  // resolveActor owns the identity DDL and seeds the role catalogue, so the identities below resolve to
  // the real roles rather than to nothing.
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);

  sqlite.exec(`CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, name TEXT, species TEXT, breed TEXT, vaccination_status TEXT);
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY, name TEXT, primary_phone TEXT);`);
  sqlite.prepare("INSERT INTO canonical_customers VALUES ('CUS-A','Asha','9800000001'),('CUS-B','Bhavna','9800000002')").run();
  sqlite.prepare("INSERT INTO canonical_pets VALUES ('PET-A','CUS-A','Bruno','dog','indie','current'),('PET-B','CUS-B','Coco','dog','indie','current')").run();

  // Two customers and one manager. The customers are bound through customer_identity_links, which is
  // what requireCustomerOwnership reads when the actor holds no manage permission.
  for (const [email, role] of [["asha@pawspace.test", "customer"], ["bhavna@pawspace.test", "customer"], ["ops@pawspace.test", "manager"]]) {
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .run(`u-${email}`, email, email.split("@")[0], role, NOW, NOW);
  }
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES ('asha@pawspace.test','CUS-A','active',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES ('bhavna@pawspace.test','CUS-B','active',?,?)").run(NOW, NOW);
  return db;
}

async function reserve(email, body) {
  const route = await import("../app/api/uat-scheduling/route.ts");
  const response = await route.POST(new Request(`${HOST}/api/uat-scheduling`, {
    method: "POST",
    headers: { "content-type": "application/json", "oai-authenticated-user-email": email },
    body: JSON.stringify({
      clientRequestId: `req-${Math.abs(hash(JSON.stringify(body)))}`,
      serviceCode: "grooming", zoneId: "koramangala",
      scheduledStart: START, scheduledEnd: END,
      ...body,
    }),
  }));
  const text = await response.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  return { status: response.status, body: parsed };
}

/** Deterministic, so the idempotency key differs per request without Math.random or Date.now. */
function hash(value) {
  let out = 0;
  for (let index = 0; index < value.length; index += 1) out = (out * 31 + value.charCodeAt(index)) | 0;
  return out;
}

const reservations = () => {
  try { return sqlite.prepare("SELECT * FROM scheduling_reservations").all(); } catch { return []; }
};

test("a customer cannot reserve a slot in another customer's name", async () => {
  await fresh();
  const attempt = await reserve("asha@pawspace.test", { customerId: "CUS-B", petIds: ["PET-B"] });

  assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
  // The refusal must land before anything is written, or a rejected caller still consumed capacity.
  assert.deepEqual(reservations(), [], "a refused reservation must leave no row behind");
});

test("a customer cannot attach another customer's pet to their own booking", async () => {
  await fresh();
  // Asha owns CUS-A, so the customer id passes. The pet does not belong to her.
  const attempt = await reserve("asha@pawspace.test", { customerId: "CUS-A", petIds: ["PET-B"] });

  assert.equal(attempt.status, 403, JSON.stringify(attempt.body));
  assert.match(String(attempt.body.error), /does not belong to this customer/);
  assert.deepEqual(reservations(), [], "a refused reservation must leave no row behind");
});

test("a customer reserving for themselves is not blocked by the ownership check", async () => {
  await fresh();
  const own = await reserve("asha@pawspace.test", { customerId: "CUS-A", petIds: ["PET-A"] });

  // What matters here is that it got PAST authority. There may be no provider in this bare fixture, so
  // NO_SCHEDULE_AVAILABLE (409) is a pass - it is a scheduling outcome, not a refusal. A 403 is not.
  assert.notEqual(own.status, 403, `the rightful owner was refused: ${JSON.stringify(own.body)}`);
  assert.ok([200, 201, 409].includes(own.status), `unexpected status ${own.status}: ${JSON.stringify(own.body)}`);
});

test("staff booking on a customer's behalf is unaffected", async () => {
  await fresh();
  // requireCustomerOwnership short-circuits for anyone holding customers.manage or bookings.manage.
  // Without that, adding this check would have broken every assisted booking the ops desk makes.
  const assisted = await reserve("ops@pawspace.test", { customerId: "CUS-A", petIds: ["PET-A"] });

  assert.notEqual(assisted.status, 403, `staff were refused a booking on behalf: ${JSON.stringify(assisted.body)}`);
  // And staff are not restricted to one customer's pets either.
  const other = await reserve("ops@pawspace.test", { customerId: "CUS-B", petIds: ["PET-B"] });
  assert.notEqual(other.status, 403, JSON.stringify(other.body));
});

test("an identity that holds nothing is refused before the body is even considered", async () => {
  await fresh();
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('nobody','Nobody','Holds nothing','[]',1,?)").run(NOW);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-nobody','nobody@pawspace.test','Nobody','nobody','active',?,?)").run(NOW, NOW);

  const attempt = await reserve("nobody@pawspace.test", { customerId: "CUS-A", petIds: ["PET-A"] });
  assert.ok([401, 403].includes(attempt.status), `expected a refusal, got ${attempt.status}: ${JSON.stringify(attempt.body)}`);
});
