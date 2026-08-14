/**
 * REGRESSION — city/zone integrity across the scheduling + booking chain (findings 6, 7, 10 FIXED).
 *
 * Companion to tests/repro-finding-06-07-10.test.mjs. The repro pins the BUGGY behaviour on exact main;
 * this suite pins the CORRECTED behaviour the fix must guarantee:
 *
 *   - BLR full chain stays consistent: cityId 'blr' -> blr provider pool -> blr reservation -> blr booking.
 *   - A second city (maa / Chennai) with a properly configured zone + provider runs its OWN full chain:
 *     cityId 'maa' -> Chennai-only provider pool -> Chennai reservation -> Chennai booking, never blr.
 *   - A Chennai booking placed over a Bengaluru reservation is REJECTED (finding #7 invariant).
 *   - A zone that does not match the reservation (same city) is REJECTED.
 *   - resolveZoneByPincode NEVER falls back to a Bengaluru zone for another city: a Chennai pincode with
 *     no Chennai zone configured is not-serviceable (null), not "East Bengaluru" (finding #10).
 *   - canonical-bookings GET now authenticates (finding #1).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CZ_DB__", "__CZ_ENV__");

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

function freshDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__CZ_DB__ = makeD1(sqlite);
  globalThis.__CZ_ENV__ = env;
  return sqlite;
}

// BLR offset is +5:30, so 04:30Z = 10:00 IST — inside grooming's 09:00-19:00 local window.
const BLR_START = "2026-09-01T04:30:00.000Z", BLR_END = "2026-09-01T06:30:00.000Z";
// Chennai has no +5:30 offset baked into the engine (cityOffsetMinutes only shifts 'blr'), so maa times
// are matched in UTC — pick a window inside 09:00-19:00 UTC.
const MAA_START = "2026-09-01T09:30:00.000Z", MAA_END = "2026-09-01T11:30:00.000Z";

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");
const serviceZones = await import("../lib/service-zones.ts");
const providerGov = await import("../lib/provider-capacity-governance.ts");

const postScheduling = (body) => schedulingRoute.POST(new Request("http://localhost/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const postBooking = (body) => bookingRoute.POST(new Request("http://localhost/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

/** Seed a Chennai (maa) grooming provider whose city_id/zone are Chennai's — so the maa pool is real. */
async function seedMaaProvider(sqlite) {
  await providerGov.seedProviderCapacityDefaults(globalThis.__CZ_DB__); // creates the table + blr defaults
  sqlite.prepare("INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,'active',1,'2026-08-01',NULL,'test',?)")
    .run("groom_maa_lakshmi", "maa", "Lakshmi V.", "full_time", JSON.stringify(["grooming"]), JSON.stringify(["maa-central"]), 4.9, 97, 1, 30, 4, 0, Date.now());
}

/** Confirm a client-priced pet_sitting booking over an existing reservation (same provider/city/zone). */
function bookingBody(o) {
  return {
    idempotencyKey: o.idempotencyKey, scheduleGroupId: o.scheduleGroupId,
    customer: { id: o.customerId, name: "Customer", primaryPhone: "+919000000001" },
    pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
    cityId: o.cityId, zoneId: o.zoneId,
    serviceCode: "pet_sitting", packageCode: "sit-basic", packageName: "Pet sitting",
    scheduledStart: o.start, scheduledEnd: o.end,
    provider: { id: o.providerId, name: o.providerName, model: o.providerModel },
    totalAmount: 2400, amountDueNow: 2400,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0 },
  };
}

// =====================================================================================================
// BLR full chain stays consistent (legitimate Bengaluru behaviour must still hold).
// =====================================================================================================
test("BLR full chain: cityId 'blr' -> blr provider pool -> blr reservation -> blr booking, all consistent", async () => {
  const sqlite = freshDb();
  const schedRes = await postScheduling({
    clientRequestId: "CZ-BLR-1", customerId: "CUS-BLR", petIds: ["Rex"],
    serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: BLR_START, scheduledEnd: BLR_END,
  });
  const sched = await schedRes.json();
  assert.equal(schedRes.status, 200, `blr reserve must succeed: ${JSON.stringify(sched)}`);
  assert.equal(sched.data.provider.cityId, "blr", "eligible pool is Bengaluru");

  const reservation = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM scheduling_reservations WHERE group_id=?").get("CZ-BLR-1");
  assert.equal(reservation.city_id, "blr");
  assert.equal(reservation.zone_id, "blr-east");

  const bookRes = await postBooking(bookingBody({
    idempotencyKey: "cz-blr-1", scheduleGroupId: "CZ-BLR-1", customerId: "CUS-BLR",
    cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END,
    providerId: sched.data.provider.id, providerName: sched.data.provider.name, providerModel: sched.data.provider.model,
  }));
  const book = await bookRes.json();
  assert.equal(bookRes.status, 201, `consistent blr booking must be accepted: ${JSON.stringify(book)}`);
  const booking = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM canonical_bookings WHERE schedule_group_id=?").get("CZ-BLR-1");
  assert.equal(booking.city_id, reservation.city_id, "booking city == reservation city");
  assert.equal(booking.zone_id, reservation.zone_id, "booking zone == reservation zone");
  assert.equal(booking.provider_id, reservation.provider_id, "booking provider == reservation provider");
});

