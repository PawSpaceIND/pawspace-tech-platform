/**
 * UNIQUENESS RACE AT THE BOOKING COMMIT BOUNDARY.
 *
 * canonical_bookings.idempotency_key and .schedule_group_id are GLOBALLY unique. The route's two
 * ownership/collision guards are reads, so a competing request can commit between them and the batch.
 * That loser used to escape as 500 {"error":"UNIQUE constraint failed: canonical_bookings.idempotency_key"}.
 *
 * These tests do not hope for a race — they inject the competing commit deterministically, inside a
 * Proxy over db.batch, which is exactly the window that was unguarded.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__UC_DB__", "__UC_ENV__");

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");
const account = await import("../lib/customer-account.ts");
const bindings = await import("../lib/identity-binding.ts");
const sessions = await import("../lib/platform-session.ts");

const START = "2026-09-01T04:30:00.000Z", END = "2026-09-01T06:30:00.000Z";
const HOST = "https://staging.pawspace.test";   // non-preview: the ownership boundary stays live
let seq = 0;
let sqlite, realDb;
const db = () => globalThis.__UC_DB__;

function freshDb() {
  sqlite = new DatabaseSync(":memory:");
  realDb = createD1(sqlite);
  globalThis.__UC_DB__ = realDb;
  globalThis.__UC_ENV__ = {};
  return sqlite;
}

/**
 * Run one booking request with `inject` executed in the exact unguarded window: the route prepares the
 * canonical_bookings INSERT only AFTER both guards have passed, and db.batch runs after that, so firing
 * here reproduces "a competing request committed between the guards and our commit".
 */
async function bookWithInjectionAtBatch(cust, body, inject) {
  let fired = false;
  globalThis.__UC_DB__ = new Proxy(realDb, {
    get(target, prop) {
      if (prop !== "prepare") { const v = Reflect.get(target, prop); return typeof v === "function" ? v.bind(target) : v; }
      return (sql) => {
        if (!fired && String(sql).includes("INSERT INTO canonical_bookings (")) { fired = true; inject(); }
        return target.prepare(sql);
      };
    },
  });
  try {
    const r = await bookingRoute.POST(request(body, cust.cookie));
    return { status: r.status, body: await r.json(), fired };
  } finally { globalThis.__UC_DB__ = realDb; }
}

