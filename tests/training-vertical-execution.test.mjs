/*
 * The Dog Training vertical, executed end to end - one stage per test, in the order a real
 * programme moves.
 *
 * catalogue -> quote -> sandbox capture -> booking governance -> programme -> session state machine
 * (accept, on the way, arrive under geofence, start, owner handover, evidence, complete) ->
 * staff-override actions -> cancellation -> refund -> invoice/GST -> payout -> filing.
 *
 * Every test drives the REAL module against a real database. No source-text assertions and no
 * mocked business logic: the shim in helpers/execution-harness.mjs is an adapter from D1's API onto
 * node:sqlite, so each module runs its own SQL against a real engine.
 *
 * Training seeds its own catalogue from lib/training-commercial-governance.ts, so the fixtures below
 * use the REAL package codes and prices rather than inventing any.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__TRN_DB__", "__TRN_ENV__");

const CITY = "blr";
const ZONE = "blr-east";
const CUSTOMER = "TRN-CUS-001";
const TRAINER = "TRN-PRV-001";
const BOOKING = "TRN-BK-001";
const PACKAGE = "training-4-puppy";   // 4 sessions, Rs 6000, 50/50 split eligible
const PACKAGE_NAME = "Puppy Training Plan";
const DAY = 86400000;
const futureStart = () => new Date(Date.now() + 7 * DAY).toISOString();

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });

const trnWorld = (env = {}) => world("__TRN_DB__", "__TRN_ENV__", env);

// --- 1. CATALOGUE + QUOTE ----------------------------------------------------
test("TRN-01 catalogue: the governed training plans are what the customer is offered", async () => {
  const { db } = trnWorld();
  const com = await import("../lib/training-commercial-governance.ts");
  const listed = await attempt(() => com.listTrainingPackages(db, futureStart()));
  assert.equal(listed.ok, true, `the catalogue must load: ${String(listed.body ?? "").slice(0, 160)}`);
  const byCode = new Map(listed.value.map((p) => [String(p.package_code), p]));
  const puppy = byCode.get(PACKAGE);
  assert.ok(puppy, `${PACKAGE} must be an active governed plan`);
  assert.equal(Number(puppy.sessions), 4, "the Puppy plan is 4 sessions");
  assert.equal(Number(puppy.base_price), 6000, "the governed plan price");
  assert.equal(Number(puppy.split_due_percent), 50, "the Puppy plan is 50/50 split eligible");
  assert.equal(String(puppy.name), PACKAGE_NAME);
  const meet = byCode.get("trainer-meet-greet");
  assert.ok(meet, "the Meet & Greet must be offered as its own governed item");
  assert.equal(Number(meet.sessions), 1);
  stage("Catalogue", "PASS", `${listed.value.length} governed plans; ${PACKAGE} is 4 sessions at Rs 6000`);
});

test("TRN-02 quote: priced by the catalogue, refused for a past start or an unknown plan", async () => {
  const { db } = trnWorld();
  const com = await import("../lib/training-commercial-governance.ts");
  const quote = (over = {}) => attempt(() => com.createTrainingQuote(db, {
    packageCode: PACKAGE, petCount: 1, scheduledStart: futureStart(), paymentMode: "split", ...over,
  }));

  const good = await quote();
  assert.equal(good.ok, true, `a valid quote must price: ${String(good.body ?? "").slice(0, 200)}`);
  assert.equal(good.value.totalAmount, 6000, "the total must come from the catalogue, not the client");
  assert.equal(good.value.amountDueNow, 3000, "a 50/50 split takes half up front");
  assert.ok(good.value.expiresAt > Date.now(), "a quote must carry a real expiry");

  const past = await quote({ scheduledStart: new Date(Date.now() - DAY).toISOString() });
  assert.equal(past.ok, false, "a quote must not be issued for a start in the past");

  const unknown = await quote({ packageCode: "training-999-imaginary" });
  assert.equal(unknown.ok, false, "an unknown plan must not be quotable");

  const prepaid = await quote({ paymentMode: "prepaid" });
  assert.equal(prepaid.ok, true);
  assert.equal(prepaid.value.amountDueNow, 6000, "prepaid takes the whole plan up front");
  stage("Quote", "PASS", "Rs 6000 catalogue price, 50/50 takes Rs 3000; past start and unknown plan refused");
});

// --- 2. SANDBOX PAYMENT + BOOKING GOVERNANCE ---------------------------------
test("TRN-03 payment: a programme cannot be booked until the deposit is server-confirmed, for the exact amount", async () => {
  const { db } = trnWorld();
  const com = await import("../lib/training-commercial-governance.ts");
  const quote = await com.createTrainingQuote(db, {
    packageCode: PACKAGE, petCount: 1, scheduledStart: futureStart(), paymentMode: "split",
  });
  const quoteId = String(quote.quoteId ?? quote.id);
  const capture = (over = {}) => attempt(() => com.captureTrainingQuoteSandbox(db, {
    quoteId, amount: 3000, paymentKey: `trn-cap-${Math.random()}`, ...over,
  }));

  // Before any capture, the booking gate must refuse.
  const unpaid = await attempt(() => com.requireTrainingQuoteSandboxCapture(db, { quoteId, amount: 3000 }));
  assert.equal(unpaid.ok, false, "an unpaid quote must not be bookable");
  assert.match(String(unpaid.body ?? ""), /server-confirmed sandbox payment/i);

  const noKey = await capture({ paymentKey: "  " });
  assert.equal(noKey.ok, false, "a capture without an idempotency key must be refused");

  const wrongAmount = await capture({ amount: 1 });
  assert.equal(wrongAmount.ok, false, "a capture must match the amount the quote governs, not the client's number");

  const captured = await capture({ paymentKey: "trn-cap-1" });
  assert.equal(captured.ok, true, `the governed deposit must capture: ${String(captured.body ?? "").slice(0, 200)}`);

  const state = await attempt(() => com.trainingQuotePaymentState(db, quoteId));
  assert.equal(state.ok, true);
  assert.equal(state.value.status, "PARTIALLY_PAID", "half of a split plan paid is PARTIALLY_PAID, not FULLY_PAID");
  assert.equal(state.value.amountPaid, 3000);
  assert.equal(state.value.remainingAmount, 3000, "the platform must know exactly what is still owed");

  const gate = await attempt(() => com.requireTrainingQuoteSandboxCapture(db, { quoteId, amount: 3000 }));
  assert.equal(gate.ok, true, "with the deposit confirmed the booking gate must open");
  assert.equal(gate.value.environment, "sandbox", "no live money may be claimed by a sandbox capture");

  const mismatched = await attempt(() => com.requireTrainingQuoteSandboxCapture(db, { quoteId, amount: 9999 }));
  assert.equal(mismatched.ok, false, "the gate must refuse an amount that does not match what was captured");
  stage("Sandbox deposit", "PASS", "unpaid, keyless and wrong-amount captures refused; Rs 3000 of Rs 6000 is PARTIALLY_PAID with Rs 3000 owed");
});

test("TRN-04 booking: one quote books one programme, and the client cannot restate the price", async () => {
  const { db } = trnWorld();
  const com = await import("../lib/training-commercial-governance.ts");
  const start = futureStart();
  const quote = await com.createTrainingQuote(db, {
    packageCode: PACKAGE, petCount: 1, scheduledStart: start, paymentMode: "split",
  });
  const quoteId = String(quote.quoteId ?? quote.id);
  await com.captureTrainingQuoteSandbox(db, { quoteId, amount: 3000, paymentKey: "trn-bk-cap" });
  const govern = (over = {}) => attempt(() => com.governTrainingBooking(db, {
    quoteId, packageCode: PACKAGE, packageName: PACKAGE_NAME, petCount: 1, scheduledStart: start,
    submittedTotal: 6000, submittedAmountDueNow: 3000, paymentMode: "split",
    paymentStatus: "partially_paid", reservationCount: 4, ...over,
  }));

  const forged = await govern({ submittedTotal: 1, submittedAmountDueNow: 1 });
  assert.equal(forged.ok, false, "a client-submitted total of 1 must never be accepted");

  const wrongName = await govern({ packageName: "Free Training Plan" });
  assert.equal(wrongName.ok, false, "the package name must match the quote, not the client's label");

  const wrongSessions = await govern({ reservationCount: 1 });
  assert.equal(wrongSessions.ok, false, "a 4-session plan must reserve 4 sessions, not 1");

  const good = await govern();
  assert.equal(good.ok, true, `the governed booking must be accepted: ${String(good.body ?? "").slice(0, 200)}`);

  // The quote is a one-shot: consuming it twice must be impossible.
  await com.trainingQuoteLinkStatement(db, quoteId, BOOKING).run();
  const consumed = await attempt(() => com.consumeTrainingQuote(db, quoteId, BOOKING));
  assert.equal(consumed.ok, true, `the quote must consume once: ${String(consumed.body ?? "").slice(0, 160)}`);
  const twice = await attempt(() => com.consumeTrainingQuote(db, quoteId, BOOKING));
  assert.equal(twice.ok, false, "a quote must never be consumable twice");

  const relinked = await govern();
  assert.equal(relinked.ok, false, "a quote already linked to a booking must not govern a second one");
  stage("Booking governance", "PASS", "forged total, wrong plan name and wrong session count refused; the quote consumes exactly once");
});

// --- 3. SESSION STATE MACHINE ------------------------------------------------
const SESSION = "TRN-SES-1";
const PROGRAMME = "TRN-PRG-1";
const DOORSTEP = { lat: 12.9716, lng: 77.6412 };

/** Seed the canonical rows plus one programme and its four sessions, session 1 scheduled. */
async function programmeWorld(over = {}) {
  const w = trnWorld();
  const life = await import("../lib/training-session-lifecycle.ts");
  await life.ensureTrainingSessionLifecycleTables(w.db);
  const now = Date.now(), start = new Date(now - 3600000).toISOString(), end = new Date(now + 3600000).toISOString();
  w.sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_service_locations (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,provider_id TEXT NOT NULL,address_text TEXT NOT NULL,latitude REAL,longitude REAL,source TEXT NOT NULL DEFAULT 'customer_booking',status TEXT NOT NULL DEFAULT 'active',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  w.sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Training Customer", "9800000222", "trn@example.test", CITY, '{}', now, now);
  w.sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'training',?,?,'TRN-SG-1',?,?,?,'in_progress','customer_app',6000,'INR','{}','["TRN-PET-1"]','test',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, ZONE, PACKAGE, PACKAGE_NAME, TRAINER, start, end, now, now);
  w.sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES ('TRN-PAY-1',?,?,6000,3000,'INR','card','split','captured','razorpay','trn-idem-1','{}',?,?)")
    .run(BOOKING, CUSTOMER, now, now);
  w.sqlite.prepare("INSERT OR REPLACE INTO booking_service_locations VALUES (?,?,?,?,?,?,'customer_booking','active',?,?)")
    .run(BOOKING, CUSTOMER, TRAINER, "42 Indiranagar 100ft Road", DOORSTEP.lat, DOORSTEP.lng, now, now);
  await w.db.prepare("INSERT OR REPLACE INTO training_programmes (id,booking_id,customer_id,provider_id,city_id,zone_id,plan_code,plan_name,pet_ids_json,requirements_json,meet_booking_id,status,total_sessions,completed_sessions,no_show_sessions,cancelled_sessions,pricing_snapshot_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'[\"TRN-PET-1\"]','[]',NULL,'scheduled',?,0,0,0,'{}',?,?)")
    .bind(PROGRAMME, BOOKING, CUSTOMER, TRAINER, CITY, ZONE, PACKAGE, PACKAGE_NAME, over.totalSessions ?? 4, now, now).run();
  await w.db.prepare("INSERT OR REPLACE INTO training_sessions (id,programme_id,booking_id,schedule_reservation_id,sequence_no,provider_id,scheduled_start,scheduled_end,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(SESSION, PROGRAMME, BOOKING, "TRN-RES-1", over.sequenceNo ?? 1, TRAINER, start, end, over.status ?? "scheduled", now, now).run();
  return { ...w, start, end };
}

test("TRN-05 session state machine: each step is reachable only from the step before it", async () => {
  const { db, sqlite } = await programmeWorld();
  const life = await import("../lib/training-session-lifecycle.ts");
  const act = (action, over = {}) => attempt(() => life.mutateTrainingSession(db, {
    sessionId: SESSION, action, actorId: TRAINER, idempotencyKey: `trn-${action}-${Math.random()}`, ...over,
  }));
  const status = () => sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(SESSION).status;

  // Nothing may be skipped: a scheduled session cannot jump straight to started.
  const skipToStart = await act("start");
  assert.equal(skipToStart.ok, false, "a scheduled session must not be startable without accept/arrive");
  const skipToArrive = await act("arrive", { latitude: DOORSTEP.lat, longitude: DOORSTEP.lng });
  assert.equal(skipToArrive.ok, false, "a trainer cannot arrive at a session they never accepted");
  assert.equal(status(), "scheduled", "refused transitions must not move the session");

  const accepted = await act("accept");
  assert.equal(accepted.ok, true, `the trainer must be able to accept: ${String(accepted.body ?? "").slice(0, 200)}`);
  assert.equal(status(), "accepted");

  const acceptTwice = await act("accept");
  assert.equal(acceptTwice.ok, false, "an accepted session must not be accepted again");

  const onTheWay = await act("on_the_way");
  assert.equal(onTheWay.ok, true, `on_the_way must follow accept: ${String(onTheWay.body ?? "").slice(0, 200)}`);
  assert.equal(status(), "on_the_way");
  stage("Session state machine", "PASS", "start and arrive refused out of order; scheduled -> accepted -> on_the_way only in sequence");
});

test("TRN-06 arrival geofence: a trainer must actually be at the customer's door", async () => {
  const { db, sqlite } = await programmeWorld();
  const life = await import("../lib/training-session-lifecycle.ts");
  const act = (action, over = {}) => attempt(() => life.mutateTrainingSession(db, {
    sessionId: SESSION, action, actorId: TRAINER, idempotencyKey: `trn-g-${action}-${Math.random()}`, ...over,
  }));
  await act("accept");
  await act("on_the_way");

  const noCoords = await act("arrive");
  assert.equal(noCoords.ok, false, "arriving without coordinates must be refused");
  assert.match(String(noCoords.body ?? ""), /requires provider latitude and longitude/i);

  // ~2.2 km away - a trainer marking themselves arrived from the next neighbourhood.
  const farAway = await act("arrive", { latitude: DOORSTEP.lat + 0.02, longitude: DOORSTEP.lng });
  assert.equal(farAway.ok, false, "a trainer 2 km away must not be able to mark themselves arrived");
  assert.match(String(farAway.body ?? ""), /from the customer doorstep/i);
  assert.match(String(farAway.body ?? ""), new RegExp(`${life.TRAINING_ARRIVAL_GEOFENCE_METERS}m`),
    "the refusal must name the governed geofence");
  assert.equal(sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(SESSION).status, "on_the_way",
    "a refused arrival must not move the session");

  // ~50 m away - inside the 250 m geofence.
  const atDoor = await act("arrive", { latitude: DOORSTEP.lat + 0.00045, longitude: DOORSTEP.lng });
  assert.equal(atDoor.ok, true, `a trainer at the door must be able to arrive: ${String(atDoor.body ?? "").slice(0, 200)}`);
  assert.ok(atDoor.value.geofence.distanceMeters <= life.TRAINING_ARRIVAL_GEOFENCE_METERS);
  assert.equal(atDoor.value.geofence.thresholdMeters, 250);
  assert.equal(sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(SESSION).status, "arrived");
  stage("Arrival geofence", "PASS", `no coordinates and a 2 km distance both refused; ${atDoor.value.geofence.distanceMeters}m accepted against a 250m threshold`);
});

// --- 4. THE FOUR COMPLETION GATES --------------------------------------------
/** Drive a session to in_session through the real state machine. */
async function inSessionWorld(over = {}) {
  const w = await programmeWorld(over);
  const life = await import("../lib/training-session-lifecycle.ts");
  const act = (action, extra = {}) => life.mutateTrainingSession(w.db, {
    sessionId: SESSION, action, actorId: TRAINER, idempotencyKey: `is-${action}-${Math.random()}`, ...extra,
  });
  await act("accept");
  await act("on_the_way");
  await act("arrive", { latitude: DOORSTEP.lat + 0.00045, longitude: DOORSTEP.lng });
  await act("start");
  return { ...w, act };
}

/** A clean, scan-approved, session-linked evidence asset of a given purpose. */
async function evidence(db, purpose, id) {
  const now = Date.now();
  const media = await import("../lib/service-media-security.ts");
  await media.ensureServiceMediaTable(db);
  await db.prepare("INSERT OR REPLACE INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,?,'k','image/jpeg',2048,'sha','clean','ready','active',0,?,?,?)")
    .bind(id, BOOKING, TRAINER, purpose, TRAINER, now, now).run();
  await db.prepare("INSERT OR REPLACE INTO training_session_media_links (media_id,session_id,programme_id,booking_id,provider_id,created_at) VALUES (?,?,?,?,?,?)")
    .bind(id, SESSION, PROGRAMME, BOOKING, TRAINER, now).run();
  return `media://asset/${id}`;
}

const GOOD_REPORT = (evidenceRefs) => ({
  attendance: { mode: "parent", safeAreaConfirmed: true, parentOrCaretakerConfirmed: true },
  homework: "Practise loose-lead walking for ten minutes twice daily until the next session.",
  progress: { recall: 7, leashWalking: 6 },
  evidenceRefs,
});

test("TRN-07 owner handover: a session cannot close without the mandatory 15-minute handover", async () => {
  const { db, sqlite, act } = await inSessionWorld();
  const life = await import("../lib/training-session-lifecycle.ts");
  const call = (action, over = {}) => attempt(() => life.mutateTrainingSession(db, {
    sessionId: SESSION, action, actorId: TRAINER, idempotencyKey: `hv-${action}-${Math.random()}`, ...over,
  }));

  const short = await call("owner_handover", { ownerHandoverMinutes: 5 });
  assert.equal(short.ok, false, "a 5-minute handover must not satisfy the 15-minute rule");
  assert.match(String(short.body ?? ""), /at least 15 minutes/i);

  const missing = await call("owner_handover", {});
  assert.equal(missing.ok, false, "a handover with no duration must be refused");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_owner_handover WHERE session_id=?").get(SESSION).n, 0,
    "a refused handover must not be recorded");

  // Completing without any handover at all must be refused for that reason.
  const refs = [await evidence(db, "before_service", "TRN-MED-B1"), await evidence(db, "after_service", "TRN-MED-A1")];
  const noHandover = await call("complete", { report: GOOD_REPORT(refs) });
  assert.equal(noHandover.ok, false, "a session must not close without the handover");
  assert.match(String(noHandover.body ?? ""), /Owner Handover/i);

  const done = await call("owner_handover", { ownerHandoverMinutes: 20 });
  assert.equal(done.ok, true, `a 20-minute handover must be accepted: ${String(done.body ?? "").slice(0, 200)}`);
  const row = sqlite.prepare("SELECT duration_minutes,completed_by FROM training_owner_handover WHERE session_id=?").get(SESSION);
  assert.equal(Number(row.duration_minutes), 20);
  assert.equal(row.completed_by, TRAINER);
  stage("Owner handover", "PASS", "5 minutes and a missing duration refused; completion blocked without it; 20 minutes recorded");
});

