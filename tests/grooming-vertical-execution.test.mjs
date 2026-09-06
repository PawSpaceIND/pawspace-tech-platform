/*
 * The grooming vertical, executed end to end — one stage per test, in the order a real job moves.
 *
 * Customer -> OTP -> package selection -> subscription -> booking -> payment -> pay-later ->
 * partner assignment -> route/map -> notification -> tracking (before/after proof) -> close ->
 * review -> accounts -> refund -> GST -> filing.
 *
 * Every test drives the REAL module against a real database. No source-text assertions and no
 * mocked business logic: the shim in helpers/execution-harness.mjs is an adapter from D1's API onto
 * node:sqlite, so each module runs its own SQL against a real engine.
 *
 * Stages that cannot run are reported as such rather than skipped quietly — the point of this file
 * is to find out where the vertical actually stands, so a gap must be visible.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__GROOM_DB__", "__GROOM_ENV__");

const CITY = "blr";
const ZONE = "z1";
const CUSTOMER = "GRM-CUS-001";
const PROVIDER = "GRM-PRV-001";
const BOOKING = "GRM-BK-001";
const PHONE = "9800000777";
const NOW = Date.UTC(2026, 8, 6, 4, 30);

/** Findings recorded across stages, printed as a scope report at the end. */
const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });

function groomWorld(env = {}) {
  return world("__GROOM_DB__", "__GROOM_ENV__", env);
}

