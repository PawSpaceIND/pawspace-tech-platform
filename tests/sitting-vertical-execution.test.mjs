/*
 * The Pet Sitting vertical, executed end to end across the three flows that matter:
 *
 *   CUSTOMER  catalogue -> quote -> care plan -> report card
 *   PARTNER   sitter acceptance -> geofenced check-in -> care events -> proof -> check-out
 *   PAYMENT   sandbox capture -> booking gate -> split balance -> completion finance -> refund
 *
 * Every test drives the REAL module against a real database. No source-text assertions and no
 * mocked business logic: the shim in helpers/execution-harness.mjs is an adapter from D1's API onto
 * node:sqlite, so each module runs its real SQL against a real engine.
 *
 * Sitting seeds its own catalogue from lib/sitting-governance.ts, so the fixtures below use the REAL
 * package codes and prices: sitting-visit-60 (Home Visit, Rs 399 + Rs 149 per extra pet) and
 * sitting-overnight (Overnight, Rs 799 + Rs 399 per extra pet).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__SIT_DB__", "__SIT_ENV__");

const CITY = "blr";
const ZONE = "blr-east";
const CUSTOMER = "SIT-CUS-001";
const SITTER = "SIT-PRV-001";
const BOOKING = "SIT-BK-001";
const VISIT = "sitting-visit-60";
const OVERNIGHT = "sitting-overnight";
const DAY = 86400000;
const DOORSTEP = { lat: 12.9784, lng: 77.6408 };

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });

/*
 * PRODUCTION-SHAPED ENV BY DEFAULT.
 *
 * lib/sitting-lifecycle.ts assertCheckInGeofence has a deliberate simulation path that fires only
 * when the worker env says NODE_ENV === "test" AND PAWSPACE_LOCAL_PREVIEW is on/true/1. That is
 * exactly what the suite runs under, so a geofence test using the default env would be waved
 * through by the simulator and would prove nothing at all. Every world here is built with the
 * simulator OFF unless a test explicitly asks for it.
 */
const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const SIM_ENV = { NODE_ENV: "test", PAWSPACE_LOCAL_PREVIEW: "on" };
const sitWorld = (env = PROD_ENV) => world("__SIT_DB__", "__SIT_ENV__", env);

const futureStart = () => new Date(Date.now() + 3 * DAY).toISOString();
const plusHours = (iso, h) => new Date(new Date(iso).getTime() + h * 3600000).toISOString();

// --- 1. CUSTOMER: catalogue and price ----------------------------------------
test("SIT-01 catalogue: the two governed sitting products are priced by the server", async () => {
  const { db } = sitWorld();
  const gov = await import("../lib/sitting-governance.ts");
  const listed = await attempt(() => gov.listSittingPackages(db, futureStart()));
  assert.equal(listed.ok, true, `the catalogue must load: ${String(listed.body ?? "").slice(0, 160)}`);
  const by = new Map(listed.value.map((p) => [String(p.package_code), p]));

  const visit = by.get(VISIT), overnight = by.get(OVERNIGHT);
  assert.ok(visit && overnight, "both the Home Visit and the Overnight product must be offered");
  assert.equal(String(visit.mode), "visit");
  assert.equal(Number(visit.base_price_per_pet), 399);
  assert.equal(Number(visit.extra_pet_price), 149);
  assert.equal(String(overnight.mode), "overnight");
  assert.equal(Number(overnight.base_price_per_pet), 799);
  assert.equal(Number(overnight.extra_pet_price), 399);
  assert.ok(listed.value.every((p) => Number(p.max_pets) >= 1 && Number(p.max_pets) <= 4));
  stage("Catalogue", "PASS", "Home Visit Rs 399 (+149/pet) and Overnight Rs 799 (+399/pet), server-priced");
});

