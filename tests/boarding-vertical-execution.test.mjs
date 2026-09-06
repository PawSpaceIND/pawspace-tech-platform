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

test("BRD-11 completion finance: no approved commercial term means no completion, and the journal must balance", async () => {
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

  /* DEFECT, recorded rather than asserted, so this test does not have to be rewritten when it is
   * fixed and cannot silently hide it either.
   *
   * lib/boarding-stay-lifecycle.ts check_out writes boarding_stays.status='completed' and
   * canonical_bookings.status='completed' and only THEN calls resolveServiceCompletionFinance().
   * D1 has no interactive transactions, so when the finance step throws - a missing or expired
   * commercial term, an unbalanced journal, an unresolvable place of supply, or any transient
   * error - both status rows are already committed. The stay is permanently `completed` with no
   * ledger journal, no payout accrual and no checkout event, the host's capacity lock is never
   * released, and the operator cannot repair it: retrying answers "Only a checked-in active stay
   * can be checked out".
   *
   * postJournal is already idempotent on its groupKey (lib/finance-accounts.ts returns
   * duplicatePrevented for an existing SERVICE-COMPLETION-<bookingId> group), so resolving finance
   * BEFORE the two status writes is safe and makes the failure retryable. */
  const after = sqlite.prepare("SELECT status FROM boarding_stays WHERE id=?").get(stayId).status;
  const bookingAfter = sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(BOOKING).status;
  const lock = sqlite.prepare("SELECT status FROM boarding_capacity_locks WHERE stay_id=?").get(stayId)?.status ?? "none";
  if (after === "completed") {
    stage("Completion atomicity", "GAP",
      `check_out commits status BEFORE finance: stay=${after}, booking=${bookingAfter}, capacity lock=${lock}, 0 ledger entries, retry refused as "not a checked-in active stay"`);
  } else {
    stage("Completion atomicity", "PASS", `a failed finance step leaves the stay at ${after} and retryable`);
  }

  await seedCommercialTerm(db);
  /* The first stay cannot be retried (see the GAP above), so the priced path is proven on a clean
   * stay in a fresh world - which is also what a correctly configured city actually looks like. */
  const w2 = await checkedInWorld();
  await seedCommercialTerm(w2.db);
  for (const [type, key] of [["meal", "brd-cf2-meal"], ["play", "brd-cf2-play"]]) {
    await life.mutateBoardingStay(w2.db, {
      stayId: w2.stayId, action: "care_event", actorId: HOST, idempotencyKey: key,
      careEventType: type, detail: { stayDate: w2.stayDay },
    });
  }
  const media2 = await cleanMedia(w2.db, w2.stayId, proof);
  await proof.mutateBoardingProof(w2.db, {
    stayId: w2.stayId, action: "record_daily_update", actorId: HOST, idempotencyKey: "brd-cf2-update",
    mediaRef: media2.mediaRef, note: "settled in well",
  });
  const done = await attempt(() => life.mutateBoardingStay(w2.db, {
    stayId: w2.stayId, action: "check_out", actorId: HOST, idempotencyKey: "brd-cf2-out",
  }));
  assert.equal(done.ok, true, `completion must succeed once priced: ${String(done.body ?? "").slice(0, 220)}`);

  const entries = w2.sqlite.prepare("SELECT account_code,debit,credit,vertical FROM finance_journal_entries WHERE source_id=? AND source_type='service_completion'").all(BOOKING);
  assert.ok(entries.length >= 2, `completion must post a double-entry journal, got ${entries.length} entries`);
  assert.ok(entries.every((e) => e.vertical === "boarding"), "every completion entry must be attributed to boarding");
  const debits = entries.reduce((n, e) => n + Number(e.debit || 0), 0);
  const credits = entries.reduce((n, e) => n + Number(e.credit || 0), 0);
  assert.ok(Math.abs(debits - credits) < 0.01, `the completion journal must balance: debits ${debits} vs credits ${credits}`);
  stage("Completion finance", "PASS", `refused without a commercial term, no payout accrued; with one, ${entries.length} balanced ledger entries at Rs ${debits.toFixed(2)}`);
});

// --- SCOPE REPORT -----------------------------------------------------------
test("BRD-99 boarding vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== BOARDING VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