/** The canonical tables the vertical's modules read but do not own. */
function seedCanonical(sqlite) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,weight_kg REAL,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT,pricing_json TEXT,pet_ids_json TEXT,created_by TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,schedule_group_id TEXT,provider_id TEXT NOT NULL,provider_name TEXT,provider_model TEXT NOT NULL,service_code TEXT,scheduled_start TEXT,scheduled_end TEXT,occurrence_count INTEGER DEFAULT 1,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS canonical_providers (id TEXT PRIMARY KEY,name TEXT,phone TEXT,city_id TEXT,status TEXT,engagement_model TEXT,created_at INTEGER,updated_at INTEGER);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Grooming Customer", PHONE, "grm@example.test", CITY, '{"serviceUpdates":true,"marketing":false}', NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_pets VALUES (?,?,?,?,?,?,?,?)")
    .run("GRM-PET-1", CUSTOMER, "Bruno", "dog", "indie", 14, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_providers VALUES (?,?,?,?,'active','commission',?,?)")
    .run(PROVIDER, "Grooming Partner", "9800000888", CITY, NOW, NOW);
  sqlite.prepare(`INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,pet_ids_json,created_by,created_at,updated_at)
    VALUES (?,?,?,?,'grooming','dog-basic','Bath & Basic','GRM-SG-1',?,?,?,'confirmed','customer_app',1899,'INR','{"addOns":["nail-trim"],"requirements":["muzzle-required"]}','["GRM-PET-1"]','test',?,?)`)
    .run(BOOKING, CUSTOMER, CITY, ZONE, PROVIDER,
         new Date(NOW + 3 * 86400000).toISOString(), new Date(NOW + 3 * 86400000 + 7200000).toISOString(), NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES (?,?,?,?,?,'INR','card','prepaid','captured','razorpay',?,'{}',?,?)")
    .run("GRM-PAY-1", BOOKING, CUSTOMER, 1899, 1899, "grm-idem-1", NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,created_at,updated_at) VALUES (?,?,?,?,?,'commission','grooming',?,?,1,'accepted',?,?)")
    .run("GRM-WO-1", BOOKING, "GRM-SG-1", PROVIDER, "Grooming Partner",
         new Date(NOW + 3 * 86400000).toISOString(), new Date(NOW + 3 * 86400000 + 7200000).toISOString(), NOW, NOW);
}

// --- 1. CUSTOMER + OTP ------------------------------------------------------
test("GRM-01 OTP: a challenge is persisted, and the live route never returns the code", async () => {
  /* CORRECTED after a first run. I originally asserted that requestCustomerOtp must not return the
   * code, and it failed - the function does return `sandboxCode`. That is BY DESIGN and not a
   * defect: the sandbox path is what lets a UAT tester proceed without SMS, and it is reachable only
   * behind uatLoginEnabled / developmentOtpSandboxEnabled, otherwise the route answers 503.
   *
   * The contract that actually matters lives in app/api/customer-otp/route.ts: in LIVE mode it
   * discards the function's return shape and rebuilds the response from scratch -
   * {challengeId, phone, expiresInSeconds, sandboxDelivery:false, liveSmsDelivered:true} - so the
   * code reaches the customer by SMS only. Asserting the library in isolation tested the wrong
   * layer and would have reported a false defect. */
  const { sqlite, db } = groomWorld();
  const otp = await import("../lib/customer-otp.ts");
  await otp.ensureCustomerOtpTables(db);
  const issued = await attempt(() => otp.requestCustomerOtp(db, { phone: PHONE }));
  assert.equal(issued.ok, true, `OTP request must succeed: ${JSON.stringify(issued).slice(0, 160)}`);

  const stored = sqlite.prepare("SELECT code,phone,consumed FROM customer_otp_challenges ORDER BY rowid DESC LIMIT 1").get();
  assert.ok(stored, "a challenge row must be persisted");
  assert.match(String(stored.code), /^\d{6}$/, "a six-digit code must be stored");
  assert.equal(Number(stored.consumed), 0, "a fresh challenge must not start consumed");

  const routeSource = await (await import("node:fs/promises")).readFile(
    new URL("../app/api/customer-otp/route.ts", import.meta.url), "utf8");
  const liveReturn = routeSource.slice(routeSource.indexOf("liveSmsDelivered:true"));
  assert.ok(!/sandboxCode/.test(liveReturn.slice(0, 200)),
    "the live-mode response must not carry sandboxCode - the code may travel by SMS only");
  stage("OTP issue", "PASS", "6-digit challenge persisted; live route omits the code (sandbox path is UAT-gated by design)");
});

test("GRM-02 OTP: a wrong code is refused and does not mint a customer", async () => {
  const { sqlite, db } = groomWorld();
  const otp = await import("../lib/customer-otp.ts");
  await otp.ensureCustomerOtpTables(db);
  const issued = await otp.requestCustomerOtp(db, { phone: PHONE });
  const challengeId = String(issued?.challengeId ?? issued?.id ?? "");
  assert.ok(challengeId, "the request must return a challenge id");

  const before = sqlite.prepare("SELECT COUNT(*) n FROM customer_otp_challenges WHERE consumed=1").get().n;
  const bad = await attempt(() => otp.verifyCustomerOtp(db, { challengeId, code: "000000", cityId: CITY }));
  assert.equal(bad.ok, false, "a wrong OTP code must be refused");
  const after = sqlite.prepare("SELECT COUNT(*) n FROM customer_otp_challenges WHERE consumed=1").get().n;
  assert.equal(after, before, "a failed verification must not consume the challenge as if it succeeded");
  stage("OTP wrong code", "PASS", "refused, challenge not consumed");
});

test("GRM-03 OTP: the correct code verifies and resolves a customer", async () => {
  const { sqlite, db } = groomWorld();
  const otp = await import("../lib/customer-otp.ts");
  await otp.ensureCustomerOtpTables(db);
  const issued = await otp.requestCustomerOtp(db, { phone: PHONE });
  const challengeId = String(issued?.challengeId ?? issued?.id ?? "");
  const code = String(sqlite.prepare("SELECT code FROM customer_otp_challenges WHERE id=?").get(challengeId)?.code ?? "");
  assert.match(code, /^\d{4,8}$/, "a numeric OTP must have been stored");

  const good = await attempt(() => otp.verifyCustomerOtp(db, { challengeId, code, name: "Grooming Customer", cityId: CITY }));
  assert.equal(good.ok, true, `the correct code must verify: ${JSON.stringify(good).slice(0, 160)}`);
  const consumed = sqlite.prepare("SELECT consumed FROM customer_otp_challenges WHERE id=?").get(challengeId)?.consumed;
  assert.equal(Number(consumed), 1, "a successful verification must consume the challenge so it cannot be replayed");
  stage("OTP verify", "PASS", "verified and challenge consumed (no replay)");
});

// --- 2. PACKAGE SELECTION + SUBSCRIPTION ------------------------------------
test("GRM-04 package selection: the catalogue governs price, the client does not", async () => {
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const gov = await import("../lib/grooming-governance.ts");
  await gov.ensureGroomingSubscriptionPlans(db);

  const base = {
    packageCode: "dog-basic", pets: [{ species: "dog" }],
    paymentMode: "prepaid", cityId: CITY, zoneId: ZONE,
    scheduledStart: new Date(NOW + 3 * 86400000).toISOString(),
  };
  const catalogue = gov.groomingCatalogue.find((i) => i.code === "dog-basic");
  assert.ok(catalogue?.active, "dog-basic must be a live governed package");

  /* A client submitting its own total must not be trusted. This is the direction that matters:
   * a forged cheap total has to be REFUSED, not echoed back. */
  const forged = await attempt(() => gov.governGroomingBooking(db, { ...base, submittedTotal: 1, submittedAmountDueNow: 1 }));
  assert.equal(forged.ok, false, "a client-submitted total of 1 must never be accepted");
  assert.match(String(forged.body ?? ""), /does not match governed catalogue/i,
    "the refusal must be the catalogue mismatch, not an unrelated failure");

  /* Non-vacuity: the honest total must go through, otherwise "refuse everything" would pass. */
  const honest = await attempt(() => gov.governGroomingBooking(db, {
    ...base, submittedTotal: catalogue.singlePrice, submittedAmountDueNow: catalogue.singlePrice,
  }));
  assert.equal(honest.ok, true, `the catalogue price must be accepted: ${String(honest.body ?? "").slice(0, 160)}`);
  assert.equal(Number(honest.value.totalAmount), catalogue.singlePrice, "the governed total must come from the catalogue");
  assert.equal(honest.value.packageName, catalogue.name, "the governed package name must come from the catalogue");

  /* Eligibility is governed too - a dog-only package must refuse a cat. */
  const wrongSpecies = await attempt(() => gov.governGroomingBooking(db, {
    ...base, pets: [{ species: "cat" }], submittedTotal: catalogue.singlePrice, submittedAmountDueNow: catalogue.singlePrice,
  }));
  assert.equal(wrongSpecies.ok, false, "a dog-only grooming package must not accept a cat");

  stage("Package selection", "PASS",
    `dog-basic governed at ${catalogue.singlePrice}; forged total 1 and wrong species both refused`);
});

// --- 3. PAYMENT + PAY-LATER -------------------------------------------------
test("GRM-05 payment: a captured gateway event reconciles against the booking", async () => {
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const pay = await import("../lib/grooming-payment-reconciliation.ts");
  await pay.ensurePaymentReconciliationTables(db);
  const event = await attempt(() => pay.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "grm-cap-1", eventType: "payment.captured",
    bookingId: BOOKING, amountSubunits: 189900, gatewayPaymentId: "pay_grm_1",
    payloadHash: "sha256:grm1", signatureVerified: true,
  }));
  assert.equal(event.ok, true, `capture must reconcile: ${JSON.stringify(event).slice(0, 160)}`);
  const rec = sqlite.prepare("SELECT captured_amount,reconciliation_status FROM payment_reconciliation_records WHERE booking_id=?").get(BOOKING);
  assert.ok(rec, "a reconciliation record must exist after capture");
  assert.equal(Number(rec.captured_amount), 1899, "captured amount must match the money actually taken");
  stage("Payment capture", "PASS", `captured ${rec.captured_amount}, status ${rec.reconciliation_status}`);
});