test("SIT-02 quote: units, extra pets and the care window are all governed", async () => {
  const { db } = sitWorld();
  const gov = await import("../lib/sitting-governance.ts");
  const start = futureStart();
  const quote = (over = {}) => attempt(() => gov.createSittingQuote(db, {
    packageCode: VISIT, petCount: 1, scheduledStart: start, scheduledEnd: plusHours(start, 1),
    paymentMode: "prepaid", cityId: CITY, zoneId: ZONE, ...over,
  }));

  const one = await quote();
  assert.equal(one.ok, true, `a single-pet visit must price: ${String(one.body ?? "").slice(0, 200)}`);
  assert.equal(one.value.totalAmount, 399, "one pet, one visit is the base price");
  assert.equal(one.value.amountDueNow, 399, "prepaid takes it all now");

  const three = await quote({ petCount: 3 });
  assert.equal(three.ok, true);
  assert.equal(three.value.totalAmount, 399 + 149 * 2, "extra pets are charged at the extra-pet rate, not the base rate");

  const overnight = await quote({
    packageCode: OVERNIGHT, scheduledEnd: new Date(new Date(start).getTime() + 2 * DAY).toISOString(),
  });
  assert.equal(overnight.ok, true, `an overnight must price: ${String(overnight.body ?? "").slice(0, 200)}`);
  assert.equal(overnight.value.billableUnits, 2, "a 48-hour overnight is 2 nights");
  assert.equal(overnight.value.totalAmount, 799 * 2);

  const split = await quote({ paymentMode: "split_50_50", packageCode: OVERNIGHT, scheduledEnd: new Date(new Date(start).getTime() + 2 * DAY).toISOString() });
  assert.equal(split.ok, true);
  assert.equal(split.value.amountDueNow, (799 * 2) / 2, "the 50/50 split takes exactly half up front");

  // Window rules.
  /* A one-hour window that has already been and gone. Keeping it inside the Home Visit's 24-hour
   * ceiling matters: my first version spanned 25 hours, so it was refused for being too LONG and
   * would have stayed green with the past-start guard deleted. */
  const pastStart = new Date(Date.now() - DAY).toISOString();
  const past = await quote({ scheduledStart: pastStart, scheduledEnd: plusHours(pastStart, 1) });
  assert.equal(past.ok, false, "a quote must not be issued for a start in the past");
  assert.match(String(past.body ?? ""), /future start/i, "the refusal must be the past start, not the window length");

  const backwards = await quote({ scheduledEnd: new Date(new Date(start).getTime() - 3600000).toISOString() });
  assert.equal(backwards.ok, false, "a care window that ends before it starts is not a window");

  const longVisit = await quote({ scheduledEnd: plusHours(start, 30) });
  assert.equal(longVisit.ok, false, "a Home Visit must not stretch past its 24-hour ceiling");

  const coupon = await quote({ couponCode: "SAVE50" });
  assert.equal(coupon.ok, false, "Sitting must refuse a coupon rather than silently ignore it");

  const tooMany = await quote({ petCount: 9 });
  assert.equal(tooMany.ok, false, "more pets than the package allows must be refused");
  stage("Quote", "PASS", "Rs 399 base + Rs 149/extra pet; 2-night overnight Rs 1598; past start, reversed window, 30h visit, coupon and pet count all refused");
});

// --- 2. PAYMENT: sandbox capture and the booking gate ------------------------
async function openQuote(db, over = {}) {
  const gov = await import("../lib/sitting-governance.ts");
  const start = over.start ?? futureStart();
  const q = await gov.createSittingQuote(db, {
    packageCode: OVERNIGHT, petCount: 1, scheduledStart: start,
    scheduledEnd: new Date(new Date(start).getTime() + 2 * DAY).toISOString(),
    paymentMode: over.paymentMode ?? "split_50_50", cityId: CITY, zoneId: ZONE,
  });
  return q;
}

test("SIT-03 capture: the amount is the server's, and a replayed key cannot restate it", async () => {
  const { db, sqlite } = sitWorld();
  const pay = await import("../lib/sitting-payment-governance.ts");
  const q = await openQuote(db);
  const capture = (over = {}) => attempt(() => pay.captureSittingQuoteSandbox(db, {
    quoteId: q.quoteId, amount: q.amountDueNow, paymentKey: `sit-cap-${Math.random()}`, ...over,
  }));

  const noKey = await capture({ paymentKey: "   " });
  assert.equal(noKey.ok, false, "a capture with no idempotency key must be refused");
  assert.match(String(noKey.body ?? ""), /MISSING_CAPTURE_KEY/);

  const missing = await capture({ quoteId: "SQ-NOT-A-QUOTE" });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404, "a capture against a quote that does not exist must 404");

  const short = await capture({ amount: 1 });
  assert.equal(short.ok, false, "a client paying Rs 1 against a Rs 799 deposit must be refused");
  assert.match(String(short.body ?? ""), /must match the Sitting quote amount due now/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sitting_quote_payment_attestations WHERE quote_id=?").get(q.quoteId).n, 0,
    "a refused capture must leave no attestation behind");

  const captured = await capture({ paymentKey: "sit-cap-1" });
  assert.equal(captured.ok, true, `the governed deposit must capture: ${String(captured.body ?? "").slice(0, 200)}`);
  assert.equal(captured.value.amount, q.amountDueNow);
  assert.equal(captured.value.environment, "sandbox", "no live money may be claimed by a sandbox capture");
  assert.equal(captured.value.duplicatePrevented, false);

  // The same key replayed is the same payment, not a second one.
  const replay = await capture({ paymentKey: "sit-cap-1" });
  assert.equal(replay.ok, true);
  assert.equal(replay.value.duplicatePrevented, true, "a replayed key must not capture twice");
  assert.equal(replay.value.reference, captured.value.reference, "the replay must return the original reference");

  // A DIFFERENT key against an already-captured quote is a replay attack, not a payment.
  const forged = await capture({ paymentKey: "sit-cap-attacker" });
  assert.equal(forged.ok, false, "a second key against a captured quote must be refused");
  assert.match(String(forged.body ?? ""), /PAYMENT_CAPTURE_REPLAY/);
  assert.equal(forged.status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sitting_quote_payment_attestations WHERE quote_id=?").get(q.quoteId).n, 1,
    "one quote must carry exactly one attestation");
  stage("Sandbox capture", "PASS", "keyless (400), unknown quote (404), wrong amount and a second key (403 replay) all refused; one quote, one attestation");
});

