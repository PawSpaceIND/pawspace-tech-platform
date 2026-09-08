/*
 * The Pet Taxi vertical, executed end to end - one test per stage, in the order a real trip moves.
 *
 *   accept -> assign a UAT-verified vehicle -> confirm pickup handover -> start ->
 *   route samples -> arrive at drop-off -> confirm drop-off handover -> complete
 *
 * Pet Taxi has the longest chain of any vertical, and every link is a custody step: a live animal is
 * handed from an owner to a driver and back again. The tests below care most about who may take the
 * pet, in what vehicle, and what has to be true before the trip is called done.
 *
 * Every test drives the REAL module against a real database. No source-text assertions and no
 * mocked business logic: the shim in helpers/execution-harness.mjs is an adapter from D1's API onto
 * node:sqlite, so each module runs its real SQL against a real engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__TAXI_DB__", "__TAXI_ENV__");

const CITY = "blr";
const ZONE = "blr-east";
const CUSTOMER = "TXI-CUS-001";
const DRIVER = "TXI-PRV-001";
const BOOKING = "TXI-BK-001";
const TRIP = "TXI-TRIP-1";
const VEHICLE = "TXI-VEH-1";
const PACKAGE = "taxi-blr-east-short";
const PACKAGE_NAME = "Bengaluru East · short UAT route";
const DAY = 86400000;

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const taxiWorld = (env = PROD_ENV) => world("__TAXI_DB__", "__TAXI_ENV__", env);

// --- 1. CATALOGUE + QUOTE -----------------------------------------------------
test("TXI-01 catalogue: the governed routes are priced by the server, one pet per trip", async () => {
  const { db } = taxiWorld();
  const gov = await import("../lib/taxi-governance.ts");
  const listed = await attempt(() => gov.listTaxiRouteClasses(db, new Date(Date.now() + DAY).toISOString()));
  assert.equal(listed.ok, true, `the catalogue must load: ${String(listed.body ?? "").slice(0, 160)}`);
  const by = new Map(listed.value.map((p) => [String(p.route_code), p]));

  const short = by.get("taxi-blr-east-short");
  assert.ok(short, "the short Bengaluru East route must be offered");
  assert.equal(Number(short.synthetic_distance_km), 5);
  assert.equal(Number(short.amount), 449);
  assert.ok(listed.value.every((p) => Number(p.max_pets) === 1),
    "a pet taxi trip carries one animal - the catalogue must not offer a multi-pet trip");

  /* Longer routes must cost more: a price list that does not rise with distance is a pricing bug
   * a customer would find before we did. */
  const amounts = listed.value
    .slice()
    .sort((a, b) => Number(a.synthetic_distance_km) - Number(b.synthetic_distance_km))
    .map((p) => Number(p.amount));
  for (let i = 1; i < amounts.length; i += 1) {
    assert.ok(amounts[i] > amounts[i - 1], `route prices must rise with distance, got ${amounts.join(" -> ")}`);
  }
  stage("Catalogue", "PASS", `${listed.value.length} governed routes, one pet each, priced ${amounts.join(" < ")} by distance`);
});

test("TXI-02 quote: distinct pickup and drop-off, one pet, and sandbox-deferred payment only", async () => {
  const { db } = taxiWorld();
  const gov = await import("../lib/taxi-governance.ts");
  const start = new Date(Date.now() + DAY).toISOString();
  const quote = (over = {}) => attempt(() => gov.createTaxiQuote(db, {
    routeCode: PACKAGE, originLabel: "18 Indiranagar", destinationLabel: "Cessna Lifeline Vet",
    petCount: 1, scheduledStart: start, paymentMode: "sandbox_deferred", ...over,
  }));

  const good = await quote();
  assert.equal(good.ok, true, `a valid trip must price: ${String(good.body ?? "").slice(0, 200)}`);
  assert.equal(good.value.totalAmount, 449, "the route class price, not the client's number");

  /* A trip from a place to itself is not a trip - and a pet cannot be collected from and returned
   * to the same doorstep by a taxi booking. */
  const sameEnds = await quote({ destinationLabel: "18 Indiranagar" });
  assert.equal(sameEnds.ok, false, "identical pickup and drop-off must be refused");
  assert.match(String(sameEnds.body ?? ""), /distinct pickup and drop-off/i);

  const caseOnly = await quote({ destinationLabel: "18 INDIRANAGAR" });
  assert.equal(caseOnly.ok, false, "the same address in different case is still the same address");

  const thin = await quote({ destinationLabel: "X" });
  assert.equal(thin.ok, false, "a one-character destination is not an address");

  const twoPets = await quote({ petCount: 2 });
  assert.equal(twoPets.ok, false, "a pet taxi trip carries exactly one animal");

  const prepaid = await quote({ paymentMode: "prepaid" });
  assert.equal(prepaid.ok, false, "Pet Taxi must refuse a payment mode it does not govern");

  const coupon = await quote({ couponCode: "SAVE50" });
  assert.equal(coupon.ok, false, "Pet Taxi must refuse a coupon rather than silently ignore it");

  const unknown = await quote({ routeCode: "taxi-mars-orbital" });
  assert.equal(unknown.ok, false, "an unknown route class must not be quotable");
  stage("Quote", "PASS", "Rs 449 for the short route; same/case-identical/one-character addresses, 2 pets, prepaid, coupon and unknown route all refused");
});