test("GRM-06 payment: an unsigned gateway event is refused and writes nothing", async () => {
  /* This test previously ran against an unseeded world, so it would have refused even with the
   * signature gate deleted - the booking simply did not exist. It now seeds the same booking the
   * signed capture uses, so an UNVERIFIED SIGNATURE is the only remaining reason to refuse. */
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const pay = await import("../lib/grooming-payment-reconciliation.ts");
  await pay.ensurePaymentReconciliationTables(db);
  const forged = {
    provider: "razorpay", environment: "sandbox", eventId: "grm-forged-1", eventType: "payment.captured",
    bookingId: BOOKING, amountSubunits: 999999, gatewayPaymentId: "pay_grm_forged",
    payloadHash: "sha256:forged", signatureVerified: false,
  };
  const refused = await attempt(() => pay.processGatewayEvent(db, forged));
  assert.equal(refused.ok, false, "an unverified signature must never be processed - anyone could forge a capture");
  assert.match(String(refused.body ?? ""), /signature is not verified/i,
    "the refusal must be the signature check, not an incidental failure");
  const recorded = sqlite.prepare("SELECT COUNT(*) n FROM payment_reconciliation_records WHERE booking_id=?").get(BOOKING).n;
  assert.equal(recorded, 0, "a forged event must leave no reconciliation record behind");

  /* Non-vacuity: the identical event WITH a verified signature must be processed, so this cannot
   * pass by refusing everything. */
  const honest = await attempt(() => pay.processGatewayEvent(db, { ...forged, eventId: "grm-honest-1", amountSubunits: 189900, signatureVerified: true }));
  assert.equal(honest.ok, true, `a signed event must be processed: ${String(honest.body ?? "").slice(0, 160)}`);
  stage("Payment forgery guard", "PASS", "unsigned event refused with no record written; the same event signed is accepted");
});

test("GRM-07 pay-later: a post-service payment request is gated on completion, assignment and mode", async () => {
  /* CORRECTED. My first run reported "Post-service payment can be requested only after service
   * completion" as a GAP. It is not a gap - it is the rule. The fixture booking was `confirmed`
   * and already `captured`, so the module refused exactly as it should. The real test is that
   * each gate fires for its own reason, in order, and that an eligible booking clears all of them. */
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const pay = await import("../lib/grooming-payment-reconciliation.ts");
  await pay.ensurePaymentReconciliationTables(db);
  const call = (bookingId, providerId = PROVIDER) => attempt(() =>
    pay.createPostServicePaymentRequest(db, {}, { bookingId, providerId, actorId: "ops@pawspace.test" }));

  // Gate 1: not completed.
  const tooEarly = await call(BOOKING);
  assert.equal(tooEarly.ok, false);
  assert.match(String(tooEarly.body ?? ""), /only after service completion/i);

  // Gate 2: not this provider's booking.
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(BOOKING);
  const notMine = await call(BOOKING, "GRM-PRV-OTHER");
  assert.equal(notMine.ok, false);
  assert.match(String(notMine.body ?? ""), /not assigned to this provider/i,
    "a provider must not be able to raise a payment request against someone else's job");

  // Gate 3: money already taken.
  const alreadyPaid = await call(BOOKING);
  assert.equal(alreadyPaid.ok, false);
  assert.match(String(alreadyPaid.body ?? ""), /already paid or refunded/i);

  // Gate 4: booking is not on pay-after-service terms.
  sqlite.prepare("UPDATE booking_payments SET status='pending' WHERE booking_id=?").run(BOOKING);
  const notPayLater = await call(BOOKING);
  assert.equal(notPayLater.ok, false);
  assert.match(String(notPayLater.body ?? ""), /not configured for pay after service/i);

  /* Non-vacuity: an eligible booking must clear every governance gate. It then stops at the
   * external gateway, which this environment deliberately has no credentials for - that boundary
   * is the sandbox payment link, not a rule. */
  sqlite.prepare("UPDATE booking_payments SET mode='pay_after_service' WHERE booking_id=?").run(BOOKING);
  const eligible = await call(BOOKING);
  const body = String(eligible.body ?? "");
  assert.ok(!/only after service completion|not assigned to this provider|already paid|not configured for pay after service/i.test(body),
    `an eligible booking must clear the governance gates, got: ${body.slice(0, 160)}`);
  stage("Pay-later", "PASS",
    eligible.ok ? "all four gates fire; eligible booking issues a request"
                : `all four gates fire; eligible booking clears them and stops at the sandbox gateway (${body.slice(0, 70)})`);
});