test("SIT-04 booking gate: an unpaid quote cannot become a booking, and a quote spends once", async () => {
  const { db } = sitWorld();
  const gov = await import("../lib/sitting-governance.ts");
  const pay = await import("../lib/sitting-payment-governance.ts");
  const q = await openQuote(db);

  const unpaid = await attempt(() => pay.requireSittingQuoteSandboxCapture(db, { quoteId: q.quoteId, amount: q.amountDueNow }));
  assert.equal(unpaid.ok, false, "an unpaid quote must not be bookable");
  assert.match(String(unpaid.body ?? ""), /server-confirmed sandbox capture before booking/i);

  await pay.captureSittingQuoteSandbox(db, { quoteId: q.quoteId, amount: q.amountDueNow, paymentKey: "sit-gate-1" });
  const paid = await attempt(() => pay.requireSittingQuoteSandboxCapture(db, { quoteId: q.quoteId, amount: q.amountDueNow }));
  assert.equal(paid.ok, true, "with the deposit confirmed the gate must open");

  const mismatched = await attempt(() => pay.requireSittingQuoteSandboxCapture(db, { quoteId: q.quoteId, amount: 99999 }));
  assert.equal(mismatched.ok, false, "the gate must refuse an amount that does not match what was captured");

  const govern = (over = {}) => attempt(() => gov.governSittingBooking(db, {
    quoteId: q.quoteId, packageCode: OVERNIGHT, packageName: "Overnight Pet Sitting", petCount: 1,
    scheduledStart: q.scheduledStart, scheduledEnd: q.scheduledEnd,
    submittedTotal: q.totalAmount, submittedAmountDueNow: q.amountDueNow,
    paymentMode: "split_50_50", paymentStatus: "captured", reservationCount: 1, ...over,
  }));

  const forged = await govern({ submittedTotal: 1, submittedAmountDueNow: 1 });
  assert.equal(forged.ok, false, "a client-submitted total of 1 must never be accepted");

  const uncaptured = await govern({ paymentStatus: "pending" });
  assert.equal(uncaptured.ok, false, "a booking must not confirm while the sandbox payment is still pending");
  assert.match(String(uncaptured.body ?? ""), /captured in sandbox before confirmation/i);

  /* Sitting reserves exactly ONE canonical care reservation regardless of how many nights it
   * bills - a 2-night overnight is 2 billable units but still one reservation. */
  const manyReservations = await govern({ reservationCount: 2 });
  assert.equal(manyReservations.ok, false, "Sitting must hold exactly one canonical care reservation");
  assert.match(String(manyReservations.body ?? ""), /exactly one canonical care reservation/i);

  const good = await govern();
  assert.equal(good.ok, true, `the governed booking must be accepted: ${String(good.body ?? "").slice(0, 200)}`);

  await gov.sittingQuoteLinkStatement(db, q.quoteId, BOOKING).run();
  const consumed = await attempt(() => gov.consumeSittingQuote(db, q.quoteId, BOOKING));
  assert.equal(consumed.ok, true, `the quote must consume once: ${String(consumed.body ?? "").slice(0, 160)}`);
  const twice = await attempt(() => gov.consumeSittingQuote(db, q.quoteId, BOOKING));
  assert.equal(twice.ok, false, "a quote must never be consumable twice");

  const relinked = await govern();
  assert.equal(relinked.ok, false, "a quote already linked to a booking must not govern a second one");
  stage("Booking gate", "PASS", "unpaid quote refused; forged total refused; the quote links and consumes exactly once");
});

