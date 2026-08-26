/**
 * The approved city status matrix, and the emergency control that suspends existing work.
 * [PTJA-W1-F38 follow-on]
 *
 * The earlier fix on this branch made PAUSED stop new fulfilment, which was the measured defect: an
 * operator paused Bengaluru, removed a pincode, and the customer app kept resolving zones and saving
 * doorstep addresses. What it did not do is express the whole matrix the business has now approved:
 *
 *   status   new customer bookings                                        existing confirmed bookings
 *   DRAFT    blocked                                                      none expected
 *   PILOT    only for explicitly enabled pincodes, services and channels  continue
 *   ACTIVE   allowed normally                                             continue
 *   PAUSED   blocked                                                      continue unless individually cancelled
 *   CLOSED   blocked                                                      reassigned, rescheduled or cancelled
 *                                                                         through an audited operation
 *
 * A pause must stop new bookings, new MANUAL bookings, wait-list conversion and automatic subscription
 * renewal scheduling - and must never silently cancel a confirmed booking. Suspending existing work is a
 * SEPARATE emergency control requiring superuser approval, a reason, a review of the affected bookings
 * and customer communication.
 *
 * WHAT IS NOT ASSERTED HERE, AND WHY. The platform has no wait-list: there is no wait-list table, module
 * or route anywhere in the repository. Rather than invent one so a rule could be ticked off, the pause
 * gate is written so that any future wait-list conversion must pass through the same booking verdict,
 * and this is recorded as an open item rather than a satisfied one.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_CITY_DB__", "__PTJA_CITY_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const OPS = "city-ops@pawspace.test";
const staff = (email) => ({
  "oai-authenticated-user-email": email,
  "oai-authenticated-user-full-name": "City%20ops",
  "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
});
const FOUNDER = staff("city-founder@pawspace.test");
const MANAGER = staff("city-manager@pawspace.test");

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_CITY_DB__ = db;
  globalThis.__PTJA_CITY_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedDefaultCityLaunchConfigs } = await import("../lib/city-governance.ts");
  const { ensureCityEmergencyTables } = await import("../lib/city-status-authority.ts");
  await ensureSecurityTables(db);
  await seedDefaultCityLaunchConfigs(db);
  // Created up front so "no emergency record was written" is an observation about an empty table.
  await ensureCityEmergencyTables(db);
  const now = Date.now();
  for (const [id, email, role] of [
    ["USR-CITY-F", "city-founder@pawspace.test", "founder"],
    ["USR-CITY-M", "city-manager@pawspace.test", "manager"],
  ]) {
    await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)").bind(id, email, email, role, now, now).run();
  }
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT,scheduled_start TEXT NOT NULL,status TEXT NOT NULL,total_amount REAL NOT NULL,updated_at INTEGER)");
  return { sqlite, db };
}

/** Columns taken from lib/food-subscription-governance.ts, the module that owns this table. */
const seedSubscription = (w, id, now) =>
  w.sqlite.prepare("INSERT INTO food_subscriptions (id,source_order_id,customer_id,city_id,zone_id,sku,item_name,quantity,renewal_interval_days,status,communication_channel,unit_price_at_signup,approved_unit_price,current_cycle,next_renewal_at,created_by,created_at,updated_at) VALUES (?,?,'CUS-9','blr','blr-east','SKU-1','Kibble 5kg',1,7,'active','whatsapp',1200,1200,0,?,?,?,?)")
    .run(id, `ORD-${id}`, now - 1000, OPS, now, now);

const setStatus = (w, status) => w.sqlite.prepare("UPDATE city_launch_configs SET status=? WHERE city_code='blr'").run(status);
const verdict = async (w, input = {}) => {
  const { cityBookingVerdict } = await import("../lib/city-status-authority.ts");
  return cityBookingVerdict(w.db, { cityId: "blr", serviceCode: "grooming", pincode: "560034", channel: "customer_app", ...input });
};

test("F38M-1: DRAFT blocks new customer bookings", async () => {
  const w = await world();
  setStatus(w, "Draft");
  const result = await verdict(w);
  assert.equal(result.allowed, false, `a Draft city takes no bookings: ${JSON.stringify(result)}`);
  assert.equal(result.status, "Draft");
});

test("F38M-2: ACTIVE allows bookings normally", async () => {
  // Non-vacuity for every block below. The platform's own word for ACTIVE is 'Live'.
  const w = await world();
  setStatus(w, "Live");
  const result = await verdict(w);
  assert.equal(result.allowed, true, `a live city books normally: ${JSON.stringify(result)}`);
});

test("F38M-3: PAUSED blocks new bookings on every channel, including manual ops bookings", async () => {
  const w = await world();
  setStatus(w, "Paused");
  for (const channel of ["customer_app", "ops_assisted", "waitlist_conversion", "subscription_renewal"]) {
    const result = await verdict(w, { channel });
    assert.equal(result.allowed, false, `${channel} must be blocked while the city is paused: ${JSON.stringify(result)}`);
    assert.equal(result.reason, "city_paused");
  }
});