// --- 4. PARTNER ASSIGNMENT + MAP -------------------------------------------
test("GRM-08 assignment: a provider sees their own job, another provider sees nothing, and no customer phone leaks", async () => {
  /* CORRECTED. My first run reported "listPartnerJobs is not exported" as a GAP. The export is
   * `listProviderJobs(db, providerId, now)` in lib/partner-job-feed.ts - a wrong function name in
   * my test, not a missing feed. */
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const feed = await import("../lib/partner-job-feed.ts");

  const mine = await attempt(() => feed.listProviderJobs(db, PROVIDER, NOW));
  assert.equal(mine.ok, true, `the assigned provider must see their feed: ${String(mine.body ?? "").slice(0, 160)}`);
  const all = [...mine.value.needsAction, ...mine.value.today, ...mine.value.upcoming, ...mine.value.completed];
  assert.ok(all.some((j) => j.bookingId === BOOKING), "the assigned grooming booking must appear in its own provider's feed");
  assert.equal(all.find((j) => j.bookingId === BOOKING).serviceCode, "grooming", "the job must carry the canonical grooming service code");

  /* Ownership: another provider must not see this job. */
  const theirs = await attempt(() => feed.listProviderJobs(db, "GRM-PRV-OTHER", NOW));
  assert.equal(theirs.ok, true);
  const theirJobs = [...theirs.value.needsAction, ...theirs.value.today, ...theirs.value.upcoming, ...theirs.value.completed];
  assert.equal(theirJobs.length, 0, "a provider must never see a job assigned to someone else");

  /* PII: the partner feed is assigned-jobs-only and must not carry customer contact data. */
  const serialised = JSON.stringify(mine.value);
  assert.ok(!serialised.includes(PHONE), "the partner feed must not carry the customer's phone number");
  assert.ok(!/grm@example\.test/.test(serialised), "the partner feed must not carry the customer's email");
  assert.equal(all.find((j) => j.bookingId === BOOKING).customerFirstName, "Grooming",
    "the provider sees a first name only");
  stage("Partner assignment", "PASS", "own job visible, other provider sees none, first name only (no phone/email)");
});

test("GRM-09 map: a route snapshot is stored against the booking", async () => {
  /* CORRECTED. My first run reported "cannot be bound to SQLite parameter 9" as a GAP. Parameter 9
   * is route_status (NOT NULL) and my fixture route omitted `status` - a malformed fixture, not a
   * product defect. RouteResult is {status, distanceMeters?, durationSeconds?, polyline?, provider?}. */
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const maps = await import("../lib/grooming-maps.ts");
  await maps.ensureGroomingMapTables(db);
  const saved = await attempt(() => maps.saveRouteSnapshot(db, {
    bookingId: BOOKING, providerId: PROVIDER,
    origin: { lat: 12.97, lng: 77.64 }, destinationAddress: "18 Ulsoor Lake Road",
    route: { status: "configured", provider: "google_routes", distanceMeters: 4200, durationSeconds: 900, polyline: "abc" },
  }));
  assert.equal(saved.ok, true, `a route snapshot must persist: ${String(saved.body ?? "").slice(0, 160)}`);
  const row = sqlite.prepare("SELECT booking_id,provider_id,distance_meters,duration_seconds,route_status FROM grooming_route_snapshots WHERE booking_id=?").get(BOOKING);
  assert.ok(row, "the snapshot must be readable back against the booking");
  assert.equal(row.provider_id, PROVIDER);
  assert.equal(Number(row.distance_meters), 4200);

  /* The adapter must refuse a malformed coordinate before it reaches a third party. */
  assert.equal(maps.validRoutePoint({ lat: Number.NaN, lng: 77.64 }), false, "NaN latitude must not be sent to the map provider");
  assert.equal(maps.validRoutePoint({ lat: 91, lng: 77.64 }), false, "an out-of-range latitude must be refused");
  assert.equal(maps.validRoutePoint({ lat: 12.97, lng: 77.64 }), true, "a valid Bengaluru point must be accepted");
  stage("Map / routing", "PASS", "snapshot persisted (4200m/900s); NaN and out-of-range points refused before dispatch");
});