async function realCustomer(id, petName) {
  const phone = `+9190000000${++seq}`;
  await account.ensureCustomerAccountTables(db());
  await db().prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'t','{}',?,?)").bind(id, "blr", id, phone, Date.now(), Date.now()).run();
  await account.mutateCustomerAccount(db(), { customerId: id, action: "upsert_pet", idempotencyKey: `p-${id}-${seq}`, pet: { name: petName, species: "dog", breed: "Indie", vaccinationStatus: "verified" } });
  const pets = await db().prepare("SELECT id FROM canonical_pets WHERE customer_id=?").bind(id).all();
  const b = await bindings.upsertIdentityBinding(db(), { identitySource: "customer_app", principalType: "phone", principalKey: phone, subjectType: "customer", subjectId: id, verificationState: "verified", actorId: "release-test", reason: "unique race" });
  const issued = await sessions.issuePlatformSession(db(), { bindingId: String(b.id ?? b.binding?.id ?? b), identitySource: "customer_app", principalType: "phone", principalKey: phone, subjectType: "customer", subjectId: id });
  return { id, petId: String(pets.results[0].id), cookie: `pawspace_identity_session=${issued.token}` };
}
const request = (body, cookie) => new Request(`${HOST}/api/canonical-bookings`, { method: "POST", headers: { "content-type": "application/json", origin: HOST, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });
async function reserve(cust, group) {
  const r = await schedulingRoute.POST(new Request(`${HOST}/api/uat-scheduling`, { method: "POST", headers: { "content-type": "application/json", origin: HOST, cookie: cust.cookie }, body: JSON.stringify({ clientRequestId: group, customerId: cust.id, petIds: [cust.petId], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: START, scheduledEnd: END }) }));
  const b = await r.json(); assert.equal(r.status, 200, JSON.stringify(b)); return b.data;
}
const bodyFor = (c, group, provider, key) => ({
  idempotencyKey: key, scheduleGroupId: group,
  customer: { id: c.id, name: "C", primaryPhone: "+919000000001" },
  pets: [{ sourceId: "Pet", name: "Pet", species: "dog" }],
  cityId: "blr", zoneId: "blr-east", serviceCode: "pet_sitting", packageCode: "sit-basic", packageName: "Pet sitting",
  scheduledStart: START, scheduledEnd: END, provider,
  totalAmount: 2400, amountDueNow: 2400,
  payment: { method: "upi", mode: "prepaid", status: "captured", detail: "t" }, pricing: { discount: 0 },
});
const book = async (c, b) => { const r = await bookingRoute.POST(request(b, c.cookie)); return { status: r.status, body: await r.json() }; };
/** Insert a competing booking row straight into SQLite, as another connection would. */
function competingBooking({ id, key, group, customerId }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','pet_sitting','p','P',?,'pr',?,?,'confirmed','app',2400,'INR','{}','t',?,?)")
    .run(id, key, customerId, group, START, END, Date.now(), Date.now());
}
const counts = () => ({
  bookings: sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n,
  payments: sqlite.prepare("SELECT COUNT(*) n FROM booking_payments").get().n,
  workOrders: sqlite.prepare("SELECT COUNT(*) n FROM provider_work_orders").get().n,
});

test("same-customer concurrent duplicate: the loser returns that customer's own rightful bundle", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const sched = await reserve(a, "G-DUP");
  // A's first request wins the race by committing inside the loser's batch window.
  const res = await bookWithInjectionAtBatch(a, bodyFor(a, "G-DUP", sched.provider, "DUP-KEY"),
    () => competingBooking({ id: "WINNER-1", key: "DUP-KEY", group: "G-DUP", customerId: "CUS-A" }));
  assert.equal(res.fired, true, "the interleaving must have happened");
  assert.equal(res.status, 200, `the loser must get the established idempotent replay status: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.data.bookingId, "WINNER-1", "and it must be the winner's — the caller's own — bundle");
  assert.equal(res.body.data.customerId, "CUS-A");
  assert.equal(res.body.data.duplicatePrevented, true, "reported as a prevented duplicate");
  // Exactly one booking; the loser added no second booking, payment or work order.
  assert.deepEqual(counts(), { bookings: 1, payments: 0, workOrders: 0 }, "the loser created nothing");
});

test("foreign idempotency-key collision: generic controlled 409, zero mutation, no foreign bundle", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const b = await realCustomer("CUS-B", "Bolt");
  const sched = await reserve(b, "G-B");
  const res = await bookWithInjectionAtBatch(b, bodyFor(b, "G-B", sched.provider, "FOREIGN-KEY"),
    () => competingBooking({ id: "A-WINS", key: "FOREIGN-KEY", group: "G-OTHER", customerId: "CUS-A" }));
  assert.equal(res.fired, true);
  assert.equal(res.status, 409, `must be a controlled 409: ${JSON.stringify(res.body)}`);
  const text = JSON.stringify(res.body);
  assert.equal(text.includes("A-WINS"), false, "no foreign booking id");
  assert.equal(text.includes("CUS-A"), false, "no foreign customer id");
  assert.equal(/UNIQUE constraint failed/i.test(text), false, "no raw constraint text");
  assert.equal(/canonical_bookings\./i.test(text), false, "no column or table names");
  assert.deepEqual(counts(), { bookings: 1, payments: 0, workOrders: 0 }, "only the injected competitor exists; B created nothing");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUS-B'").get().n, 0, "B has no booking");
});

test("foreign schedule-group collision: controlled refusal, zero mutation", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const b = await realCustomer("CUS-B", "Bolt");
  const sched = await reserve(b, "G-SHARED");
  const res = await bookWithInjectionAtBatch(b, bodyFor(b, "G-SHARED", sched.provider, "B-OWN-KEY"),
    () => competingBooking({ id: "A-GROUP-WINS", key: "A-OTHER-KEY", group: "G-SHARED", customerId: "CUS-A" }));
  assert.equal(res.fired, true);
  assert.ok(res.status === 409 || res.status === 403, `controlled refusal expected, got ${res.status}: ${JSON.stringify(res.body)}`);
  const text = JSON.stringify(res.body);
  assert.equal(/UNIQUE constraint failed/i.test(text), false, "no raw constraint text");
  assert.equal(text.includes("A-GROUP-WINS"), false, "no foreign booking id");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUS-B'").get().n, 0, "B created nothing");
});

test("an unrelated database error is NOT converted to a replay or a 409", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const sched = await reserve(a, "G-ERR");
  // A genuine fault at exactly the same boundary — armed by the booking INSERT so the schema-ensuring
  // batches before it are untouched. It must not be mistaken for idempotent success.
  let fired = false, armed = false;
  globalThis.__UC_DB__ = new Proxy(realDb, {
    get(target, prop) {
      if (prop === "prepare") return (sql) => { if (String(sql).includes("INSERT INTO canonical_bookings (")) armed = true; return target.prepare(sql); };
      if (prop !== "batch") { const v = Reflect.get(target, prop); return typeof v === "function" ? v.bind(target) : v; }
      return async (statements) => {
        if (armed && !fired) { fired = true; throw new Error("database disk image is malformed"); }
        return target.batch(statements);
      };
    },
  });
  const r = await bookingRoute.POST(request(bodyFor(a, "G-ERR", sched.provider, "ERR-KEY"), a.cookie));
  const body = await r.json();
  globalThis.__UC_DB__ = realDb;
  assert.equal(fired, true);
  assert.notEqual(r.status, 200, "an unknown failure must never look like a successful replay");
  assert.notEqual(r.status, 409, "and must not be laundered into a collision refusal");
  assert.equal(r.status, 500, `it stays a failure: ${r.status} ${JSON.stringify(body)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 0, "nothing was written");
});

test("the batch stays atomic: a collision leaves no partial booking, payment or work-order row", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const b = await realCustomer("CUS-B", "Bolt");
  const sched = await reserve(b, "G-ATOMIC");
  const res = await bookWithInjectionAtBatch(b, bodyFor(b, "G-ATOMIC", sched.provider, "ATOMIC-KEY"),
    () => competingBooking({ id: "OTHER", key: "ATOMIC-KEY", group: "G-OTHER2", customerId: "CUS-A" }));
  assert.equal(res.status, 409);
  // The losing batch contained customer, pets, booking, work order, payment and lifecycle statements.
  // None of its rows may survive.
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id='CUS-B'").get().n, 0, "no booking");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_payments WHERE customer_id='CUS-B'").get().n, 0, "no payment");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_work_orders").get().n, 0, "no work order");
});

test("no raw constraint text reaches the client on any collision path", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const b = await realCustomer("CUS-B", "Bolt");
  const sched = await reserve(b, "G-TEXT");
  const raced = await bookWithInjectionAtBatch(b, bodyFor(b, "G-TEXT", sched.provider, "TXT-KEY"),
    () => competingBooking({ id: "X", key: "TXT-KEY", group: "G-OTHER3", customerId: "CUS-A" }));
  // ...and the deterministic pre-check path, which never reaches the batch at all.
  const bSched2 = await reserve(b, "G-TEXT2");
  const precheck = await book(b, bodyFor(b, "G-TEXT2", bSched2.provider, "TXT-KEY"));
  for (const [name, r] of [["raced", raced], ["pre-check", precheck]]) {
    const text = JSON.stringify(r.body);
    assert.equal(/UNIQUE constraint failed/i.test(text), false, `${name} must not leak constraint text: ${text}`);
    assert.equal(/canonical_bookings/i.test(text), false, `${name} must not leak table names: ${text}`);
    assert.equal(r.status, 409, `${name} is a controlled 409`);
  }
  assert.equal(raced.body.error, precheck.body.error, "both collision paths give the same generic message");
});