// --- 3. PARTNER: acceptance, care plan, geofenced check-in -------------------
/** Canonical rows a sitting booking needs, with the sitter assigned and the doorstep known. */
function seedCanonical(sqlite, over = {}) {
  const now = Date.now();
  const start = over.start ?? new Date(now - 3600000).toISOString();
  const end = over.end ?? new Date(now + 2 * DAY).toISOString();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER DEFAULT 1,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'customer_booking',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_assignment_offers (group_id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',offered_at INTEGER NOT NULL,expires_at INTEGER NOT NULL,responded_at INTEGER,response_reason TEXT,attempt_no INTEGER NOT NULL DEFAULT 1,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_assignment_decisions (group_id TEXT PRIMARY KEY,strategy TEXT NOT NULL,shortlist_json TEXT NOT NULL,selected_provider_id TEXT,status TEXT NOT NULL,actor_id TEXT,reason TEXT,updated_at INTEGER NOT NULL);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Sitting Customer", "9800000333", "sit@example.test", CITY, '{}', now, now);
  sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'pet_sitting',?,'Overnight Pet Sitting','SIT-SG-1',?,?,?,?,'customer_app',1598,'INR','{}','["SIT-PET-1"]','test',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, ZONE, OVERNIGHT, SITTER, start, end, over.status ?? "confirmed", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES ('SIT-WO-1',?,'SIT-SG-1',?,'Sitter One','commission','pet_sitting',?,?,1,'accepted',?,?)")
    .run(BOOKING, SITTER, start, end, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_service_locations VALUES (?,?,?,?,?,?,'customer_booking','active',?,?)")
    .run(BOOKING, CUSTOMER, SITTER, "18 Indiranagar", DOORSTEP.lat, DOORSTEP.lng, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('SIT-RES-1','SIT-SG-1',?,'pet_sitting',?,?,?,'[\"SIT-PET-1\"]',?,?,1,1,'overnight','confirmed','{}',?)")
    .run(SITTER, CITY, ZONE, CUSTOMER, start, end, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES ('SIT-PAY-1',?,?,1598,799,'INR','card','split_50_50','captured','razorpay','sit-idem-1','{}',?,?)")
    .run(BOOKING, CUSTOMER, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO provider_assignment_offers (group_id,booking_id,provider_id,status,offered_at,expires_at,attempt_no,updated_at) VALUES ('SIT-SG-1',?,?,?,?,?,1,?)")
    .run(BOOKING, over.offerProviderId ?? SITTER, over.offerStatus ?? "pending", now, over.offerExpiresAt ?? (now + 3600000), now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_assignment_decisions (group_id,strategy,shortlist_json,selected_provider_id,status,actor_id,reason,updated_at) VALUES ('SIT-SG-1','auto','[]',?,'assigned','system',NULL,?)")
    .run(SITTER, now);
  return { start, end };
}

async function sittingWorld(env = PROD_ENV, over = {}) {
  const w = sitWorld(env);
  const life = await import("../lib/sitting-lifecycle.ts");
  await life.ensureSittingLifecycleTables(w.db);
  const win = seedCanonical(w.sqlite, over);
  return { ...w, ...win, life };
}

test("SIT-05 sitter acceptance: only the assigned sitter, only while awaiting, and only once", async () => {
  const { db, sqlite, life } = await sittingWorld();
  const act = (action, over = {}) => attempt(() => life.mutateSittingBooking(db, {
    bookingId: BOOKING, action, actorId: SITTER, providerId: SITTER,
    idempotencyKey: `sit-${action}-${Math.random()}`, ...over,
  }));

  const accepted = await act("accept", { idempotencyKey: "sit-acc-1" });
  assert.equal(accepted.ok, true, `the assigned sitter must be able to accept: ${String(accepted.body ?? "").slice(0, 220)}`);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned");

  const replay = await act("accept", { idempotencyKey: "sit-acc-1" });
  assert.equal(replay.ok, true);
  assert.equal(replay.value.duplicatePrevented, true, "a replayed key must not accept twice");

  // One key belongs to one action on one record.
  const crossed = await act("check_in", { idempotencyKey: "sit-acc-1" });
  assert.equal(crossed.ok, false, "an idempotency key must not be reusable for a different action");
  assert.match(String(crossed.body ?? ""), /one action on one record/i);

  /* The offer is what authorises the acceptance: a sitter cannot accept a job offered to someone
   * else, nor one whose offer window has closed. */
  const other = await sittingWorld(PROD_ENV, { offerProviderId: "SIT-PRV-OTHER" });
  const notMine = await attempt(() => other.life.mutateSittingBooking(other.db, {
    bookingId: BOOKING, action: "accept", actorId: SITTER, providerId: SITTER, idempotencyKey: "sit-acc-other",
  }));
  assert.equal(notMine.ok, false, "a sitter must not accept a job offered to a different sitter");
  assert.match(String(notMine.body ?? ""), /No pending sitter offer/i);

  const stale = await sittingWorld(PROD_ENV, { offerExpiresAt: Date.now() - 60000 });
  const expired = await attempt(() => stale.life.mutateSittingBooking(stale.db, {
    bookingId: BOOKING, action: "accept", actorId: SITTER, providerId: SITTER, idempotencyKey: "sit-acc-exp",
  }));
  assert.equal(expired.ok, false, "an expired offer must not still be acceptable");

  // Declining needs a stated reason - a sitter cannot drop a job silently.
  const w2 = await sittingWorld();
  const thin = await attempt(() => w2.life.mutateSittingBooking(w2.db, {
    bookingId: BOOKING, action: "decline", actorId: SITTER, providerId: SITTER,
    idempotencyKey: "sit-dec-1", reason: "x",
  }));
  assert.equal(thin.ok, false, "a decline must carry a real reason");
  const declined = await attempt(() => w2.life.mutateSittingBooking(w2.db, {
    bookingId: BOOKING, action: "decline", actorId: SITTER, providerId: SITTER,
    idempotencyKey: "sit-dec-2", reason: "family emergency, cannot cover this booking",
  }));
  assert.equal(declined.ok, true, `a reasoned decline must be accepted: ${String(declined.body ?? "").slice(0, 200)}`);
  assert.equal(w2.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "reassignment_needed",
    "a declined booking must go back for reassignment, not silently stall");
  stage("Sitter acceptance", "PASS", "accept moves to assigned; replay deduplicated; key reuse, another sitter offer and an expired offer all refused; a reasoned decline routes to reassignment");
});

test("SIT-06 care plan: emergency contact, vet AND home access are all required", async () => {
  const { db, sqlite, life } = await sittingWorld();
  const plan = (carePlan, key) => attempt(() => life.mutateSittingBooking(db, {
    bookingId: BOOKING, action: "submit_care_plan", actorId: CUSTOMER, providerId: SITTER,
    idempotencyKey: key, carePlan,
  }));
  const full = { emergencyContact: "9800000333", vet: "Cessna Lifeline", homeAccess: "keypad 4417, spare key with neighbour" };

  for (const [label, missing] of [["emergency contact", "emergencyContact"], ["vet", "vet"], ["home access", "homeAccess"]]) {
    const partial = { ...full };
    delete partial[missing];
    const res = await plan(partial, `sit-plan-${missing}`);
    assert.equal(res.ok, false, `a care plan with no ${label} must be refused`);
    assert.match(String(res.body ?? ""), /emergency contact, vet and home access/i);
  }
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM sitting_care_plan_snapshots WHERE booking_id=?").get(BOOKING).n, 0,
    "a refused care plan must not be stored");

  const good = await plan(full, "sit-plan-ok");
  assert.equal(good.ok, true, `a complete care plan must be accepted: ${String(good.body ?? "").slice(0, 200)}`);
  const snap = sqlite.prepare("SELECT plan_json,status FROM sitting_care_plan_snapshots WHERE booking_id=?").get(BOOKING);
  assert.equal(snap.status, "ready");
  assert.match(String(snap.plan_json), /keypad 4417/, "the plan the customer wrote must be what is stored");
  stage("Care plan", "PASS", "emergency contact, vet and home access each mandatory; a complete plan stores verbatim and marks ready");
});

/** Accept + a ready care plan, so check-in is the only gate left. */
async function readyForCheckIn(env = PROD_ENV, over = {}) {
  const w = await sittingWorld(env, over);
  await w.life.mutateSittingBooking(w.db, {
    bookingId: BOOKING, action: "accept", actorId: SITTER, providerId: SITTER, idempotencyKey: `r-a-${Math.random()}`,
  });
  await w.life.mutateSittingBooking(w.db, {
    bookingId: BOOKING, action: "submit_care_plan", actorId: CUSTOMER, providerId: SITTER,
    idempotencyKey: `r-p-${Math.random()}`,
    carePlan: { emergencyContact: "9800000333", vet: "Cessna Lifeline", homeAccess: "keypad 4417" },
  });
  return w;
}

test("SIT-07 check-in geofence: a sitter must be at the door, with the simulator OFF", async () => {
  /* This is the stage most at risk of proving nothing.
   *
   * lib/sitting-lifecycle.ts assertCheckInGeofence falls back to a DETERMINISTIC SIMULATION when
   * coordinates are missing - but only when the worker env says NODE_ENV === "test" AND
   * PAWSPACE_LOCAL_PREVIEW is on. The suite runs under exactly those values, so a geofence test on
   * the default env is waved through by the simulator no matter where the sitter claims to be.
   * Every world here is built with the simulator OFF; the simulated path is exercised separately
   * below, and pinned as test-only. */
  const { db, sqlite, life } = await readyForCheckIn(PROD_ENV);
  const checkIn = (over = {}) => attempt(() => life.mutateSittingBooking(db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER,
    idempotencyKey: `sit-in-${Math.random()}`, ...over,
  }));

  /* Order of gates. Acceptance and a ready care plan both come BEFORE the geofence, and each must
   * refuse for its own reason - my first version only ever tested a world that already had both,
   * so deleting the care-plan gate changed nothing and the test stayed green. */
  const fresh = await sittingWorld(PROD_ENV);
  const beforeAccept = await attempt(() => fresh.life.mutateSittingBooking(fresh.db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER,
    idempotencyKey: "sit-pre-1", latitude: DOORSTEP.lat, longitude: DOORSTEP.lng,
  }));
  assert.equal(beforeAccept.ok, false, "a sitter cannot check in to a booking they never accepted");
  assert.match(String(beforeAccept.body ?? ""), /acceptance is required before check-in/i);

  await fresh.life.mutateSittingBooking(fresh.db, {
    bookingId: BOOKING, action: "accept", actorId: SITTER, providerId: SITTER, idempotencyKey: "sit-pre-acc",
  });
  const noPlan = await attempt(() => fresh.life.mutateSittingBooking(fresh.db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER,
    idempotencyKey: "sit-pre-2", latitude: DOORSTEP.lat, longitude: DOORSTEP.lng,
  }));
  assert.equal(noPlan.ok, false, "a sitter standing at the door still cannot start without a care plan");
  assert.match(String(noPlan.body ?? ""), /ready Sitting care plan is required/i);
  assert.equal(fresh.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned");

  const noCoords = await checkIn();
  assert.equal(noCoords.ok, false, "with the simulator off, a check-in without coordinates must be refused");
  assert.match(String(noCoords.body ?? ""), /requires provider latitude and longitude/i);

  // ~2.2 km away - a sitter marking themselves in from the next neighbourhood.
  const farAway = await checkIn({ latitude: DOORSTEP.lat + 0.02, longitude: DOORSTEP.lng });
  assert.equal(farAway.ok, false, "a sitter 2 km from the home must not be able to check in");
  assert.match(String(farAway.body ?? ""), /from the customer doorstep/i);
  assert.match(String(farAway.body ?? ""), new RegExp(`${life.SITTING_CHECKIN_GEOFENCE_METERS}m`),
    "the refusal must name the governed geofence");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned",
    "a refused check-in must not start the booking");

  // ~50 m away - inside the 250 m geofence.
  const atDoor = await checkIn({ latitude: DOORSTEP.lat + 0.00045, longitude: DOORSTEP.lng });
  assert.equal(atDoor.ok, true, `a sitter at the door must be able to check in: ${String(atDoor.body ?? "").slice(0, 220)}`);
  assert.ok(atDoor.value.geofence.distanceMeters <= life.SITTING_CHECKIN_GEOFENCE_METERS);
  assert.equal(atDoor.value.geofence.thresholdMeters, 250);
  assert.equal(atDoor.value.geofence.simulated, false, "a real check-in must not be flagged as simulated");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "in_progress");
  stage("Check-in geofence", "PASS", `simulator OFF: unaccepted, no care plan, no coordinates and 2 km all refused; ${atDoor.value.geofence.distanceMeters}m accepted against a 250m threshold`);
});

test("SIT-08 geofence simulator: it is reachable only under test env, and it says so on the record", async () => {
  /* The simulator exists so UAT can run without real GPS. What matters is that it cannot be reached
   * from a production-shaped environment, and that anything it produces is LABELLED simulated
   * rather than passed off as a real GPS fix. */
  const sim = await readyForCheckIn(SIM_ENV);
  const simulated = await attempt(() => sim.life.mutateSittingBooking(sim.db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER, idempotencyKey: "sit-sim-1",
  }));
  assert.equal(simulated.ok, true, `under test env the simulator must stand in: ${String(simulated.body ?? "").slice(0, 200)}`);
  assert.equal(simulated.value.geofence.simulated, true,
    "a simulated fix must be recorded as simulated, never as a real one");
  assert.equal(simulated.value.geofence.telemetryMode, "deterministic_local_uat",
    "the record must name the simulation mode plainly");

  /* The same call, from a production-shaped env, must be refused. This is the assertion that keeps
   * the simulator from ever becoming a production bypass. */
  const prod = await readyForCheckIn(PROD_ENV);
  const refused = await attempt(() => prod.life.mutateSittingBooking(prod.db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER, idempotencyKey: "sit-sim-2",
  }));
  assert.equal(refused.ok, false, "the simulator must not be reachable outside the test environment");
  assert.equal(prod.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned");

  // Nor may a half-set env open it: preview on but NODE_ENV production.
  const half = await readyForCheckIn({ NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "on" });
  const halfRefused = await attempt(() => half.life.mutateSittingBooking(half.db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER, idempotencyKey: "sit-sim-3",
  }));
  assert.equal(halfRefused.ok, false, "PAWSPACE_LOCAL_PREVIEW alone must not open the simulator");
  stage("Geofence simulator", "PASS", "reachable only when NODE_ENV=test AND preview is on; labelled deterministic_local_uat; preview alone does not open it");
});