test("TRN-08 session report: attendance, safe area and real homework are all required to close", async () => {
  const { db, act } = await inSessionWorld();
  const life = await import("../lib/training-session-lifecycle.ts");
  await life.mutateTrainingSession(db, { sessionId: SESSION, action: "owner_handover", actorId: TRAINER, idempotencyKey: "rp-hv", ownerHandoverMinutes: 20 });
  const refs = [await evidence(db, "before_service", "TRN-MED-B2"), await evidence(db, "after_service", "TRN-MED-A2")];
  const close = (report) => attempt(() => life.mutateTrainingSession(db, {
    sessionId: SESSION, action: "complete", actorId: TRAINER, idempotencyKey: `rp-${Math.random()}`, report,
  }));

  for (const [label, report, expected] of [
    ["no attendance mode", { ...GOOD_REPORT(refs), attendance: { safeAreaConfirmed: true } }, /Attendance mode must be parent or trainer_led/i],
    ["an invented attendance mode", { ...GOOD_REPORT(refs), attendance: { mode: "remote", safeAreaConfirmed: true } }, /Attendance mode must be parent or trainer_led/i],
    ["no safe-area confirmation", { ...GOOD_REPORT(refs), attendance: { mode: "parent", parentOrCaretakerConfirmed: true } }, /Safe training area confirmation/i],
    ["parent mode without the parent present", { ...GOOD_REPORT(refs), attendance: { mode: "parent", safeAreaConfirmed: true } }, /Parent\/caretaker attendance confirmation/i],
    ["token homework", { ...GOOD_REPORT(refs), homework: "ok" }, /Meaningful homework/i],
    ["no numeric progress score", { ...GOOD_REPORT(refs), progress: { recall: "improving" } }, /1-10 progress score/i],
    ["an out-of-range progress score", { ...GOOD_REPORT(refs), progress: { recall: 42 } }, /1-10 progress score/i],
  ]) {
    const res = await close(report);
    assert.equal(res.ok, false, `${label} must not close a session`);
    assert.match(String(res.body ?? ""), expected, `${label} must be refused for its own reason`);
  }
  stage("Session report", "PASS", "invented attendance mode, unconfirmed safe area, absent parent, token homework and a non-numeric or out-of-range progress score all refused");
});

