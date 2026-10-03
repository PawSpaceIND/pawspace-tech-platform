/**
 * Bug B2 follow-up: the 20 s preview deadline must not poison the isolate.
 *
 * The Workers runtime cancels a finished request's unfinished I/O, and a cancelled promise never
 * settles. Reproduced under workerd (Miniflare, the built worker, 60 ms per D1 call, deadline 1.5 s):
 * the first cold preview answered 503 at the deadline while its schema set-up was still running; the
 * set-up's in-flight promise, cached per isolate, never settled, and EVERY later preview on that isolate
 * waited on it and answered 503 too. Two fixes, both executed here:
 *
 * 1. The deadline hands the unfinished work to the request's waitUntil (ctx.waitUntil, carried in the
 *    request's D1 scope by worker/index.ts), so the runtime lets it finish.
 * 2. The per-isolate schema guards added for B2 keep only a "ready" set. They never share an in-flight
 *    promise across requests, so a set-up that never finishes (a cancelled request) cannot block a later
 *    request: the later request runs the idempotent set-up itself.
 *
 * No network: fetch is stubbed for the only external call on this path (geocoding).
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__SCHED_DEADLINE_DB__", "__SCHED_DEADLINE_ENV__");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
globalThis.fetch = async (url) => Response.json({ status: "OK", results: [{ formatted_address: new URL(String(url)).searchParams.get("address"), geometry: { location: { lat: 12.9784, lng: 77.6408 } } }] });

const route = await import("../app/api/uat-scheduling/route.ts");
const metricsLib = await import("../lib/request-d1-metrics.ts");
const { ensureSecurityTables } = await import("../lib/server-auth.ts");
const { seedDefaultZones, ensureServiceZonesTables } = await import("../lib/service-zones.ts");
const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
const { ensureCustomerAccountTables } = await import("../lib/customer-account.ts");
const { upsertIdentityBinding, ensureIdentityBindingTables } = await import("../lib/identity-binding.ts");
const { issuePlatformSession, ensurePlatformSessionTables, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
const { ensureControlRuntimeTables } = await import("../lib/control-runtime-switches.ts");

/** Every D1 call waits `latencyMs` before reaching SQLite, like a distant staging D1. */
function slowed(raw, latencyMs) {
  const statement = (inner) => ({ __raw: inner, bind: (...values) => statement(inner.bind(...values)),
    first: async (...args) => { await sleep(latencyMs); return inner.first(...args); }, all: async () => { await sleep(latencyMs); return inner.all(); },
    run: async () => { await sleep(latencyMs); return inner.run(); }, raw: async () => { await sleep(latencyMs); return inner.raw(); } });
  return { prepare: (sql) => statement(raw.prepare(sql)), batch: async (list) => { await sleep(latencyMs); return raw.batch(list.map((item) => item.__raw ?? item)); }, exec: async (sql) => { await sleep(latencyMs); return raw.exec(sql); } };
}

const CUSTOMER = "CUST-B2-DEADLINE";
const RUNTIME = { PAWSPACE_SCHEDULING_ENV: "uat", PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_MAPS_ENV: "sandbox", GOOGLE_MAPS_SERVER_API_KEY_UAT: "test-not-a-key", PAWSPACE_DEPLOYMENT_ENV: "staging", PAWSPACE_TEST_SERVICE_DISCOVERY_FIXTURE: "off" };
const DAY = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);