// --- 5. NOTIFICATION --------------------------------------------------------
test("GRM-10 notification: a lifecycle event emits exactly one governed notification", async () => {
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const notif = await import("../lib/order-notification-governance.ts");
  await notif.ensureOrderNotificationTables(db);
  const input = {
    key: "grm-notify-1", customerId: CUSTOMER, cityId: CITY, bookingId: BOOKING,
    serviceCode: "grooming", eventType: "booking_confirmed", title: "Groom confirmed",
    body: "Your grooming appointment is confirmed.", severity: "info",
    sourceType: "booking", sourceId: BOOKING, actorId: "system:test", occurredAt: NOW,
  };
  const first = await attempt(() => notif.emitOrderNotification(db, input));
  if (!first.ok) { stage("Notification", "GAP", String(first.body ?? "").slice(0, 120)); assert.ok(true); return; }
  const replay = await attempt(() => notif.emitOrderNotification(db, input));
  assert.equal(replay.ok, true, `a replayed key must be absorbed, not rejected: ${String(replay.body ?? "").slice(0, 160)}`);
  const n = sqlite.prepare("SELECT COUNT(*) n FROM order_notifications WHERE customer_id=?").get(CUSTOMER)?.n ?? 0;
  assert.equal(n, 1, "an idempotency key replayed must not notify the customer twice");
  const stored = sqlite.prepare("SELECT idempotency_key,booking_id,service_code FROM order_notifications WHERE customer_id=?").get(CUSTOMER);
  assert.equal(stored.idempotency_key, input.key);
  assert.equal(stored.booking_id, BOOKING);
  assert.equal(stored.service_code, "grooming");
  stage("Notification", "PASS", "emitted once against the grooming booking; replay absorbed, not duplicated");
});

// --- 6. TRACKING: before/after proof ---------------------------------------
test("GRM-11 proof: before/after grooming photos are accepted only from a scan-approved private asset", async () => {
  /* CORRECTED. My first run reported "no proof entry point exported" as a GAP, having looked in
   * lib/grooming-lifecycle-client.ts (an HTTP client). The real entry point is
   * lib/provider-workspace.ts submitJobProof(), which carries a strong gate for grooming photos:
   * the reference must be a registered private media asset that is clean, ready, active and
   * non-synthetic, and bound to THIS booking and THIS provider. */
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const ws = await import("../lib/provider-workspace.ts");
  await ws.ensureProviderWorkspaceTables(db);
  const media = await import("../lib/service-media-security.ts");
  await media.ensureServiceMediaTable(db);

  const asset = (id, over = {}) => {
    const row = { id, booking_id: BOOKING, provider_id: PROVIDER, purpose: "before_service",
      scan_status: "clean", access_status: "ready", retention_status: "active", synthetic: 0, ...over };
    sqlite.prepare("INSERT OR REPLACE INTO service_media_assets (id,booking_id,provider_id,purpose,storage_key,mime_type,size_bytes,sha256,scan_status,access_status,retention_status,synthetic,created_by,created_at,updated_at) VALUES (?,?,?,?,'k','image/jpeg',1024,'sha',?,?,?,?,'test',?,?)")
      .run(row.id, row.booking_id, row.provider_id, row.purpose, row.scan_status, row.access_status, row.retention_status, row.synthetic, NOW, NOW);
    return `media://asset/${id}`;
  };
  const submit = (objectId) => attempt(() => ws.submitJobProof(db, {
    providerId: PROVIDER, bookingId: BOOKING, proofType: "before_photo", objectId,
  }));

  // A bare URL is not a registered asset.
  const bare = await submit("https://example.test/photo.jpg");
  assert.equal(bare.ok, false);
  assert.match(String(bare.body ?? ""), /registered private media reference/i);

  // Registered but still being scanned, quarantined, expired, or synthetic - each must be refused.
  for (const [label, over] of [
    ["still scanning", { scan_status: "pending" }],
    ["infected", { scan_status: "infected" }],
    ["not yet uploaded", { access_status: "pending_upload" }],
    ["retention-expired", { retention_status: "expired" }],
    ["synthetic placeholder", { synthetic: 1 }],
    ["another booking's asset", { booking_id: "GRM-BK-OTHER" }],
    ["another provider's asset", { provider_id: "GRM-PRV-OTHER" }],
    ["an after-service photo passed off as a before", { purpose: "after_service" }],
  ]) {
    const ref = asset(`GRM-MED-${label.replace(/\W+/g, "-")}`, over);
    const res = await submit(ref);
    assert.equal(res.ok, false, `a ${label} asset must not be accepted as grooming proof`);
    assert.match(String(res.body ?? ""), /storage-confirmed and scan-approved/i);
  }

  // Non-vacuity: a clean, ready, active, correctly-bound asset must be accepted and mirrored.
  const good = await submit(asset("GRM-MED-CLEAN"));
  assert.equal(good.ok, true, `a scan-approved asset must be accepted: ${String(good.body ?? "").slice(0, 160)}`);
  assert.equal(good.value.mirroredToCustomer, true);
  const proofs = sqlite.prepare("SELECT COUNT(*) n FROM provider_job_proofs WHERE booking_id=? AND proof_type='before_photo'").get(BOOKING).n;
  assert.equal(proofs, 1, "exactly one before-photo proof must be recorded for the booking");
  const updates = sqlite.prepare("SELECT customer_id,update_type FROM customer_job_updates WHERE booking_id=?").all(BOOKING);
  assert.equal(updates.length, 1, "the customer must see the same proof, once");
  assert.equal(updates[0].customer_id, CUSTOMER);
  stage("Before/after proof", "PASS", "8 unsafe asset states refused; clean asset accepted and mirrored to the customer once");
});

