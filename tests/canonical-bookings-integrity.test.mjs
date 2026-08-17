import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Two controls this route was missing, both of which let a caller get an answer it had not earned.
//
// AUTHORIZATION. The handler ran its whole body for anybody. resolveActor and requireCustomerOwnership
// guarded who a booking could be written FOR, not who could reach the handler: GET listed a hundred
// bookings with customer names, provider names and payment status to an unauthenticated caller, and
// POST reached governance, quote consumption and reservation reads before identity mattered at all.
// Both now ask lib/api-gateway for the permission the path and method demand, as their first statement.
//
// CITY/ZONE INTEGRITY. The route matched the reservation's PROVIDER, then persisted the booking with the
// CLIENT-supplied cityId and zoneId — the two fields the booking is routed, priced and reported by. A
// Bengaluru reservation could be confirmed into a booking labelled Chennai, and every projection
// downstream believed the label rather than the reservation.
//
// These run the REAL exported handlers. Every claim is a status the handler returned, a body it wrote,
// or a row read back out of the database afterwards.
// ---------------------------------------------------------------------------
installWorkersHooks("__BOOKING_INTEGRITY_DB__", "__BOOKING_INTEGRITY_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const SCHEDULING_DDL = [
  "CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)",
];

const CUSTOMER = "CUS-INTEG-1", PROVIDER = "PRV-INTEG-1";
const CITY = "blr", ZONE = "koramangala";
const START = "2026-11-04T09:00:00.000Z", END = "2026-11-04T11:00:00.000Z";

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__BOOKING_INTEGRITY_DB__ = makeD1(sqlite);
  globalThis.__BOOKING_INTEGRITY_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  return sqlite;
}

/** Seed the scheduling decision and reservation the POST requires. City/zone are parameters here
 *  precisely because the reservation's city/zone is the thing under test. */
function seedScheduling(sqlite, groupId, { city = CITY, zone = ZONE } = {}) {
  for (const ddl of SCHEDULING_DDL) sqlite.exec(ddl);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(groupId, "balanced", "[]", PROVIDER, "assigned", "test", "seeded", 1);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`RES-${groupId}`, groupId, PROVIDER, "pet_sitting", city, zone, CUSTOMER, "[]", START, END, 1, 1, null, "reserved", "{}", 1);
}

function body({ key, group, city = CITY, zone = ZONE, pets = [{ sourceId: "acct-1", name: "Bruno", species: "dog" }] }) {
  return JSON.stringify({
    idempotencyKey: key, scheduleGroupId: group,
    customer: { id: CUSTOMER, name: "Integrity tester", primaryPhone: "+919000000001" },
    pets, cityId: city, zoneId: zone,
    serviceCode: "pet_sitting", packageCode: "home-visit", packageName: "Pet Sitting",
    scheduledStart: START, scheduledEnd: END,
    provider: { id: PROVIDER, name: "Sitter One", model: "full_time" },
    totalAmount: 1349, amountDueNow: 1349,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0 },
  });
}

/** localhost is the development-preview origin, which resolveActor treats as a superuser. Anything
 *  else exercises the real identity path — which is what an authorization test needs. */
const LOCAL = "http://localhost/api/canonical-bookings";
const HOSTED = "https://app.pawspace.in/api/canonical-bookings";

async function call(method, url, { headers = {}, payload } = {}) {
  const mod = await import("../app/api/canonical-bookings/route.ts");
  const request = new Request(url, method === "GET" ? { method, headers } : {
    method, headers: { "content-type": "application/json", ...headers }, body: payload,
  });
  const response = await mod[method](request);
  let parsed = null;
  try { parsed = JSON.parse(await response.clone().text()); } catch { /* non-JSON */ }
  return { status: response.status, body: parsed };
}

const TOUCHED = ["canonical_pets", "canonical_bookings", "booking_payments", "provider_work_orders", "booking_lifecycle_events"];
const counts = (sqlite) => Object.fromEntries(TOUCHED.map((t) => {
  try { return [t, sqlite.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n]; } catch { return [t, 0]; }
}));

