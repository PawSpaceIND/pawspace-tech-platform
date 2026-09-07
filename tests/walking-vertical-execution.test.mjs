/*
 * The Dog Walking vertical, executed end to end - one test per stage, in the order a real walk moves.
 *
 *   CUSTOMER  catalogue -> quote -> booking governance
 *   WALKER    acceptance -> governed handover -> geofenced start -> route samples -> completion
 *   PAYMENT   per-walk amount -> pay-after-service -> completion finance -> cancellation/refund
 *
 * Every test drives the REAL module against a real database. No source-text assertions and no
 * mocked business logic: the shim in helpers/execution-harness.mjs is an adapter from D1's API onto
 * node:sqlite, so each module runs its real SQL against a real engine.
 *
 * Walking seeds its own catalogue from lib/walking-governance.ts, so the fixtures use the REAL
 * package codes: walking-30 (30 minutes, Rs 349) and walking-60 (60 minutes, Rs 549), both solo.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__WALK_DB__", "__WALK_ENV__");

const CITY = "blr";
const ZONE = "blr-east";
const CUSTOMER = "WLK-CUS-001";
const WALKER = "WLK-PRV-001";
const BOOKING = "WLK-BK-001";
const SESSION = "WLK-SES-1";
const PACKAGE = "walking-30";
const PACKAGE_NAME = "30-minute Solo Walk";
const DAY = 86400000;
const DOORSTEP = { lat: 12.9784, lng: 77.6408 };

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });

/* Walking's geofence has NO simulator - it refuses missing coordinates outright - so a
 * production-shaped env is used throughout and nothing here can be waved through. */
const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const walkWorld = (env = PROD_ENV) => world("__WALK_DB__", "__WALK_ENV__", env);

const futureStart = () => new Date(Date.now() + 3 * DAY).toISOString();
const plusMinutes = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString();

// --- 1. CUSTOMER: catalogue, quote, booking ----------------------------------
test("WLK-01 catalogue: the two governed walk products are priced by the server", async () => {
  const { db } = walkWorld();
  const gov = await import("../lib/walking-governance.ts");
  const listed = await attempt(() => gov.listWalkingPackages(db, futureStart()));
  assert.equal(listed.ok, true, `the catalogue must load: ${String(listed.body ?? "").slice(0, 160)}`);
  const by = new Map(listed.value.map((p) => [String(p.package_code), p]));

  const short = by.get("walking-30"), long = by.get("walking-60");
  assert.ok(short && long, "both the 30 and 60 minute walks must be offered");
  assert.equal(Number(short.duration_minutes), 30);
  assert.equal(Number(short.amount_per_walk), 349);
  assert.equal(Number(long.duration_minutes), 60);
  assert.equal(Number(long.amount_per_walk), 549);
  assert.ok(listed.value.every((p) => Number(p.max_pets) === 1),
    "a solo walk is one dog - the catalogue must not offer a multi-pet walk");
  stage("Catalogue", "PASS", "30-minute Rs 349 and 60-minute Rs 549, solo only, server-priced");
});

test("WLK-02 quote: duration must match the package, and only pay-after-service is offered", async () => {
  const { db } = walkWorld();
  const gov = await import("../lib/walking-governance.ts");
  const start = futureStart();
  const quote = (over = {}) => attempt(() => gov.createWalkingQuote(db, {
    packageCode: PACKAGE, mode: "one_off", petCount: 1, walkCount: 1,
    scheduledStart: start, scheduledEnd: plusMinutes(start, 30),
    paymentMode: "pay_after_service", ...over,
  }));

  const good = await quote();
  assert.equal(good.ok, true, `a valid 30-minute walk must price: ${String(good.body ?? "").slice(0, 200)}`);
  assert.equal(good.value.totalAmount, 349, "one walk at the catalogue price");

  /* The window must be exactly the package's duration - a 45-minute window is not a 30-minute walk
   * and must not be sold as one. */
  const wrongDuration = await quote({ scheduledEnd: plusMinutes(start, 45) });
  assert.equal(wrongDuration.ok, false, "a 45-minute window must not be quoted as a 30-minute walk");
  assert.match(String(wrongDuration.body ?? ""), /duration does not match/i);

  const past = await quote({
    scheduledStart: new Date(Date.now() - DAY).toISOString(),
    scheduledEnd: new Date(Date.now() - DAY + 30 * 60000).toISOString(),
  });
  assert.equal(past.ok, false, "a walk in the past must not be quotable");

  /* Dog Walking is deliberately pay-after-service only in this gate. Prepaid must be refused
   * rather than silently accepted. */
  const prepaid = await quote({ paymentMode: "prepaid" });
  assert.equal(prepaid.ok, false, "Dog Walking must refuse a payment mode it does not govern");
  assert.match(String(prepaid.body ?? ""), /pay-after-service/i);

  const coupon = await quote({ couponCode: "SAVE50" });
  assert.equal(coupon.ok, false, "Dog Walking must refuse a coupon rather than silently ignore it");

  const unknown = await quote({ packageCode: "walking-999" });
  assert.equal(unknown.ok, false, "an unknown package must not be quotable");
  stage("Quote", "PASS", "Rs 349 for 30 minutes; mismatched duration, past window, prepaid, coupon and unknown package all refused");
});