test("F38M-4: CLOSED blocks new bookings and says existing work needs an audited operation", async () => {
  const w = await world();
  setStatus(w, "Closed");
  const result = await verdict(w);
  assert.equal(result.allowed, false);
  assert.equal(result.reason, "city_closed");
  assert.equal(result.existingWorkHandling, "audited_operation_required",
    "a closed city's existing bookings must be reassigned, rescheduled or cancelled deliberately");
});

test("F38M-5: PILOT allows only explicitly enabled pincodes, services and channels", async () => {
  const w = await world();
  setStatus(w, "Pilot");
  const { writeServicePolicy } = await import("../lib/service-policy-governance.ts");
  const { CITY_STATUS_DOMAIN, APPROVED_CITY_STATUS_POLICY } = await import("../lib/city-status-authority.ts");
  await writeServicePolicy(w.db, { domain: CITY_STATUS_DOMAIN, serviceCode: "*", cityId: "blr",
    config: { ...APPROVED_CITY_STATUS_POLICY, pilotAllowedPincodes: ["560034"], pilotAllowedServices: ["grooming"], pilotAllowedChannels: ["customer_app"] } },
    OPS, "Bengaluru pilot: Koramangala grooming on the app only");

  assert.equal((await verdict(w)).allowed, true, "the enabled combination is allowed");
  assert.equal((await verdict(w, { pincode: "560102" })).allowed, false, "a pincode outside the pilot is not");
  assert.equal((await verdict(w, { serviceCode: "boarding" })).allowed, false, "nor a service outside it");
  assert.equal((await verdict(w, { channel: "ops_assisted" })).allowed, false, "nor a channel outside it");
});

test("F38M-6: a PILOT city with nothing enabled allows nothing", async () => {
  // Absence is not permission. A pilot whose allow-list nobody has filled in is a pilot with no cohort.
  const w = await world();
  setStatus(w, "Pilot");
  const result = await verdict(w);
  assert.equal(result.allowed, false, `an empty pilot allow-list permits nothing: ${JSON.stringify(result)}`);
  assert.equal(result.reason, "pilot_scope_not_enabled");
});

test("F38M-7: pausing a city never cancels a confirmed booking", async () => {
  const w = await world();
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,scheduled_start,status,total_amount,updated_at) VALUES ('BK-KEEP','CUS-1','grooming','blr','2026-12-01T04:30:00.000Z','confirmed',1899,1)").run();
  setStatus(w, "Paused");

  const result = await verdict(w);
  assert.equal(result.allowed, false);
  assert.equal(result.existingWorkHandling, "continue", "confirmed bookings continue unless individually cancelled");
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-KEEP'").get().status, "confirmed",
    "and nothing about a pause touches the booking itself");
});

test("F38M-8: automatic subscription renewal scheduling stops while a city is paused", async () => {
  const w = await world();
  setStatus(w, "Paused");
  const renewal = await verdict(w, { channel: "subscription_renewal" });
  assert.equal(renewal.allowed, false, "a paused city does not auto-renew customers into itself");
});

test("F38M-9: the emergency control suspends existing work, and only a superuser may fire it", async () => {
  const w = await world();
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,scheduled_start,status,total_amount,updated_at) VALUES ('BK-SUSP','CUS-2','grooming','blr','2026-12-01T04:30:00.000Z','confirmed',1899,1)").run();
  const { pauseNewAndSuspendExisting } = await import("../lib/city-status-authority.ts");

  await assert.rejects(() => pauseNewAndSuspendExisting(w.db, { cityId: "blr", actorId: "city-manager@pawspace.test",
    actorPermissions: ["launch.manage"], reason: "Flooding across the city", customerCommunication: { channel: "sms", template: "city_suspended" } }),
    "a manager may run a city but may not suspend every booking in it");

  const outcome = await pauseNewAndSuspendExisting(w.db, { cityId: "blr", actorId: "city-founder@pawspace.test",
    actorPermissions: ["*"], reason: "Flooding across the city", customerCommunication: { channel: "sms", template: "city_suspended" } });

  assert.equal(outcome.affectedBookings, 1, "the affected bookings are counted for review");
  assert.equal(w.sqlite.prepare("SELECT status FROM city_launch_configs WHERE city_code='blr'").get().status, "Paused",
    "new work stops");
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-SUSP'").get().status, "suspended_city_emergency",
    "and existing work is suspended under a distinct status, not quietly cancelled");
});