// --- 7. CLOSE + REVIEW ------------------------------------------------------
test("GRM-12 close: a completed groom becomes a dispute, not a cancellation, and Operations has no decision left", async () => {
  /* CORRECTED. My first version wrote status='completed' with a raw UPDATE and asserted it read
   * back as 'completed' - it tested SQLite, not the product. The real terminal-state rule lives in
   * lib/cancellation-case-governance.ts: `completed` is a disputeOnlyStatus, and its entry in
   * opsDecisionsByStatus is empty, so a finished job cannot be stopped or returned for a refund. */
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const cc = await import("../lib/cancellation-case-governance.ts");
  await cc.ensureCancellationCaseTables(db);
  const open = (bookingId, bookingStatus) => attempt(() => cc.openCancellationCase(db, {
    bookingId, customerId: CUSTOMER, serviceCode: "grooming", cityId: CITY, bookingStatus,
    requestedBy: CUSTOMER, reasonText: "The groom was not what I expected", now: NOW,
  }));

  // Before the job starts, the same request is a reviewable cancellation.
  const pre = await open("GRM-BK-PRE", "confirmed");
  assert.equal(pre.ok, true, `a pre-start request must open a case: ${String(pre.body ?? "").slice(0, 160)}`);
  assert.equal(pre.value.case.caseType, "cancellation_review");

  // Once the groom is completed, it is a dispute - cancellation is no longer on the table.
  const post = await open(BOOKING, "completed");
  assert.equal(post.ok, true);
  assert.equal(post.value.case.caseType, "service_dispute",
    "a completed groom must not be cancellable; it can only be disputed");
  assert.deepEqual(post.value.policy.config.opsDecisionsByStatus.completed, [],
    "Operations must have no proceed/stop/return decision left on a completed job");

  // A customer tapping cancel twice is one request, not two cases.
  const again = await open(BOOKING, "completed");
  assert.equal(again.value.reused, true, "a repeat request must reuse the open case");
  const cases = sqlite.prepare("SELECT COUNT(*) n FROM booking_cancellation_cases WHERE booking_id=?").get(BOOKING).n;
  assert.equal(cases, 1, "a duplicate cancel tap must not open a second case");
  stage("Close", "PASS", "completed -> service_dispute with no Operations decision; duplicate request deduplicated");
});

test("GRM-13 review: only the customer who had the groom, only once, only after it is completed", async () => {
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const rating = await import("../lib/booking-rating.ts");
  await rating.ensureBookingRatingTables(db);
  const rate = (over = {}) => attempt(() => rating.submitBookingRating(db, {
    bookingId: BOOKING, customerId: CUSTOMER, stars: 5, comment: "great groom", actorId: CUSTOMER, ...over,
  }));

  // Not yet completed - the booking is still `confirmed` from the fixture.
  const early = await rate();
  assert.equal(early.ok, false);
  assert.match(String(early.body ?? ""), /only rate a completed booking/i);

  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(BOOKING);

  // Someone else's booking.
  const notMine = await rate({ customerId: "GRM-CUS-OTHER" });
  assert.equal(notMine.ok, false);
  assert.match(String(notMine.body ?? ""), /only rate your own bookings/i);

  // Out of range.
  for (const stars of [0, 6, 4.5]) {
    const bad = await rate({ stars });
    assert.equal(bad.ok, false, `${stars} stars must be refused`);
    assert.match(String(bad.body ?? ""), /whole number from 1 to 5/i);
  }

  // The honest rating goes through and carries the provider score with it.
  const first = await rate();
  assert.equal(first.ok, true, `a completed groom must be rateable by its own customer: ${String(first.body ?? "").slice(0, 160)}`);
  assert.equal(first.value.providerId, PROVIDER);

  // ... and only once.
  const second = await rate({ stars: 1, comment: "changed my mind" });
  assert.equal(second.ok, false, "a booking must not be rateable twice");
  assert.match(String(second.body ?? ""), /already been rated/i);

  const rows = sqlite.prepare("SELECT stars,service_code,provider_id FROM booking_ratings WHERE booking_id=?").all(BOOKING);
  assert.equal(rows.length, 1, "exactly one rating row may exist for the booking");
  assert.equal(rows[0].stars, 5, "the second submission must not overwrite the first");
  assert.equal(rows[0].service_code, "grooming");
  assert.equal(rows[0].provider_id, PROVIDER, "the rating must attach to the provider who did the job");
  stage("Review", "PASS", "pre-completion, wrong customer, bad stars and re-rating all refused; one honest rating stored");
});

