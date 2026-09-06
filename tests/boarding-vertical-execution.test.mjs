/*
 * The Boarding vertical, executed end to end - one stage per test, in the order a real stay moves.
 *
 * host discovery -> capability match -> quote -> booking -> split payment -> host acceptance ->
 * care plan -> check-in -> daily proof -> medication -> incident -> check-out -> balance payment ->
 * cancellation -> refund -> host settlement -> review/trust -> GST -> filing.
 *
 * Every test drives the REAL module against a real database. No source-text assertions and no
 * mocked business logic: the shim in helpers/execution-harness.mjs is an adapter from D1's API onto
 * node:sqlite, so each module runs its own SQL against a real engine.
 *
 * Boarding self-seeds its catalogue and its host roster from lib/boarding-governance.ts
 * (`founder_seed`), so the fixtures below use the REAL package codes and the REAL host ids rather
 * than inventing any. host_maya_rohan is dog-only, takes 2 guest pets, supports medication and is
 * one-family-at-a-time; host_arjun_tara takes 3, has a resident beagle and does NOT support
 * medication. Those differences are what the capability stage is for.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__BOARD_DB__", "__BOARD_ENV__");

const CITY = "blr";
const ZONE = "blr-east";
const CUSTOMER = "BRD-CUS-001";
const HOST = "host_maya_rohan";       // dog-only, 2 guest pets, medication yes, one family only
const OTHER_HOST = "host_arjun_tara"; // 3 guest pets, resident beagle, medication NO
const BOOKING = "BRD-BK-001";
const PACKAGE = "boarding-24h";       // overnight, Rs 699 per pet per unit
const PACKAGE_NAME = "Luxury Stay";

/* Boarding quotes demand a future check-in, so the window is anchored to the real clock. */
const DAY = 86400000;
const startAt = () => new Date(Date.now() + 7 * DAY).toISOString();
const endAt = () => new Date(Date.now() + 9 * DAY).toISOString();

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });

function boardWorld(env = {}) {
  return world("__BOARD_DB__", "__BOARD_ENV__", env);
}