test("F38M-10: the emergency control refuses without a reason or a communication plan", async () => {
  const w = await world();
  const { pauseNewAndSuspendExisting } = await import("../lib/city-status-authority.ts");
  await assert.rejects(() => pauseNewAndSuspendExisting(w.db, { cityId: "blr", actorId: OPS, actorPermissions: ["*"], reason: "x",
    customerCommunication: { channel: "sms", template: "t" } }), "a one-character reason is not a reason");
  await assert.rejects(() => pauseNewAndSuspendExisting(w.db, { cityId: "blr", actorId: OPS, actorPermissions: ["*"],
    reason: "Flooding across the city" }), "suspending a city's customers without telling them is not an option");
});

test("F38M-11: the emergency suspension is fully audited", async () => {
  const w = await world();
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,scheduled_start,status,total_amount,updated_at) VALUES ('BK-AUD','CUS-3','grooming','blr','2026-12-01T04:30:00.000Z','confirmed',1899,1)").run();
  const { pauseNewAndSuspendExisting } = await import("../lib/city-status-authority.ts");
  await pauseNewAndSuspendExisting(w.db, { cityId: "blr", actorId: "city-founder@pawspace.test", actorPermissions: ["*"],
    reason: "Flooding across the city", customerCommunication: { channel: "sms", template: "city_suspended" } });

  const audit = w.sqlite.prepare("SELECT actor_id,reason,affected_json FROM city_emergency_suspensions WHERE city_id='blr'").get();
  assert.equal(audit.actor_id, "city-founder@pawspace.test");
  assert.match(String(audit.reason), /Flooding/);
  const affected = JSON.parse(audit.affected_json);
  assert.ok(affected.bookingIds.includes("BK-AUD"), "the audit names every booking it touched, for review");
  assert.ok(affected.customerCommunication, "and the communication that was sent");
});

test("F38M-12: an ordinary pause does NOT suspend existing work", async () => {
  // Non-vacuity for the emergency control, and the sharpest line in the approved matrix: the two
  // controls are different, and confusing them is how a city pause becomes a mass cancellation.
  const w = await world();
  w.sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,city_id,scheduled_start,status,total_amount,updated_at) VALUES ('BK-ORD','CUS-4','grooming','blr','2026-12-01T04:30:00.000Z','confirmed',1899,1)").run();
  setStatus(w, "Paused");
  await verdict(w);
  assert.equal(w.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id='BK-ORD'").get().status, "confirmed");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM city_emergency_suspensions").get().n, 0,
    "and no emergency record is written by an ordinary pause");
});

test("F38M-13: a city with no launch config is still governed by its reviewed zone mapping", async () => {
  /*
   * The contract this repository already made, pinned by tests/service-zone-coverage.test.mjs and
   * preserved by the first half of this finding: a reviewed service_zone_mappings row opens a second city
   * without a launch config. A first draft of this gate blocked here and took every second city offline -
   * the suite said so at once. The matrix governs cities that HAVE been launched and says nothing about
   * cities that have not; the launch-readiness gate is what stops an unverifiable city reaching customers.
   */
  const w = await world();
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM city_launch_configs WHERE city_code='maa'").get().n, 0,
    "this case is only meaningful while Chennai has no launch config");

  const result = await verdict(w, { cityId: "maa", pincode: "600001" });
  assert.equal(result.allowed, true, `a second city must not be closed by a matrix it was never entered into: ${JSON.stringify(result)}`);
  assert.equal(result.reason, "no_launch_governance");
});

test("F38M-14: automatic food subscription renewals skip a paused city and touch nothing", async () => {
  const w = await world();
  const { ensureFoodSubscriptionTables, processDueFoodSubscriptionRenewals } = await import("../lib/food-subscription-governance.ts");
  await ensureFoodSubscriptionTables(w.db);
  const now = Date.now();
  seedSubscription(w, "FS-1", now);
  setStatus(w, "Paused");

  const outcome = await processDueFoodSubscriptionRenewals(w.db, { actorId: OPS, at: now });

  assert.equal(outcome.processed, 0, "a paused city does not renew customers into itself");
  assert.ok(outcome.skippedForCity.includes("FS-1"), "and the skip is reported rather than silent");
  assert.equal(w.sqlite.prepare("SELECT status FROM food_subscriptions WHERE id='FS-1'").get().status, "active",
    "the subscription itself is untouched - it renews when the market reopens");
});

test("F38M-15: the same renewal runs normally once the city is live again", async () => {
  // Non-vacuity for the case above. A renewal sweep that skipped everything would stop the business.
  const w = await world();
  const { ensureFoodSubscriptionTables, processDueFoodSubscriptionRenewals } = await import("../lib/food-subscription-governance.ts");
  await ensureFoodSubscriptionTables(w.db);
  const now = Date.now();
  seedSubscription(w, "FS-2", now);
  setStatus(w, "Live");

  const outcome = await processDueFoodSubscriptionRenewals(w.db, { actorId: OPS, at: now });
  assert.equal(outcome.processed, 1, `a live city renews normally: ${JSON.stringify(outcome).slice(0, 300)}`);
  assert.deepEqual(outcome.skippedForCity, []);
});