/** Create the tables without leaving a booking behind, so a refused request has a baseline. */
async function warmSchema(sqlite) {
  seedScheduling(sqlite, "SG-WARM");
  await call("POST", LOCAL, { payload: body({ key: "warm", group: "SG-WARM" }) });
  for (const t of TOUCHED) sqlite.exec(`DELETE FROM ${t}`);
}

// --- authorization ---------------------------------------------------------------------------

test("an unauthenticated GET is refused and discloses no booking data", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  // A real booking exists, so a leak would have something to leak.
  seedScheduling(sqlite, "SG-EXIST");
  assert.equal((await call("POST", LOCAL, { payload: body({ key: "exists", group: "SG-EXIST" }) })).status, 201);

  const denied = await call("GET", HOSTED);
  assert.ok(denied.status === 401 || denied.status === 403, `expected a refusal, got ${denied.status}`);
  assert.equal(denied.body?.bookings, undefined, "a refused GET must not carry a bookings payload");
  // Nothing about the booking may appear in the refusal, however it is worded.
  const serialized = JSON.stringify(denied.body ?? {});
  for (const secret of [CUSTOMER, PROVIDER, "Integrity tester", "Sitter One"]) {
    assert.ok(!serialized.includes(secret), `a refusal must not disclose ${secret}`);
  }
});

test("an unauthenticated POST is refused before any write", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  seedScheduling(sqlite, "SG-UNAUTH");
  const before = counts(sqlite);

  const denied = await call("POST", HOSTED, { payload: body({ key: "unauth", group: "SG-UNAUTH" }) });
  assert.ok(denied.status === 401 || denied.status === 403, `expected a refusal, got ${denied.status} ${JSON.stringify(denied.body)}`);
  assert.deepEqual(counts(sqlite), before, "a refused POST must write nothing");

  // The control: the identical payload from a permitted caller succeeds. Without it, "wrote nothing"
  // would also hold if the request had failed for some unrelated reason.
  const allowed = await call("POST", LOCAL, { payload: body({ key: "unauth", group: "SG-UNAUTH" }) });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
});

test("a caller cannot assert a role or identity the session does not carry", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  seedScheduling(sqlite, "SG-SPOOF");
  const before = counts(sqlite);

  // Headers a client can set at will. None of them may stand in for a session.
  const spoofs = [
    ["claimed role", { "x-role": "superuser", "x-role-code": "founder" }],
    ["claimed permissions", { "x-permissions": "*", "x-pawspace-permissions": "bookings.manage" }],
    ["claimed identity", { "x-user-email": "founder@pawspace.in", "x-actor": "founder@pawspace.in" }],
    ["forged preview flag", { "x-development-preview": "true", "x-preview": "1" }],
    ["forged forwarded identity", { "x-forwarded-user": "founder@pawspace.in" }],
  ];
  for (const [label, headers] of spoofs) {
    const denied = await call("POST", HOSTED, { headers, payload: body({ key: `spoof-${label}`, group: "SG-SPOOF" }) });
    assert.ok(denied.status === 401 || denied.status === 403, `${label}: expected a refusal, got ${denied.status}`);
    const getDenied = await call("GET", HOSTED, { headers });
    assert.ok(getDenied.status === 401 || getDenied.status === 403, `${label} (GET): expected a refusal, got ${getDenied.status}`);
  }
  assert.deepEqual(counts(sqlite), before, "no spoofed request may write anything");
});

test("an authenticated role that lacks the required permission is refused", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  seedScheduling(sqlite, "SG-ROLE");
  // A real, active staff identity whose role carries a permission that has nothing to do with
  // bookings. Authentication is not the question here — authorization is. Before this change the
  // route consulted NO permission at all: ownership was checked, entitlement never was.
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)")
    .run("marketing_only", "Marketing only", "Holds no booking permission", JSON.stringify(["marketing.view"]), 0, 1);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("USR-MKT", "marketing@pawspace.test", "Marketing", "marketing_only", "active", 1, 1);
  const headers = { "oai-authenticated-user-email": "marketing@pawspace.test" };
  const before = counts(sqlite);

  const listed = await call("GET", HOSTED, { headers });
  assert.equal(listed.status, 403, `GET: ${JSON.stringify(listed.body)}`);
  assert.equal(listed.body?.bookings, undefined, "an under-permissioned GET must carry no bookings");

  const created = await call("POST", HOSTED, { headers, payload: body({ key: "role", group: "SG-ROLE" }) });
  assert.equal(created.status, 403, `POST: ${JSON.stringify(created.body)}`);
  assert.deepEqual(counts(sqlite), before, "an under-permissioned POST must write nothing");
});