// --- 2. THE CUSTODY CHAIN ------------------------------------------------------
function seedCanonical(sqlite, over = {}) {
  const now = Date.now();
  const start = new Date(now - 600000).toISOString(), end = new Date(now + 2700000).toISOString();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER DEFAULT 1,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL);
    /* taxi_trips is created by app/api/taxi-bookings/route.ts when the booking is made, and again by
     * lib/taxi-ops-governance.ts - NOT by ensureTaxiLifecycleTables, which reads and writes it
     * throughout. Same two-creator shape as walking_sessions, and the same reason it is not a bug:
     * a trip cannot exist before its booking, so the route always gets there first. This fixture
     * stands in for that route, using the same DDL. */
    CREATE TABLE IF NOT EXISTS taxi_trips (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT NOT NULL,reservation_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,origin_label TEXT NOT NULL,destination_label TEXT NOT NULL,route_code TEXT NOT NULL,synthetic_distance_km REAL NOT NULL,estimated_duration_minutes INTEGER NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'scheduled',vehicle_id TEXT,pickup_verification_status TEXT NOT NULL DEFAULT 'pending',dropoff_verification_status TEXT NOT NULL DEFAULT 'pending',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Taxi Customer", "9800000555", "txi@example.test", CITY, '{}', now, now);
  sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'pet_taxi',?,?,'TXI-SG-1',?,?,?,?,'customer_app',?,'INR','{}','["TXI-PET-1"]','test',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, ZONE, PACKAGE, PACKAGE_NAME, DRIVER, start, end,
         over.status ?? "confirmed", over.total ?? 449, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES ('TXI-WO-1',?,'TXI-SG-1',?,'Driver One','commission','pet_taxi',?,?,1,'accepted',?,?)")
    .run(BOOKING, DRIVER, start, end, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('TXI-RES-1','TXI-SG-1',?,'pet_taxi',?,?,?,'[\"TXI-PET-1\"]',?,?,1,1,'trip','confirmed','{}',?)")
    .run(DRIVER, CITY, ZONE, CUSTOMER, start, end, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES ('TXI-PAY-1',?,?,?,0,'INR','card','sandbox_deferred','pending','razorpay','txi-idem-1','{}',?,?)")
    .run(BOOKING, CUSTOMER, over.total ?? 449, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES ('TXI-SG-1',?,?,'pending',?,?,1,?)")
    .run(BOOKING, DRIVER, now, now + 3600000, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('TXI-SG-1','auto','[]',?,'assigned','system',NULL,?)")
    .run(DRIVER, now);
  return { start, end };
}

async function taxiTripWorld(over = {}) {
  const w = taxiWorld();
  const life = await import("../lib/taxi-lifecycle.ts");
  await life.ensureTaxiLifecycleTables(w.db);
  const win = seedCanonical(w.sqlite, over);
  const now = Date.now();
  await w.db.prepare("INSERT OR REPLACE INTO taxi_trips (id,booking_id,schedule_group_id,reservation_id,provider_id,origin_label,destination_label,route_code,synthetic_distance_km,estimated_duration_minutes,scheduled_start,scheduled_end,status,vehicle_id,pickup_verification_status,dropoff_verification_status,created_at,updated_at) VALUES (?,?,'TXI-SG-1','TXI-RES-1',?,'18 Indiranagar','Cessna Lifeline Vet',?,5,45,?,?,?,NULL,'pending','pending',?,?)")
    .bind(TRIP, BOOKING, DRIVER, PACKAGE, win.start, win.end, over.tripStatus ?? "scheduled", now, now).run();
  /* One active, UAT-verified vehicle owned by this driver, plus one that is NOT verified and one
   * owned by someone else - the three cases the assignment gate has to tell apart. */
  const veh = (id, provider, inspection, active) => w.sqlite
    .prepare("INSERT OR REPLACE INTO taxi_vehicle_profiles (id,provider_id,label,vehicle_type,pet_restraint,inspection_status,active,updated_at) VALUES (?,?,'Ertiga','mpv','crate',?,?,?)")
    .run(id, provider, inspection, active, now);
  veh(VEHICLE, DRIVER, "uat_verified", 1);
  veh("TXI-VEH-UNVERIFIED", DRIVER, "pending", 1);
  veh("TXI-VEH-INACTIVE", DRIVER, "uat_verified", 0);
  veh("TXI-VEH-OTHER", "TXI-PRV-OTHER", "uat_verified", 1);
  return { ...w, ...win, life };
}

const drive = (life, db, action, over = {}) => attempt(() => life.mutateTaxiBooking(db, {
  bookingId: BOOKING, action, actorId: DRIVER, providerId: DRIVER,
  idempotencyKey: `txi-${action}-${Math.random()}`, ...over,
}));

test("TXI-03 vehicle: a pet may only travel in an active, UAT-verified vehicle owned by that driver", async () => {
  const { db, sqlite, life } = await taxiTripWorld();

  const beforeAccept = await drive(life, db, "assign_vehicle", { vehicleId: VEHICLE });
  assert.equal(beforeAccept.ok, false, "a vehicle cannot be assigned before the driver accepts");
  assert.match(String(beforeAccept.body ?? ""), /Driver acceptance is required/i);

  const accepted = await drive(life, db, "accept", { idempotencyKey: "txi-acc-1" });
  assert.equal(accepted.ok, true, `the assigned driver must be able to accept: ${String(accepted.body ?? "").slice(0, 220)}`);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned");

  for (const [label, vehicleId] of [
    ["an unverified vehicle", "TXI-VEH-UNVERIFIED"],
    ["a deactivated vehicle", "TXI-VEH-INACTIVE"],
    ["another driver's vehicle", "TXI-VEH-OTHER"],
    ["a vehicle that does not exist", "TXI-VEH-NOWHERE"],
  ]) {
    const res = await drive(life, db, "assign_vehicle", { vehicleId });
    assert.equal(res.ok, false, `${label} must not be allowed to carry a pet`);
    assert.match(String(res.body ?? ""), /active UAT-verified vehicle owned by this driver/i);
    assert.equal(sqlite.prepare("SELECT vehicle_id FROM taxi_trips WHERE booking_id=?").get(BOOKING).vehicle_id, null,
      `${label} must leave the trip with no vehicle attached`);
  }

  const good = await drive(life, db, "assign_vehicle", { vehicleId: VEHICLE });
  assert.equal(good.ok, true, `a verified owned vehicle must be assignable: ${String(good.body ?? "").slice(0, 200)}`);
  const trip = sqlite.prepare("SELECT vehicle_id,status FROM taxi_trips WHERE booking_id=?").get(BOOKING);
  assert.equal(trip.vehicle_id, VEHICLE);
  assert.equal(trip.status, "vehicle_assigned");
  stage("Vehicle assignment", "PASS", "unverified, deactivated, another driver's and non-existent vehicles all refused; only the verified owned vehicle carries the pet");
});

test("TXI-04 custody: pickup and drop-off are governed handovers, in order", async () => {
  const { db, sqlite, life } = await taxiTripWorld();
  await drive(life, db, "accept", { idempotencyKey: "txi-c-acc" });

  const beforeVehicle = await drive(life, db, "confirm_pickup", { handoverMethod: "owner" });
  assert.equal(beforeVehicle.ok, false, "a pet cannot be collected before a vehicle is assigned");
  assert.match(String(beforeVehicle.body ?? ""), /vehicle assignment is required before pickup/i);

  await drive(life, db, "assign_vehicle", { vehicleId: VEHICLE, idempotencyKey: "txi-c-veh" });

  /* Who physically handed the pet over is a custody fact, not free text. */
  const invented = await drive(life, db, "confirm_pickup", { handoverMethod: "left_at_gate" });
  assert.equal(invented.ok, false, "an invented pickup handover method must be refused");
  assert.match(String(invented.body ?? ""), /governed Pet Taxi pickup handover method/i);
  const none = await drive(life, db, "confirm_pickup", {});
  assert.equal(none.ok, false, "a pickup with no stated handover method must be refused");

  const skipToStart = await drive(life, db, "start_trip", {});
  assert.equal(skipToStart.ok, false, "a trip cannot start before the pet is collected");
  assert.match(String(skipToStart.body ?? ""), /Confirmed pickup handover is required/i);

  const pickup = await drive(life, db, "confirm_pickup", { handoverMethod: "clinic_staff", idempotencyKey: "txi-c-pick" });
  assert.equal(pickup.ok, true, `a governed pickup must be accepted: ${String(pickup.body ?? "").slice(0, 200)}`);
  assert.equal(sqlite.prepare("SELECT pickup_verification_status FROM taxi_trips WHERE booking_id=?").get(BOOKING).pickup_verification_status, "uat_confirmed");

  await drive(life, db, "start_trip", { idempotencyKey: "txi-c-start" });

  /* Drop-off is two steps: arrive, then hand the pet over. Neither may be skipped. */
  const skipArrival = await drive(life, db, "confirm_dropoff", {});
  assert.equal(skipArrival.ok, false, "a pet cannot be handed over before the vehicle has arrived");
  assert.match(String(skipArrival.body ?? ""), /Drop-off arrival is required/i);

  await drive(life, db, "arrive_dropoff", { idempotencyKey: "txi-c-arrive" });
  const dropoff = await drive(life, db, "confirm_dropoff", { idempotencyKey: "txi-c-drop" });
  assert.equal(dropoff.ok, true, `the drop-off handover must be recordable: ${String(dropoff.body ?? "").slice(0, 200)}`);
  assert.equal(sqlite.prepare("SELECT dropoff_verification_status FROM taxi_trips WHERE booking_id=?").get(BOOKING).dropoff_verification_status, "uat_confirmed");
  stage("Custody chain", "PASS", "pickup before vehicle, invented/absent method, start before pickup and handover before arrival all refused; both handovers recorded uat_confirmed");
});

// --- 3. COMPLETION -------------------------------------------------------------
async function taxiAtDropoff(over = {}) {
  const w = await taxiTripWorld(over);
  await drive(w.life, w.db, "accept", { idempotencyKey: `d-a-${Math.random()}` });
  await drive(w.life, w.db, "assign_vehicle", { vehicleId: VEHICLE, idempotencyKey: `d-v-${Math.random()}` });
  await drive(w.life, w.db, "confirm_pickup", { handoverMethod: "owner", idempotencyKey: `d-p-${Math.random()}` });
  await drive(w.life, w.db, "start_trip", { idempotencyKey: `d-s-${Math.random()}` });
  return w;
}

async function taxiRouteSamples(db, n) {
  const proof = await import("../lib/taxi-proof-governance.ts");
  for (let i = 0; i < n; i += 1) {
    await proof.mutateTaxiProof(db, {
      bookingId: BOOKING, action: "record_location_sample", actorId: DRIVER,
      idempotencyKey: `txi-rs-${i}-${Math.random()}`,
      latitude: 12.9784 + i * 0.002, longitude: 77.6408 + i * 0.002, accuracyMeters: 10,
    });
  }
}

async function seedCommercialTerm(db) {
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const now = Date.now();
  await db.prepare("INSERT OR REPLACE INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('TXI-TERM-1','pet_taxi',NULL,1,'active','commission_standard',0.70,'provider_gst_on_behalf',0.18,0,0,0,12,'2026-04-01','taxi vertical execution test','ops','finance','APR-1',?,?)")
    .bind(now, now).run();
}

test("TXI-05 route proof: a trip cannot be completed without real sandbox route evidence", async () => {
  const { db, life } = await taxiAtDropoff();
  const proof = await import("../lib/taxi-proof-governance.ts");

  await drive(life, db, "arrive_dropoff", { idempotencyKey: "txi-r-arr" });
  await drive(life, db, "confirm_dropoff", { idempotencyKey: "txi-r-drop" });

  const none = await drive(life, db, "complete_trip", {});
  assert.equal(none.ok, false, "a trip with no route proof must not be completable");
  assert.match(String(none.body ?? ""), /at least two canonical sandbox route samples/i);

  /* Samples are validated, so a driver cannot pad the count with nonsense. Note these are recorded
   * DURING the trip - the module refuses them once the trip is no longer in progress, which is
   * itself the right rule and is asserted here. */
  const late = await attempt(() => proof.mutateTaxiProof(db, {
    bookingId: BOOKING, action: "record_location_sample", actorId: DRIVER,
    idempotencyKey: "txi-late", latitude: 12.97, longitude: 77.64, accuracyMeters: 10,
  }));
  assert.equal(late.ok, false, "route samples must not be back-filled after the trip has ended");
  assert.match(String(late.body ?? ""), /only during an active trip/i);

  /* Now do it properly on a fresh trip: sample while in progress, then complete. */
  const w2 = await taxiAtDropoff();
  const bad = (over) => attempt(() => proof.mutateTaxiProof(w2.db, {
    bookingId: BOOKING, action: "record_location_sample", actorId: DRIVER,
    idempotencyKey: `txi-bad-${Math.random()}`, latitude: 12.97, longitude: 77.64, accuracyMeters: 10, ...over,
  }));
  for (const [label, over] of [
    ["an out-of-range latitude", { latitude: 91 }],
    ["an out-of-range longitude", { longitude: 181 }],
    ["a non-numeric coordinate", { latitude: "somewhere" }],
    ["zero accuracy", { accuracyMeters: 0 }],
    ["a 900 m accuracy circle", { accuracyMeters: 900 }],
  ]) {
    const res = await bad(over);
    assert.equal(res.ok, false, `${label} must not be accepted as a route sample`);
    assert.match(String(res.body ?? ""), /Valid Pet Taxi sandbox coordinates and accuracy/i);
  }

  await taxiRouteSamples(w2.db, 1);
  await drive(w2.life, w2.db, "arrive_dropoff", { idempotencyKey: "txi-r2-arr" });
  await drive(w2.life, w2.db, "confirm_dropoff", { idempotencyKey: "txi-r2-drop" });
  const one = await drive(w2.life, w2.db, "complete_trip", {});
  assert.equal(one.ok, false, "a single sample is a point, not a route");
  stage("Route proof", "PASS", "no samples and one sample refused; five malformed samples rejected; back-filling after the trip refused");
});

test("TXI-06 completion atomicity: a failed finance step rolls the booking AND the trip back", async () => {
  /* Taxi guards this with an explicit rollback that restores canonical_bookings to in_progress and
   * taxi_trips to dropoff_confirmed. I had read that guard and believed it correct - Dog Walking's
   * looked correct too and could never run, so this asserts it by execution rather than by reading. */
  const { db, sqlite, life } = await taxiAtDropoff();
  await taxiRouteSamples(db, 2);
  await drive(life, db, "arrive_dropoff", { idempotencyKey: "txi-f-arr" });
  await drive(life, db, "confirm_dropoff", { idempotencyKey: "txi-f-drop" });

  const unpriced = await drive(life, db, "complete_trip", {});
  assert.equal(unpriced.ok, false, "a trip with no approved commercial term must not complete");
  assert.match(String(unpriced.body ?? ""), /no active commercial term for service pet_taxi/i,
    `the refusal must be the missing term, not a constraint error from the rollback itself: ${String(unpriced.body ?? "").slice(0, 160)}`);

  const trip = sqlite.prepare("SELECT status FROM taxi_trips WHERE booking_id=?").get(BOOKING);
  assert.equal(trip.status, "dropoff_confirmed", "a failed finance step must roll the TRIP back");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "in_progress",
    "a failed finance step must roll the BOOKING back too");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING).n, 0,
    "a failed completion must not accrue a driver payout");

  await seedCommercialTerm(db);
  const retry = await drive(life, db, "complete_trip", {});
  assert.equal(retry.ok, true, `the same trip must complete on retry once priced: ${String(retry.body ?? "").slice(0, 240)}`);
  assert.equal(sqlite.prepare("SELECT status FROM taxi_trips WHERE booking_id=?").get(BOOKING).status, "completed");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "completed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING).n, 1,
    "a retried completion must accrue ONE driver payout, never two");

  const entries = sqlite.prepare("SELECT debit,credit,vertical FROM finance_journal_entries WHERE source_id=? AND source_type='service_completion'").all(BOOKING);
  assert.ok(entries.length >= 2, `completion must post a double-entry journal, got ${entries.length}`);
  const debits = entries.reduce((n, e) => n + Number(e.debit || 0), 0);
  const credits = entries.reduce((n, e) => n + Number(e.credit || 0), 0);
  assert.ok(Math.abs(debits - credits) < 0.01, `the completion journal must balance: ${debits} vs ${credits}`);
  stage("Completion atomicity", "PASS", `a failed finance step rolls booking AND trip back; the retry posts ${entries.length} balanced entries at Rs ${debits.toFixed(2)} and one payout`);
});

// --- SCOPE REPORT -------------------------------------------------------------
test("TXI-99 pet taxi vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== PET TAXI VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