test("SIT-09 check-in money gate: an unpaid 50/50 balance stops the handover", async () => {
  const { db, sqlite, life } = await readyForCheckIn(PROD_ENV);
  const split = await import("../lib/stay-split-payments.ts");
  await split.ensureStayPaymentTables(db);
  await split.staySplitScheduleStatement(db, {
    bookingId: BOOKING, serviceCode: "pet_sitting", customerId: CUSTOMER, totalAmount: 1598,
    paidNowAmount: 799, balanceAmount: 799, balanceDueAt: Date.now() + 3600000, status: "pending_balance",
  }).run();
  const checkIn = (key) => attempt(() => life.mutateSittingBooking(db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER,
    idempotencyKey: key, latitude: DOORSTEP.lat + 0.00045, longitude: DOORSTEP.lng,
  }));

  const unpaid = await checkIn("sit-money-1");
  assert.equal(unpaid.ok, false, "an unpaid balance must block check-in even when the sitter is at the door");
  assert.match(String(unpaid.body ?? ""), /balance must be paid before check-in/i);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned");

  const paid = await attempt(() => split.payStayBalance(db, {
    bookingId: BOOKING, actorId: CUSTOMER, idempotencyKey: "sit-bal-1",
  }));
  assert.equal(paid.ok, true, `the balance must be payable: ${String(paid.body ?? "").slice(0, 200)}`);
  assert.equal(paid.value.schedule.status, "paid");
  const replay = await attempt(() => split.payStayBalance(db, {
    bookingId: BOOKING, actorId: CUSTOMER, idempotencyKey: "sit-bal-1",
  }));
  assert.equal(replay.value.duplicatePrevented, true, "a replayed balance payment must not charge twice");

  const done = await checkIn("sit-money-2");
  assert.equal(done.ok, true, `with the balance settled check-in must proceed: ${String(done.body ?? "").slice(0, 220)}`);
  assert.ok(split.SPLIT_ELIGIBLE_SERVICES.has("pet_sitting"), "pet_sitting is a split-eligible service");
  stage("Check-in money gate", "PASS", "unpaid Rs 799 balance blocks a sitter standing at the door; paying it once opens the handover");
});

