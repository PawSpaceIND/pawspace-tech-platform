/**
 * P0 — CROSS-CUSTOMER RESERVATION-GROUP OWNERSHIP BYPASS.
 *
 * requireCustomerOwnership proves the caller owns the customer id in the request BODY. It proves nothing
 * about the scheduleGroupId in that same body, and nothing else in the booking route compared the two. So
 * a byte-identical, otherwise-valid confirmation with ONLY the scheduleGroupId swapped for a stranger's
 * group was accepted: 201, a real booking, a captured payment and a provider work order — all against the
 * victim's reserved slot, while the victim's reservation stayed 'assigned'.
 *
 * These tests are deliberately NON-VACUOUS: each attack is preceded by a positive control proving the same
 * customer, same pet, same package, same price and same window DOES produce a 201 on its OWN group. The
 * only differing variable in the attack is the foreign scheduleGroupId.
 *
 * This is an AUTHORITY refusal (403), not a state conflict (409), and it must leave the victim untouched —
 * including no compensating release of the victim's capacity.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

installWorkersHooks("__XGRP_DB__", "__XGRP_ENV__");

const BLR_START = "2026-09-01T04:30:00.000Z", BLR_END = "2026-09-01T06:30:00.000Z";
const PKG = { code: "dog-bath", name: "Essential Bath", price: 1349 };

const schedulingRoute = await import("../app/api/uat-scheduling/route.ts");
const bookingRoute = await import("../app/api/canonical-bookings/route.ts");

const postScheduling = (body) => schedulingRoute.POST(new Request("http://localhost/api/uat-scheduling", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const postBooking = (body) => bookingRoute.POST(new Request("http://localhost/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));

const petOf = (customerId) => `PET-${customerId}`;

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__XGRP_DB__ = createD1(sqlite);
  globalThis.__XGRP_ENV__ = {};
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  const insertPet = sqlite.prepare("INSERT OR IGNORE INTO canonical_pets (id,customer_id,name,species,vaccination_status,source_pet_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)");
  // Each customer genuinely owns their OWN pet, so the attack cannot be dismissed as a pet-ownership failure.
  for (const c of ["CUS-A", "CUS-B"]) insertPet.run(petOf(c), c, "Rex", "dog", "not_provided", "p1", 0, 0);
  return sqlite;
}

async function reserve({ groupId, customerId }) {
  const res = await postScheduling({
    clientRequestId: groupId, customerId, petIds: [petOf(customerId)],
    serviceCode: "grooming", cityId: "blr", zoneId: "blr-east",
    scheduledStart: BLR_START, scheduledEnd: BLR_END,
  });
  const body = await res.json();
  assert.equal(res.status, 200, `reserve must succeed: ${JSON.stringify(body)}`);
  return body.data;
}

/** A fully valid confirmation. Only `scheduleGroupId` is varied between control and attack. */
function booking({ idempotencyKey, scheduleGroupId, customerId, provider }) {
  return {
    idempotencyKey, scheduleGroupId,
    customer: { id: customerId, name: "Customer", primaryPhone: "+919000000001" },
    pets: [{ sourceId: "p1", name: "Rex", species: "dog" }],
    cityId: "blr", zoneId: "blr-east",
    serviceCode: "grooming", packageCode: PKG.code, packageName: PKG.name,
    scheduledStart: BLR_START, scheduledEnd: BLR_END,
    provider: { id: provider.id, name: provider.name, model: provider.model },
    totalAmount: PKG.price, amountDueNow: PKG.price,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "customer app" },
    pricing: { discount: 0 },
  };
}

const snapshotReservations = (sqlite, groupId) =>
  sqlite.prepare("SELECT id,group_id,provider_id,customer_id,status,scheduled_start,scheduled_end,capacity_units FROM scheduling_reservations WHERE group_id=? ORDER BY id").all(groupId);