test("an authorized GET and POST keep the behaviour they had", async () => {
  const sqlite = freshDb();
  seedScheduling(sqlite, "SG-OK");

  const created = await call("POST", LOCAL, { payload: body({ key: "ok-1", group: "SG-OK" }) });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body?.data?.customerId, CUSTOMER);
  assert.equal(created.body?.data?.status, "confirmed");
  assert.equal(created.body?.data?.petIds?.length, 1);

  const listed = await call("GET", LOCAL);
  assert.equal(listed.status, 200);
  assert.equal(listed.body?.bookings?.length, 1, "an authorized GET still lists the booking");
  assert.equal(listed.body.bookings[0].customer_id, CUSTOMER);
  assert.equal(listed.body.bookings[0].pets?.length, 1, "and still resolves its pets");
});

test("a booking for another customer is refused by the ownership layer, not by luck", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  seedScheduling(sqlite, "SG-CROSS");
  // An identity bound to a DIFFERENT customer. ensureSecurityTables has already created this table
  // with its real shape, so the insert must carry every NOT NULL column it actually declares.
  sqlite.prepare("INSERT OR REPLACE INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,?,?,?)")
    .run("someone@pawspace.test", "CUS-OTHER", "active", 1, 1);
  const before = counts(sqlite);

  const denied = await call("POST", HOSTED, {
    headers: { "oai-authenticated-user-email": "someone@pawspace.test" },
    payload: body({ key: "cross", group: "SG-CROSS" }),
  });
  assert.ok(denied.status >= 400, `expected a refusal, got ${denied.status}`);
  assert.notEqual(denied.status, 201);
  assert.deepEqual(counts(sqlite), before, "a cross-customer attempt must write nothing");
});

// --- city/zone integrity ---------------------------------------------------------------------