/** The canonical tables the vertical's modules read but do not own. */
function seedCanonical(sqlite, over = {}) {
  const start = over.start ?? startAt(), end = over.end ?? endAt();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL,explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,lease_expires_at INTEGER,customer_session_id TEXT,attempt_id TEXT);
  `);
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Boarding Customer", "9800000111", "brd@example.test", CITY, '{"serviceUpdates":true}', now, now);
  sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'boarding',?,?,'BRD-SG-1',?,?,?,?,'customer_app',?,'INR','{}','["BRD-PET-1"]','test',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, ZONE, PACKAGE, PACKAGE_NAME, HOST, start, end,
         over.bookingStatus ?? "confirmed", over.total ?? 1398, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES ('BRD-PAY-1',?,?,?,?,'INR','card',?,?,'razorpay','brd-idem-1','{}',?,?)")
    .run(BOOKING, CUSTOMER, over.total ?? 1398, over.dueNow ?? 1398, over.mode ?? "prepaid", over.paymentStatus ?? "captured", now, now);
  sqlite.prepare("INSERT OR REPLACE INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,capacity_units,occurrence_number,care_mode,status,explanation_json,created_at) VALUES ('BRD-RES-1','BRD-SG-1',?,'boarding',?,?,?,'[\"BRD-PET-1\"]',?,?,1,1,'overnight','confirmed','{}',?)")
    .run(HOST, CITY, ZONE, CUSTOMER, start, end, now);
  return { start, end };
}

/** Insert a stay directly in the shape boardingStayStatement produces. */
async function seedStay(db, over = {}) {
  const gov = await import("../lib/boarding-governance.ts");
  await gov.ensureBoardingGovernanceTables(db);
  const start = over.start ?? startAt(), end = over.end ?? endAt();
  await gov.boardingStayStatement(db, {
    bookingId: over.bookingId ?? BOOKING, customerId: CUSTOMER, providerId: over.providerId ?? HOST,
    cityId: CITY, zoneId: ZONE, packageCode: PACKAGE,
    scheduledStart: start, scheduledEnd: end, stayUnits: 2, petCount: over.petCount ?? 2,
  }).run();
  const row = await db.prepare("SELECT id FROM boarding_stays WHERE booking_id=?").bind(over.bookingId ?? BOOKING).first();
  return String(row.id);
}

// --- 1. HOST DISCOVERY + CAPABILITY MATCH -----------------------------------
test("BRD-01 discovery: the host roster is city/zone scoped and carries no host contact data", async () => {
  const { db } = boardWorld();
  const gov = await import("../lib/boarding-governance.ts");
  const hosts = await attempt(() => gov.listBoardingHosts(db, { cityId: CITY, zoneId: ZONE }));
  assert.equal(hosts.ok, true, `the host roster must load: ${String(hosts.body ?? "").slice(0, 160)}`);
  const ids = hosts.value.map((h) => h.providerId);
  assert.ok(ids.includes(HOST), "the seeded Indiranagar host must be discoverable in its own zone");

  const elsewhere = await attempt(() => gov.listBoardingHosts(db, { cityId: CITY, zoneId: "blr-west" }));
  assert.equal(elsewhere.ok, true);
  assert.equal(elsewhere.value.length, 0, "a host must not surface in a zone they do not serve");

  const serialised = JSON.stringify(hosts.value);
  assert.ok(!/\b[6-9]\d{9}\b/.test(serialised), "the public host roster must not carry a phone number");
  assert.ok(!/@/.test(serialised), "the public host roster must not carry an email address");
  stage("Host discovery", "PASS", `${ids.length} hosts in ${CITY}/${ZONE}, none in blr-west, no contact data`);
});

test("BRD-02 capability: species, capacity, medication and one-family-at-a-time are all matched", async () => {
  const { db } = boardWorld();
  const cap = await import("../lib/boarding-host-capability.ts");
  const gov = await import("../lib/boarding-governance.ts");
  await gov.ensureBoardingGovernanceTables(db);
  const match = (over = {}) => attempt(() => cap.assertBoardingHostMatches(db, {
    providerId: HOST, cityId: CITY, zoneId: ZONE, species: ["dog"], petCount: 1,
    medicationRequired: false, customerId: CUSTOMER, ...over,
  }));

  const ok = await match();
  assert.equal(ok.ok, true, `a dog with no medication must match a dog-only host: ${String(ok.body ?? "").slice(0, 160)}`);

  const cat = await match({ species: ["cat"] });
  assert.equal(cat.ok, false, "a cat must not be matched to a dog-only host");

  const tooMany = await match({ petCount: 3 });
  assert.equal(tooMany.ok, false, "3 pets must not be matched to a host who takes 2");

  const meds = await attempt(() => cap.assertBoardingHostMatches(db, {
    providerId: OTHER_HOST, cityId: CITY, zoneId: ZONE, species: ["dog"], petCount: 1,
    medicationRequired: true, customerId: CUSTOMER,
  }));
  assert.equal(meds.ok, false, "a pet needing medication must not be matched to a host who cannot give it");

  const wrongZone = await match({ zoneId: "blr-west" });
  assert.equal(wrongZone.ok, false, "a host must not be matched outside their zone");
  stage("Host capability", "PASS", "species, capacity, medication and zone all refuse; a clean match is accepted");
});

// --- 2. QUOTE ---------------------------------------------------------------
test("BRD-03 quote: the catalogue prices the stay and the window rules are enforced", async () => {
  const { db } = boardWorld();
  const gov = await import("../lib/boarding-governance.ts");
  const quote = (over = {}) => attempt(() => gov.createBoardingQuote(db, {
    packageCode: PACKAGE, petCount: 2, scheduledStart: startAt(), scheduledEnd: endAt(),
    paymentMode: "prepaid", cityId: CITY, zoneId: ZONE, ...over,
  }));

  const good = await quote();
  assert.equal(good.ok, true, `a valid Boarding quote must be priced: ${String(good.body ?? "").slice(0, 160)}`);
  assert.equal(good.value.packageCode, PACKAGE);
  assert.equal(good.value.stayUnits, 2, "a 48-hour overnight stay is 2 billed units");
  assert.equal(good.value.totalAmount, 699 * 2 * 2, "2 pets x 2 units at the catalogue's Rs 699");
  assert.equal(good.value.amountDueNow, good.value.totalAmount, "prepaid takes the whole amount now");

  // A stay that has already started cannot be quoted.
  const past = await quote({ scheduledStart: new Date(Date.now() - DAY).toISOString() });
  assert.equal(past.ok, false, "a quote must not be issued for a check-in in the past");

  // Overnight boarding has a floor: a 4-hour window is a daycare shape, not an overnight one.
  const tooShort = await quote({ scheduledEnd: new Date(Date.now() + 7 * DAY + 4 * 3600000).toISOString() });
  assert.equal(tooShort.ok, false, "an overnight package must refuse a sub-10-hour window");

  // Coupons are deliberately not enabled for Boarding.
  const coupon = await quote({ couponCode: "SAVE50" });
  assert.equal(coupon.ok, false, "Boarding must refuse a coupon rather than silently ignore it");

  const tooMany = await quote({ petCount: 9 });
  assert.equal(tooMany.ok, false, "a quote must refuse more pets than the package allows");
  stage("Quote", "PASS", `Rs ${good.value.totalAmount} for 2 pets x 2 units; past window, short window, coupon and pet count all refused`);
});

test("BRD-04 split payment: 50/50 takes half now and schedules the balance before check-in", async () => {
  const { db } = boardWorld();
  const gov = await import("../lib/boarding-governance.ts");
  const split = await import("../lib/stay-split-payments.ts");

  const quote = await attempt(() => gov.createBoardingQuote(db, {
    packageCode: PACKAGE, petCount: 2, scheduledStart: startAt(), scheduledEnd: endAt(),
    paymentMode: "split_50_50", cityId: CITY, zoneId: ZONE,
  }));
  assert.equal(quote.ok, true, `a split quote must be priced: ${String(quote.body ?? "").slice(0, 160)}`);
  assert.equal(quote.value.amountDueNow, quote.value.totalAmount / 2, "the 50/50 split takes exactly half up front");

  const plan = split.splitPaymentPlan({ totalAmount: 2796, scheduledStart: startAt() });
  assert.equal(plan.dueNow + plan.balance, 2796, "the split must account for every rupee of the total");
  assert.equal(plan.dueNow, 1398);
  assert.ok(plan.balanceDueAt < new Date(startAt()).getTime(),
    "the balance must fall due BEFORE check-in, never after the pet is already there");
  assert.equal(new Date(startAt()).getTime() - plan.balanceDueAt, split.BALANCE_LEAD_MS);

  assert.ok(split.SPLIT_ELIGIBLE_SERVICES.has("boarding"), "boarding is a split-eligible service");
  assert.ok(!split.SPLIT_ELIGIBLE_SERVICES.has("grooming"), "grooming is not; a one-visit service is paid in full");
  stage("Split payment", "PASS", `half up front, balance due ${split.BALANCE_LEAD_MS / 3600000}h before check-in`);
});

// --- 3. STAY LIFECYCLE: acceptance -> care plan -> check-in ------------------
/* From here the stay must be ACTIVE, so the window straddles now: care events and daily proof are
 * both keyed to IST stay days, and a stay starting next week has no day you can log against yet. */
const istDay = (ms) => new Date(ms + 19800000).toISOString().slice(0, 10);

/* Every stay day in the product is an IST day derived from check_in_at, NOT from the wall clock.
 * The first version of this file computed the expected day from Date.now(), which is the same
 * value for most of the day and a DIFFERENT one between 18:30 and 24:00 UTC - the test would have
 * passed all day and failed every evening. One check-in instant is fixed per world and every
 * expectation is derived from it. */
async function activeWorld(over = {}) {
  const w = boardWorld();
  /* Anchor check-in to just after IST midnight TODAY, so the stay's one required day is always the
   * current IST day and a proof uploaded during the test is credited to it. Using `now - 2h` made
   * the required day yesterday whenever the suite ran after 18:30 UTC, and daily proof - which is
   * deliberately stamped with the SERVER's upload day and cannot be back-dated - could then never
   * satisfy it. That is the product behaving correctly; it was the fixture that was unrealistic. */
  const startMs = Date.parse(`${istDay(Date.now())}T00:00:00Z`) - 19800000 + 60000;
  const win = { start: new Date(startMs).toISOString(), end: new Date(Date.now() + 20 * 3600000).toISOString() };
  seedCanonical(w.sqlite, { ...win, ...over });
  const stayId = await seedStay(w.db, { ...win, ...over });
  return { ...w, stayId, ...win, stayDay: istDay(startMs) };
}

test("BRD-05 acceptance: only the assigned host, only while awaiting, and only once", async () => {
  const { db, sqlite, stayId } = await activeWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const act = (over = {}) => attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "accept", actorId: HOST, idempotencyKey: `brd-accept-${Math.random()}`, ...over,
  }));

  const accepted = await act({ idempotencyKey: "brd-accept-1" });
  assert.equal(accepted.ok, true, `the assigned host must be able to accept: ${String(accepted.body ?? "").slice(0, 200)}`);
  assert.equal(sqlite.prepare("SELECT status FROM boarding_stays WHERE id=?").get(stayId).status, "confirmed");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned",
    "accepting must move the canonical booking too, not just the stay");

  // Replaying the SAME key is the same action, not a second one.
  const replay = await act({ idempotencyKey: "brd-accept-1" });
  assert.equal(replay.ok, true);
  assert.equal(replay.value.duplicatePrevented, true, "a replayed idempotency key must not re-accept");

  // A fresh key on an already-confirmed stay is a real second attempt and must be refused.
  const twice = await act();
  assert.equal(twice.ok, false, "an already-accepted stay must not be accepted again");
  assert.match(String(twice.body ?? ""), /not awaiting host acceptance/i);

  // One key belongs to one action on one record.
  const crossed = await attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "check_in", actorId: HOST, idempotencyKey: "brd-accept-1",
  }));
  assert.equal(crossed.ok, false, "an idempotency key must not be reusable for a different action");
  stage("Host acceptance", "PASS", "assigned host accepts once; replay deduplicated, re-accept and key reuse refused");
});

test("BRD-06 care plan: a stay cannot be made ready without an emergency contact and a vet", async () => {
  const { db, sqlite, stayId } = await activeWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const plan = (carePlan, key) => attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "submit_care_plan", actorId: CUSTOMER, idempotencyKey: key, carePlan,
  }));

  const noVet = await plan({ emergencyContact: "9800000111" }, "brd-plan-1");
  assert.equal(noVet.ok, false, "a care plan without a vet must be refused");
  assert.match(String(noVet.body ?? ""), /emergency contact and vet/i);

  const noContact = await plan({ vet: "Cessna Lifeline" }, "brd-plan-2");
  assert.equal(noContact.ok, false, "a care plan without an emergency contact must be refused");
  assert.equal(sqlite.prepare("SELECT care_plan_status FROM boarding_stays WHERE id=?").get(stayId).care_plan_status,
    "required", "a refused care plan must leave the stay still requiring one");

  const good = await plan({
    emergencyContact: "9800000111", vet: "Cessna Lifeline", feeding: "twice daily",
    medication: "none", specialInstructions: "afraid of thunder",
  }, "brd-plan-3");
  assert.equal(good.ok, true, `a complete care plan must be accepted: ${String(good.body ?? "").slice(0, 160)}`);
  assert.equal(sqlite.prepare("SELECT care_plan_status FROM boarding_stays WHERE id=?").get(stayId).care_plan_status, "ready");
  const snap = sqlite.prepare("SELECT plan_json,status FROM boarding_care_plan_snapshots WHERE stay_id=?").get(stayId);
  assert.equal(snap.status, "ready");
  assert.match(String(snap.plan_json), /afraid of thunder/, "the plan the customer wrote must be what is stored");
  stage("Care plan", "PASS", "vet and emergency contact both mandatory; a complete plan stores verbatim and marks ready");
});

test("BRD-07 check-in: needs host acceptance, a ready care plan, and any 50/50 balance settled", async () => {
  const { db, sqlite, stayId } = await activeWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const split = await import("../lib/stay-split-payments.ts");
  const checkIn = (key) => attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "check_in", actorId: HOST, idempotencyKey: key,
  }));

  const beforeAccept = await checkIn("brd-in-1");
  assert.equal(beforeAccept.ok, false);
  assert.match(String(beforeAccept.body ?? ""), /host acceptance is required/i);

  await life.mutateBoardingStay(db, { stayId, action: "accept", actorId: HOST, idempotencyKey: "brd-in-accept" });
  const noPlan = await checkIn("brd-in-2");
  assert.equal(noPlan.ok, false);
  assert.match(String(noPlan.body ?? ""), /ready care plan is required/i);

  await life.mutateBoardingStay(db, {
    stayId, action: "submit_care_plan", actorId: CUSTOMER, idempotencyKey: "brd-in-plan",
    carePlan: { emergencyContact: "9800000111", vet: "Cessna Lifeline" },
  });

  /* The money gate: an unpaid 50/50 balance must stop the handover. This is the one that protects
   * the business - the pet is about to be dropped off and half the fee is still outstanding. */
  await split.ensureStayPaymentTables(db);
  await split.staySplitScheduleStatement(db, {
    bookingId: BOOKING, serviceCode: "boarding", customerId: CUSTOMER, totalAmount: 2796,
    paidNowAmount: 1398, balanceAmount: 1398, balanceDueAt: Date.now() + 3600000, status: "pending_balance",
  }).run();
  const unpaid = await checkIn("brd-in-3");
  assert.equal(unpaid.ok, false, "an unpaid stay balance must block check-in");
  assert.match(String(unpaid.body ?? ""), /balance must be paid before check-in/i);

  const paid = await attempt(() => split.payStayBalance(db, {
    bookingId: BOOKING, actorId: CUSTOMER, idempotencyKey: "brd-balance-1",
  }));
  assert.equal(paid.ok, true, `the balance must be payable: ${String(paid.body ?? "").slice(0, 160)}`);
  assert.equal(paid.value.schedule.status, "paid");

  const replay = await attempt(() => split.payStayBalance(db, {
    bookingId: BOOKING, actorId: CUSTOMER, idempotencyKey: "brd-balance-1",
  }));
  assert.equal(replay.ok, true);
  assert.equal(replay.value.duplicatePrevented, true, "a replayed balance payment must not charge twice");

  const done = await checkIn("brd-in-4");
  assert.equal(done.ok, true, `check-in must succeed once every gate is satisfied: ${String(done.body ?? "").slice(0, 200)}`);
  const row = sqlite.prepare("SELECT status,check_in_status FROM boarding_stays WHERE id=?").get(stayId);
  assert.equal(row.status, "in_progress");
  assert.equal(row.check_in_status, "complete");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "in_progress");
  stage("Check-in", "PASS", "refused without acceptance, without a care plan and with an unpaid balance; accepted once all three clear");
});

// --- 4. DAILY PROOF: the media chain -----------------------------------------
/** Drive a stay to in_progress through the real lifecycle, then return its ids. */
async function checkedInWorld() {
  const w = await activeWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  await life.mutateBoardingStay(w.db, { stayId: w.stayId, action: "accept", actorId: HOST, idempotencyKey: `a-${w.stayId}` });
  await life.mutateBoardingStay(w.db, {
    stayId: w.stayId, action: "submit_care_plan", actorId: CUSTOMER, idempotencyKey: `p-${w.stayId}`,
    carePlan: { emergencyContact: "9800000111", vet: "Cessna Lifeline" },
  });
  await life.mutateBoardingStay(w.db, { stayId: w.stayId, action: "check_in", actorId: HOST, idempotencyKey: `i-${w.stayId}` });
  return w;
}

const SHA = "a".repeat(64);

/** The commercial term Finance approves per service; without it completion has no payout basis. */
async function seedCommercialTerm(db) {
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const now = Date.now();
  await db.prepare("INSERT OR REPLACE INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('BRD-TERM-1','boarding',NULL,1,'active','commission_standard',0.70,'provider_gst_on_behalf',0.18,0,0,0,12,'2026-04-01','boarding vertical execution test','ops','finance','APR-1',?,?)")
    .bind(now, now).run();
}
let mediaSeq = 0;

/** prepare -> sandbox finalize -> scan clean, by the real module, returning the media ref. */
async function cleanMedia(db, stayId, proof, purpose = "stay_update", scanBy = "ops@pawspace.test") {
  const key = () => `brd-media-${++mediaSeq}`;
  const prepared = await proof.mutateBoardingProof(db, {
    stayId, action: "prepare_media", actorId: HOST, idempotencyKey: key(),
    purpose, mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA,
  });
  await proof.mutateBoardingProof(db, {
    stayId, action: "sandbox_finalize_media", actorId: HOST, idempotencyKey: key(),
    uploadToken: prepared.upload.token, storageObjectId: `boarding/${prepared.mediaId}.jpg`,
  });
  await proof.mutateBoardingProof(db, {
    stayId, action: "record_media_scan", actorId: scanBy, idempotencyKey: key(),
    mediaRef: prepared.mediaRef, scanResult: "clean",
  });
  return prepared;
}

test("BRD-08 proof: media must be prepared, uploaded, and scanned by someone other than the uploader", async () => {
  const { db, sqlite, stayId } = await checkedInWorld();
  const proof = await import("../lib/boarding-proof-governance.ts");
  const call = (over) => attempt(() => proof.mutateBoardingProof(db, {
    stayId, actorId: HOST, idempotencyKey: `brd-p-${Math.random()}`, ...over,
  }));

  // The adapter refuses evidence it cannot stand behind.
  const badMime = await call({ action: "prepare_media", purpose: "stay_update", mimeType: "application/pdf", sizeBytes: 2048, sha256: SHA });
  assert.equal(badMime.ok, false, "a PDF is not photo or video proof");
  const noHash = await call({ action: "prepare_media", purpose: "stay_update", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "nope" });
  assert.equal(noHash.ok, false, "proof without a real SHA-256 must be refused");
  const tooBig = await call({ action: "prepare_media", purpose: "stay_update", mimeType: "image/jpeg", sizeBytes: 20_000_000, sha256: SHA });
  assert.equal(tooBig.ok, false, "a 20 MB image exceeds the 10 MB image ceiling");

  const prepared = await call({ action: "prepare_media", purpose: "stay_update", mimeType: "image/jpeg", sizeBytes: 2048, sha256: SHA });
  assert.equal(prepared.ok, true, `a valid proof request must be granted: ${String(prepared.body ?? "").slice(0, 160)}`);
  assert.equal(prepared.value.scanStatus, "pending");
  assert.equal(prepared.value.proofReady, false, "nothing is proof until it has been uploaded and scanned");
  assert.equal(prepared.value.upload.adapterConnected, false, "the sandbox contract must not claim a live storage adapter");

  // The storage confirmation must be an opaque object id, never a public URL.
  const publicUrl = await call({
    action: "sandbox_finalize_media", uploadToken: prepared.value.upload.token,
    storageObjectId: "https://cdn.example.test/leak.jpg",
  });
  assert.equal(publicUrl.ok, false, "a public URL must not be accepted as a storage confirmation");

  const finalized = await call({
    action: "sandbox_finalize_media", uploadToken: prepared.value.upload.token,
    storageObjectId: `boarding/${prepared.value.mediaId}.jpg`,
  });
  assert.equal(finalized.ok, true, `the upload must finalize: ${String(finalized.body ?? "").slice(0, 160)}`);

  // Separation of duties: the host who uploaded the evidence cannot also clear it.
  const selfScan = await call({ action: "record_media_scan", mediaRef: prepared.value.mediaRef, scanResult: "clean" });
  assert.equal(selfScan.ok, false, "the uploader must not be able to pass their own media scan");

  const scanned = await call({
    action: "record_media_scan", actorId: "ops@pawspace.test",
    mediaRef: prepared.value.mediaRef, scanResult: "clean",
  });
  assert.equal(scanned.ok, true, `an independent scan must clear the media: ${String(scanned.body ?? "").slice(0, 160)}`);
  assert.equal(scanned.value.proofReady, true);
  const asset = sqlite.prepare("SELECT scan_status,access_status FROM service_media_assets WHERE id=?").get(prepared.value.mediaId);
  assert.equal(asset.scan_status, "clean");
  assert.equal(asset.access_status, "ready");
  stage("Daily proof media", "PASS", "mime/size/checksum refused; public URL refused; uploader cannot clear their own scan");
});

test("BRD-09 care events: milestones are typed and must fall inside the stay window", async () => {
  const { db, sqlite, stayId, stayDay } = await checkedInWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const care = (over) => attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "care_event", actorId: HOST, idempotencyKey: `brd-c-${Math.random()}`,
    detail: { stayDate: stayDay }, ...over,
  }));

  const meal = await care({ careEventType: "meal", detail: { stayDate: stayDay, note: "breakfast" } });
  assert.equal(meal.ok, true, `a meal must be loggable during an active stay: ${String(meal.body ?? "").slice(0, 160)}`);
  assert.equal(meal.value.stayDate, stayDay);

  const unknown = await care({ careEventType: "haircut" });
  assert.equal(unknown.ok, false, "an unrecognised care event must be refused, not stored as free text");

  const outside = await care({ careEventType: "meal", detail: { stayDate: "2020-01-01" } });
  assert.equal(outside.ok, false, "a milestone dated outside the stay window must be refused");
  assert.match(String(outside.body ?? ""), /valid stayDate within the stay window/i);

  /* LIKE 'care_%' also matches care_plan_ready - '_' is a single-character wildcard in SQL, so the
   * first version of this assertion counted the care-plan event as a milestone. Match exactly. */
  const events = sqlite.prepare("SELECT event_type FROM boarding_stay_events WHERE stay_id=? AND event_type IN ('care_meal','care_play','care_walk','care_medication','care_photo_update','care_video_update','care_general_update','care_incident')").all(stayId);
  assert.equal(events.length, 1, "only the one valid milestone may have been written");
  assert.equal(events[0].event_type, "care_meal");
  stage("Care events", "PASS", "typed vocabulary enforced; a date outside the stay window refused; only valid events stored");
});

// --- 5. CHECK-OUT ------------------------------------------------------------
test("BRD-10 check-out: blocked until every stay day has a meal, play and real media", async () => {
  const { db, sqlite, stayId, stayDay } = await checkedInWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const proof = await import("../lib/boarding-proof-governance.ts");
  await seedCommercialTerm(db);
  const out = (key) => attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "check_out", actorId: HOST, idempotencyKey: key,
  }));

  const nothing = await out("brd-out-1");
  assert.equal(nothing.ok, false, "a stay with no care record must not be checked out");
  assert.match(String(nothing.body ?? ""), /mandatory daily milestones are incomplete/i);
  assert.match(String(nothing.body ?? ""), new RegExp(`${stayDay}:meal`), "the refusal must name the day and what is missing");

  await life.mutateBoardingStay(db, {
    stayId, action: "care_event", actorId: HOST, idempotencyKey: "brd-out-meal",
    careEventType: "meal", detail: { stayDate: stayDay },
  });
  const onlyMeal = await out("brd-out-2");
  assert.equal(onlyMeal.ok, false, "a meal alone is not a complete day");
  assert.match(String(onlyMeal.body ?? ""), new RegExp(`${stayDay}:play`));
  assert.ok(!new RegExp(`${stayDay}:meal`).test(String(onlyMeal.body ?? "")), "the milestone already met must drop out of the refusal");

  await life.mutateBoardingStay(db, {
    stayId, action: "care_event", actorId: HOST, idempotencyKey: "brd-out-play",
    careEventType: "play", detail: { stayDate: stayDay },
  });
  const noMedia = await out("brd-out-3");
  assert.equal(noMedia.ok, false, "meal and play without photographic proof is still incomplete");
  assert.match(String(noMedia.body ?? ""), new RegExp(`${stayDay}:media`));

  // A daily update backed by scanned media completes the day.
  const media = await cleanMedia(db, stayId, proof);
  const update = await attempt(() => proof.mutateBoardingProof(db, {
    stayId, action: "record_daily_update", actorId: HOST, idempotencyKey: "brd-out-update",
    mediaRef: media.mediaRef, note: "Bruno ate well and played in the garden",
  }));
  assert.equal(update.ok, true, `the daily update must record: ${String(update.body ?? "").slice(0, 160)}`);

  const done = await out("brd-out-4");
  assert.equal(done.ok, true, `check-out must succeed once every milestone is met: ${String(done.body ?? "").slice(0, 220)}`);
  const row = sqlite.prepare("SELECT status,check_out_status FROM boarding_stays WHERE id=?").get(stayId);
  assert.equal(row.status, "completed");
  assert.equal(row.check_out_status, "complete");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "completed");
  const locks = sqlite.prepare("SELECT status FROM boarding_capacity_locks WHERE stay_id=?").all(stayId);
  assert.ok(locks.every((l) => l.status === "released"), "checking out must release the host's capacity for the next guest");
  stage("Check-out", "PASS", "refused naming each missing milestone; completes only with meal + play + scanned media; capacity released");
});

test("BRD-11 completion finance: a failed completion is retryable, and the retry balances without double-paying", async () => {
  /* Checking out is not just a status change - it accrues the host payout, the platform fee, GST and
   * TCS into the ledger. lib/service-completion-finance.ts refuses to complete a stay it has no
   * approved commercial basis to price, and refuses again if the entries it built do not balance
   * against the order value. Both refusals are the point of this stage. */
  const { db, sqlite, stayId, stayDay } = await checkedInWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const proof = await import("../lib/boarding-proof-governance.ts");

  for (const [type, key] of [["meal", "brd-cf-meal"], ["play", "brd-cf-play"]]) {
    await life.mutateBoardingStay(db, {
      stayId, action: "care_event", actorId: HOST, idempotencyKey: key,
      careEventType: type, detail: { stayDate: stayDay },
    });
  }
  const media = await cleanMedia(db, stayId, proof);
  await proof.mutateBoardingProof(db, {
    stayId, action: "record_daily_update", actorId: HOST, idempotencyKey: "brd-cf-update",
    mediaRef: media.mediaRef, note: "settled in well",
  });

  // Every care milestone is met, so the ONLY thing left to refuse on is the missing term.
  const unpriced = await attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "check_out", actorId: HOST, idempotencyKey: "brd-cf-out-1",
  }));
  assert.equal(unpriced.ok, false, "a stay with no approved commercial term must not complete");
  assert.match(String(unpriced.body ?? ""), /no active commercial term for service boarding/i,
    "the refusal must be the missing commercial term, not a leftover milestone");

  /* These two ARE correct and are pinned: a refused completion must not leave money behind. */
  const payouts = sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING)?.n ?? 0;
  assert.equal(payouts, 0, "a refused completion must not accrue a host payout");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM boarding_stay_events WHERE stay_id=? AND event_type='checked_out'").get(stayId).n, 0,
    "a refused completion must not log a checkout event");

  /* FIXED, and now asserted so it cannot regress.
   *
   * check_out used to write boarding_stays.status='completed' and canonical_bookings.status=
   * 'completed' and only THEN resolve finance. D1 has no interactive transactions, so any failure
   * in the finance step - a missing or expired commercial term, an unbalanced journal, an
   * unresolvable place of supply, a transient error - left both rows permanently `completed` with
   * no journal, no payout accrual and no checked_out event, the host's capacity lock still active,
   * and no way back: the retry answered "Only a checked-in active stay can be checked out".
   *
   * lib/boarding-stay-lifecycle.ts now resolves finance FIRST, so a finance failure is retryable. */
  assert.equal(sqlite.prepare("SELECT status FROM boarding_stays WHERE id=?").get(stayId).status, "in_progress",
    "a failed completion must leave the stay open, not half-closed");
  assert.equal(sqlite.prepare("SELECT check_out_status FROM boarding_stays WHERE id=?").get(stayId).check_out_status, "pending");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "in_progress",
    "a failed completion must not close the canonical booking either");

  await seedCommercialTerm(db);
  /* The operator configures the term and retries THE SAME stay - the recovery that was impossible
   * before. It must complete, and it must not pay the host twice for retrying. */
  const done = await attempt(() => life.mutateBoardingStay(db, {
    stayId, action: "check_out", actorId: HOST, idempotencyKey: "brd-cf-out-2",
  }));
  assert.equal(done.ok, true, `the same stay must complete on retry once priced: ${String(done.body ?? "").slice(0, 220)}`);
  assert.equal(sqlite.prepare("SELECT status FROM boarding_stays WHERE id=?").get(stayId).status, "completed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM provider_payout_computations WHERE booking_id=?").get(BOOKING).n, 1,
    "a retried completion must accrue ONE host payout, never two");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM boarding_stay_events WHERE stay_id=? AND event_type='checked_out'").get(stayId).n, 1);
  const lockAfter = sqlite.prepare("SELECT status FROM boarding_capacity_locks WHERE stay_id=?").all(stayId);
  assert.ok(lockAfter.every((l) => l.status === "released"), "the recovered completion must still free the host's capacity");

  const entries = sqlite.prepare("SELECT account_code,debit,credit,vertical FROM finance_journal_entries WHERE source_id=? AND source_type='service_completion'").all(BOOKING);
  assert.ok(entries.length >= 2, `completion must post a double-entry journal, got ${entries.length} entries`);
  assert.ok(entries.every((e) => e.vertical === "boarding"), "every completion entry must be attributed to boarding");
  const debits = entries.reduce((n, e) => n + Number(e.debit || 0), 0);
  const credits = entries.reduce((n, e) => n + Number(e.credit || 0), 0);
  assert.ok(Math.abs(debits - credits) < 0.01, `the completion journal must balance: debits ${debits} vs credits ${credits}`);
  stage("Completion finance", "PASS", `refused without a term and fully retryable; the retry posts ${entries.length} balanced entries at Rs ${debits.toFixed(2)} and exactly one payout`);
});

// --- 6. CANCELLATION + REFUND -----------------------------------------------
test("BRD-12 cancellation: a delivered or in-progress stay cannot be cancelled, and no one approves their own refund", async () => {
  const { db, sqlite, stayId } = await activeWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const fin = await import("../lib/boarding-finance-governance.ts");
  const call = (over) => attempt(() => fin.mutateBoardingFinance(db, {
    bookingId: BOOKING, actorId: "ops@pawspace.test", idempotencyKey: `brd-f-${Math.random()}`,
    reason: "customer travel plans changed", ...over,
  }));

  await life.mutateBoardingStay(db, { stayId, action: "accept", actorId: HOST, idempotencyKey: "brd-can-accept" });

  const requested = await call({ action: "request_cancel" });
  assert.equal(requested.ok, true, `a cancellation request must open: ${String(requested.body ?? "").slice(0, 160)}`);
  assert.equal(requested.value.status, "policy_review_required");
  assert.equal(requested.value.bookingPreserved, true, "requesting must not itself cancel anything");
  assert.equal(sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status, "assigned",
    "a request is a request; the booking must not move until someone decides");

  // Segregation of duties: the person who asked cannot be the person who approves.
  const selfApprove = await call({ action: "approve_cancel", actorId: "ops@pawspace.test", approvedRefundAmount: 100 });
  assert.equal(selfApprove.ok, false, "the requester must not approve their own refund");
  assert.match(String(selfApprove.body ?? ""), /segregation of duties/i);

  // An in-progress stay is an Operations incident, not an automatic cancellation.
  await life.mutateBoardingStay(db, {
    stayId, action: "submit_care_plan", actorId: CUSTOMER, idempotencyKey: "brd-can-plan",
    carePlan: { emergencyContact: "9800000111", vet: "Cessna Lifeline" },
  });
  await life.mutateBoardingStay(db, { stayId, action: "check_in", actorId: HOST, idempotencyKey: "brd-can-in" });
  const inProgress = await call({ action: "approve_cancel", actorId: "finance@pawspace.test", approvedRefundAmount: 100 });
  assert.equal(inProgress.ok, false, "a stay with the pet already in the host's home must not auto-cancel");
  assert.match(String(inProgress.body ?? ""), /Operations incident workflow/i);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM boarding_refund_ledger WHERE booking_id=?").get(BOOKING).n, 0,
    "a refused approval must not write a refund");
  stage("Cancellation governance", "PASS", "request preserves the booking; requester cannot approve; an in-progress stay is refused to Operations");
});

test("BRD-13 refund: capped by money actually collected, counting refunds already approved, and decided once", async () => {
  /* The comment in lib/boarding-finance-governance.ts records the defect this guards: the ceiling
   * was applied per approval, so N open requests approved N full refunds and moved 200% of the money
   * collected out of the company. The ceiling is the BOOKING's remaining headroom. */
  const { db, sqlite, stayId } = await activeWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const fin = await import("../lib/boarding-finance-governance.ts");
  await life.mutateBoardingStay(db, { stayId, action: "accept", actorId: HOST, idempotencyKey: "brd-rf-accept" });
  const call = (over) => attempt(() => fin.mutateBoardingFinance(db, {
    bookingId: BOOKING, idempotencyKey: `brd-r-${Math.random()}`, reason: "customer cancelled the stay", ...over,
  }));

  const req1 = await call({ action: "request_cancel", actorId: CUSTOMER });
  assert.equal(req1.ok, true);

  // Rs 1398 was captured. More than that must be refused outright.
  const overCap = await call({ action: "approve_cancel", actorId: "finance@pawspace.test", approvedRefundAmount: 5000 });
  assert.equal(overCap.ok, false, "a refund may never exceed the money actually collected");
  assert.match(String(overCap.body ?? ""), /cannot exceed the amount actually collected/i);
  assert.match(String(overCap.body ?? ""), /1398/, "the refusal must name the real ceiling");

  const partial = await call({ action: "approve_cancel", actorId: "finance@pawspace.test", approvedRefundAmount: 1000 });
  assert.equal(partial.ok, true, `a refund within the cap must be approved: ${String(partial.body ?? "").slice(0, 160)}`);
  const ledger = sqlite.prepare("SELECT amount,status,policy_source FROM boarding_refund_ledger WHERE booking_id=?").all(BOOKING);
  assert.equal(ledger.length, 1);
  assert.equal(Number(ledger[0].amount), 1000);
  assert.equal(ledger[0].status, "sandbox_pending", "no live money may move from a test approval");
  assert.equal(sqlite.prepare("SELECT status FROM boarding_stays WHERE id=?").get(stayId).status, "cancelled");
  const locks = sqlite.prepare("SELECT status FROM boarding_capacity_locks WHERE stay_id=?").all(stayId);
  assert.ok(locks.every((l) => l.status === "released"), "cancelling must free the host's capacity");

  /* A SECOND request on the same booking must only be able to reach the REMAINING headroom.
   * Rs 1398 collected minus Rs 1000 already approved leaves Rs 398. */
  sqlite.prepare("UPDATE canonical_bookings SET status='assigned' WHERE id=?").run(BOOKING);
  sqlite.prepare("UPDATE boarding_stays SET status='confirmed' WHERE id=?").run(stayId);
  await call({ action: "request_cancel", actorId: CUSTOMER });
  const secondFull = await call({ action: "approve_cancel", actorId: "finance@pawspace.test", approvedRefundAmount: 1398 });
  assert.equal(secondFull.ok, false, "a second approval must not be able to refund the full amount again");
  assert.match(String(secondFull.body ?? ""), /398/, "the ceiling must now be the REMAINING headroom, not the original capture");
  const total = sqlite.prepare("SELECT COALESCE(SUM(amount),0) t FROM boarding_refund_ledger WHERE booking_id=?").get(BOOKING).t;
  assert.ok(Number(total) <= 1398, `total refunds ${total} must never exceed the Rs 1398 collected`);
  stage("Refund ceiling", "PASS", `capped at collected Rs 1398; after approving Rs 1000 the ceiling drops to Rs 398; total never exceeds capture`);
});

// --- 7. HOST SETTLEMENT ------------------------------------------------------
test("BRD-14 settlement: prepared only after checkout, and it asserts no payout it has no rule for", async () => {
  const { db, sqlite, stayId, stayDay } = await checkedInWorld();
  const life = await import("../lib/boarding-stay-lifecycle.ts");
  const proof = await import("../lib/boarding-proof-governance.ts");
  const fin = await import("../lib/boarding-finance-governance.ts");
  await seedCommercialTerm(db);
  const settle = (key) => attempt(() => fin.mutateBoardingFinance(db, {
    bookingId: BOOKING, action: "prepare_settlement", actorId: "finance@pawspace.test",
    idempotencyKey: key, reason: "host settlement preparation",
  }));

  const early = await settle("brd-st-1");
  assert.equal(early.ok, false, "a host cannot be settled for a stay that has not finished");
  assert.match(String(early.body ?? ""), /only after canonical checkout/i);

  for (const [type, key] of [["meal", "brd-st-meal"], ["play", "brd-st-play"]]) {
    await life.mutateBoardingStay(db, {
      stayId, action: "care_event", actorId: HOST, idempotencyKey: key,
      careEventType: type, detail: { stayDate: stayDay },
    });
  }
  const media = await cleanMedia(db, stayId, proof);
  await proof.mutateBoardingProof(db, {
    stayId, action: "record_daily_update", actorId: HOST, idempotencyKey: "brd-st-update",
    mediaRef: media.mediaRef, note: "good stay",
  });
  await life.mutateBoardingStay(db, { stayId, action: "check_out", actorId: HOST, idempotencyKey: "brd-st-out" });

  const prepared = await settle("brd-st-2");
  assert.equal(prepared.ok, true, `settlement must prepare after checkout: ${String(prepared.body ?? "").slice(0, 160)}`);
  const row = sqlite.prepare("SELECT provider_id,gross_booking_value,payout_amount,payout_rule_status,tax_status,approval_status,payout_status FROM boarding_host_settlement_ledger WHERE booking_id=?").get(BOOKING);
  assert.ok(row, "a settlement row must exist for the completed stay");
  assert.equal(row.provider_id, HOST, "the settlement must name the host who actually did the stay");

  /* The point of this stage: preparing a settlement is NOT deciding one. Until a payout rule and a
   * tax treatment are configured, the ledger must hold no amount and instruct no payment. */
  assert.equal(row.payout_amount, null, "no payout amount may be asserted before a payout rule exists");
  assert.equal(row.payout_rule_status, "rule_pending");
  assert.equal(row.tax_status, "configuration_required");
  assert.equal(row.approval_status, "not_ready");
  assert.equal(row.payout_status, "not_instructed", "nothing may be instructed for payment from a prepare step");

  const again = await settle("brd-st-3");
  assert.equal(again.ok, true, "preparing twice is idempotent on the booking, not a second obligation");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM boarding_host_settlement_ledger WHERE booking_id=?").get(BOOKING).n, 1,
    "one booking must never carry two settlement obligations");
  stage("Host settlement", "PASS", "refused before checkout; after it, one row per booking asserting no amount and instructing no payment");
});

// --- 8. REVIEW + TRUST -------------------------------------------------------
test("BRD-15 review: only the customer whose completed stay it was, and the host score follows the reviews", async () => {
  const { db, sqlite } = await activeWorld();
  const reviews = await import("../lib/host-reviews.ts");
  await reviews.ensureHostReviewsTables(db);
  const review = (over = {}) => attempt(() => reviews.submitHostReview(db, {
    hostProviderId: HOST, customerId: CUSTOMER, bookingId: BOOKING, rating: 5,
    title: "Wonderful host", body: "Bruno came home happy and well looked after all week.", ...over,
  }));

  const early = await review();
  assert.equal(early.ok, false, "a stay that is not finished cannot be reviewed");
  assert.match(String(early.body ?? ""), /only completed bookings can be reviewed/i);

  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(BOOKING);

  const notMine = await review({ customerId: "BRD-CUS-OTHER" });
  assert.equal(notMine.ok, false, "a customer must not review someone else's stay");
  const wrongHost = await review({ hostProviderId: OTHER_HOST });
  assert.equal(wrongHost.ok, false, "a review must attach to the host who actually did the stay");
  for (const rating of [0, 6, 3.5]) {
    const bad = await review({ rating });
    assert.equal(bad.ok, false, `${rating} stars must be refused`);
  }
  const thin = await review({ body: "good" });
  assert.equal(thin.ok, false, "a review body must carry enough substance to be useful");

  const good = await review();
  assert.equal(good.ok, true, `the customer whose stay it was must be able to review: ${String(good.body ?? "").slice(0, 160)}`);
  const twice = await review({ rating: 1, title: "Changed my mind", body: "Actually it was not good at all, sorry." });
  assert.equal(twice.ok, false, "one completed stay is one review");

  const listed = await attempt(() => reviews.listHostReviews(db, HOST, {}));
  assert.equal(listed.ok, true);
  assert.equal(listed.value.reviews.length, 1);
  assert.equal(listed.value.stats.avgRating, 5, "the published host score must be the real average of real reviews");
  assert.equal(listed.value.stats.totalReviews, 1, "the published count must be the real number of reviews");
  assert.equal(listed.value.stats.ratingHistogram[5], 1, "the histogram must reflect the review that was actually left");
  stage("Review + trust", "PASS", "pre-completion, wrong customer, wrong host, bad rating, thin body and re-review all refused; score is the real average");
});

// --- 9. GST + FILING ---------------------------------------------------------
test("BRD-16 GST: a boarding invoice fails closed with no tax policy, and issues once with one", async () => {
  const { db, sqlite } = await activeWorld();
  const inv = await import("../lib/boarding-invoice.ts");
  await inv.ensureBoardingInvoiceTables(db);
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(BOOKING);
  const issue = (key = "service completed") => attempt(() => inv.issueBoardingInvoice(db, {
    bookingId: BOOKING, reason: key, actorId: "finance@pawspace.test",
  }));

  const unconfigured = await issue("boarding vertical execution test");
  assert.equal(unconfigured.ok, false, "issuing a tax invoice with no policy would fabricate a GST rate");
  assert.equal(unconfigured.status, 409, "the refusal must be the governed 409, not an incidental crash");
  assert.match(String(unconfigured.body ?? ""), /blocked until a published tax policy is configured/i,
    "the refusal must name the missing tax policy - any other failure means the guard is not what stopped it");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_invoices WHERE booking_id=?").get(BOOKING).n, 0,
    "no invoice row may exist after a refused issue");

  const saved = await attempt(() => inv.saveBoardingTaxPolicy(db, {
    cityId: CITY, taxMode: "exclusive", taxRate: 18, effectiveFrom: "2026-04-01",
    actorId: "finance@pawspace.test", reason: "boarding vertical execution test",
  }));
  assert.equal(saved.ok, true, `a tax policy must be publishable: ${String(saved.body ?? "").slice(0, 160)}`);

  const issued = await issue();
  assert.equal(issued.ok, true, `an invoice must issue once the policy exists: ${String(issued.body ?? "").slice(0, 200)}`);
  assert.match(String(issued.value.invoiceNumber), /^BRD-|BLR/, `invoice number must be city and FY scoped: ${issued.value.invoiceNumber}`);

  const duplicate = await issue();
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.value.duplicatePrevented, true, "one booking is one invoice; a second issue must not mint a new number");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM booking_invoices WHERE booking_id=?").get(BOOKING).n, 1);
  stage("GST invoice", "PASS", `fails closed with no policy; issues ${issued.value.invoiceNumber} once, duplicate prevented`);
});

test("BRD-17 filing: host settlements carry 194H TDS at the governed FY threshold and rate", async () => {
  /* Boarding host settlements reach TDS through boarding_host_settlement_ledger, a different source
   * table from the commission payouts a groomer is paid through, so it is proved separately here. */
  const { db, sqlite } = await activeWorld();
  const tds = await import("../lib/tds-governance.ts");
  await tds.ensureTdsTables(db);
  const fin = await import("../lib/boarding-finance-governance.ts");
  await fin.ensureBoardingFinanceTables(db);
  const period = new Date().toISOString().slice(0, 7);
  const settlement = (bookingId, amount) => sqlite.prepare("INSERT OR REPLACE INTO boarding_host_settlement_ledger (booking_id,stay_id,provider_id,gross_booking_value,currency,payout_amount,payout_rule_status,tax_status,approval_status,payout_status,eligible_at,created_at,updated_at) VALUES (?,?,?,?,'INR',?,'rule_applied','resolved','approved','not_instructed',?,?,?)")
    .run(bookingId, `S-${bookingId}`, HOST, amount, amount, Date.now(), Date.now(), Date.now());

  // Below the Rs 20,000 FY commission threshold: nothing may be deducted.
  settlement("BRD-BK-S1", 15000);
  const below = await attempt(() => tds.computeMonthlyTds(db, { period, actorId: "finance@pawspace.test" }));
  assert.equal(below.ok, true, `TDS computation must run: ${String(below.body ?? "").slice(0, 200)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tds_deductions WHERE period=?").get(period).n, 0,
    "no TDS may be deducted before the FY commission threshold is crossed");

  // Crossing it taxes the whole untaxed FY cumulative at 2%.
  settlement("BRD-BK-S2", 10000);
  const over = await attempt(() => tds.computeMonthlyTds(db, { period, actorId: "finance@pawspace.test" }));
  assert.equal(over.ok, true, `TDS recomputation must run: ${String(over.body ?? "").slice(0, 200)}`);
  const rows = sqlite.prepare("SELECT section,deductee_id,base_amount,rate_pct,tds_amount FROM tds_deductions WHERE period=?").all(period);
  assert.equal(rows.length, 1, "one 194H deduction row for the boarding host");
  assert.equal(rows[0].section, "194H", "a boarding host settlement is commission, deducted under 194H");
  assert.equal(rows[0].deductee_id, HOST);
  assert.equal(Number(rows[0].base_amount), 25000, "the base is the full untaxed FY cumulative at first crossing");
  assert.equal(Number(rows[0].rate_pct), 2);
  assert.equal(Number(rows[0].tds_amount), 500, "2% of 25,000 is 500");
  stage("Filing (194H)", "PASS", `nil below Rs 20,000 FY, then Rs 500 on Rs 25,000 at 2% against ${HOST}`);
});

// --- SCOPE REPORT -----------------------------------------------------------
test("BRD-99 boarding vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== BOARDING VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
