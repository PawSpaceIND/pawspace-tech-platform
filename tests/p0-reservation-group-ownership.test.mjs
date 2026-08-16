/**
 * P0 — CROSS-CUSTOMER RESERVATION-GROUP OWNERSHIP BYPASS.
 *
 * THE BUG
 * requireCustomerOwnership proves the caller owns input.customer.id. Nothing proved they owned
 * input.scheduleGroupId: the assignment and reservation lookups key on group_id alone. So customer B,
 * signed in legitimately as themselves and booking their own pet, could quote customer A's
 * scheduleGroupId and receive 201 — a confirmed booking, a payment and a work order, all consuming A's
 * hold. Worse, the replay lookup keyed on group_id (or a guessed idempotency key) with no customer
 * scope, so when A then confirmed their OWN group they were handed B's bundle: B's booking id, work
 * order id and payment id.
 *
 * NON-VACUITY — READ BEFORE CHANGING THIS FILE
 * isDevelopmentPreview() is true for hostname "localhost", and a preview actor short-circuits
 * requireCustomerOwnership entirely. A test on localhost therefore proves NOTHING about ownership: it
 * runs as a superuser and every probe below would pass even with the fix reverted. These tests use a
 * NON-preview host and REAL minted sessions (verified identity binding + issuePlatformSession + the
 * session cookie). V0 asserts an unauthenticated write is refused, which fails loudly if that setup
 * ever stops being real.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__P0O_DB__", "__P0O_ENV__");

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");
const account = await import("../lib/customer-account.ts");
const bindings = await import("../lib/identity-binding.ts");
const sessions = await import("../lib/platform-session.ts");

const START = "2026-09-01T04:30:00.000Z", END = "2026-09-01T06:30:00.000Z";
// Deliberately NOT localhost: keeps isDevelopmentPreview() false so ownership is actually enforced.
const HOST = "https://staging.pawspace.test";
const db = () => globalThis.__P0O_DB__;
let seq = 0;

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__P0O_DB__ = createD1(sqlite);
  globalThis.__P0O_ENV__ = {};
  return sqlite;
}

/** A genuinely signed-in customer: canonical row, saved pet, verified binding, active session cookie. */
async function realCustomer(id, petName) {
  const phone = `+9190000000${++seq}`;
  await account.ensureCustomerAccountTables(db());
  await db().prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,NULL,'test','{}',?,?)")
    .bind(id, "blr", `Cust ${id}`, phone, Date.now(), Date.now()).run();
  await account.mutateCustomerAccount(db(), { customerId: id, action: "upsert_pet", idempotencyKey: `pet-${id}-${seq}`, pet: { name: petName, species: "dog", breed: "Indie", vaccinationStatus: "verified" } });
  const pets = await db().prepare("SELECT id FROM canonical_pets WHERE customer_id=?").bind(id).all();
  const binding = await bindings.upsertIdentityBinding(db(), { identitySource: "customer_app", principalType: "phone", principalKey: phone, subjectType: "customer", subjectId: id, verificationState: "verified", actorId: "test", reason: "p0 ownership regression" });
  const issued = await sessions.issuePlatformSession(db(), { bindingId: String(binding.id ?? binding.binding?.id ?? binding), identitySource: "customer_app", principalType: "phone", principalKey: phone, subjectType: "customer", subjectId: id });
  return { id, petId: String(pets.results[0].id), cookie: `pawspace_identity_session=${issued.token}` };
}