/** Drive to in_progress with the simulator off. */
async function activeWorld(over = {}) {
  const w = await readyForCheckIn(PROD_ENV, over);
  await w.life.mutateSittingBooking(w.db, {
    bookingId: BOOKING, action: "check_in", actorId: SITTER, providerId: SITTER,
    idempotencyKey: `a-in-${Math.random()}`, latitude: DOORSTEP.lat + 0.00045, longitude: DOORSTEP.lng,
  });
  return w;
}

test("SIT-10 care events: typed vocabulary, and only while the booking is actually running", async () => {
  const { db, sqlite, life } = await activeWorld();
  const care = (over = {}) => attempt(() => life.mutateSittingBooking(db, {
    bookingId: BOOKING, action: "care_event", actorId: SITTER, providerId: SITTER,
    idempotencyKey: `sit-c-${Math.random()}`, ...over,
  }));

  for (const type of ["meal", "walk", "medication", "photo_update", "general_update", "incident", "home_check"]) {
    const res = await care({ careEventType: type, detail: { note: `${type} logged` } });
    assert.equal(res.ok, true, `${type} must be a loggable sitting care event: ${String(res.body ?? "").slice(0, 140)}`);
    assert.equal(res.value.eventType, type);
  }

  const unknown = await care({ careEventType: "grooming" });
  assert.equal(unknown.ok, false, "an unrecognised care event must be refused, not stored as free text");

  const logged = sqlite.prepare("SELECT event_type FROM sitting_care_events WHERE booking_id=? AND event_type IN ('care_meal','care_walk','care_medication','care_photo_update','care_general_update','care_incident','care_home_check')").all(BOOKING);
  assert.equal(logged.length, 7, "exactly the seven governed event types may have been written");

  /* Before check-in there is no active care to log. */
  const notStarted = await readyForCheckIn(PROD_ENV);
  const early = await attempt(() => notStarted.life.mutateSittingBooking(notStarted.db, {
    bookingId: BOOKING, action: "care_event", actorId: SITTER, providerId: SITTER,
    idempotencyKey: "sit-c-early", careEventType: "meal",
  }));
  assert.equal(early.ok, false, "care cannot be logged against a booking the sitter has not started");
  assert.match(String(early.body ?? ""), /only during an active booking/i);
  stage("Care events", "PASS", "all seven governed types accepted; an invented type and logging before check-in both refused");
});