const countBookings = (sqlite) => sqlite.prepare("SELECT COUNT(*) c FROM canonical_bookings").get().c;
const tableCount = (sqlite, table) => {
  const t = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
  return t ? sqlite.prepare(`SELECT COUNT(*) c FROM ${table}`).get().c : 0;
};

// =====================================================================================================
// 1 — B attacks A. Positive control first, so the 403 cannot be a false negative.
// =====================================================================================================
test("B -> A: control proves B's request shape is genuinely bookable, then the same request on A's group is 403 with zero mutation", async () => {
  const sqlite = freshDb();
  const schedA = await reserve({ groupId: "GRP-A", customerId: "CUS-A" });
  const schedB = await reserve({ groupId: "GRP-B", customerId: "CUS-B" });

  // POSITIVE CONTROL — B confirms B's own group. Same customer, pet, package, price, window.
  const control = await postBooking(booking({ idempotencyKey: "ctrl-b", scheduleGroupId: "GRP-B", customerId: "CUS-B", provider: schedB.provider }));
  assert.equal(control.status, 201, `control must succeed, otherwise the attack result proves nothing: ${JSON.stringify(await control.json())}`);
  const bookingsAfterControl = countBookings(sqlite);
  const paymentsAfterControl = tableCount(sqlite, "canonical_payments");
  const workOrdersAfterControl = tableCount(sqlite, "provider_work_orders");

  const victimBefore = snapshotReservations(sqlite, "GRP-A");
  assert.equal(victimBefore.length > 0, true, "A genuinely holds a reservation");
  assert.equal(victimBefore[0].status, "assigned", "A's hold is active before the attack");

  // ATTACK — byte-identical to the control except scheduleGroupId points at A's group.
  const attack = await postBooking(booking({ idempotencyKey: "attack-b-to-a", scheduleGroupId: "GRP-A", customerId: "CUS-B", provider: schedA.provider }));
  const attackBody = await attack.json();

  assert.equal(attack.status, 403, `a foreign scheduling group is an AUTHORITY refusal, not 409/201: ${JSON.stringify(attackBody)}`);
  assert.equal(countBookings(sqlite), bookingsAfterControl, "zero new canonical booking");
  assert.equal(tableCount(sqlite, "canonical_payments"), paymentsAfterControl, "zero new payment");
  assert.equal(tableCount(sqlite, "provider_work_orders"), workOrdersAfterControl, "zero new work order");
  assert.deepEqual(snapshotReservations(sqlite, "GRP-A"), victimBefore, "victim reservation byte-for-byte unchanged");
  assert.equal(attackBody.capacityReleased, undefined, "no compensating release ran against the victim");
  assert.equal(attackBody.capacityReleaseFailed, undefined, "and no cleanup was attempted at all");
});

// =====================================================================================================
// 2 — the inverse: A attacks B. Same guarantee, so the fix is not one-directional.
// =====================================================================================================
test("A -> B: control proves A's request shape is bookable, then the same request on B's group is 403 with zero mutation", async () => {
  const sqlite = freshDb();
  const schedA = await reserve({ groupId: "GRP-A2", customerId: "CUS-A" });
  const schedB = await reserve({ groupId: "GRP-B2", customerId: "CUS-B" });

  const control = await postBooking(booking({ idempotencyKey: "ctrl-a", scheduleGroupId: "GRP-A2", customerId: "CUS-A", provider: schedA.provider }));
  assert.equal(control.status, 201, `control must succeed: ${JSON.stringify(await control.json())}`);
  const bookingsAfterControl = countBookings(sqlite);

  const victimBefore = snapshotReservations(sqlite, "GRP-B2");
  const attack = await postBooking(booking({ idempotencyKey: "attack-a-to-b", scheduleGroupId: "GRP-B2", customerId: "CUS-A", provider: schedB.provider }));
  const attackBody = await attack.json();

  assert.equal(attack.status, 403, `inverse attack must also be refused: ${JSON.stringify(attackBody)}`);
  assert.equal(countBookings(sqlite), bookingsAfterControl, "zero new canonical booking");
  assert.deepEqual(snapshotReservations(sqlite, "GRP-B2"), victimBefore, "victim reservation byte-for-byte unchanged");
});