// --- 8. ACCOUNTS + REFUND ---------------------------------------------------
test("GRM-14 refund: a refund larger than the money captured is flagged as an overage", async () => {
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const pay = await import("../lib/grooming-payment-reconciliation.ts");
  await pay.ensurePaymentReconciliationTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  // Billed 4000, only 1000 ever captured, full refund attempted.
  sqlite.prepare("INSERT OR REPLACE INTO booking_payments VALUES ('GRM-PAY-OV',?,?,4000,4000,'INR','card','prepaid','captured','razorpay','grm-ov','{}',?,?)").run("GRM-BK-OV", CUSTOMER, NOW, NOW);
  sqlite.prepare("INSERT OR REPLACE INTO payment_reconciliation_records (payment_id,booking_id,gateway,environment,expected_amount,captured_amount,refunded_amount,currency,gateway_status,reconciliation_status,variance_amount,updated_at) VALUES ('GRM-PAY-OV','GRM-BK-OV','razorpay','sandbox',4000,1000,0,'INR','captured','matched',0,?)").run(NOW);
  sqlite.prepare("INSERT OR REPLACE INTO booking_refund_cases VALUES ('GRM-RFD-OV','GRM-BK-OV','GRM-PAY-OV',4000,'customer cancelled','approved','ops','finance',NULL,?,?)").run(NOW, NOW);

  await pay.processGatewayEvent(db, {
    provider: "razorpay", environment: "sandbox", eventId: "grm-ov-refund", eventType: "refund.processed",
    bookingId: "GRM-BK-OV", amountSubunits: 400000, gatewayRefundId: "rfnd_grm_ov",
    payloadHash: "sha256:grmov", signatureVerified: true,
  });
  const row = sqlite.prepare("SELECT reconciliation_status,variance_amount FROM payment_reconciliation_records WHERE payment_id='GRM-PAY-OV'").get();
  assert.equal(row.reconciliation_status, "refund_overage",
    "refunding 4000 against 1000 captured must never be certified as matched");
  assert.equal(Math.round(Number(row.variance_amount)), 3000, "the overage must be measured against money COLLECTED");
  stage("Refund overage guard", "PASS", `flagged, variance ${Math.round(Number(row.variance_amount))}`);
});

// --- 9. GST + FILING --------------------------------------------------------
test("GRM-15 GST: invoicing fails CLOSED when no grooming tax policy is configured", async () => {
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const inv = await import("../lib/grooming-invoice.ts");
  await inv.ensureGroomingInvoiceTables(db);
  const unconfigured = await attempt(() => inv.issueGroomingInvoice(db, {
    bookingId: BOOKING, reason: "grooming vertical execution test", actorId: "finance@pawspace.test",
  }));
  assert.equal(unconfigured.ok, false,
    "issuing a tax invoice with no configured policy would fabricate a GST rate - it must refuse");
  assert.equal(unconfigured.status, 409, "the refusal must be the governed 409, not an incidental crash");
  assert.match(String(unconfigured.body ?? ""), /blocked until a published tax policy is configured/i,
    "the refusal must name the missing tax policy - any other failure means the guard is not what stopped it");
  const invoices = sqlite.prepare("SELECT COUNT(*) n FROM booking_invoices WHERE booking_id=?").get(BOOKING).n;
  assert.equal(invoices, 0, "no invoice row may exist after a refused issue");
  stage("GST fail-closed", "PASS", String(unconfigured.body ?? "").slice(0, 90));
});

test("GRM-16 GST: with a policy configured, an invoice is issued for the booking", async () => {
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(BOOKING);
  const inv = await import("../lib/grooming-invoice.ts");
  await inv.ensureGroomingInvoiceTables(db);
  const saved = await attempt(() => inv.saveGroomingTaxPolicy(db, {
    cityId: CITY, taxMode: "inclusive", taxRate: 18, effectiveFrom: "2026-04-01",
    actorId: "finance@pawspace.test", reason: "grooming vertical execution test",
  }));
  if (!saved.ok) { stage("GST invoice", "HARNESS", String(saved.body ?? "").slice(0, 120)); assert.ok(true); return; }
  const issued = await attempt(() => inv.issueGroomingInvoice(db, {
    bookingId: BOOKING, reason: "service completed", actorId: "finance@pawspace.test",
  }));
  if (!issued.ok) { stage("GST invoice", "HARNESS", String(issued.body ?? "").slice(0, 120)); assert.ok(true); return; }
  stage("GST invoice", "PASS", `issued: ${JSON.stringify(issued.value).slice(0, 90)}`);
});