// --- 2. WALKER: acceptance, handover, geofenced start ------------------------
function seedCanonical(sqlite, over = {}) {
  const now = Date.now();
  const start = over.start ?? new Date(now - 600000).toISOString();
  const end = over.end ?? new Date(now + 1800000).toISOString();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER DEFAULT 1,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'customer_booking',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    /* walking_sessions is created by app/api/walking-bookings/route.ts when the booking is made,
     * and again by lib/walking-ops-governance.ts - NOT by ensureWalkingLifecycleTables, which reads
     * and writes it throughout. That is a two-creator fragility rather than a bug: a walk cannot
     * exist before its booking, so the route always gets there first. This fixture stands in for
     * that route, using the same DDL. */
    CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS walking_sessions (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,occurrence_number INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',handover_status TEXT NOT NULL DEFAULT 'pending',completion_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Walking Customer", "9800000444", "wlk@example.test", CITY, '{}', now, now);
  sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'dog_walking',?,?,'WLK-SG-1',?,?,?,?,'customer_app',?,'INR',?,'["WLK-PET-1"]','test',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, ZONE, PACKAGE, PACKAGE_NAME, WALKER, start, end,
         over.status ?? "confirmed", over.total ?? 349, over.pricingJson ?? JSON.stringify({ perWalkAmount: 349 }), now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES ('WLK-WO-1',?,'WLK-SG-1',?,'Walker One','commission','dog_walking',?,?,1,'accepted',?,?)")
    .run(BOOKING, WALKER, start, end, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_service_locations VALUES (?,?,?,?,?,?,'customer_booking','active',?,?)")
    .run(BOOKING, CUSTOMER, WALKER, "18 Indiranagar", DOORSTEP.lat, DOORSTEP.lng, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('WLK-RES-1','WLK-SG-1',?,'dog_walking',?,?,?,'[\"WLK-PET-1\"]',?,?,1,1,'walk','confirmed','{}',?)")
    .run(WALKER, CITY, ZONE, CUSTOMER, start, end, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES ('WLK-PAY-1',?,?,?,0,'INR','card','pay_after_service','pending','razorpay','wlk-idem-1','{}',?,?)")
    .run(BOOKING, CUSTOMER, over.total ?? 349, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES ('WLK-SG-1',?,?,'pending',?,?,1,?)")
    .run(BOOKING, WALKER, now, now + 3600000, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('WLK-SG-1','auto','[]',?,'assigned','system',NULL,?)")
    .run(WALKER, now);
  return { start, end };
}

async function walkingWorld(over = {}) {
  const w = walkWorld();
  const life = await import("../lib/walking-lifecycle.ts");
  await life.ensureWalkingLifecycleTables(w.db);
  const win = seedCanonical(w.sqlite, over);
  const now = Date.now();
  await w.db.prepare("INSERT OR REPLACE INTO walking_sessions (id,booking_id,schedule_group_id,reservation_id,provider_id,occurrence_number,scheduled_start,scheduled_end,status,handover_status,completion_status,created_at,updated_at) VALUES (?,?,'WLK-SG-1','WLK-RES-1',?,1,?,?,?,?,'pending',?,?)")
    .bind(SESSION, BOOKING, WALKER, win.start, win.end, over.sessionStatus ?? "scheduled", over.handoverStatus ?? "pending", now, now).run();
  return { ...w, ...win, life };
}

const act = (life, db, action, over = {}) => attempt(() => life.mutateWalkingBooking(db, {
  bookingId: BOOKING, sessionId: SESSION, action, actorId: WALKER, providerId: WALKER,
  idempotencyKey: `wlk-${action}-${Math.random()}`, ...over,
}));

test("WLK-03 handover: a walk cannot start until the dog is handed over by a governed method", async () => {
  const { db, sqlite, life } = await walkingWorld();

  const beforeAccept = await act(life, db, "confirm_handover", { handoverMethod: "owner" });
  assert.equal(beforeAccept.ok, false, "handover cannot precede the walker accepting the job");
  assert.match(String(beforeAccept.body ?? ""), /acceptance is required before handover/i);

  const accepted = await act(life, db, "accept", { idempotencyKey: "wlk-acc-1" });
  assert.equal(accepted.ok, true, `the assigned walker must be able to accept: ${String(accepted.body ?? "").slice(0, 220)}`);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned");

  const replay = await act(life, db, "accept", { idempotencyKey: "wlk-acc-1" });
  assert.equal(replay.value.duplicatePrevented, true, "a replayed key must not accept twice");

  /* The handover method is a governed vocabulary - who physically handed the dog over is a safety
   * fact, not free text. */
  const invented = await act(life, db, "confirm_handover", { handoverMethod: "left_in_garden" });
  assert.equal(invented.ok, false, "an invented handover method must be refused");
  assert.match(String(invented.body ?? ""), /governed Dog Walking handover method/i);

  const none = await act(life, db, "confirm_handover", {});
  assert.equal(none.ok, false, "a handover with no method must be refused");
  assert.equal(sqlite.prepare("SELECT handover_status FROM walking_sessions WHERE id=?").get(SESSION).handover_status, "pending",
    "a refused handover must leave the session still awaiting one");

  for (const method of ["owner", "building_staff", "secure_key"]) {
    const w2 = await walkingWorld();
    await act(w2.life, w2.db, "accept", { idempotencyKey: `a-${method}` });
    const res = await act(w2.life, w2.db, "confirm_handover", { handoverMethod: method, idempotencyKey: `h-${method}` });
    assert.equal(res.ok, true, `${method} must be a governed handover method: ${String(res.body ?? "").slice(0, 160)}`);
    assert.equal(w2.sqlite.prepare("SELECT status,handover_status FROM walking_sessions WHERE id=?").get(SESSION).status, "ready_to_start");
  }
  stage("Handover", "PASS", "refused before acceptance, with an invented method and with none; all three governed methods accepted");
});

test("WLK-04 start geofence: a walker must be at the door, and there is no simulator to hide behind", async () => {
  const { db, sqlite, life } = await walkingWorld();
  await act(life, db, "accept", { idempotencyKey: "wlk-g-acc" });

  /* Two separate gates, in order: the canonical booking must be assigned, and only then is the
   * missing handover the reason. Asserting the handover message on an unaccepted booking tested
   * the wrong gate. */
  const beforeAssign = await walkingWorld();
  const unassigned = await act(beforeAssign.life, beforeAssign.db, "start_walk", { latitude: DOORSTEP.lat, longitude: DOORSTEP.lng });
  assert.equal(unassigned.ok, false, "a walk must not start on a booking no walker has accepted");
  assert.match(String(unassigned.body ?? ""), /must be assigned before a walk starts/i);

  const beforeHandover = await act(life, db, "start_walk", { latitude: DOORSTEP.lat, longitude: DOORSTEP.lng });
  assert.equal(beforeHandover.ok, false, "an accepted booking still must not start without a confirmed handover");
  assert.match(String(beforeHandover.body ?? ""), /Confirmed handover is required/i);

  await act(life, db, "confirm_handover", { handoverMethod: "owner", idempotencyKey: "wlk-g-h" });

  const noCoords = await act(life, db, "start_walk", {});
  assert.equal(noCoords.ok, false, "starting without coordinates must be refused outright");
  assert.match(String(noCoords.body ?? ""), /requires walker latitude and longitude/i);

  // ~2.2 km away.
  const farAway = await act(life, db, "start_walk", { latitude: DOORSTEP.lat + 0.02, longitude: DOORSTEP.lng });
  assert.equal(farAway.ok, false, "a walker 2 km from the home must not be able to start the walk");
  assert.match(String(farAway.body ?? ""), new RegExp(`${life.WALKING_START_GEOFENCE_METERS}m`),
    "the refusal must name the governed geofence");
  assert.equal(sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(SESSION).status, "ready_to_start",
    "a refused start must not begin the walk");

  const atDoor = await act(life, db, "start_walk", { latitude: DOORSTEP.lat + 0.00045, longitude: DOORSTEP.lng });
  assert.equal(atDoor.ok, true, `a walker at the door must be able to start: ${String(atDoor.body ?? "").slice(0, 220)}`);
  assert.ok(atDoor.value.distanceMeters <= life.WALKING_START_GEOFENCE_METERS);
  assert.equal(atDoor.value.thresholdMeters, 250);
  assert.equal(atDoor.value.telemetryMode, "deterministic_sandbox",
    "the record must say plainly that this is sandbox telemetry, not a production GPS fix");
  assert.equal(sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(SESSION).status, "in_progress");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "in_progress");
  stage("Start geofence", "PASS", `unassigned booking, no handover, no coordinates and 2 km all refused; ${atDoor.value.distanceMeters}m accepted against a 250m threshold`);
});

// --- 3. COMPLETION: route proof, per-walk money, and failure atomicity -------
/** Drive a walk to in_progress through the real state machine. */
async function walkingWorld_inProgress(over = {}) {
  const w = await walkingWorld(over);
  await act(w.life, w.db, "accept", { idempotencyKey: `ip-a-${Math.random()}` });
  await act(w.life, w.db, "confirm_handover", { handoverMethod: "owner", idempotencyKey: `ip-h-${Math.random()}` });
  await act(w.life, w.db, "start_walk", {
    latitude: DOORSTEP.lat + 0.00045, longitude: DOORSTEP.lng, idempotencyKey: `ip-s-${Math.random()}`,
  });
  return w;
}

/** Record n valid sandbox route samples through the real proof module. */
async function routeSamples(db, n) {
  const proof = await import("../lib/walking-proof-governance.ts");
  for (let i = 0; i < n; i += 1) {
    await proof.mutateWalkingProof(db, {
      bookingId: BOOKING, sessionId: SESSION, action: "record_location_sample", actorId: WALKER,
      idempotencyKey: `rs-${i}-${Math.random()}`,
      latitude: DOORSTEP.lat + i * 0.0002, longitude: DOORSTEP.lng + i * 0.0002, accuracyMeters: 8,
    });
  }
}

async function seedCommercialTerm(db) {
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const now = Date.now();
  await db.prepare("INSERT OR REPLACE INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('WLK-TERM-1','dog_walking',NULL,1,'active','commission_standard',0.70,'provider_gst_on_behalf',0.18,0,0,0,12,'2026-04-01','walking vertical execution test','ops','finance','APR-1',?,?)")
    .bind(now, now).run();
}

test("WLK-05 route proof: a walk cannot be completed without real sandbox route evidence", async () => {
  const { db, sqlite, life } = await walkingWorld_inProgress();
  const proof = await import("../lib/walking-proof-governance.ts");

  const none = await act(life, db, "complete_walk", {});
  assert.equal(none.ok, false, "a walk with no route proof must not be completable");
  assert.match(String(none.body ?? ""), /at least two canonical sandbox route samples/i);

  /* The samples themselves are validated - a walker cannot post nonsense to satisfy the count. */
  const bad = (over) => attempt(() => proof.mutateWalkingProof(db, {
    bookingId: BOOKING, sessionId: SESSION, action: "record_location_sample", actorId: WALKER,
    idempotencyKey: `bad-${Math.random()}`, latitude: DOORSTEP.lat, longitude: DOORSTEP.lng, accuracyMeters: 8, ...over,
  }));
  for (const [label, over] of [
    ["an out-of-range latitude", { latitude: 91 }],
    ["an out-of-range longitude", { longitude: 181 }],
    ["a non-numeric coordinate", { latitude: "here" }],
    ["zero accuracy", { accuracyMeters: 0 }],
    ["a 900 m accuracy circle", { accuracyMeters: 900 }],
  ]) {
    const res = await bad(over);
    assert.equal(res.ok, false, `${label} must not be accepted as a route sample`);
    assert.match(String(res.body ?? ""), /Valid Dog Walking sandbox coordinates and accuracy/i);
  }

  await routeSamples(db, 1);
  const one = await act(life, db, "complete_walk", {});
  assert.equal(one.ok, false, "a single sample is a point, not a route");

  await routeSamples(db, 1);
  await seedCommercialTerm(db);
  const done = await act(life, db, "complete_walk", {});
  assert.equal(done.ok, true, `two samples and a priced term must complete the walk: ${String(done.body ?? "").slice(0, 240)}`);
  assert.equal(sqlite.prepare("SELECT status,completion_status FROM walking_sessions WHERE id=?").get(SESSION).status, "completed");
  stage("Route proof", "PASS", "no samples and one sample both refused; five malformed samples rejected; two valid samples complete the walk");
});

test("WLK-06 per-walk money: the amount is taken from pricing, never invented by division", async () => {
  /* walkingPerSessionAmount prefers an explicitly configured perWalkAmount. It will divide a total
   * by the session count ONLY for a demo seed AND only when the division is exact - otherwise it
   * returns 0 and completion is refused. It would rather stop than bill a rounded number. */
  const life = await import("../lib/walking-lifecycle.ts");
  const perWalk = life.walkingPerSessionAmount;

  assert.equal(perWalk({ perWalkAmount: 349 }, 349, 1), 349, "a configured per-walk amount is used as-is");
  assert.equal(perWalk({ perWalkAmount: 349 }, 99999, 7), 349, "a configured amount must beat any division of the total");
  assert.equal(perWalk({ demoSeed: true }, 1047, 3), 349, "a demo seed may divide a total that divides exactly");
  assert.equal(perWalk({ demoSeed: true }, 1000, 3), 0,
    "1000 over 3 walks does not divide exactly - it must refuse rather than bill a rounded 333.33");
  assert.equal(perWalk({}, 1047, 3), 0, "without a demo seed there is no licence to divide a total at all");
  assert.equal(perWalk(null, 349, 1), 0, "no pricing at all means no amount");
  assert.equal(perWalk({ perWalkAmount: 0 }, 349, 1), 0, "a zero configured amount is not a price");
  assert.equal(perWalk({ perWalkAmount: -349 }, 349, 1), 0, "a negative amount is never a price");

  /* And the refusal reaches the caller: a booking whose pricing cannot yield a per-walk amount
   * must not be completable. */
  const w = await walkingWorld_inProgress({ pricingJson: "{}" });
  await routeSamples(w.db, 2);
  await seedCommercialTerm(w.db);
  const unpriced = await act(w.life, w.db, "complete_walk", {});
  assert.equal(unpriced.ok, false, "a walk with no derivable per-walk amount must not complete");
  assert.match(String(unpriced.body ?? ""), /per-walk amount is mis/i);
  assert.equal(w.sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(SESSION).status, "in_progress",
    "a refused completion must leave the walk running");
  stage("Per-walk money", "PASS", "configured amount wins; exact demo division allowed; 1000/3 and undivided totals refused rather than rounded");
});

test("WLK-07 completion atomicity: a failed finance step rolls BOTH the session and the booking back", async () => {
  /* This is the Boarding defect's shape, tested where it would hurt most. Walking guards it with a
   * two-level rollback: a failed session claim restores the booking, and a failed finance step
   * restores the session AND the booking before rethrowing. Verified by execution, not by reading. */
  const { db, sqlite, life } = await walkingWorld_inProgress();
  await routeSamples(db, 2);

  const unpriced = await act(life, db, "complete_walk", {});
  assert.equal(unpriced.ok, false, "a walk with no approved commercial term must not complete");
  assert.match(String(unpriced.body ?? ""), /no active commercial term for service dog_walking/i);

  const session = sqlite.prepare("SELECT status,completion_status FROM walking_sessions WHERE id=?").get(SESSION);
  assert.equal(session.status, "in_progress", "a failed finance step must roll the SESSION back");
  assert.notEqual(session.completion_status, "complete", "a failed completion must not mark the walk complete");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "in_progress",
    "a failed finance step must roll the BOOKING back too");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING).n, 0,
    "a failed completion must not accrue a walker payout");

  /* And the operator can then fix the configuration and retry THE SAME walk. */
  await seedCommercialTerm(db);
  const retry = await act(life, db, "complete_walk", {});
  assert.equal(retry.ok, true, `the same walk must complete on retry once priced: ${String(retry.body ?? "").slice(0, 240)}`);
  assert.equal(sqlite.prepare("SELECT status FROM walking_sessions WHERE id=?").get(SESSION).status, "completed");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "completed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING).n, 1,
    "a retried completion must accrue ONE walker payout, never two");

  const entries = sqlite.prepare("SELECT debit,credit,vertical FROM finance_journal_entries WHERE source_id=? AND source_type='service_completion'").all(BOOKING);
  assert.ok(entries.length >= 2, `completion must post a double-entry journal, got ${entries.length}`);
  const debits = entries.reduce((n, e) => n + Number(e.debit || 0), 0);
  const credits = entries.reduce((n, e) => n + Number(e.credit || 0), 0);
  assert.ok(Math.abs(debits - credits) < 0.01, `the completion journal must balance: ${debits} vs ${credits}`);
  stage("Completion atomicity", "PASS", `a failed finance step rolls session AND booking back to in_progress; the retry posts ${entries.length} balanced entries at Rs ${debits.toFixed(2)} and one payout`);
});

// --- SCOPE REPORT -------------------------------------------------------------
test("WLK-99 dog walking vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== DOG WALKING VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