test("a booking whose city and zone match the reservation is confirmed", async () => {
  const sqlite = freshDb();
  seedScheduling(sqlite, "SG-MATCH", { city: "blr", zone: "koramangala" });

  const ok = await call("POST", LOCAL, { payload: body({ key: "match", group: "SG-MATCH", city: "blr", zone: "koramangala" }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const row = sqlite.prepare("SELECT city_id,zone_id FROM canonical_bookings WHERE idempotency_key='match'").get();
  assert.equal(row.city_id, "blr");
  assert.equal(row.zone_id, "koramangala");
});

test("a city or zone that differs from the reservation is refused before any write", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  const mismatches = [
    // The one that motivated this: a Bengaluru reservation relabelled as Chennai.
    ["different city", { city: "maa", zone: "koramangala" }],
    ["different zone", { city: "blr", zone: "indiranagar" }],
    ["both different", { city: "maa", zone: "adyar" }],
    ["case differs", { city: "BLR", zone: "koramangala" }],
    ["padded", { city: " blr", zone: "koramangala" }],
  ];
  for (const [label, claim] of mismatches) {
    const group = `SG-MM-${label.replace(/\s+/g, "-")}`;
    seedScheduling(sqlite, group, { city: "blr", zone: "koramangala" });
    const before = counts(sqlite);
    const denied = await call("POST", LOCAL, { payload: body({ key: group, group, ...claim }) });
    assert.equal(denied.status, 409, `${label}: ${JSON.stringify(denied.body)}`);
    assert.match(denied.body?.error ?? "", /city\/zone does not match/i, label);
    assert.deepEqual(counts(sqlite), before, `${label}: a mismatch must write nothing`);
  }

  // The control: the same group, claimed correctly, is confirmed — so the refusals above are the
  // city/zone rule and not some unrelated failure.
  const group = "SG-MM-CONTROL";
  seedScheduling(sqlite, group, { city: "blr", zone: "koramangala" });
  const ok = await call("POST", LOCAL, { payload: body({ key: group, group, city: "blr", zone: "koramangala" }) });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
});

test("a city/zone mismatch is refused before the quote is consumed", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  seedScheduling(sqlite, "SG-ORDER", { city: "blr", zone: "koramangala" });
  const before = counts(sqlite);

  // A training booking needs a server quote. If the city/zone rule ran after quote consumption, this
  // would answer with the quote error; answering with the city/zone error proves the ordering.
  const denied = await call("POST", LOCAL, {
    payload: JSON.stringify({
      ...JSON.parse(body({ key: "order", group: "SG-ORDER", city: "maa", zone: "adyar" })),
      serviceCode: "dog_training", packageCode: "train-1", packageName: "Training",
    }),
  });
  assert.equal(denied.status, 409);
  assert.match(denied.body?.error ?? "", /city\/zone does not match/i, "the city/zone rule must answer first");
  assert.deepEqual(counts(sqlite), before);
});

// --- the ordering the pet-identity work depends on --------------------------------------------

test("replay still precedes every new-booking rule, including the two added here", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);

  // A booking already in the database, whose city/zone disagree with its reservation and whose
  // payload would now be refused. A replay must still return it.
  seedScheduling(sqlite, "SG-HIST", { city: "blr", zone: "koramangala" });
  sqlite.prepare(`INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at)
    VALUES ('BK-OLD','hist-key',?,'["PET-OLD"]','["acct-1"]','maa','adyar','pet_sitting','home-visit','Pet Sitting','SG-HIST',?,?,?,'confirmed','customer_app',1349,'INR','{}',?,1,1)`)
    .run(CUSTOMER, PROVIDER, START, END, CUSTOMER);
  const before = counts(sqlite);

  for (const [label, key, group] of [["by idempotency key", "hist-key", "SG-OTHER"], ["by schedule group", "other-key", "SG-HIST"]]) {
    const replay = await call("POST", LOCAL, { payload: body({ key, group, city: "maa", zone: "adyar" }) });
    assert.equal(replay.status, 200, `${label}: ${JSON.stringify(replay.body)}`);
    assert.equal(replay.body?.data?.bookingId, "BK-OLD", label);
    assert.equal(replay.body?.data?.duplicatePrevented, true, label);
  }
  assert.deepEqual(counts(sqlite), before, "a replay must have no side effects");

  // The control: the same mismatched payload on a NEW key is refused.
  seedScheduling(sqlite, "SG-HIST-NEW", { city: "blr", zone: "koramangala" });
  const fresh = await call("POST", LOCAL, { payload: body({ key: "hist-new", group: "SG-HIST-NEW", city: "maa", zone: "adyar" }) });
  assert.equal(fresh.status, 409);
  assert.match(fresh.body?.error ?? "", /city\/zone does not match/i);
});

test("authorization is refused ahead of the pet-identity rules, not after them", async () => {
  const sqlite = freshDb();
  await warmSchema(sqlite);
  seedScheduling(sqlite, "SG-PREC");

  // A payload that is invalid for the pet rules AND unauthenticated. The refusal must be the
  // authorization one, which proves the gate runs before the body is even parsed.
  const denied = await call("POST", HOSTED, { payload: body({ key: "prec", group: "SG-PREC", pets: [{ sourceId: 7, name: "Seven" }] }) });
  assert.ok(denied.status === 401 || denied.status === 403, `expected a refusal, got ${denied.status}`);
  assert.notEqual(denied.body?.error, "A pet source id must be text", "authorization must answer first");

  // ...and the same payload from a permitted caller reaches the pet rule.
  const permitted = await call("POST", LOCAL, { payload: body({ key: "prec-2", group: "SG-PREC", pets: [{ sourceId: 7, name: "Seven" }] }) });
  assert.equal(permitted.status, 400);
  assert.equal(permitted.body?.error, "A pet source id must be text");
});