test("TRN-09 evidence: closing needs before AND after proof, scan-approved and bound to this session", async () => {
  const { db, sqlite } = await inSessionWorld();
  const life = await import("../lib/training-session-lifecycle.ts");
  await life.mutateTrainingSession(db, { sessionId: SESSION, action: "owner_handover", actorId: TRAINER, idempotencyKey: "ev-hv", ownerHandoverMinutes: 20 });
  const close = (refs) => attempt(() => life.mutateTrainingSession(db, {
    sessionId: SESSION, action: "complete", actorId: TRAINER, idempotencyKey: `ev-${Math.random()}`, report: GOOD_REPORT(refs),
  }));

  assert.deepEqual([...life.TRAINING_REQUIRED_PROOF], ["before_service", "after_service"]);

  const none = await close([]);
  assert.equal(none.ok, false, "a session must not close with no evidence at all");
  assert.match(String(none.body ?? ""), /At least one secure Training evidence asset/i);

  const bare = await close(["https://example.test/photo.jpg"]);
  assert.equal(bare.ok, false, "a bare URL is not governed evidence");
  assert.match(String(bare.body ?? ""), /canonical media:\/\/asset reference/i);

  const before = await evidence(db, "before_service", "TRN-MED-B3");
  const onlyBefore = await close([before]);
  assert.equal(onlyBefore.ok, false, "a before photo alone does not prove the session happened");

  // An asset that exists but is not scan-approved, and one linked to a different session.
  const dirty = await evidence(db, "after_service", "TRN-MED-DIRTY");
  sqlite.prepare("UPDATE service_media_assets SET scan_status='pending' WHERE id='TRN-MED-DIRTY'").run();
  const unscanned = await close([before, dirty]);
  assert.equal(unscanned.ok, false, "unscanned media must not count as proof");
  assert.match(String(unscanned.body ?? ""), /not clean, ready, active, non-synthetic/i);

  const foreign = await evidence(db, "after_service", "TRN-MED-FOREIGN");
  sqlite.prepare("UPDATE training_session_media_links SET session_id='TRN-SES-OTHER' WHERE media_id='TRN-MED-FOREIGN'").run();
  const wrongSession = await close([before, foreign]);
  assert.equal(wrongSession.ok, false, "evidence from another session must not close this one");

  const after = await evidence(db, "after_service", "TRN-MED-A3");
  const good = await close([before, after]);
  assert.equal(good.ok, true, `before and after proof must close the session: ${String(good.body ?? "").slice(0, 220)}`);
  assert.equal(sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(SESSION).status, "completed");
  stage("Session evidence", "PASS", "no evidence, bare URL, before-only, unscanned and another session's asset all refused; before+after closes");
});

