/*
 * Day-31 cross-module test 5: booking + auto-assignment against a provider whose availability
 * changes underneath the booking.
 *
 * capacity profile -> slot reservation -> provider goes unavailable -> booking confirmation guard.
 *
 * The window between reserving a groomer's slot and confirming the booking is real: the groomer
 * calls in sick, Ops blocks them, and the confirmation is still in flight. The platform's defence
 * is a database TRIGGER (block_unavailable_provider_booking) rather than an application check,
 * which is the right instrument - it cannot be bypassed by a caller that forgets to ask - but a
 * trigger whose overlap predicate is wrong fails silently in both directions: it either lets a
 * sick groomer be dispatched, or it blocks a perfectly good booking that merely touches the edge
 * of a block.
 *
 * Both directions are asserted, at the boundary, in the same suite. Modules executed:
 * provider-capacity-governance, provider-assignment-eligibility, provider-verification-mandate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world } from "./helpers/execution-harness.mjs";

installWorkersHooks("__D31_AVAIL_DB__", "__D31_AVAIL_ENV__");

const PROVIDER = "PRV-D31-AVL";
const GROUP = "GRP-D31-AVL";
const OPS = "ops@pawspace.in";
const START = "2026-10-01T04:00:00.000Z";   // 09:30 IST
const END = "2026-10-01T05:30:00.000Z";     // 11:00 IST

async function seedSlot() {
  const { sqlite, db } = world("__D31_AVAIL_DB__", "__D31_AVAIL_ENV__");
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.ensureProviderBookingGuard(db);

  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(PROVIDER, "blr", "Kiran G", "in_house", '["grooming"]', '["blr-east"]', String(now), OPS, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT)");
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,status,created_at) VALUES (?,?,?,'grooming','blr','blr-east','CUS-D31','[\"PET-1\"]',?,?,'held',?)")
    .run("RES-D31-AVL", GROUP, PROVIDER, START, END, now);
  return { sqlite, db, capacity };
}

/** Confirming a booking means inserting the guard row - the trigger is what decides. */
const confirmBooking = (sqlite) => {
  try {
    sqlite.prepare("INSERT INTO provider_booking_confirmation_guards (group_id,created_at) VALUES (?,?)").run(GROUP, Date.now());
    return { confirmed: true };
  } catch (error) {
    return { confirmed: false, reason: String(error.message) };
  }
};

const blockWindow = (sqlite, startsAt, endsAt) =>
  sqlite.prepare("INSERT INTO provider_unavailability (id,provider_id,starts_at,ends_at,reason,status,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'active',?,?,?)")
    .run(`PUNAVAIL-${startsAt}`, PROVIDER, startsAt, endsAt, "Day-31 availability boundary", OPS, Date.now(), Date.now());

test("a free provider's booking confirms", async () => {
  const { sqlite } = await seedSlot();
  assert.equal(confirmBooking(sqlite).confirmed, true);
});

test("a provider who goes unavailable AFTER the slot was held cannot be dispatched", async () => {
  const { sqlite, capacity, db } = await seedSlot();
  await capacity.setProviderAvailability(db, {
    providerId: PROVIDER, available: false,
    reason: "Called in sick after the slot was held", actorId: OPS, actorIsStaff: true,
  });
  const result = confirmBooking(sqlite);
  assert.equal(result.confirmed, false, "a sick groomer must not reach a customer's door");
  assert.match(result.reason, /provider_unavailable_before_booking/);
});

test("the overlap boundary is exact in both directions", async () => {
  /*
   * A block that ENDS exactly when the appointment starts, or STARTS exactly when it ends, does not
   * overlap it - refusing those would cancel good bookings for no reason. One millisecond further
   * in and it does overlap, and must refuse.
   */
  const cases = [
    ["ends exactly at appointment start", "2026-10-01T02:00:00.000Z", START, true],
    ["ends one ms into the appointment", "2026-10-01T02:00:00.000Z", "2026-10-01T04:00:00.001Z", false],
    ["starts exactly at appointment end", END, "2026-10-01T08:00:00.000Z", true],
    ["starts one ms before appointment end", "2026-10-01T05:29:59.999Z", "2026-10-01T08:00:00.000Z", false],
    ["fully contains the appointment", "2026-10-01T00:00:00.000Z", "2026-10-01T23:00:00.000Z", false],
  ];
  for (const [label, startsAt, endsAt, shouldConfirm] of cases) {
    const { sqlite, db, capacity } = await seedSlot();
    blockWindow(sqlite, startsAt, endsAt);
    assert.equal(confirmBooking(sqlite).confirmed, shouldConfirm, `booking guard, ${label}`);
    assert.equal(
      await capacity.providerUnavailableForWindow(db, { providerId: PROVIDER, scheduledStart: START, scheduledEnd: END }),
      !shouldConfirm,
      `providerUnavailableForWindow must agree with the trigger, ${label}`,
    );
  }
});

test("a cancelled reservation does not keep blocking the group", async () => {
  const { sqlite } = await seedSlot();
  blockWindow(sqlite, "2026-10-01T00:00:00.000Z", "2026-10-01T23:00:00.000Z");
  assert.equal(confirmBooking(sqlite).confirmed, false);
  sqlite.prepare("UPDATE scheduling_reservations SET status='cancelled' WHERE group_id=?").run(GROUP);
  assert.equal(confirmBooking(sqlite).confirmed, true,
    "once the held slot is released the block no longer concerns this group");
});

test("clearing the block puts the provider back to work, and a staff clear is scoped to real blocks", async () => {
  const { sqlite, db, capacity } = await seedSlot();
  await capacity.setProviderAvailability(db, {
    providerId: PROVIDER, available: false, reason: "Sick day", actorId: OPS, actorIsStaff: true,
  });
  assert.equal(confirmBooking(sqlite).confirmed, false);

  const restored = await capacity.setProviderAvailability(db, {
    providerId: PROVIDER, available: true, reason: "Back at work", actorId: OPS, actorIsStaff: true,
  });
  assert.equal(restored.available, true);
  assert.equal(restored.restrictionsRemaining, 0);
  assert.equal(confirmBooking(sqlite).confirmed, true);
});
