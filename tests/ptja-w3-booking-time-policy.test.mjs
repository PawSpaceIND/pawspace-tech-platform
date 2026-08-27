/**
 * PawSpace booking time rules and stay caps. [PTJA-W3-BT]
 *
 * THE APPROVED RULE, supplied by the business:
 *   - Reject any booking whose start time is in the past.
 *   - Minimum lead time: Grooming, Dog Walking and Pet Taxi 2 hours; Training, Pet Sitting and
 *     Boarding 24 hours.
 *   - Maximum advance-booking horizon: 180 days for all schedulable services.
 *   - Maximum stay: Boarding 90 consecutive days, Pet Sitting 30 consecutive days. A longer INITIAL
 *     booking is rejected; an extension must be an explicit audited modification or a new booking.
 *   - One central configurable policy, not values hardcoded across routes.
 *   - Validation server-side using SERVER time. The client timestamp is never authoritative.
 *   - Fresh Food follows fulfilment/delivery-slot rules and Relocation stays a request/case workflow;
 *     neither is forced through occurrence-booking rules.
 *
 * WHAT WAS MEASURED BEFORE. backend/src/scheduling.ts buildOccurrences validates only that the end is
 * after the start and that a minimum duration is met. There is no lead time anywhere in the repository,
 * no upper horizon, and no maximum stay length in the code, the tests or the seeded catalogue - a
 * Boarding stay could be opened for a decade. The reserve route carries a single hardcoded
 * `reserveStart <= Date.now()` refusal, which is the past-start half only, written inline rather than
 * as policy anybody can change.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_BT_DB__", "__PTJA_BT_ENV__");

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

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_BT_DB__ = db;
  globalThis.__PTJA_BT_ENV__ = {};
  const policy = await import("../lib/booking-time-policy.ts");
  await policy.seedBookingTimePolicies(db);
  return { sqlite, db, policy };
}

const attempt = (promise) => promise.then(
  (value) => ({ ok: true, value }),
  async (error) => ({ ok: false, status: error instanceof Response ? error.status : 0, message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error) }),
);

const check = (policy, db, serviceCode, startMs, endMs, extra = {}) =>
  attempt(policy.assertBookingWindow(db, { serviceCode, cityId: "blr", scheduledStart: iso(startMs), scheduledEnd: iso(endMs), ...extra }));

// ---------------------------------------------------------------------------------------------------
// Past starts and the per-service lead time
// ---------------------------------------------------------------------------------------------------

test("BT-01: a start time in the past is refused for every schedulable service", async () => {
  const { db, policy } = await world();
  const now = Date.now();
  for (const serviceCode of ["grooming", "dog_walking", "pet_taxi", "dog_training", "pet_sitting", "boarding"]) {
    const refused = await check(policy, db, serviceCode, now - 2 * HOUR, now - HOUR);
    assert.equal(refused.ok, false, `${serviceCode} must refuse a past start: ${JSON.stringify(refused).slice(0, 200)}`);
  }
});

test("BT-02: the two-hour services refuse a booking inside their lead time", async () => {
  const { db, policy } = await world();
  const now = Date.now();
  for (const serviceCode of ["grooming", "dog_walking", "pet_taxi"]) {
    const refused = await check(policy, db, serviceCode, now + 90 * 60_000, now + 90 * 60_000 + 4 * HOUR);
    assert.equal(refused.ok, false, `${serviceCode} needs two hours' notice: ${JSON.stringify(refused).slice(0, 250)}`);
  }
});

test("BT-03: the two-hour services accept a booking just outside their lead time", async () => {
  // Non-vacuity for BT-02. Refusing everything would satisfy it and stop same-day bookings entirely.
  const { db, policy } = await world();
  const now = Date.now();
  for (const serviceCode of ["grooming", "dog_walking", "pet_taxi"]) {
    const allowed = await check(policy, db, serviceCode, now + 3 * HOUR, now + 7 * HOUR);
    assert.equal(allowed.ok, true, `${serviceCode} at three hours' notice must be accepted: ${JSON.stringify(allowed).slice(0, 250)}`);
  }
});

test("BT-04: the twenty-four-hour services refuse a booking inside their lead time", async () => {
  const { db, policy } = await world();
  const now = Date.now();
  for (const serviceCode of ["dog_training", "pet_sitting", "boarding"]) {
    const refused = await check(policy, db, serviceCode, now + 20 * HOUR, now + 22 * HOUR);
    assert.equal(refused.ok, false, `${serviceCode} needs a day's notice: ${JSON.stringify(refused).slice(0, 250)}`);
    // And a two-hour booking, which the sibling services accept, must not slip through here.
    const alsoRefused = await check(policy, db, serviceCode, now + 3 * HOUR, now + 5 * HOUR);
    assert.equal(alsoRefused.ok, false, `${serviceCode} must not inherit the two-hour rule: ${JSON.stringify(alsoRefused).slice(0, 250)}`);
  }
});

test("BT-05: the twenty-four-hour services accept a booking just outside their lead time", async () => {
  // Non-vacuity for BT-04.
  const { db, policy } = await world();
  const now = Date.now();
  for (const serviceCode of ["dog_training", "pet_sitting", "boarding"]) {
    const allowed = await check(policy, db, serviceCode, now + 25 * HOUR, now + 27 * HOUR);
    assert.equal(allowed.ok, true, `${serviceCode} at twenty-five hours must be accepted: ${JSON.stringify(allowed).slice(0, 250)}`);
  }
});

// ---------------------------------------------------------------------------------------------------
// The 180-day horizon
// ---------------------------------------------------------------------------------------------------

test("BT-06: a booking beyond one hundred and eighty days is refused", async () => {
  const { db, policy } = await world();
  const now = Date.now();
  const refused = await check(policy, db, "grooming", now + 181 * DAY, now + 181 * DAY + 4 * HOUR);
  assert.equal(refused.ok, false, `the horizon must bound the calendar: ${JSON.stringify(refused).slice(0, 250)}`);
  const wayOut = await check(policy, db, "grooming", now + 73 * 365 * DAY, now + 73 * 365 * DAY + 4 * HOUR);
  assert.equal(wayOut.ok, false, "and seventy-three years out is refused too");
});

test("BT-07: a booking inside the horizon is accepted", async () => {
  // Non-vacuity for BT-06.
  const { db, policy } = await world();
  const now = Date.now();
  const allowed = await check(policy, db, "grooming", now + 179 * DAY, now + 179 * DAY + 4 * HOUR);
  assert.equal(allowed.ok, true, `one hundred and seventy-nine days out must be accepted: ${JSON.stringify(allowed).slice(0, 250)}`);
});

test("BT-08: a recurring calendar whose LAST occurrence falls beyond the horizon is refused", async () => {
  // The first occurrence being inside the window says nothing about the twelfth.
  const { db, policy } = await world();
  const now = Date.now();
  const refused = await check(policy, db, "dog_training", now + 2 * DAY, now + 2 * DAY + HOUR, {
    occurrences: [{ start: iso(now + 2 * DAY), end: iso(now + 2 * DAY + HOUR) }, { start: iso(now + 200 * DAY), end: iso(now + 200 * DAY + HOUR) }],
  });
  assert.equal(refused.ok, false, `the whole calendar must sit inside the horizon: ${JSON.stringify(refused).slice(0, 250)}`);
});

// ---------------------------------------------------------------------------------------------------
// Maximum stay duration
// ---------------------------------------------------------------------------------------------------

test("BT-09: a Boarding stay longer than ninety days is refused", async () => {
  const { db, policy } = await world();
  const now = Date.now();
  const refused = await check(policy, db, "boarding", now + 2 * DAY, now + 2 * DAY + 91 * DAY);
  assert.equal(refused.ok, false, `ninety-one nights must be refused: ${JSON.stringify(refused).slice(0, 250)}`);
});

test("BT-10: a Boarding stay of eighty-nine days is accepted", async () => {
  // Non-vacuity, and it protects the existing 20/30/45-day Boarding plans.
  const { db, policy } = await world();
  const now = Date.now();
  for (const days of [20, 30, 45, 89]) {
    const allowed = await check(policy, db, "boarding", now + 2 * DAY, now + 2 * DAY + days * DAY);
    assert.equal(allowed.ok, true, `a ${days}-day stay must be accepted: ${JSON.stringify(allowed).slice(0, 250)}`);
  }
});

test("BT-11: a Pet Sitting stay longer than thirty days is refused, and ninety is not its cap", async () => {
  const { db, policy } = await world();
  const now = Date.now();
  const refused = await check(policy, db, "pet_sitting", now + 2 * DAY, now + 2 * DAY + 31 * DAY);
  assert.equal(refused.ok, false, `thirty-one days must be refused: ${JSON.stringify(refused).slice(0, 250)}`);
  const boardingCap = await check(policy, db, "pet_sitting", now + 2 * DAY, now + 2 * DAY + 60 * DAY);
  assert.equal(boardingCap.ok, false, "Pet Sitting must not inherit the Boarding cap");
  const allowed = await check(policy, db, "pet_sitting", now + 2 * DAY, now + 2 * DAY + 29 * DAY);
  assert.equal(allowed.ok, true, `twenty-nine days must be accepted: ${JSON.stringify(allowed).slice(0, 250)}`);
});

// ---------------------------------------------------------------------------------------------------
// Server time is authoritative
// ---------------------------------------------------------------------------------------------------

test("BT-12: a client-supplied clock cannot buy a booking that server time refuses", async () => {
  const { db, policy } = await world();
  const now = Date.now();
  const refused = await attempt(policy.assertBookingWindow(db, {
    serviceCode: "grooming", cityId: "blr",
    scheduledStart: iso(now - DAY), scheduledEnd: iso(now - DAY + 4 * HOUR),
    // Everything a caller might send hoping it is believed.
    now: now - 30 * DAY, clientNow: now - 30 * DAY, currentTime: now - 30 * DAY, serverTime: now - 30 * DAY,
  }));
  assert.equal(refused.ok, false, `the client clock must not be authoritative: ${JSON.stringify(refused).slice(0, 250)}`);
});

// ---------------------------------------------------------------------------------------------------
// Governed, and scoped to the services it applies to
// ---------------------------------------------------------------------------------------------------

test("BT-13: a city may lengthen its own lead time without a code change", async () => {
  const { db, policy } = await world();
  const governance = await import("../lib/service-policy-governance.ts");
  const now = Date.now();
  const before = await check(policy, db, "grooming", now + 3 * HOUR, now + 7 * HOUR);
  assert.equal(before.ok, true, "three hours is fine under the platform rule");
  await governance.writeServicePolicy(db, {
    domain: policy.BOOKING_TIME_POLICY_DOMAIN, serviceCode: "grooming", cityId: "blr",
    config: { minimumLeadMinutes: 6 * 60 },
  }, "founder@pawspace.test", "Bengaluru grooming needs six hours to route a van");
  const after = await check(policy, db, "grooming", now + 3 * HOUR, now + 7 * HOUR);
  assert.equal(after.ok, false, `the city rule applies: ${JSON.stringify(after).slice(0, 250)}`);
  const elsewhere = await attempt(policy.assertBookingWindow(db, { serviceCode: "grooming", cityId: "del", scheduledStart: iso(now + 3 * HOUR), scheduledEnd: iso(now + 7 * HOUR) }));
  assert.equal(elsewhere.ok, true, `and does not leak into another city: ${JSON.stringify(elsewhere).slice(0, 250)}`);
});

test("BT-14: the Control Center cannot declare the client timestamp authoritative", async () => {
  const { db, policy } = await world();
  const governance = await import("../lib/service-policy-governance.ts");
  const refused = await attempt(governance.writeServicePolicy(db, {
    domain: policy.BOOKING_TIME_POLICY_DOMAIN, serviceCode: "grooming", cityId: "blr",
    config: { trustClientTimestamp: true },
  }, "founder@pawspace.test", "Trusting the app clock to allow faster bookings"));
  assert.equal(refused.ok, false, `server time is not configurable away: ${JSON.stringify(refused).slice(0, 300)}`);
});

test("BT-15: the Control Center cannot remove the past-start refusal or unbound the horizon", async () => {
  const { db, policy } = await world();
  const governance = await import("../lib/service-policy-governance.ts");
  for (const config of [{ rejectPastStart: false }, { maximumHorizonDays: 0 }, { maximumHorizonDays: 4000 }, { minimumLeadMinutes: -60 }]) {
    const refused = await attempt(governance.writeServicePolicy(db, {
      domain: policy.BOOKING_TIME_POLICY_DOMAIN, serviceCode: "grooming", cityId: "blr", config,
    }, "founder@pawspace.test", "Loosening the booking window"));
    assert.equal(refused.ok, false, `${JSON.stringify(config)} must not be storable: ${JSON.stringify(refused).slice(0, 250)}`);
  }
});

test("BT-16: Fresh Food and Relocation are not forced through occurrence-booking rules", async () => {
  // Food follows fulfilment/delivery-slot rules; Relocation is a request/case workflow. Neither has an
  // occurrence-booking contract, so this gate must say so rather than inventing a lead time for them.
  const { db, policy } = await world();
  for (const serviceCode of ["pet_food", "relocation"]) {
    assert.equal(policy.isSchedulableService(serviceCode), false, `${serviceCode} is not an occurrence-booked service`);
    const skipped = await check(policy, db, serviceCode, Date.now() - 5 * DAY, Date.now() - 5 * DAY + HOUR);
    assert.equal(skipped.ok, true, `${serviceCode} must pass through untouched: ${JSON.stringify(skipped).slice(0, 250)}`);
    assert.equal(skipped.value?.applied, false, "and say plainly that no occurrence rule was applied");
  }
});

test("BT-17: an unknown service is refused rather than waved through", async () => {
  // The audit's recurring defect. A service nobody has classified is not a service with no rules.
  //
  // The window here deliberately SATISFIES every other rule - five days out, a four-hour span, well
  // inside the horizon - so the only thing that can refuse it is the unknown-service check itself.
  // Written first with a three-hour window, which the strict platform default refused on lead time
  // alone: sabotage showed the test stayed green with the unknown-service refusal deleted, so it was
  // proving the wrong control.
  const { db, policy } = await world();
  const now = Date.now();
  const control = await check(policy, db, "grooming", now + 5 * DAY, now + 5 * DAY + 4 * HOUR);
  assert.equal(control.ok, true, "the window itself is unobjectionable for a known service");
  const refused = await check(policy, db, "teleportation", now + 5 * DAY, now + 5 * DAY + 4 * HOUR);
  assert.equal(refused.ok, false, `an unknown service must not book: ${JSON.stringify(refused).slice(0, 250)}`);
  assert.match(String(refused.message), /not a bookable/i, `for the stated reason: ${String(refused.message).slice(0, 200)}`);
});

// ---------------------------------------------------------------------------------------------------
// The reserve chokepoint — no canonical booking exists without a scheduling reservation behind it
// ---------------------------------------------------------------------------------------------------

const ORIGIN = "https://uat.pawspace.in";
const OWNER = "CUS-BT-1";

async function reserveWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_BT_DB__ = db;
  globalThis.__PTJA_BT_ENV__ = { DB: db, PAWSPACE_SCHEDULING_ENV: "uat" };
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)")
    .run("ops_scheduler", "Ops scheduler", "Books scheduling capacity", JSON.stringify(["scheduling.book", "scheduling.view", "bookings.manage"]), now);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("u_ops_bt", "ops@pawspace.in", "Ops", "ops_scheduler", now, now);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,name TEXT NOT NULL,species TEXT NOT NULL,breed TEXT,vaccination_status TEXT NOT NULL DEFAULT 'not_provided',source_pet_id TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,vaccination_status,created_at,updated_at) VALUES ('PET-BT','" + OWNER + "','Bruno','dog','verified',?,?)").run(now, now);
  let sequence = 0;
  const reserve = async ({ serviceCode = "grooming", start, end }) => {
    const { POST } = await import("../app/api/uat-scheduling/route.ts");
    sequence += 1;
    const response = await POST(new Request(`${ORIGIN}/api/uat-scheduling`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "oai-authenticated-user-email": "ops@pawspace.in", "oai-authenticated-user-full-name": "Ops" },
      body: JSON.stringify({
        clientRequestId: `bt-${sequence}`, customerId: OWNER, petIds: ["PET-BT"],
        serviceCode, cityId: "blr", zoneId: "blr-east",
        scheduledStart: iso(start), scheduledEnd: iso(end),
      }),
    }));
    return { status: response.status, body: await response.json().catch(() => null) };
  };
  // A real reservation first, so the tables exist and "no capacity was consumed" is measured against a
  // live table rather than against a table that does not exist - an absent table would satisfy the
  // assertion for the wrong reason.
  const warmup = await reserve({ start: Date.now() + 5 * DAY, end: Date.now() + 5 * DAY + 4 * HOUR });
  const held = () => Number(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_reservations").get().c);
  return { sqlite, db, reserve, warmup, held };
}

test("BT-18: the reserve route refuses a Grooming slot inside the two-hour lead time", async () => {
  const { reserve, held } = await reserveWorld();
  const now = Date.now();
  const before = held();
  const result = await reserve({ start: now + 45 * 60_000, end: now + 45 * 60_000 + 4 * HOUR });
  assert.equal(result.status, 400, `a 45-minute-notice booking must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.match(JSON.stringify(result.body), /notice|lead/i, `and say why: ${JSON.stringify(result.body)}`);
  assert.equal(held(), before, "and no capacity is consumed for a slot that cannot be delivered");
});

test("BT-19: the reserve route refuses a Boarding stay beyond ninety days", async () => {
  const { reserve, held } = await reserveWorld();
  const now = Date.now();
  const before = held();
  const result = await reserve({ serviceCode: "boarding", start: now + 2 * DAY, end: now + 2 * DAY + 120 * DAY });
  assert.equal(result.status, 400, `a 120-day stay must be refused: ${JSON.stringify(result).slice(0, 300)}`);
  assert.equal(held(), before, "and reserves nothing");
});

test("BT-20: the reserve route still accepts a legitimate booking", async () => {
  // Non-vacuity for BT-18 and BT-19. Refusing every reservation would satisfy both and stop the
  // platform taking bookings at all.
  const { reserve } = await reserveWorld();
  const now = Date.now();
  const result = await reserve({ start: now + 3 * DAY, end: now + 3 * DAY + 4 * HOUR });
  assert.notEqual(result.status, 400,
    `a three-day-out Grooming booking must not be refused by the time gate: ${JSON.stringify(result).slice(0, 400)}`);
  assert.ok(JSON.stringify(result.body ?? {}).includes("bookingWindow") || result.status === 409,
    `and the verdict is published when a provider is found: ${JSON.stringify(result.body).slice(0, 300)}`);
});

test("BT-21: a refused booking is refused BEFORE any scheduling side effect", async () => {
  // The gate runs twice - once on the request window, once on the generated calendar - and the second
  // alone would still refuse. What only the FIRST one buys is that nothing is written on the way: the
  // roster seeding, capacity defaults and the whole assignment computation sit between them. Sabotage
  // of the early call site leaves the lead-time cases green, so this is the case that pins it.
  const { sqlite, reserve, held } = await reserveWorld();
  const now = Date.now();
  const rosterBefore = Number(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_availability").get().c);
  const before = held();
  const result = await reserve({ start: now + 45 * 60_000, end: now + 45 * 60_000 + 4 * HOUR });
  assert.equal(result.status, 400, `the booking is refused: ${JSON.stringify(result).slice(0, 250)}`);
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_availability").get().c), rosterBefore,
    "and no roster row is seeded for a booking that was never going to be accepted");
  assert.equal(held(), before, "and nothing is reserved");
});