test("TRN-10 final balance: the last session of a split plan cannot close until the balance is paid", async () => {
  /* assertFinalBalancePaid applies ONLY on the last session (sequence_no === total_sessions), which
   * is the commercial point: the customer pays the second half before the programme is delivered.
   * Both directions are pinned here, because a gate that fires on every session would be just as
   * wrong as one that never fires. */
  const life = await import("../lib/training-session-lifecycle.ts");
  const com = await import("../lib/training-commercial-governance.ts");

  const closeLast = async (payBalance) => {
    const w = await inSessionWorld({ sequenceNo: 4, totalSessions: 4 });
    await com.ensureTrainingCommercialTables(w.db);
    const quote = await com.createTrainingQuote(w.db, {
      packageCode: PACKAGE, petCount: 1, scheduledStart: futureStart(), paymentMode: "split",
    });
    const quoteId = String(quote.quoteId ?? quote.id);
    await com.captureTrainingQuoteSandbox(w.db, { quoteId, amount: 3000, paymentKey: `fb-${Math.random()}` });
    await com.trainingQuoteLinkStatement(w.db, quoteId, BOOKING).run();
    if (payBalance) {
      await com.collectTrainingRemainingBalanceSandbox(w.db, { quoteId, amount: 3000, paymentKey: `fb2-${Math.random()}` });
    }
    await life.mutateTrainingSession(w.db, { sessionId: SESSION, action: "owner_handover", actorId: TRAINER, idempotencyKey: `fb-hv-${Math.random()}`, ownerHandoverMinutes: 20 });
    const refs = [await evidence(w.db, "before_service", "TRN-MED-FB-B"), await evidence(w.db, "after_service", "TRN-MED-FB-A")];
    const res = await attempt(() => life.mutateTrainingSession(w.db, {
      sessionId: SESSION, action: "complete", actorId: TRAINER, idempotencyKey: `fb-c-${Math.random()}`, report: GOOD_REPORT(refs),
    }));
    return { res, w, quoteId };
  };

  const unpaid = await closeLast(false);
  assert.equal(unpaid.res.ok, false, "the final session must not close while half the fee is outstanding");
  assert.match(String(unpaid.res.body ?? ""), /Final Training session is blocked/i);
  assert.equal(unpaid.w.sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(SESSION).status, "in_session",
    "a blocked completion must leave the session open");

  const paid = await closeLast(true);
  assert.equal(paid.res.ok, true, `with the balance settled the final session must close: ${String(paid.res.body ?? "").slice(0, 220)}`);
  const state = await com.trainingQuotePaymentState(paid.w.db, paid.quoteId);
  assert.equal(state.status, "FULLY_PAID");
  assert.equal(state.remainingAmount, 0);

  // A mid-programme session must NOT be gated on the final balance.
  const mid = await inSessionWorld({ sequenceNo: 2, totalSessions: 4 });
  await life.mutateTrainingSession(mid.db, { sessionId: SESSION, action: "owner_handover", actorId: TRAINER, idempotencyKey: "mid-hv", ownerHandoverMinutes: 20 });
  const midRefs = [await evidence(mid.db, "before_service", "TRN-MED-M-B"), await evidence(mid.db, "after_service", "TRN-MED-M-A")];
  const midClose = await attempt(() => life.mutateTrainingSession(mid.db, {
    sessionId: SESSION, action: "complete", actorId: TRAINER, idempotencyKey: "mid-c", report: GOOD_REPORT(midRefs),
  }));
  assert.equal(midClose.ok, true, `session 2 of 4 must close without the final balance: ${String(midClose.body ?? "").slice(0, 220)}`);
  stage("Final balance gate", "PASS", "session 4 of 4 blocked until the Rs 3000 balance is paid; session 2 of 4 unaffected");
});

