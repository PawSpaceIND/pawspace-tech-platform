/**
 * Staging testers saw "No groomer is available" although the seeded roster covers every zone. Two kinds of left-over
 * state caused it: every unpaid "Reserve & review payment" held its groomer for good (a group with a canonical
 * booking is never lease-released), and saving a seeded groomer in /control rewrote updated_by, which dropped it from
 * matching. On a declared UAT runtime both are now self-healing; production behaviour is unchanged.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__UAT_GROOMERS_DB__", "__UAT_GROOMERS_ENV__");
const { releaseAbandonedUatCheckouts, UAT_ABANDONED_CHECKOUT_GRACE_MS } = await import("../lib/scheduling-reservation-leases.ts");
const { isUatRosterProviderId } = await import("../lib/provider-assignment-eligibility.ts");

const UAT = { PAWSPACE_SCHEDULING_ENV: "uat" };
const NOW = Date.UTC(2026, 8, 27, 6, 0);

function world() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,schedule_group_id TEXT,service_code TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT,status TEXT,detail_json TEXT NOT NULL DEFAULT '{}',updated_at INTEGER);
    CREATE TABLE provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT,status TEXT,updated_at INTEGER);
    CREATE TABLE scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT,provider_id TEXT,status TEXT);
    CREATE TABLE scheduling_assignment_decisions (id TEXT PRIMARY KEY,group_id TEXT,status TEXT,actor_id TEXT,reason TEXT,updated_at INTEGER);
  `);
  return { sqlite, db: d1(sqlite) };
}
function checkout(sqlite, id, { ageMs, payment = "created" }) {
  const group = `GRP-${id}`;
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,?,'grooming','payment_pending',?,?)").run(id, group, NOW - ageMs, NOW - ageMs);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,?,'{}',?)").run(`PAY-${id}`, id, payment, NOW - ageMs);
  sqlite.prepare("INSERT INTO provider_work_orders VALUES (?,?,'payment_pending',?)").run(`WO-${id}`, id, NOW - ageMs);
  sqlite.prepare("INSERT INTO scheduling_reservations VALUES (?,?,'uatcap_groom_south','assigned')").run(`RES-${id}`, group);
  sqlite.prepare("INSERT INTO scheduling_assignment_decisions VALUES (?,?,'assigned','system','auto',?)").run(`DEC-${id}`, group, NOW - ageMs);
}
const statusOf = (sqlite, table, where, id) => sqlite.prepare(`SELECT status FROM ${table} WHERE ${where}=?`).get(id).status;

test("an unpaid UAT checkout older than 30 minutes releases its groomer; a newer or paid one keeps it", async () => {
  const { sqlite, db } = world();
  checkout(sqlite, "OLD", { ageMs: UAT_ABANDONED_CHECKOUT_GRACE_MS + 60_000 });
  checkout(sqlite, "NEW", { ageMs: 5 * 60_000 });
  checkout(sqlite, "PAID", { ageMs: 2 * UAT_ABANDONED_CHECKOUT_GRACE_MS, payment: "captured" });
  const result = await releaseAbandonedUatCheckouts(db, UAT, NOW);
  assert.equal(result.released, 1);
  assert.equal(statusOf(sqlite, "canonical_bookings", "id", "OLD"), "cancelled");
  assert.equal(statusOf(sqlite, "scheduling_reservations", "group_id", "GRP-OLD"), "cancelled", "the groomer is free again");
  assert.equal(statusOf(sqlite, "scheduling_assignment_decisions", "group_id", "GRP-OLD"), "expired");
  assert.equal(statusOf(sqlite, "scheduling_reservations", "group_id", "GRP-NEW"), "assigned", "inside the grace period");
  assert.equal(statusOf(sqlite, "canonical_bookings", "id", "PAID"), "payment_pending", "a captured payment keeps its booking");
  assert.equal(statusOf(sqlite, "scheduling_reservations", "group_id", "GRP-PAID"), "assigned");
});

test("outside a declared UAT runtime nothing is released", async () => {
  const { sqlite, db } = world();
  checkout(sqlite, "OLD", { ageMs: 10 * UAT_ABANDONED_CHECKOUT_GRACE_MS });
  for (const env of [{}, { PAWSPACE_SCHEDULING_ENV: "production" }, null]) {
    const result = await releaseAbandonedUatCheckouts(db, env, NOW);
    assert.equal(result.released, 0);
  }
  assert.equal(statusOf(sqlite, "scheduling_reservations", "group_id", "GRP-OLD"), "assigned");
});

test("seeded UAT roster ids stay recognisable after a staff edit; other providers do not", () => {
  for (const id of ["uatcap_groom_south", "uatcap_groom_ft", "uatcap_groom_east_7", "groom_arun"]) assert.equal(isUatRosterProviderId(id), true, id);
  for (const id of ["PRV-REAL-1", "uatcap_", "uatcap_groom;drop", "groom_arun_x", ""]) assert.equal(isUatRosterProviderId(id), false, id);
});