// =====================================================================================================
// Chennai (maa) full chain runs on its OWN city — never Bengaluru.
// =====================================================================================================
test("MAA full chain: cityId 'maa' -> Chennai-only provider pool -> Chennai reservation -> Chennai booking", async () => {
  const sqlite = freshDb();
  await seedMaaProvider(sqlite);
  const schedRes = await postScheduling({
    clientRequestId: "CZ-MAA-1", customerId: "CUS-MAA", petIds: ["Simba"],
    serviceCode: "grooming", cityId: "maa", zoneId: "maa-central", scheduledStart: MAA_START, scheduledEnd: MAA_END,
  });
  const sched = await schedRes.json();
  assert.equal(schedRes.status, 200, `maa reserve must succeed with a seeded Chennai provider: ${JSON.stringify(sched)}`);
  assert.equal(sched.data.provider.cityId, "maa", "the eligible pool is Chennai's, not Bengaluru's");
  assert.notEqual(sched.data.provider.cityId, "blr", "no Bengaluru provider bleeds into a Chennai request");

  const reservation = sqlite.prepare("SELECT city_id,zone_id,provider_id FROM scheduling_reservations WHERE group_id=?").get("CZ-MAA-1");
  assert.equal(reservation.city_id, "maa", "reservation persisted city_id='maa' (unreachable on main)");
  assert.equal(reservation.zone_id, "maa-central");

  const bookRes = await postBooking(bookingBody({
    idempotencyKey: "cz-maa-1", scheduleGroupId: "CZ-MAA-1", customerId: "CUS-MAA",
    cityId: "maa", zoneId: "maa-central", start: MAA_START, end: MAA_END,
    providerId: sched.data.provider.id, providerName: sched.data.provider.name, providerModel: sched.data.provider.model,
  }));
  const book = await bookRes.json();
  assert.equal(bookRes.status, 201, `consistent Chennai booking must be accepted: ${JSON.stringify(book)}`);
  const booking = sqlite.prepare("SELECT city_id,zone_id FROM canonical_bookings WHERE schedule_group_id=?").get("CZ-MAA-1");
  assert.equal(booking.city_id, "maa", "booking city == reservation city (Chennai)");
  assert.equal(booking.zone_id, "maa-central", "booking zone == reservation zone (Chennai)");
});

// =====================================================================================================
// Finding #7 — the server invariant rejects a booking whose city/zone != the reservation's.
// =====================================================================================================
test("Chennai booking over a BLR reservation is REJECTED (city mismatch)", async () => {
  const sqlite = freshDb();
  const schedRes = await postScheduling({
    clientRequestId: "CZ-MIX-1", customerId: "CUS-MIX", petIds: ["Rex"],
    serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: BLR_START, scheduledEnd: BLR_END,
  });
  const sched = await schedRes.json();
  assert.equal(schedRes.status, 200);

  const bookRes = await postBooking(bookingBody({
    idempotencyKey: "cz-mix-1", scheduleGroupId: "CZ-MIX-1", customerId: "CUS-MIX",
    cityId: "maa", zoneId: "maa-central", start: BLR_START, end: BLR_END, // client lies: Chennai over a blr reservation
    providerId: sched.data.provider.id, providerName: sched.data.provider.name, providerModel: sched.data.provider.model,
  }));
  const book = await bookRes.json();
  assert.equal(bookRes.status, 409, `mismatched-city booking must be rejected: ${JSON.stringify(book)}`);
  assert.match(book.error, /city\/zone|city and zone/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, 0, "no booking written on city mismatch");
});