// --- 5. STAFF OVERRIDE -------------------------------------------------------
test("TRN-11 overrides: rescheduling, replacing the trainer and cancelling a session all need staff authority", async () => {
  const { db, sqlite } = await programmeWorld();
  const life = await import("../lib/training-session-lifecycle.ts");
  const act = (action, over = {}) => attempt(() => life.mutateTrainingSession(db, {
    sessionId: SESSION, action, actorId: TRAINER, idempotencyKey: `ov-${action}-${Math.random()}`,
    reason: "customer asked to move the session", ...over,
  }));

  for (const [action, pattern] of [
    ["reschedule", /staff/i],
    ["replace_provider", /staff/i],
    ["cancel_session", /staff/i],
  ]) {
    const res = await act(action);
    assert.equal(res.ok, false, `${action} must not be available to a trainer acting alone`);
    assert.match(String(res.body ?? ""), pattern, `${action} must be refused for want of staff authority`);
  }
  assert.equal(sqlite.prepare("SELECT status FROM training_sessions WHERE id=?").get(SESSION).status, "scheduled",
    "refused overrides must not move the session");

  /* Non-vacuity: the trainer's OWN actions must still work, so this cannot pass by refusing
   * everything. A trainer can ask for a reschedule; they just cannot grant one. */
  const request = await act("request_reschedule");
  assert.equal(request.ok, true, `a trainer must be able to REQUEST a reschedule: ${String(request.body ?? "").slice(0, 200)}`);
  stage("Staff override", "PASS", "reschedule, replace_provider and cancel_session all refused to a trainer; request_reschedule still works");
});

