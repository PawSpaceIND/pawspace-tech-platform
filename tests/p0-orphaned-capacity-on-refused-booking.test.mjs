/**
 * P0 — a refused booking must not strand the capacity its reservation was holding.
 *
 * Reserve and confirm are two separate requests. Reserve writes durable, capacity-consuming
 * scheduling_reservations rows; confirm re-validates price, commercial policy, provider and city/zone.
 * On the release candidate, a refusal at confirm returned 4xx and left the reservation 'assigned'
 * forever — there is no expiry column and no sweep — so the provider's slot stayed consumed with no
 * booking behind it. Tester 3 reproduced this twice live: a Bengaluru price mismatch and a Chennai
 * booking with no commercial policy configured.
 *
 * These tests drive the REAL scheduling and booking routes over a REAL transactional D1 shim.
 *
 * Chennai stays commercially blocked on purpose. Case 2 asserts the refusal and the cleanup — it does
 * NOT configure a Chennai policy, because the point is that the block holds while the capacity is
 * still returned.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__P0CAP_DB__", "__P0CAP_ENV__");

/** canonical_pets.id is a primary key, so each customer needs their OWN pet row. */
const petOf = (customerId) => `PET-${customerId}`;

function freshDb(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__P0CAP_DB__ = createD1(sqlite);
  globalThis.__P0CAP_ENV__ = env;
  // Reserve enforces pet ownership against canonical_pets, but SKIPS the check when the table does not
  // exist yet (the query is .catch()-guarded). The booking route's ensureTables() creates that table, so
  // a reserve AFTER a booking attempt is suddenly held to a guard the first reserve never saw. Seeding
  // ownership up front makes every reserve in this file face the same production guard — the same
  // fixture correction f552a4a made for the runtime-d1 suite.
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const insertPet = sqlite.prepare("INSERT OR IGNORE INTO canonical_pets (id,customer_id,name,species,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
  for (const customerId of ["CUS-A", "CUS-B", "CUS-M"]) insertPet.run(petOf(customerId), customerId, "Rex", "dog", "not_provided", "p1", 0, 0);
  return sqlite;
}

// BLR is +5:30, so 04:30Z = 10:00 IST — inside grooming's 09:00–19:00 local roster.
const BLR_START = "2026-09-01T04:30:00.000Z", BLR_END = "2026-09-01T06:30:00.000Z";
// The engine only shifts 'blr', so maa windows are matched in UTC.
const MAA_START = "2026-09-01T09:30:00.000Z", MAA_END = "2026-09-01T11:30:00.000Z";

// A real catalogue entry: dog-bath / Essential Bath, single-pet price 1349.
const PKG = { code: "dog-bath", name: "Essential Bath", price: 1349 };

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");
const providerGov = await import("../lib/provider-capacity-governance.ts");

const postScheduling = (body) => schedulingRoute.POST(new Request("http://localhost/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const postBooking = (body) => bookingRoute.POST(new Request("http://localhost/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

async function seedMaaProvider(sqlite) {
  await providerGov.seedProviderCapacityDefaults(globalThis.__P0CAP_DB__);
  sqlite.prepare("INSERT OR IGNORE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,?,?,?,?,?,?,'active',1,'2026-08-01',NULL,'test',?)")
    .run("groom_maa_lakshmi", "maa", "Lakshmi V.", "full_time", JSON.stringify(["grooming"]), JSON.stringify(["maa-central"]), 4.9, 97, 1, 30, 4, 0, Date.now());
}

/** A grooming booking body. `totalAmount` is deliberately a parameter so a test can tamper with it. */
function groomingBooking(o) {
  return {
    idempotencyKey: o.idempotencyKey, scheduleGroupId: o.scheduleGroupId,
    customer: { id: o.customerId, name: "Customer", primaryPhone: "+919000000001" },
    pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
    cityId: o.cityId, zoneId: o.zoneId,
    serviceCode: "grooming", packageCode: PKG.code, packageName: PKG.name,
    scheduledStart: o.start, scheduledEnd: o.end,
    provider: { id: o.providerId, name: o.providerName, model: o.providerModel },
    totalAmount: o.totalAmount ?? PKG.price, amountDueNow: o.amountDueNow ?? o.totalAmount ?? PKG.price,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0 },
  };
}

async function reserve(o) {
  const res = await postScheduling({
    clientRequestId: o.groupId, customerId: o.customerId, petIds: [petOf(o.customerId)],
    serviceCode: "grooming", cityId: o.cityId, zoneId: o.zoneId,
    scheduledStart: o.start, scheduledEnd: o.end,
  });
  const body = await res.json();
  assert.equal(res.status, 200, `reserve must succeed: ${JSON.stringify(body)}`);
  return body.data;
}

const activeHolds = (sqlite, groupId) =>
  sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get(groupId).c;
const countBookings = (sqlite) => sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c;
const countPayments = (sqlite) => {
  const t = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='canonical_payments'").get();
  return t ? sqlite.prepare("SELECT COUNT(*) c FROM canonical_payments").get().c : 0;
};

// =====================================================================================================
// CASE 1 — Bengaluru price mismatch (Tester 3's live repro #1)
// =====================================================================================================
test("CASE 1: a BLR booking refused for a tampered price releases the hold, and the slot is bookable again", async () => {
  const sqlite = freshDb();
  const sched = await reserve({ groupId: "P0-BLR-1", customerId: "CUS-A", cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END });
  assert.equal(activeHolds(sqlite, "P0-BLR-1"), 1, "reserve holds capacity");

  const res = await postBooking(groomingBooking({
    idempotencyKey: "p0-blr-1", scheduleGroupId: "P0-BLR-1", customerId: "CUS-A",
    cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END,
    providerId: sched.provider.id, providerName: sched.provider.name, providerModel: sched.provider.model,
    totalAmount: 1, amountDueNow: 1, // tampered: real price is 1349
  }));
  const body = await res.json();

  assert.equal(res.status, 409, `a tampered price is a client refusal, not a 500: ${JSON.stringify(body)}`);
  assert.equal(countBookings(sqlite), 0, "zero canonical bookings");
  assert.equal(countPayments(sqlite), 0, "zero payments — no money moved");
  assert.equal(activeHolds(sqlite, "P0-BLR-1"), 0, "the hold is released, not stranded");
  assert.equal(body.capacityReleased, 1, "the response states honestly that one hold was released");

  // The freed slot is genuinely reusable: a fresh reserve for the same provider/window succeeds.
  const again = await reserve({ groupId: "P0-BLR-1-RETRY", customerId: "CUS-A", cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END });
  assert.equal(again.provider.id, sched.provider.id, "the same provider/slot is bookable again");
});

test("CASE 1b: repeating the refused booking is idempotent — it never double-releases or resurrects a hold", async () => {
  const sqlite = freshDb();
  const sched = await reserve({ groupId: "P0-BLR-2", customerId: "CUS-A", cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END });
  const bad = groomingBooking({
    idempotencyKey: "p0-blr-2", scheduleGroupId: "P0-BLR-2", customerId: "CUS-A",
    cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END,
    providerId: sched.provider.id, providerName: sched.provider.name, providerModel: sched.provider.model,
    totalAmount: 1, amountDueNow: 1,
  });

  const first = await (await postBooking(bad)).json();
  assert.equal(first.capacityReleased, 1, "first refusal releases the one hold");
  const second = await postBooking(bad);
  const secondBody = await second.json();
  assert.equal(second.status, 409, "still refused");
  assert.equal(secondBody.capacityReleased, 0, "second refusal releases nothing — already cancelled");
  assert.equal(activeHolds(sqlite, "P0-BLR-2"), 0, "still zero active holds");
  assert.equal(countBookings(sqlite), 0, "still zero bookings");
});

// =====================================================================================================
// CASE 2 — Chennai, no commercial policy (Tester 3's live repro #2). Chennai stays BLOCKED.
// =====================================================================================================
test("CASE 2: a Chennai booking refused for a missing commercial policy releases the hold, with zero BLR leakage", async () => {
  const sqlite = freshDb();
  await seedMaaProvider(sqlite);

  const sched = await reserve({ groupId: "P0-MAA-1", customerId: "CUS-M", cityId: "maa", zoneId: "maa-central", start: MAA_START, end: MAA_END });
  assert.equal(sched.provider.cityId, "maa", "only a Chennai provider is evaluated/selected");
  assert.equal(sched.provider.id, "groom_maa_lakshmi", "the Chennai provider specifically");
  assert.equal(activeHolds(sqlite, "P0-MAA-1"), 1, "the Chennai reserve holds capacity");

  const res = await postBooking(groomingBooking({
    idempotencyKey: "p0-maa-1", scheduleGroupId: "P0-MAA-1", customerId: "CUS-M",
    cityId: "maa", zoneId: "maa-central", start: MAA_START, end: MAA_END,
    providerId: sched.provider.id, providerName: sched.provider.name, providerModel: sched.provider.model,
  }));
  const body = await res.json();

  // P1: this exact refusal returned HTTP 500 on the release candidate.
  assert.equal(res.status, 409, `a missing commercial policy is a configuration refusal, not an outage: ${JSON.stringify(body)}`);
  assert.match(String(body.error), /No active Grooming commercial policy/i, "and it still says why");

  assert.equal(countBookings(sqlite), 0, "zero canonical bookings — Chennai stays commercially blocked");
  assert.equal(countPayments(sqlite), 0, "zero payments — no money moved");
  assert.equal(activeHolds(sqlite, "P0-MAA-1"), 0, "the Chennai hold is released");

  const leaked = sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations WHERE city_id='blr'").get().c;
  assert.equal(leaked, 0, "zero BLR leakage — nothing was reserved in Bengaluru");
});

// =====================================================================================================
// CASE 3 — successful booking control: compensation must NOT touch a legitimate reservation.
// =====================================================================================================
test("CASE 3: a valid booking succeeds and its reservation is NOT cancelled by the compensation path", async () => {
  const sqlite = freshDb();
  const sched = await reserve({ groupId: "P0-OK-1", customerId: "CUS-A", cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END });

  const res = await postBooking(groomingBooking({
    idempotencyKey: "p0-ok-1", scheduleGroupId: "P0-OK-1", customerId: "CUS-A",
    cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END,
    providerId: sched.provider.id, providerName: sched.provider.name, providerModel: sched.provider.model,
  }));
  const body = await res.json();
  assert.equal(res.status, 201, `a correctly priced booking must be accepted: ${JSON.stringify(body)}`);

  assert.equal(countBookings(sqlite), 1, "exactly one booking");
  assert.equal(activeHolds(sqlite, "P0-OK-1"), 1, "the legitimate hold survives — capacity stays committed to the real booking");

  const booking = sqlite.prepare("SELECT provider_id,schedule_group_id FROM canonical_bookings WHERE schedule_group_id=?").get("P0-OK-1");
  const reservation = sqlite.prepare("SELECT provider_id FROM scheduling_reservations WHERE group_id=? AND status!='cancelled'").get("P0-OK-1");
  assert.equal(booking.provider_id, reservation.provider_id, "booking/reservation linkage remains correct");
});

// =====================================================================================================
// CASE 4 — duplicate / idempotent replay must not release the live booking's hold.
// =====================================================================================================
test("CASE 4: replaying a successful booking returns the same booking and never releases its reservation", async () => {
  const sqlite = freshDb();
  const sched = await reserve({ groupId: "P0-IDEM-1", customerId: "CUS-A", cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END });
  const good = groomingBooking({
    idempotencyKey: "p0-idem-1", scheduleGroupId: "P0-IDEM-1", customerId: "CUS-A",
    cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END,
    providerId: sched.provider.id, providerName: sched.provider.name, providerModel: sched.provider.model,
  });

  assert.equal((await postBooking(good)).status, 201, "first confirm creates the booking");
  const replay = await postBooking(good);
  assert.ok(replay.status < 400, "the replay is not an error");

  assert.equal(countBookings(sqlite), 1, "no duplicate booking");
  assert.equal(countPayments(sqlite) <= 1, true, "no duplicate payment");
  assert.equal(activeHolds(sqlite, "P0-IDEM-1"), 1, "the replay did NOT release the valid reservation");
});

// =====================================================================================================
// CASE 5 — hostile cross-customer. The security invariant: cleanup must never be a weapon.
// =====================================================================================================
test("CASE 5: customer B cannot release customer A's hold by sending a deliberately failing booking against A's group", async () => {
  const sqlite = freshDb();
  // A reserves legitimately.
  const schedA = await reserve({ groupId: "P0-VICTIM", customerId: "CUS-A", cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END });
  assert.equal(activeHolds(sqlite, "P0-VICTIM"), 1, "A holds capacity");
  const before = sqlite.prepare("SELECT id,status,customer_id FROM scheduling_reservations WHERE group_id=?").all("P0-VICTIM");

  // B quotes A's group. B passes ownership for B's OWN customer id, so the request gets past
  // requireCustomerOwnership — this is exactly the attack a group-scoped cleanup would have enabled.
  const res = await postBooking(groomingBooking({
    idempotencyKey: "p0-attack-1", scheduleGroupId: "P0-VICTIM", customerId: "CUS-B",
    cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END,
    providerId: schedA.provider.id, providerName: schedA.provider.name, providerModel: schedA.provider.model,
    totalAmount: 1, amountDueNow: 1, // deliberately failing
  }));
  const body = await res.json();

  assert.ok(res.status >= 400, `the attacker's request is refused: ${JSON.stringify(body)}`);
  assert.notEqual(body.capacityReleased, 1, "the attacker is never told a victim hold was released");

  const after = sqlite.prepare("SELECT id,status,customer_id FROM scheduling_reservations WHERE group_id=?").all("P0-VICTIM");
  assert.deepEqual(after, before, "ZERO MUTATION against the victim reservation — byte-for-byte unchanged");
  assert.equal(activeHolds(sqlite, "P0-VICTIM"), 1, "A's capacity hold survives the attack intact");
  assert.equal(countBookings(sqlite), 0, "and the attacker created no booking");
});

// =====================================================================================================
// CASE 6 — characterize failure DURING compensation: never silently claim capacity was released.
// =====================================================================================================
test("CASE 6: if the cleanup itself fails, the response says so rather than implying the slot is free", async () => {
  const sqlite = freshDb();
  const sched = await reserve({ groupId: "P0-FAIL-1", customerId: "CUS-A", cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END });

  // Break the cleanup specifically: the compensating UPDATE cannot run, while the read path the rest of
  // the refusal depends on still works. This is the honest failure mode — cleanup fails, refusal stands.
  const realDb = globalThis.__P0CAP_DB__;
  globalThis.__P0CAP_DB__ = {
    ...realDb,
    prepare(sql) {
      if (sql.startsWith("UPDATE scheduling_reservations SET status='cancelled'")) {
        return { bind: () => ({ run: async () => { throw new Error("simulated cleanup failure"); } }) };
      }
      return realDb.prepare(sql);
    },
  };

  const res = await postBooking(groomingBooking({
    idempotencyKey: "p0-fail-1", scheduleGroupId: "P0-FAIL-1", customerId: "CUS-A",
    cityId: "blr", zoneId: "blr-east", start: BLR_START, end: BLR_END,
    providerId: sched.provider.id, providerName: sched.provider.name, providerModel: sched.provider.model,
    totalAmount: 1, amountDueNow: 1,
  }));
  const body = await res.json();
  globalThis.__P0CAP_DB__ = realDb;

  assert.equal(res.status, 409, "the booking refusal still stands — a cleanup failure is not laundered into a 500");
  assert.equal(countBookings(sqlite), 0, "still zero bookings");
  assert.equal(body.capacityReleaseFailed, true, "the response admits the cleanup failed");
  assert.equal(body.capacityReleased, null, "and does NOT claim a number of released holds");
  assert.equal(activeHolds(sqlite, "P0-FAIL-1"), 1, "the hold is genuinely still held — matching what we reported");
});