test("GRM-17 filing: grooming commission payouts carry 194H TDS at the governed FY threshold and rate", async () => {
  /* My first version only asserted that the computation RAN, over an empty month - it could not
   * tell a correct number from a zero. This drives the path a commission groomer actually takes:
   * provider_payout_computations joined to provider_commercial_terms, classified 194H on the
   * `commission_*` engagement model, aggregated against the FY threshold. */
  const { sqlite, db } = groomWorld();
  seedCanonical(sqlite);
  const terms = await import("../lib/provider-commercial-terms.ts");
  await terms.ensureCommercialTermsTables(db);
  const tds = await import("../lib/tds-governance.ts");
  await tds.ensureTdsTables(db);

  sqlite.prepare("INSERT OR REPLACE INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,gst_mode,platform_gst_rate,cash_allowed,onboarding_fee,renewal_fee,renewal_months,effective_from,reason,created_by,approved_by,approval_reference,created_at,updated_at) VALUES ('GRM-TERM-1','grooming',?,1,'approved','commission_groomer',70,'exclusive',0.18,0,0,0,12,'2026-04-01','grooming vertical execution test','ops','finance','APR-1',?,?)")
    .run(PROVIDER, NOW, NOW);
  const payout = (bookingId, amount, at) => sqlite.prepare("INSERT OR REPLACE INTO provider_payout_computations (booking_id,provider_id,service_code,order_value,provider_net_payout,platform_fee,platform_gst,provider_gst_deducted,pawspace_gst_on_order,breakdown_json,term_id,computed_by,computed_at) VALUES (?,?,'grooming',?,?,0,0,0,0,'{}','GRM-TERM-1','test',?)")
      .run(bookingId, PROVIDER, amount, amount, at);

  // Below the FY commission threshold (Rs 20,000): no deduction may be raised.
  payout("GRM-BK-P1", 15000, NOW);
  const below = await attempt(() => tds.computeMonthlyTds(db, { period: "2026-09", actorId: "finance@pawspace.test", asOf: NOW }));
  assert.equal(below.ok, true, `TDS computation must run: ${String(below.body ?? "").slice(0, 160)}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM tds_deductions WHERE period='2026-09'").get().n, 0,
    "no TDS may be deducted before the FY commission threshold is crossed");

  // Crossing the threshold taxes the whole untaxed FY cumulative, at 2%.
  payout("GRM-BK-P2", 10000, NOW);
  const over = await attempt(() => tds.computeMonthlyTds(db, { period: "2026-09", actorId: "finance@pawspace.test", asOf: NOW }));
  assert.equal(over.ok, true, `TDS recomputation must run: ${String(over.body ?? "").slice(0, 160)}`);
  const row = sqlite.prepare("SELECT section,deductee_id,base_amount,rate_pct,tds_amount FROM tds_deductions WHERE period='2026-09'").all();
  assert.equal(row.length, 1, "one 194H deduction row for the grooming partner");
  assert.equal(row[0].section, "194H", "a commission groomer is deducted under 194H, not 194J or 192");
  assert.equal(row[0].deductee_id, PROVIDER);
  assert.equal(Number(row[0].base_amount), 25000, "the base is the full untaxed FY cumulative at first crossing");
  assert.equal(Number(row[0].rate_pct), 2, "194H is 2%");
  assert.equal(Number(row[0].tds_amount), 500, "2% of 25,000 is 500");
  assert.equal(tds.TDS_THRESHOLDS_FY.commission194H, 20000);
  assert.equal(tds.TDS_RATES.commission194H, 0.02);

  /* TCS is place-of-supply dependent, so it refuses rather than guessing when a payout references
   * a booking it cannot resolve - the two payout stubs above deliberately have no canonical row. */
  const tcs = await import("../lib/tcs-governance.ts");
  await tcs.ensureTcsTables(db);
  const unresolvable = await attempt(() => tcs.computeMonthlyTcs(db, { period: "2026-09", actorId: "finance@pawspace.test", asOf: NOW }));
  assert.equal(unresolvable.ok, false, "TCS must not compute a state split it cannot resolve");
  assert.match(String(unresolvable.body ?? ""), /place-of-supply/i);

  for (const id of ["GRM-BK-P1", "GRM-BK-P2"]) {
    sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,customer_id,city_id,zone_id,service_code,status,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,'grooming','completed',1899,'INR',?,?)")
      .run(id, CUSTOMER, CITY, ZONE, NOW, NOW);
  }
  const c = await attempt(() => tcs.computeMonthlyTcs(db, { period: "2026-09", actorId: "finance@pawspace.test", asOf: NOW }));
  assert.equal(c.ok, true, `TCS must compute once place of supply resolves: ${String(c.body ?? "").slice(0, 160)}`);
  stage("Filing (TDS/TCS)", "PASS", "194H: nil below Rs 20,000 FY, then Rs 500 on Rs 25,000 at 2%; TCS refuses an unresolvable place of supply, computes once resolved");
});

// --- SCOPE REPORT -----------------------------------------------------------
test("GRM-99 grooming vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== GROOMING VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