// --- 6. CANCELLATION + REFUND ------------------------------------------------
test("TRN-12 cancellation: a terminal programme cannot reopen, and no one approves their own case", async () => {
  const { db, sqlite } = await programmeWorld();
  const can = await import("../lib/training-cancellation.ts");
  await can.ensureTrainingCancellationTables(db);
  const request = (over = {}) => attempt(() => can.requestTrainingCancellation(db, {
    bookingId: BOOKING, reason: "customer is relocating out of the city",
    idempotencyKey: `trn-can-${Math.random()}`, actorId: CUSTOMER, ...over,
  }));

  const thin = await request({ reason: "no" });
  assert.equal(thin.ok, false, "a cancellation needs a real reason, not a token one");

  const opened = await request({ idempotencyKey: "trn-can-1" });
  assert.equal(opened.ok, true, `a cancellation case must open: ${String(opened.body ?? "").slice(0, 200)}`);
  const caseId = String(opened.value.caseId);

  const replay = await request({ idempotencyKey: "trn-can-1" });
  assert.equal(replay.ok, true);
  assert.equal(replay.value.duplicatePrevented, true, "a replayed key must not open a second case");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM training_cancellation_cases WHERE booking_id=?").get(BOOKING).n, 1,
    "one booking must carry one open cancellation case, not two");

  // Segregation of duties: the requester cannot approve their own refund.
  const selfApprove = await attempt(() => can.approveTrainingCancellation(db, {
    caseId, reason: "approving my own request", actorId: CUSTOMER,
  }));
  assert.equal(selfApprove.ok, false, "the requester must not approve their own cancellation");
  assert.match(String(selfApprove.body ?? ""), /segregation of duties/i);

  // A programme that already finished cannot open a new case.
  sqlite.prepare("UPDATE training_programmes SET status='completed' WHERE id=?").run(PROGRAMME);
  const afterTerminal = await request({ idempotencyKey: "trn-can-2" });
  assert.equal(afterTerminal.ok, false, "a completed programme must not accept a new cancellation request");
  assert.match(String(afterTerminal.body ?? ""), /Terminal or cancelled/i);
  stage("Cancellation governance", "PASS", "token reason refused; replay deduplicated; requester cannot approve; terminal programme cannot reopen");
});