const req = (path, body, cookie) => new Request(`${HOST}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: HOST, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) });

async function reserve(cust, group) {
  const r = await schedulingRoute.POST(req("/api/uat-scheduling", { clientRequestId: group, customerId: cust.id, petIds: [cust.petId], serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: START, scheduledEnd: END }, cust.cookie));
  const b = await r.json();
  assert.equal(r.status, 200, `reserve must succeed: ${JSON.stringify(b)}`);
  return b.data;
}

const bookingBody = (cust, group, provider, over = {}) => ({
  idempotencyKey: over.idempotencyKey ?? `bk-${group}-${cust.id}`, scheduleGroupId: group,
  customer: { id: cust.id, name: "C", primaryPhone: "+919000000001" },
  pets: [{ sourceId: cust.petId, name: "Pet", species: "dog" }],
  cityId: "blr", zoneId: "blr-east",
  serviceCode: over.serviceCode ?? "pet_sitting", packageCode: over.packageCode ?? "sit-basic", packageName: "Pet sitting",
  scheduledStart: START, scheduledEnd: END,
  provider: { id: provider.id, name: provider.name, model: provider.model },
  totalAmount: over.totalAmount ?? 2400, amountDueNow: over.amountDueNow ?? 2400,
  payment: { method: "upi", mode: "prepaid", status: "captured", detail: "test" },
  pricing: { discount: 0 },
});
const book = async (cust, body) => { const r = await bookingRoute.POST(req("/api/canonical-bookings", body, cust.cookie)); return { status: r.status, body: await r.json() }; };
/** Full reservation rows, so "unchanged" can be asserted byte-for-byte rather than by status alone. */
const reservationRows = (s, group) => s.prepare("SELECT * FROM scheduling_reservations WHERE group_id=? ORDER BY id").all(group);
const artefacts = (s, customerId) => ({
  bookings: s.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?").get(customerId).n,
  payments: s.prepare("SELECT COUNT(*) n FROM booking_payments WHERE customer_id=?").get(customerId).n,
  workOrders: s.prepare("SELECT COUNT(*) n FROM provider_work_orders").get().n,
});

test("V0 non-vacuity: these probes run without the development-preview superuser", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const r = await bookingRoute.POST(req("/api/canonical-bookings", bookingBody(a, "G", { id: "p", name: "n", model: "commission" }), undefined));
  assert.ok(r.status === 401 || r.status === 403, `an unauthenticated write must be refused, got ${r.status} — if this passes as 2xx the suite is running as preview and proves nothing`);
});

test("B quoting A's scheduleGroupId is refused 403 and leaves A's reservation byte-identical and usable", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const b = await realCustomer("CUS-B", "Bolt");
  const sched = await reserve(a, "G-OWN-1");
  const before = reservationRows(s, "G-OWN-1");
  assert.ok(before.length > 0, "precondition: A holds capacity");

  // B: own valid session, own customer id (ownership legitimately passes), own pet, A's group.
  const hostile = await book(b, bookingBody(b, "G-OWN-1", sched.provider));
  assert.equal(hostile.status, 403, `foreign scheduleGroupId must be 403, got ${hostile.status}: ${JSON.stringify(hostile.body)}`);

  // Zero B artefacts.
  assert.deepEqual(artefacts(s, "CUS-B"), { bookings: 0, payments: 0, workOrders: 0 }, "the refusal must create no booking, payment or work order");
  // A's reservation byte-identical — not merely "still assigned".
  assert.deepEqual(reservationRows(s, "G-OWN-1"), before, "A's reservation rows must be completely unchanged");

  // ...and still usable: A confirms successfully afterwards.
  const rightful = await book(a, bookingBody(a, "G-OWN-1", sched.provider));
  assert.equal(rightful.status, 201, `A must still be able to confirm: ${JSON.stringify(rightful.body)}`);
  assert.equal(rightful.body.data.customerId, "CUS-A");
  assert.ok(reservationRows(s, "G-OWN-1").some(r => r.status !== "cancelled"), "a successful booking retains its reservation");
});

test("A's replay returns only A's bundle, and B can never retrieve it", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const b = await realCustomer("CUS-B", "Bolt");
  const sched = await reserve(a, "G-OWN-2");
  const body = bookingBody(a, "G-OWN-2", sched.provider);
  const first = await book(a, body);
  assert.equal(first.status, 201);
  const aBooking = first.body.data.bookingId;

  // Rightful idempotent replay: same bundle, nothing new.
  const before = artefacts(s, "CUS-A");
  const replay = await book(a, body);
  assert.equal(replay.status, 200, "A's replay must return the existing bundle");
  assert.equal(replay.body.data.bookingId, aBooking, "A's replay must return A's OWN booking");
  assert.deepEqual(artefacts(s, "CUS-A"), before, "replay creates nothing new");

  // B cannot reach A's bundle through the replay path — not via A's group...
  const viaGroup = await book(b, bookingBody(b, "G-OWN-2", sched.provider));
  assert.equal(viaGroup.status, 403, "B must be refused on A's group");
  assert.equal(JSON.stringify(viaGroup.body).includes(aBooking), false, "B must never see A's booking id");
  // ...nor by guessing A's idempotency key.
  const viaKey = await book(b, bookingBody(b, "G-OWN-2", sched.provider, { idempotencyKey: body.idempotencyKey }));
  assert.equal(JSON.stringify(viaKey.body).includes(aBooking), false, "a guessed idempotency key must not leak A's bundle");
  assert.equal(artefacts(s, "CUS-B").bookings, 0, "B still has no booking");
});

test("a hostile refusal cannot release A's reservation", async () => {
  const s = freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  const b = await realCustomer("CUS-B", "Bolt");
  const sched = await reserve(a, "G-OWN-3");
  const before = reservationRows(s, "G-OWN-3");

  // A deliberately-failing booking (bad price) quoting A's group: the refusal path must not free it.
  const hostile = await book(b, bookingBody(b, "G-OWN-3", sched.provider, { serviceCode: "grooming", packageCode: "groom-basic", totalAmount: 1, amountDueNow: 1 }));
  assert.equal(hostile.status, 403, "ownership is checked before any refusal compensation can run");
  assert.deepEqual(reservationRows(s, "G-OWN-3"), before, "A's hold must be untouched");
  assert.deepEqual(artefacts(s, "CUS-B"), { bookings: 0, payments: 0, workOrders: 0 });
});

test("a group that does not exist is still 409, not mistaken for an ownership failure", async () => {
  freshDb();
  const a = await realCustomer("CUS-A", "Rex");
  // A real reservation elsewhere, so the scheduling tables exist and the only thing missing is THIS
  // group. (With no scheduling tables at all the route answers 500 from the assignment lookup — that
  // is pre-existing on the base commit and unrelated to ownership.)
  const sched = await reserve(a, "G-REAL");
  const res = await book(a, bookingBody(a, "G-DOES-NOT-EXIST", sched.provider));
  assert.equal(res.status, 409, `an unknown group must stay 409, not become a 403: ${JSON.stringify(res.body)}`);
  assert.equal(String(res.body.error).includes("another customer"), false, "an unknown group is not an ownership failure");
});