test("Booking with a mismatched ZONE (right city) is REJECTED", async () => {
  const sqlite = freshDb();
  const schedRes = await postScheduling({
    clientRequestId: "CZ-ZONE-1", customerId: "CUS-Z", petIds: ["Rex"],
    serviceCode: "grooming", cityId: "blr", zoneId: "blr-east", scheduledStart: BLR_START, scheduledEnd: BLR_END,
  });
  const sched = await schedRes.json();
  assert.equal(schedRes.status, 200);

  const bookRes = await postBooking(bookingBody({
    idempotencyKey: "cz-zone-1", scheduleGroupId: "CZ-ZONE-1", customerId: "CUS-Z",
    cityId: "blr", zoneId: "blr-west", start: BLR_START, end: BLR_END, // wrong zone, reservation is blr-east
    providerId: sched.data.provider.id, providerName: sched.data.provider.name, providerModel: sched.data.provider.model,
  }));
  const book = await bookRes.json();
  assert.equal(bookRes.status, 409, `mismatched-zone booking must be rejected: ${JSON.stringify(book)}`);
  assert.match(book.error, /city\/zone|city and zone/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c, 0, "no booking written on zone mismatch");
});

// =====================================================================================================
// Finding #10 — resolveZoneByPincode never invents a Bengaluru zone for another city.
// =====================================================================================================
function seedLiveCity(sqlite, { city, cityCode, pincodes }) {
  sqlite.exec("CREATE TABLE IF NOT EXISTS city_launch_configs (city TEXT,city_code TEXT,pincodes TEXT,status TEXT)");
  sqlite.prepare("INSERT INTO city_launch_configs (city,city_code,pincodes,status) VALUES (?,?,?,?)").run(city, cityCode, pincodes, "Live");
}

test("a Chennai pincode with NO Chennai zone configured is NOT-serviceable (no blr fallback)", async () => {
  const sqlite = freshDb();
  seedLiveCity(sqlite, { city: "Chennai", cityCode: "maa", pincodes: "600001-600100" });
  // No 'maa-central' zone exists in SERVICE_ZONES here.
  delete serviceZones.SERVICE_ZONES["maa-central"];
  const resolved = await serviceZones.resolveZoneByPincode(globalThis.__CZ_DB__, "600042"); // T. Nagar, Chennai
  assert.equal(resolved, null, "a Chennai pincode with no Chennai zone must return not-serviceable, never a blr zone");
});

test("a Chennai pincode WITH a Chennai zone configured resolves to THAT Chennai zone", async () => {
  const sqlite = freshDb();
  seedLiveCity(sqlite, { city: "Chennai", cityCode: "maa", pincodes: "600001-600100" });
  serviceZones.SERVICE_ZONES["maa-central"] = { zoneId: "maa-central", zoneName: "Central Chennai", description: "T. Nagar, Adyar", color: "#3F51B5", serviceAvailable: true };
  try {
    const resolved = await serviceZones.resolveZoneByPincode(globalThis.__CZ_DB__, "600042");
    assert.ok(resolved, "the Chennai pincode is inside a Live Chennai range");
    assert.equal(resolved.assignment.city, "Chennai");
    assert.equal(resolved.zone.zoneId, "maa-central", "resolves to the Chennai zone, not blr-east");
    assert.equal(resolved.zone.zoneId.slice(0, 3), "maa", "a genuine Chennai zone is produced");
  } finally {
    delete serviceZones.SERVICE_ZONES["maa-central"];
  }
});

test("BLR pincode still resolves to its blr zone (BLR behaviour unchanged)", async () => {
  const sqlite = freshDb();
  seedLiveCity(sqlite, { city: "Bengaluru", cityCode: "blr", pincodes: "560001-560110" });
  // 560006 is not in the explicit table, so it only resolves via the Live blr range -> blr-central.
  const resolved = await serviceZones.resolveZoneByPincode(globalThis.__CZ_DB__, "560006");
  assert.ok(resolved, "an in-range Bengaluru pincode must still resolve");
  assert.equal(resolved.zone.zoneId, "blr-central", "blr range falls back to blr-central, unchanged");
  // And an out-of-range pincode is still refused (no 'serve everywhere' regression).
  assert.equal(await serviceZones.resolveZoneByPincode(globalThis.__CZ_DB__, "400001"), null, "Mumbai must not resolve");
});

// =====================================================================================================
// Finding #1 — canonical-bookings GET now authenticates.
// =====================================================================================================
test("canonical-bookings GET authenticates: dev-preview reads, unauthenticated is refused", async () => {
  freshDb();
  const ok = await bookingRoute.GET(new Request("http://localhost/api/canonical-bookings"));
  assert.equal(ok.status, 200, "a permitted (dev-preview superuser) actor may read the lifecycle board");

  const denied = await bookingRoute.GET(new Request("https://app.pawspace.in/api/canonical-bookings"));
  assert.notEqual(denied.status, 200, "an unauthenticated non-preview request must NOT read the board (GET is now gated)");
});