test("TRN-13 refund policy: a cancellation cannot be priced until a policy is published", async () => {
  const { db } = await programmeWorld();
  const can = await import("../lib/training-cancellation.ts");
  await can.ensureTrainingCancellationTables(db);
  const opened = await can.requestTrainingCancellation(db, {
    bookingId: BOOKING, reason: "customer is relocating out of the city",
    idempotencyKey: "trn-pol-1", actorId: CUSTOMER,
  });

  const unpriced = await attempt(() => can.approveTrainingCancellation(db, {
    caseId: String(opened.caseId), reason: "finance approves this cancellation", actorId: "finance@pawspace.test",
  }));
  assert.equal(unpriced.ok, false, "a refund must not be computed with no published policy");
  assert.match(String(unpriced.body ?? ""), /policy is not configured|awaiting Finance approval/i,
    `the refusal must be about the missing policy: ${String(unpriced.body ?? "").slice(0, 160)}`);

  // The policy itself is validated - a percentage over 100 is not a policy.
  const absurd = await attempt(() => can.saveTrainingCancellationPolicy(db, {
    cityId: CITY, feeType: "percent_captured", feeValue: 150, noShowTreatment: "chargeable",
    effectiveFrom: "2026-04-01", actorId: "finance@pawspace.test", reason: "training vertical execution test",
  }));
  assert.equal(absurd.ok, false, "a cancellation fee of 150% of what was captured is not a policy");

  const saved = await attempt(() => can.saveTrainingCancellationPolicy(db, {
    cityId: CITY, feeType: "percent_captured", feeValue: 25, noShowTreatment: "chargeable",
    effectiveFrom: "2026-04-01", actorId: "finance@pawspace.test", reason: "training vertical execution test",
  }));
  assert.equal(saved.ok, true, `a valid policy must publish: ${String(saved.body ?? "").slice(0, 200)}`);
  stage("Refund policy", "PASS", "no refund computed without a published policy; a 150% fee refused; a 25% policy publishes");
});