test("SIT-11 proof: media is prepared, uploaded and scanned by someone other than the uploader", async () => {
  const { db, sqlite } = await activeWorld();
  const proof = await import("../lib/sitting-proof-governance.ts");
  const call = (over) => attempt(() => proof.mutateSittingProof(db, {
    bookingId: BOOKING, actorId: SITTER, idempotencyKey: `sit-p-${Math.random()}`, ...over,
  }));
  const SHA = "b".repeat(64);

  const badMime = await call({ action: "prepare_media", purpose: "sitting_update", mimeType: "application/pdf", sizeBytes: 2048, sha256: SHA });
  assert.equal(badMime.ok, false, "a PDF is not photo or video proof");
  const noHash = await call({ action: "prepare_media", purpose: "sitting_update", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "nope" });
  assert.equal(noHash.ok, false, "proof without a real SHA-256 must be refused");

  const prepared = await call({ action: "prepare_media", purpose: "sitting_update", mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA });
  assert.equal(prepared.ok, true, `a valid proof request must be granted: ${String(prepared.body ?? "").slice(0, 200)}`);
  assert.equal(prepared.value.scanStatus, "pending");

  const publicUrl = await call({
    action: "sandbox_finalize_media", uploadToken: prepared.value.upload.token,
    storageObjectId: "https://cdn.example.test/leak.jpg",
  });
  assert.equal(publicUrl.ok, false, "a public URL must not be accepted as a storage confirmation");

  const finalized = await call({
    action: "sandbox_finalize_media", uploadToken: prepared.value.upload.token,
    storageObjectId: `sitting/${prepared.value.mediaId}.jpg`,
  });
  assert.equal(finalized.ok, true, `the upload must finalize: ${String(finalized.body ?? "").slice(0, 200)}`);

  const selfScan = await call({ action: "record_media_scan", mediaRef: prepared.value.mediaRef, scanResult: "clean" });
  assert.equal(selfScan.ok, false, "the sitter who uploaded the evidence must not clear their own scan");
  assert.equal(selfScan.status, 403);
  assert.match(String(selfScan.body ?? ""), /cannot be scan-approved by the actor who submitted it/i,
    "the refusal must be separation of duties, not an incidental ownership or state error");

  const scanned = await call({
    action: "record_media_scan", actorId: "ops@pawspace.test",
    mediaRef: prepared.value.mediaRef, scanResult: "clean",
  });
  assert.equal(scanned.ok, true, `an independent scan must clear the media: ${String(scanned.body ?? "").slice(0, 200)}`);
  const asset = sqlite.prepare("SELECT scan_status,access_status FROM service_media_assets WHERE id=?").get(prepared.value.mediaId);
  assert.equal(asset.scan_status, "clean");
  assert.equal(asset.access_status, "ready");
  stage("Proof media", "PASS", "mime and checksum refused; public URL refused; the uploader cannot clear their own scan");
});

// --- 4. CLOSE + MONEY --------------------------------------------------------
/** The commercial term Finance approves per service; without it completion has no payout basis. */
async function seedCommercialTerm(db) {
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const now = Date.now();
  await db.prepare("INSERT OR REPLACE INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('SIT-TERM-1','pet_sitting',NULL,1,'active','commission_standard',0.70,'provider_gst_on_behalf',0.18,0,0,0,12,'2026-04-01','sitting vertical execution test','ops','finance','APR-1',?,?)")
    .bind(now, now).run();
}