// =====================================================================================================
// 3 — legitimate own-group confirmations keep working in both directions.
// =====================================================================================================
test("A->A and B->B both still succeed, and each booking is linked to its own reservation", async () => {
  const sqlite = freshDb();
  const schedA = await reserve({ groupId: "GRP-A3", customerId: "CUS-A" });
  const schedB = await reserve({ groupId: "GRP-B3", customerId: "CUS-B" });

  assert.equal((await postBooking(booking({ idempotencyKey: "ok-a", scheduleGroupId: "GRP-A3", customerId: "CUS-A", provider: schedA.provider }))).status, 201, "A->A succeeds");
  assert.equal((await postBooking(booking({ idempotencyKey: "ok-b", scheduleGroupId: "GRP-B3", customerId: "CUS-B", provider: schedB.provider }))).status, 201, "B->B succeeds");

  assert.equal(countBookings(sqlite), 2, "both legitimate bookings exist");
  const a = sqlite.prepare("SELECT customer_id FROM canonical_bookings WHERE schedule_group_id=?").get("GRP-A3");
  const b = sqlite.prepare("SELECT customer_id FROM canonical_bookings WHERE schedule_group_id=?").get("GRP-B3");
  assert.equal(a.customer_id, "CUS-A", "A's booking is on A's group");
  assert.equal(b.customer_id, "CUS-B", "B's booking is on B's group");
});

// =====================================================================================================
// 4 — the replay lookup matches on schedule_group_id, so it too must not leak across customers.
// =====================================================================================================
test("an attacker quoting a group that ALREADY has the victim's booking is refused 403, not handed the victim's booking bundle", async () => {
  freshDb();
  const schedA = await reserve({ groupId: "GRP-A4", customerId: "CUS-A" });
  await reserve({ groupId: "GRP-B4", customerId: "CUS-B" });

  assert.equal((await postBooking(booking({ idempotencyKey: "ok-a4", scheduleGroupId: "GRP-A4", customerId: "CUS-A", provider: schedA.provider }))).status, 201, "A books first");

  // The prior-booking lookup is `idempotency_key=? OR schedule_group_id=?`. Without the gate placed
  // ahead of it, this would return A's booking bundle to B.
  const res = await postBooking(booking({ idempotencyKey: "attack-replay", scheduleGroupId: "GRP-A4", customerId: "CUS-B", provider: schedA.provider }));
  const body = await res.json();
  assert.equal(res.status, 403, "refused on authority before the replay lookup runs");
  assert.equal(body.data, undefined, "and no booking bundle is disclosed to the attacker");
});

// =====================================================================================================
// 5 — response classes stay distinct: authority is 403, commercial conflict is still 409.
// =====================================================================================================
test("ownership is 403 while a price conflict on the caller's OWN group is still 409", async () => {
  const sqlite = freshDb();
  const schedA = await reserve({ groupId: "GRP-A5", customerId: "CUS-A" });
  await reserve({ groupId: "GRP-B5", customerId: "CUS-B" });

  const foreign = await postBooking(booking({ idempotencyKey: "cls-403", scheduleGroupId: "GRP-A5", customerId: "CUS-B", provider: schedA.provider }));
  assert.equal(foreign.status, 403, "foreign group -> 403");

  const tampered = booking({ idempotencyKey: "cls-409", scheduleGroupId: "GRP-A5", customerId: "CUS-A", provider: schedA.provider });
  tampered.totalAmount = 1; tampered.amountDueNow = 1;
  const priceRes = await postBooking(tampered);
  assert.equal(priceRes.status, 409, "own group, bad price -> still 409, not relabelled as an authority failure");
  assert.equal(countBookings(sqlite), 0, "and neither request created a booking");
});