// --- 7. INVOICE --------------------------------------------------------------
test("TRN-14 invoice: not until fully paid, then arithmetically right, once, and fail-closed for an untaxed city", async () => {
  const { db, sqlite } = await programmeWorld();
  const fin = await import("../lib/training-finance.ts");
  await fin.ensureTrainingFinanceTables(db);

  const noDraft = await attempt(() => fin.issueTrainingInvoice(db, {
    bookingId: "TRN-BK-NOT-A-BOOKING", reason: "training vertical execution test", actorId: "finance@pawspace.test",
  }));
  assert.equal(noDraft.ok, false, "an invoice must not be issued for a booking with no draft");
  assert.equal(noDraft.status, 404);

  const thinReason = await attempt(() => fin.issueTrainingInvoice(db, {
    bookingId: BOOKING, reason: "x", actorId: "finance@pawspace.test",
  }));
  assert.equal(thinReason.ok, false, "issuing a tax document needs a real stated reason");
  assert.equal(thinReason.status, 400);

  /* The guard that actually fires here is the money one, and it is the one worth pinning: a tax
   * invoice must not be minted for a programme the customer has not finished paying for. My first
   * version asserted only that issuing FAILED, which a 404 satisfies just as well - so removing the
   * draft-status check left it green. Name the refusal. */
  const unpaid = await attempt(() => fin.issueTrainingInvoice(db, {
    bookingId: BOOKING, reason: "training vertical execution test", actorId: "finance@pawspace.test",
  }));
  assert.equal(unpaid.ok, false, "a tax invoice must not be issued for a part-paid programme");
  assert.equal(unpaid.status, 409, "the refusal must be the governed 409, not an incidental 404");
  assert.match(String(unpaid.body ?? ""), /until the governed package payment is FULLY_PAID/i,
    "the refusal must name the outstanding payment - any other failure means the guard is not what stopped it");
  const minted = sqlite.prepare("SELECT invoice_number FROM training_finance_invoices WHERE booking_id=?").get(BOOKING);
  assert.ok(!minted?.invoice_number, "no invoice number may be minted while money is outstanding");

  /* Pay the programme in full and let it invoice.
   *
   * CORRECTED. I first asserted that a fully paid programme must still be refused for want of a tax
   * policy. It is not, and it should not be: lib/training-finance.ts SEEDS a published Bengaluru
   * policy (18% inclusive, with its reason recorded on the row), so the launch city always has one.
   * The fail-closed guard is real but unreachable for blr - it is proved below on a city that has
   * no policy. What matters here is that the invoice, once issued, is arithmetically right. */
  const com = await import("../lib/training-commercial-governance.ts");
  const quote = await com.createTrainingQuote(db, {
    packageCode: PACKAGE, petCount: 1, scheduledStart: futureStart(), paymentMode: "split",
  });
  const quoteId = String(quote.quoteId ?? quote.id);
  await com.captureTrainingQuoteSandbox(db, { quoteId, amount: 3000, paymentKey: "inv-dep" });
  await com.collectTrainingRemainingBalanceSandbox(db, { quoteId, amount: 3000, paymentKey: "inv-bal" });
  await com.trainingQuoteLinkStatement(db, quoteId, BOOKING).run();
  assert.equal((await com.trainingQuotePaymentState(db, quoteId)).status, "FULLY_PAID",
    "the fixture must genuinely be paid in full before this half means anything");

  const issued = await attempt(() => fin.issueTrainingInvoice(db, {
    bookingId: BOOKING, reason: "training vertical execution test", actorId: "finance@pawspace.test",
  }));
  assert.equal(issued.ok, true, `a fully paid programme must invoice: ${String(issued.body ?? "").slice(0, 200)}`);
  assert.match(String(issued.value.invoiceNumber), /^TRN-BLR-\d{2}-\d{2}-\d{6}$/,
    `the number must be city and FY scoped: ${issued.value.invoiceNumber}`);
  assert.equal(issued.value.liveTaxFiling, false, "a sandbox invoice must not claim a live tax filing");

  /* Rs 6000 INCLUSIVE of 18% GST: taxable 5084.75, tax 915.25, total unchanged at 6000. An
   * exclusive reading would have added 1080 and charged the customer 7080. */
  const row = sqlite.prepare("SELECT tax_mode,tax_rate,taxable_amount,tax_amount,invoice_total FROM training_finance_invoices WHERE booking_id=?").get(BOOKING);
  assert.equal(row.tax_mode, "inclusive");
  assert.equal(Number(row.tax_rate), 18);
  assert.equal(Number(row.taxable_amount), 5084.75);
  assert.equal(Number(row.tax_amount), 915.25);
  assert.equal(Number(row.invoice_total), 6000, "an inclusive rate must not inflate what the customer pays");
  assert.equal(Math.round((Number(row.taxable_amount) + Number(row.tax_amount)) * 100) / 100, 6000,
    "taxable plus tax must reconcile to the invoice total exactly");

  const twice = await attempt(() => fin.issueTrainingInvoice(db, {
    bookingId: BOOKING, reason: "training vertical execution test", actorId: "finance@pawspace.test",
  }));
  assert.equal(twice.ok, true);
  assert.equal(twice.value.duplicatePrevented, true, "one programme is one invoice number");
  assert.equal(twice.value.invoiceNumber, issued.value.invoiceNumber);

  /* The fail-closed guard, on a city with no published policy. */
  sqlite.prepare("UPDATE training_programmes SET city_id='hyd' WHERE id=?").run(PROGRAMME);
  const unpublished = await attempt(() => fin.refreshTrainingFinanceReadModel(db));
  assert.equal(unpublished.ok, false, "a city with no published tax policy must not produce an invoice draft at all");
  assert.match(String(unpublished.body ?? ""), /Published Training tax policy is required/i);

  stage("Invoice", "PASS", "no draft (404), token reason (400) and part-paid (409) refused; fully paid issues Rs 6000 = 5084.75 + 915.25 at 18% inclusive, once; an unpublished city fails closed");
});

// --- 8. TRAINER PAYOUT -------------------------------------------------------
test("TRN-15 payout: nothing is approved without a statement, a real reason, or a valid period", async () => {
  const { db } = await programmeWorld();
  const fin = await import("../lib/training-finance.ts");
  const approve = (over = {}) => attempt(() => fin.approveTrainingPayout(db, {
    providerId: TRAINER, periodCode: new Date().toISOString().slice(0, 7),
    idempotencyKey: `trn-po-${Math.random()}`, reason: "monthly trainer payout approval",
    actorId: "finance@pawspace.test", ...over,
  }));

  for (const [label, over] of [
    ["a malformed period", { periodCode: "September" }],
    ["a token reason", { reason: "ok" }],
    ["no idempotency key", { idempotencyKey: "" }],
    ["no provider", { providerId: "" }],
  ]) {
    const res = await approve(over);
    assert.equal(res.ok, false, `${label} must not approve a payout`);
    assert.equal(res.status, 400, `${label} must be refused as a bad request`);
  }

  /* Non-vacuity: a well-formed request for a trainer with no earned statement must be refused as
   * NOT FOUND, not as malformed - money cannot be paid against a statement that does not exist. */
  const noStatement = await approve();
  assert.equal(noStatement.ok, false, "a payout must not be approved with no statement behind it");
  assert.equal(noStatement.status, 404, "the refusal must be a missing statement, not a validation error");
  assert.match(String(noStatement.body ?? ""), /payout statement not found/i);

  const earnings = await attempt(() => fin.listTrainerEarnings(db, TRAINER));
  assert.equal(earnings.ok, true);
  assert.equal(earnings.value.livePayout, false, "no live payout may be claimed");
  assert.equal(earnings.value.executionMode, "sandbox_not_connected",
    "the earnings view must say plainly that no payout rail is connected");
  stage("Trainer payout", "PASS", "malformed period, token reason, missing key and missing provider refused 400; no statement refused 404; no live payout rail claimed");
});

// --- SCOPE REPORT ------------------------------------------------------------
test("TRN-99 training vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== DOG TRAINING VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