async function stagingWorld(latencyMs) {
  const sqlite = new DatabaseSync(":memory:");
  const setup = d1(sqlite);
  enterWorkersDbScope(setup);
  globalThis.__SCHED_DEADLINE_DB__ = setup;
  globalThis.__SCHED_DEADLINE_ENV__ = RUNTIME;
  await ensureSecurityTables(setup); await seedDefaultZones(setup); await seedProviderCapacityDefaults(setup); await ensureCustomerAccountTables(setup);
  const roster = fs.readFileSync(new URL("../scripts/uat-staging-provider-capacity.sql", import.meta.url), "utf8").split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");
  for (const statement of roster.split(/;\s*\n/).map((item) => item.trim()).filter(Boolean)) sqlite.exec(`${statement};`);
  sqlite.prepare("INSERT OR IGNORE INTO canonical_pets(id,customer_id,source_pet_id,name,species,vaccination_status,created_at,updated_at) VALUES ('PET-B2-DL',?,'PET-B2-DL','Bruno','dog','verified',?,?)").run(CUSTOMER, Date.now(), Date.now());
  const binding = await upsertIdentityBinding(setup, { identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${CUSTOMER}`, subjectType: "customer", subjectId: CUSTOMER, verificationState: "verified", actorId: "b2-deadline-test", reason: "B2 deadline cancellation regression" });
  const issued = await issuePlatformSession(setup, { bindingId: String(binding.id), identitySource: String(binding.identity_source), principalType: String(binding.principal_type), principalKey: String(binding.principal_key), subjectType: "customer", subjectId: CUSTOMER });
  const db = slowed(d1(sqlite), latencyMs);
  return { sqlite, db, cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}` };
}

function previewRequest(world) {
  return new Request(`${ORIGIN}/api/uat-scheduling`, { method: "POST", headers: { "content-type": "application/json", cookie: world.cookie, origin: ORIGIN },
    body: JSON.stringify({ action: "preview", clientRequestId: `v2-grooming-preview:${crypto.randomUUID()}`, customerId: CUSTOMER, petIds: ["PET-B2-DL"], serviceCode: "grooming",
      cityId: "blr", zoneId: "blr-east", scheduledStart: `${DAY}T05:30:00.000Z`, scheduledEnd: `${DAY}T07:30:00.000Z`, serviceAddress: "12, 100 Feet Road, Indiranagar", servicePincode: "560038" }) });
}

/** The route in the scope worker/index.ts opens for POST /api/uat-scheduling, with the request's waitUntil. */
async function preview(world, { deadlineMs } = {}) {
  enterWorkersDbScope(world.db);
  globalThis.__SCHED_DEADLINE_DB__ = world.db;
  const handedOff = [];
  const request = previewRequest(world);
  const metrics = metricsLib.createRequestD1Metrics(request, true, (promise) => { handedOff.push(promise); });
  const response = await metricsLib.runWithRequestD1Metrics(metrics, () => route.executeGovernedSchedulingRequest(request, undefined, deadlineMs ? { previewDeadlineMs: deadlineMs } : {}));
  return { response, body: await response.clone().json(), handedOff };
}

test("a preview answered at the deadline hands its unfinished work to the request's waitUntil, which then finishes it", async () => {
  const world = await stagingWorld(30);
  const original = console.log; console.log = () => {};
  try {
    const cold = await preview(world, { deadlineMs: 150 });
    assert.equal(cold.response.status, 503, `the cold preview is answered at the deadline: ${JSON.stringify(cold.body)}`);
    assert.equal(cold.response.headers.get("retry-after"), "5");
    assert.equal(cold.handedOff.length, 1, "the unfinished preview work is handed to waitUntil exactly once, so the runtime does not cancel it");
    const outcome = await Promise.race([cold.handedOff[0].then(() => "settled"), sleep(15_000).then(() => "still running")]);
    assert.equal(outcome, "settled", "the handed-off work runs to completion");

    // The isolate is healthy afterwards: the next preview is answered normally, and nothing is handed off.
    const next = await preview(world);
    assert.equal(next.response.status, 200, JSON.stringify(next.body));
    assert.deepEqual(next.body.data.providers.map((provider) => provider.id).slice(0, 3), ["uatcap_groom_east", "uatcap_groom_ft", "uatcap_groom_east_2"], "the historical top-three ranking remains the prefix while all eligible groomers are visible");
    assert.equal(next.handedOff.length, 0, "a preview answered in time hands nothing off");
  } finally { console.log = original; }
});

test("a schema guard whose first run never finishes (a cancelled request) does not block the next request", async () => {
  // Models the workerd behaviour: the first caller's D1 calls never settle. A later caller on the same
  // database must run the idempotent set-up itself instead of waiting on the first caller's promise.
  for (const [name, ensure] of [["ensureControlRuntimeTables", ensureControlRuntimeTables], ["ensureIdentityBindingTables", ensureIdentityBindingTables], ["ensurePlatformSessionTables", ensurePlatformSessionTables], ["ensureServiceZonesTables", ensureServiceZonesTables]]) {
    const live = d1(new DatabaseSync(":memory:"));
    let cancelled = true;
    const never = new Promise(() => {});
    const statement = (inner) => ({ __raw: inner, bind: (...values) => statement(inner.bind(...values)),
      first: (...args) => cancelled ? never : inner.first(...args), all: () => cancelled ? never : inner.all(), run: () => cancelled ? never : inner.run(), raw: () => cancelled ? never : inner.raw() });
    const db = { prepare: (sql) => statement(live.prepare(sql)), batch: (list) => cancelled ? never : live.batch(list.map((item) => item.__raw ?? item)), exec: (sql) => cancelled ? never : live.exec(sql) };
    ensure(db).catch(() => undefined); // the cancelled request: its set-up never settles
    await sleep(5);
    cancelled = false;
    const outcome = await Promise.race([ensure(db).then(() => "done"), sleep(1_000).then(() => "blocked")]);
    assert.equal(outcome, "done", `${name}: a later request must not wait on a cancelled request's set-up`);
    const before = Date.now();
    await ensure(db);
    assert.ok(Date.now() - before < 50, `${name}: and once it has succeeded it is a no-op`);
  }
});

test("worker/index.ts gives the scheduling request scope the request's ctx.waitUntil", () => {
  const worker = fs.readFileSync(new URL("../worker/index.ts", import.meta.url), "utf8");
  assert.match(worker, /runWithRequestD1Metrics\(createRequestD1Metrics\(request,true,promise=>ctx\.waitUntil\(promise\)\),/);
});

// The Reserve and booking paths' remaining schema guards shared a cold isolate's in-flight set-up promise across
// requests in the same way; they now keep only a ready set (lib/d1-ensure-once.js). Same model as above, one test
// per guard, plus the two guards whose set-up depends on a table another module creates.
const leases = await import("../lib/scheduling-reservation-leases.ts");
const servicePolicy = await import("../lib/service-policy-governance.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");
const conversation = await import("../lib/booking-conversation.ts");
/** A D1 binding whose calls never settle while `state.cancelled` is set (a cancelled request's I/O); every call is counted. */
function cancellable(sqlite) {
  const live = d1(sqlite), never = new Promise(() => {}), state = { cancelled: true, calls: 0 };
  const gate = (work) => { state.calls++; return state.cancelled ? never : work(); };
  const statement = (inner) => ({ __raw: inner, bind: (...values) => statement(inner.bind(...values)),
    first: (...args) => gate(() => inner.first(...args)), all: () => gate(() => inner.all()), run: () => gate(() => inner.run()), raw: () => gate(() => inner.raw()) });
  return { state, db: { prepare: (sql) => statement(live.prepare(sql)), batch: (list) => gate(() => live.batch(list.map((item) => item.__raw ?? item))), exec: (sql) => gate(() => live.exec(sql)) } };
}
// An existing reservations table from before the lease columns, and the bookings table the conversation trigger sits on.
const RESERVATIONS = "CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,care_mode TEXT,status TEXT NOT NULL)";
const BOOKINGS = "CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,created_at INTEGER NOT NULL)";
const present = (sqlite, name) => Boolean(sqlite.prepare("SELECT name FROM sqlite_master WHERE name=?").get(name));
for (const [name, ensure, prerequisite, objects] of [
  ["ensureSchedulingReservationLeaseGovernance", leases.ensureSchedulingReservationLeaseGovernance, RESERVATIONS, ["scheduling_reservation_lease_cleanup", "block_expired_reservation_booking", "uq_scheduling_reservations_active_provider_window"]],
  ["ensureServicePolicyTables", servicePolicy.ensureServicePolicyTables, null, ["service_policy_configs", "service_policy_audit"]],
  ["ensureProviderCapacityTables", capacity.ensureProviderCapacityTables, null, ["provider_capacity_profiles", "provider_unavailability", "provider_assignment_offers"]],
  ["ensureProviderBookingGuard", capacity.ensureProviderBookingGuard, null, ["provider_booking_confirmation_guards", "block_unavailable_provider_booking"]],
  ["ensureBookingConversationOnInsert", conversation.ensureBookingConversationOnInsert, BOOKINGS, ["communication_threads", "communication_participants", "trg_canonical_booking_customer_conversation"]],
]) {
  test(`${name}: a set-up whose first caller was cancelled mid-flight never leaves a later caller waiting, and a finished one is remembered`, async () => {
    const sqlite = new DatabaseSync(":memory:");
    if (prerequisite) sqlite.exec(prerequisite);
    const { db, state } = cancellable(sqlite);
    ensure(db).catch(() => undefined); // the cancelled request: its set-up never settles
    await sleep(5);
    state.cancelled = false;
    const outcome = await Promise.race([ensure(db).then(() => "done"), sleep(1_000).then(() => "blocked")]);
    assert.equal(outcome, "done", `${name}: a later request must not wait on a cancelled request's set-up`);
    for (const object of objects) assert.ok(present(sqlite, object), `${name}: ${object} was set up`);
    const calls = state.calls;
    await ensure(db);
    assert.equal(state.calls, calls, `${name}: once a set-up has finished, the isolate does not run it again`);
    sqlite.close();
  });
}

test("the lease set-up still answers false and keeps checking until scheduling_reservations exists, then applies once and answers true", async () => {
  const sqlite = new DatabaseSync(":memory:"), { db, state } = cancellable(sqlite);
  state.cancelled = false;
  assert.equal(await leases.ensureSchedulingReservationLeaseGovernance(db), false, "no reservations table yet");
  const checked = state.calls;
  assert.equal(await leases.ensureSchedulingReservationLeaseGovernance(db), false);
  assert.ok(state.calls > checked, "a missing dependency is checked again, never remembered");
  sqlite.exec(RESERVATIONS);
  assert.equal(await leases.ensureSchedulingReservationLeaseGovernance(db), true, "applied once another module created the table");
  const columns = sqlite.prepare("PRAGMA table_info(scheduling_reservations)").all().map((column) => column.name);
  assert.ok(columns.includes("lease_expires_at") && columns.includes("customer_session_id"), "the lease columns were added");
  const applied = state.calls;
  assert.equal(await leases.ensureSchedulingReservationLeaseGovernance(db), true);
  assert.equal(state.calls, applied, "then remembered");
  sqlite.close();
});

test("the booking conversation set-up still fails, and is tried again, while canonical_bookings does not exist", async () => {
  const sqlite = new DatabaseSync(":memory:"), { db, state } = cancellable(sqlite);
  state.cancelled = false;
  await assert.rejects(conversation.ensureBookingConversationOnInsert(db), /canonical_bookings/, "the trigger needs the bookings table");
  sqlite.exec(BOOKINGS);
  await conversation.ensureBookingConversationOnInsert(db);
  assert.ok(present(sqlite, "trg_canonical_booking_customer_conversation"), "set up once the table exists");
  const calls = state.calls;
  await conversation.ensureBookingConversationOnInsert(db);
  assert.equal(state.calls, calls, "then remembered");
  sqlite.close();
});

// The lease cleanup worker/index.ts runs (and waits for) before every Reserve and canonical booking handed a pass in
// progress to every concurrent request on the isolate. A request cancelled mid-cleanup never settles its pass, so the
// next Reserve and booking waited on it for ever. Driven through the gateway exactly as worker/index.ts runs it
// (tests/helpers/stay-taxi-latency-harness.mjs viaWorker): Boarding price, reserve and canonical booking.
test("a request whose lease cleanup never finished (a cancelled request) does not block the next Reserve or canonical booking", async () => {
  const h = await import("./helpers/stay-taxi-latency-harness.mjs");
  const boarding = await import("../app/api/boarding-commercial/route.ts");
  const canonical = await import("../app/api/canonical-bookings/route.ts");
  const w = await h.stayWorld({ dbGlobal: "__SCHED_DEADLINE_DB__", envGlobal: "__SCHED_DEADLINE_ENV__", ownRoster: true });
  // The binding the gateway and the routes use: while `state.cancelled` is set, its calls never settle.
  const { db: gate, state } = cancellable(w.sqlite);
  state.cancelled = false;
  const binding = h.counted(gate);
  Object.assign(w, { db: binding.db, log: binding.log, env: { ...w.env, DB: binding.db } });
  const customer = { id: h.CUSTOMER, name: "Stay Latency", primaryPhone: "9000099001" }, host = "stay_host_large";
  const within = (answer) => Promise.race([answer, sleep(3_000).then(() => "blocked")]);
  const reserveRequest = (group, window) => h.schedulingRequest(w, { clientRequestId: group, petIds: [h.PETS.dog], serviceCode: "boarding", careMode: "visit", preferredProviderId: host, ...window });
  async function stay(day, group) {
    const window = { scheduledStart: h.ist(day, 10), scheduledEnd: h.ist(day, 14) };
    const q = (await (await h.viaWorker(w, h.boardingQuoteRequest(w, { packageCode: "boarding-4h", petCount: 1, ...window, providerId: host }), boarding.POST)).json()).data;
    const reserve = await within(h.viaWorker(w, reserveRequest(group, window), route.POST));
    if (reserve === "blocked") return { reserve, booking: null };
    // Read each body once. Node 22 may collect a cloned response's tee branch and
    // cancel the retained original before the later assertion reads it again.
    const reserveBody = await reserve.json();
    const provider = reserveBody.data?.provider;
    const booking = await within(h.viaWorker(w, h.canonicalBookingRequest(w, { idempotencyKey: group, scheduleGroupId: group, customer, pets: [{ sourceId: h.PETS.dog, name: "Bruno", species: "dog", vaccinationStatus: "verified" }], cityId: "blr", zoneId: "blr-east", serviceCode: "boarding", packageCode: q.packageCode, packageName: q.packageName, ...window, provider: provider && { id: provider.id, name: provider.name, model: provider.model }, totalAmount: q.totalAmount, amountDueNow: q.amountDueNow, payment: { method: "upi", mode: q.paymentMode, status: "created", detail: "Awaiting" }, pricing: { discount: 0, boardingQuoteId: q.quoteId } }), canonical.POST));
    const bookingBody = booking === "blocked" ? null : await booking.json();
    return { reserve, reserveBody, booking, bookingBody };
  }
  const warm = await stay(3, "stay:lease-warm");
  assert.deepEqual([warm.reserve.status, warm.booking.status], [200, 201], "the isolate is warm and healthy");
  // The cancelled request: its lease cleanup (and everything else it asks D1) never hears back.
  state.cancelled = true;
  h.viaWorker(w, reserveRequest("stay:lease-cancelled", { scheduledStart: h.ist(4, 10), scheduledEnd: h.ist(4, 14) }), route.POST).catch(() => undefined);
  await sleep(5);
  state.cancelled = false;
  const next = await stay(5, "stay:lease-next");
  assert.notEqual(next.reserve, "blocked", "the next Reserve must not wait on the cancelled request's lease cleanup");
  assert.equal(next.reserve.status, 200, JSON.stringify(next.reserveBody));
  assert.notEqual(next.booking, "blocked", "the next canonical booking must not wait on it either");
  assert.equal(next.booking.status, 201, JSON.stringify(next.bookingBody));
});