test("SIT-12 check-out: a failed completion rolls back, and a priced one posts a balanced journal", async () => {
  /* Sitting already guards what Boarding did not: resolveServiceCompletionFinance is wrapped, and a
   * failure restores the booking to in_progress before rethrowing. Both directions are pinned. */
  const { db, sqlite, life } = await activeWorld();
  const out = (key) => attempt(() => life.mutateSittingBooking(db, {
    bookingId: BOOKING, action: "check_out", actorId: SITTER, providerId: SITTER, idempotencyKey: key,
  }));

  const unpriced = await out("sit-out-1");
  assert.equal(unpriced.ok, false, "a booking with no approved commercial term must not complete");
  assert.match(String(unpriced.body ?? ""), /no active commercial term for service pet_sitting/i);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "in_progress",
    "a failed completion must roll the booking back, not leave it half-closed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING).n, 0,
    "a failed completion must not accrue a sitter payout");

  await seedCommercialTerm(db);
  const done = await out("sit-out-2");
  assert.equal(done.ok, true, `the same booking must complete on retry once priced: ${String(done.body ?? "").slice(0, 240)}`);
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "completed");
  assert.equal(sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(BOOKING).status, "completed",
    "closing the booking must close the sitter's work order too");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING).n, 1,
    "a retried completion must accrue ONE sitter payout, never two");

  const entries = sqlite.prepare("SELECT debit,credit,vertical FROM finance_journal_entries WHERE source_id=? AND source_type='service_completion'").all(BOOKING);
  assert.ok(entries.length >= 2, `completion must post a double-entry journal, got ${entries.length}`);
  const debits = entries.reduce((n, e) => n + Number(e.debit || 0), 0);
  const credits = entries.reduce((n, e) => n + Number(e.credit || 0), 0);
  assert.ok(Math.abs(debits - credits) < 0.01, `the completion journal must balance: ${debits} vs ${credits}`);
  stage("Check-out + completion finance", "PASS", `unpriced completion rolls back to in_progress and retries cleanly; ${entries.length} balanced entries at Rs ${debits.toFixed(2)}, one payout`);
});

test("SIT-13 cancellation: a delivered stay cannot be refunded, and no one approves their own request", async () => {
  const fin = await import("../lib/sitting-finance-governance.ts");

  const w = await sittingWorld();
  await fin.ensureSittingFinanceTables(w.db);
  const req = (over = {}) => attempt(() => fin.mutateSittingFinance(w.db, {
    bookingId: BOOKING, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: `sit-rc-${Math.random()}`, reason: "customer travel plans changed", ...over,
  }));

  const opened = await req({ idempotencyKey: "sit-rc-1" });
  assert.equal(opened.ok, true, `a cancellation request must open: ${String(opened.body ?? "").slice(0, 220)}`);
  assert.equal(opened.value.status, "policy_review_required", "a cancellation must go to policy review, not auto-refund");
  assert.equal(opened.value.bookingPreserved, true, "requesting a cancellation must not itself cancel the booking");

  const replay = await req({ idempotencyKey: "sit-rc-1" });
  assert.equal(replay.value.duplicatePrevented, true, "a replayed key must not open a second request");

  /* Segregation of duties: the requester must not approve their own refund. */
  const selfApprove = await attempt(() => fin.mutateSittingFinance(w.db, {
    bookingId: BOOKING, action: "approve_cancel", actorId: CUSTOMER,
    idempotencyKey: "sit-ac-1", reason: "approving my own request", approvedRefundAmount: 1598,
  }));
  assert.equal(selfApprove.ok, false, "the requester must not approve their own cancellation");
  assert.match(String(selfApprove.body ?? ""), /segregation of duties/i);

  /* A refund can never exceed what was actually collected. */
  const overRefund = await attempt(() => fin.mutateSittingFinance(w.db, {
    bookingId: BOOKING, action: "approve_cancel", actorId: "finance@pawspace.test",
    idempotencyKey: "sit-ac-2", reason: "finance approves this cancellation", approvedRefundAmount: 99999,
  }));
  assert.equal(overRefund.ok, false, "a refund larger than the money collected must be refused");

  /* An in-progress stay is an Operations incident, not a self-service cancellation. */
  const running = await activeWorld();
  await fin.ensureSittingFinanceTables(running.db);
  const midStay = await attempt(() => fin.mutateSittingFinance(running.db, {
    bookingId: BOOKING, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: "sit-rc-mid", reason: "customer changed their mind mid-stay",
  }));
  assert.equal(midStay.ok, false, "an in-progress sitting must not be cancellable without Operations");
  assert.match(String(midStay.body ?? ""), /Operations incident workflow/i);

  /* And a delivered stay is closed for good. */
  const delivered = await activeWorld();
  await seedCommercialTerm(delivered.db);
  await delivered.life.mutateSittingBooking(delivered.db, {
    bookingId: BOOKING, action: "check_out", actorId: SITTER, providerId: SITTER, idempotencyKey: "sit-done",
  });
  await fin.ensureSittingFinanceTables(delivered.db);
  const afterDelivery = await attempt(() => fin.mutateSittingFinance(delivered.db, {
    bookingId: BOOKING, action: "request_cancel", actorId: CUSTOMER,
    idempotencyKey: "sit-rc-late", reason: "customer wants a refund after the stay",
  }));
  assert.equal(afterDelivery.ok, false, "a delivered sitting must not accept a cancellation request");
  assert.match(String(afterDelivery.body ?? ""), /Closed Sitting bookings cannot accept/i);
  stage("Cancellation + refund", "PASS", "requests go to policy review; requester cannot approve; over-refund, mid-stay and post-delivery cancellation all refused");
});

// --- SCOPE REPORT -------------------------------------------------------------
test("SIT-99 pet sitting vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== PET SITTING VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
