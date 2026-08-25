/**
 * PawSpace Total Journey Audit — permanent behavioural regressions for the CONFIRMED P0 defects.
 *
 * Every case in this file was reproduced by TWO independent blind verifiers before a line of production
 * code was changed. Each records the failure it locks out, and each fails if its fix is reverted.
 *
 * Nothing here reads a source file. Every assertion executes the real module or the real route.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_P0_DB__", "__PTJA_P0_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  // Depth-aware: real D1 batches never nest, but route code reached through another route's ensure*
  // helpers does re-enter batch(). A naive BEGIN here fails with "transaction within a transaction" and
  // would look like a product defect. Only the outermost batch owns the transaction.
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

function world(env = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_P0_DB__ = db;
  globalThis.__PTJA_P0_ENV__ = env;
  return { sqlite, db };
}

// =====================================================================================================
// PTJA-P0-01 — a package price outside its own effective window is quoted and charged
//
// CONFIRMED independently by both verifiers. Operators schedule prices through a first-class UI control
// ("Effective from" date input on the Pricing Control panel, whitelisted by PATCH /api/pricing-control),
// but resolveLivePrice selected the row on `package_code=? AND active=1` alone and calculatePrice never
// read pkg.effectiveFrom/effectiveTo. A price scheduled for 2027 was therefore quoted for a 2026 stay,
// and a price retired in 2025 was quoted forever.
//
// The asymmetry is what makes it unambiguous rather than a design choice: activeOn() in
// lib/pricing-engine.ts applies exactly this window test to dynamic_pricing_rules. Only the package row
// was exempt. Every priced vertical shares this resolver - grooming, boarding, sitting and training.
// =====================================================================================================

const PKG_COLUMNS = "id,service_code,package_code,name,description,base_price,slot_minutes,blocking_minutes,tax_inclusive,active,version,effective_from,effective_to,updated_by,updated_at";

async function pricingWorld() {
  const { sqlite, db } = world();
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensurePricingControlRuntime(db);
  const seed = (packageCode, basePrice, effectiveFrom, effectiveTo) =>
    sqlite.prepare(`INSERT OR REPLACE INTO service_packages (${PKG_COLUMNS}) VALUES (?,?,?,?,?,?,?,?,?,1,1,?,?,'ptja',0)`)
      .run(`SP-${packageCode}`, "grooming", packageCode, `Pkg ${packageCode}`, "", basePrice, 60, 75, 1, effectiveFrom, effectiveTo);
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  const quote = (packageCode, scheduledStart, fallbackPrice = 1111) =>
    resolveLivePrice(db, { packageCode, fallbackPrice, scheduledStart, cityId: "blr" });
  return { sqlite, db, seed, quote };
}

const IN_2026 = "2026-09-16T05:00:00.000Z";

test("P0-01: a package whose effective window has NOT OPENED is not charged today", async () => {
  // Measured before the fix: {"price":5555,"source":"pricing_control"} for a 2026 stay.
  const { seed, quote } = await pricingWorld();
  seed("future-price", 5555, "2027-01-01", "2027-12-31");
  const result = await quote("future-price", IN_2026, 1111);
  assert.equal(result.price, 1111, "a 2027-only price must not be charged for a 2026 stay");
  assert.equal(result.source, "fallback_default", "an out-of-window package is no package at all");
});

test("P0-01: a package whose effective window has CLOSED is not charged forever", async () => {
  // Measured before the fix: {"price":7777,"source":"pricing_control"} long after the window expired.
  const { seed, quote } = await pricingWorld();
  seed("retired-price", 7777, "2025-01-01", "2025-06-30");
  const result = await quote("retired-price", IN_2026, 1111);
  assert.equal(result.price, 1111, "a price retired in June 2025 must not still be charged in 2026");
  assert.equal(result.source, "fallback_default");
});

test("P0-01: a currently-effective package is still charged - the fix is not a blanket refusal", async () => {
  // Non-vacuity. A window test that rejects everything would also make both cases above pass.
  const { seed, quote } = await pricingWorld();
  seed("current-price", 1499, "2020-01-01", null);
  const result = await quote("current-price", IN_2026, 1111);
  assert.equal(result.price, 1499, "a live catalogue price must still be used");
  assert.equal(result.source, "pricing_control");
});

test("P0-01: an open-ended window (effective_to NULL) stays open", async () => {
  const { seed, quote } = await pricingWorld();
  seed("open-ended", 2499, "2026-01-01", null);
  assert.equal((await quote("open-ended", IN_2026)).price, 2499);
});

test("P0-01: the window boundaries are inclusive on both ends", async () => {
  // The same inclusivity activeOn() already uses for rules: >= from, <= to. A boundary day is INSIDE.
  const { seed, quote } = await pricingWorld();
  seed("bounded", 1799, "2026-09-16", "2026-09-16");
  assert.equal((await quote("bounded", IN_2026)).price, 1799, "the first and last day of the window are inside it");
  assert.equal((await quote("bounded", "2026-09-15T05:00:00.000Z")).source, "fallback_default", "the day before is outside");
  assert.equal((await quote("bounded", "2026-09-17T05:00:00.000Z")).source, "fallback_default", "the day after is outside");
});

test("P0-01: the window is judged against the BOOKING date, not today", async () => {
  // The consequence that makes this a pricing defect rather than a deployment one: the same package
  // must price a 2027 stay at the 2027 price and refuse to price a 2026 stay with it.
  const { seed, quote } = await pricingWorld();
  seed("seasonal", 3999, "2027-01-01", "2027-01-31");
  assert.equal((await quote("seasonal", "2027-01-15T05:00:00.000Z")).price, 3999, "inside the window it applies");
  assert.equal((await quote("seasonal", IN_2026)).source, "fallback_default", "outside it, it does not");
});

// =====================================================================================================
// PTJA-P0-02 — a pet_sitting booking is priced entirely by the client on /api/canonical-bookings
//
// CONFIRMED independently by both verifiers with the same canonical failure: in
// app/api/canonical-bookings/route.ts the `governed` commercial object is initialised FROM THE CLIENT
// PAYLOAD and is only overwritten for grooming (governGroomingBookingWithLiveMultiPet), dog_training
// (trainingQuoteId required) and boarding (boardingQuoteId required). pet_sitting - the fourth member of
// that route's own `services` set - had no server-side override at all, so the client's packageCode,
// packageName, totalAmount and amountDueNow were persisted verbatim into canonical_bookings and
// booking_payments with no catalogue lookup.
//
// The governed Sitting path already exists and is complete: /api/sitting-bookings requires a server
// sittingQuoteId, requires a sandbox capture bound to that quote, runs governSittingBooking (which
// re-derives price, window, pet count, city/zone and payment mode from the quote row) and then links and
// consumes the quote. Both real clients already use it - app/sitting/page.tsx and
// app/mobile-app/stay-flow.tsx via createCanonicalSittingBooking - and so does the Layer 2 swarm. NO
// caller in this repository posts serviceCode "pet_sitting" to /api/canonical-bookings.
//
// So the correction is to shut the ungoverned door, not to build a second governed one: adding quote
// governance to canonical-bookings would mean re-deciding capture, quote-link and mark-used semantics
// that /api/sitting-bookings already owns. Nothing here invents a price or a policy - it refuses a route
// that has none and names the route that does.
// =====================================================================================================

async function sittingSession(db, customerId) {
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const binding = await upsertIdentityBinding(db, {
    identitySource: "customer_otp", principalType: "identity_subject", principalKey: `customer:${customerId}`,
    subjectType: "customer", subjectId: customerId, verificationState: "verified",
    actorId: "ptja-p0-02", reason: "PTJA P0-02 executable regression",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: String(binding.identity_source),
    principalType: String(binding.principal_type), principalKey: String(binding.principal_key),
    subjectType: "customer", subjectId: customerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

async function call(modulePath, method, path, body, cookie, extraHeaders = {}) {
  const route = await import(modulePath);
  const request = new Request(`https://uat.pawspace.in${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...extraHeaders },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response = await route[method](request);
  return { status: response.status, body: await response.json() };
}

// One real customer, one real sitter assignment, one real server quote, one real sandbox capture.
async function sittingWorld(tag) {
  const { sqlite, db } = world({ PAWSPACE_PAYMENT_ENV: "sandbox" });
  sqlite.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=MEMORY;");
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { seedDefaultZones } = await import("../lib/service-zones.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await ensureSecurityTables(db);
  await seedDefaultZones(db);
  await seedProviderCapacityDefaults(db);

  const customerId = `CUS-PTJA-P02-${tag}`;
  const cookie = await sittingSession(db, customerId);
  const start = new Date(Date.now() + 10 * 86_400_000);
  start.setUTCHours(6, 0, 0, 0);
  const scheduledStart = start.toISOString(), scheduledEnd = new Date(start.getTime() + 3_600_000).toISOString();
  const groupId = `PTJA-P02-${tag}`;

  const scheduled = await call("../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: groupId, customerId, petIds: [`PTJAPET${tag}`], serviceCode: "pet_sitting",
    cityId: "blr", zoneId: "blr-east", scheduledStart, scheduledEnd, occurrences: 1, careMode: "visit",
    preferredProviderId: "sit_sana",
  }, cookie);
  const provider = scheduled.body.data?.provider;
  assert.ok(provider, `sitter assignment failed: ${scheduled.status} ${JSON.stringify(scheduled.body)}`);

  const quoted = await call("../app/api/sitting-commercial/route.ts", "POST", "/api/sitting-commercial", {
    packageCode: "sitting-visit-60", petCount: 1, scheduledStart, scheduledEnd, paymentMode: "prepaid",
    cityId: "blr", zoneId: "blr-east",
  }, cookie);
  const quote = quoted.body.data;
  assert.ok(quote?.quoteId, `sitting quote failed: ${quoted.status} ${JSON.stringify(quoted.body)}`);

  const customer = { id: customerId, name: "PTJA sitting customer", primaryPhone: "+919800001122" };
  const pets = [{ sourceId: `PTJAPET${tag}`, name: "Kaju", species: "dog", vaccinationStatus: "verified" }];
  return { sqlite, db, cookie, customer, pets, provider, quote, groupId, scheduledStart, scheduledEnd };
}

test("P0-02: /api/canonical-bookings refuses a client-priced pet_sitting booking", async () => {
  // Measured before the fix: HTTP 201, and canonical_bookings.total_amount = 1 with
  // booking_payments.amount = 1, for a stay whose ONLY governed catalogue price is Rs 399. The client
  // named its own package, its own name and its own price and the server stored all three.
  const ctx = await sittingWorld("A");
  const attempt = await call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", {
    idempotencyKey: "ptja:p02:client-priced", scheduleGroupId: ctx.groupId,
    customer: ctx.customer, pets: ctx.pets, cityId: "blr", zoneId: "blr-east",
    serviceCode: "pet_sitting", packageCode: "sitting-visit-60", packageName: "Home Visit",
    scheduledStart: ctx.scheduledStart, scheduledEnd: ctx.scheduledEnd, provider: ctx.provider,
    totalAmount: 1, amountDueNow: 1,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "client-declared" },
    pricing: { discount: 0 },
  }, ctx.cookie);

  assert.equal(attempt.status, 409, `a client-priced Sitting booking must be refused, got ${attempt.status} ${JSON.stringify(attempt.body)}`);
  assert.match(String(attempt.body.error), /sitting/i, "the refusal must name the governed Sitting route");

  // The refusal is BEFORE any write: no booking, no payment, no consumed quote.
  const persisted = ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE service_code='pet_sitting'").get();
  assert.equal(Number(persisted.n), 0, "no pet_sitting booking may be persisted by the ungoverned route");
  const quoteRow = ctx.sqlite.prepare("SELECT status FROM sitting_commercial_quotes WHERE id=?").get(ctx.quote.quoteId);
  assert.equal(String(quoteRow.status), "open", "the server quote must be untouched by the refused attempt");
});

test("P0-02: the ONE governed Sitting route still books, at the server price - the fix is not a shutdown", async () => {
  // Non-vacuity, and the reason the refusal above is the smallest correction: the governed door works.
  const ctx = await sittingWorld("B");
  const captured = await call("../app/api/sitting-payment-sandbox/route.ts", "POST", "/api/sitting-payment-sandbox",
    { quoteId: ctx.quote.quoteId, amount: ctx.quote.amountDueNow }, ctx.cookie,
    { "x-payment-capture-key": "ptja-p02-capture" });
  assert.equal(captured.status, 201, `sandbox capture failed: ${JSON.stringify(captured.body)}`);

  const booked = await call("../app/api/sitting-bookings/route.ts", "POST", "/api/sitting-bookings", {
    idempotencyKey: "ptja:p02:governed", scheduleGroupId: ctx.groupId, sittingQuoteId: ctx.quote.quoteId,
    customer: ctx.customer, pets: ctx.pets, cityId: "blr", zoneId: "blr-east",
    packageCode: ctx.quote.packageCode, packageName: ctx.quote.packageName,
    scheduledStart: ctx.scheduledStart, scheduledEnd: ctx.scheduledEnd, provider: ctx.provider,
    totalAmount: ctx.quote.totalAmount, amountDueNow: ctx.quote.amountDueNow,
    payment: { method: "payment_link", mode: "prepaid", detail: "PTJA governed sitting capture" },
  }, ctx.cookie);
  assert.equal(booked.status, 201, `the governed Sitting route must still book: ${JSON.stringify(booked.body)}`);

  const row = ctx.sqlite.prepare("SELECT service_code,total_amount FROM canonical_bookings WHERE id=?").get(booked.body.data.bookingId);
  assert.equal(String(row.service_code), "pet_sitting");
  assert.equal(Number(row.total_amount), Number(ctx.quote.totalAmount), "the persisted amount is the SERVER quote, not a client number");
  assert.equal(Number(row.total_amount), 399, "and the server quote is the catalogue price for a single-pet Home Visit");
});

test("P0-02: the refusal is scoped to pet_sitting - the other verticals answer for themselves", async () => {
  // The gate must be keyed on the one service that had no governance. Posted against the same scheduling
  // group, dog_training must still fail for its OWN reason and must never be answered by the Sitting
  // refusal - otherwise a blanket rejection would satisfy the case above just as well.
  const ctx = await sittingWorld("C");
  const base = {
    scheduleGroupId: ctx.groupId, customer: ctx.customer, pets: ctx.pets, cityId: "blr", zoneId: "blr-east",
    packageCode: "trainer-meet-greet", packageName: "Meet & Greet",
    scheduledStart: ctx.scheduledStart, scheduledEnd: ctx.scheduledEnd, provider: ctx.provider,
    totalAmount: 1, amountDueNow: 1,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "client-declared" },
    pricing: { discount: 0 },
  };
  const training = await call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings",
    { ...base, idempotencyKey: "ptja:p02:training", serviceCode: "dog_training" }, ctx.cookie);
  assert.equal(training.status, 409);
  assert.doesNotMatch(String(training.body.error), /sitting/i, "dog_training must never be answered by the Sitting refusal");
  assert.match(String(training.body.error), /scheduling reservation/i, "it fails on its own reservation check");
});

test("P0-02: a pet_sitting booking that already exists still replays through /api/canonical-bookings", async () => {
  // The refusal sits AFTER the replay lookup on purpose. A Sitting booking created by the governed route
  // is a real canonical booking; a client replaying its own idempotency key against this route must get
  // its booking back, not a 409. History is never orphaned by a new refusal.
  const ctx = await sittingWorld("D");
  const key = "ptja:p02:replayable";
  const captured = await call("../app/api/sitting-payment-sandbox/route.ts", "POST", "/api/sitting-payment-sandbox",
    { quoteId: ctx.quote.quoteId, amount: ctx.quote.amountDueNow }, ctx.cookie, { "x-payment-capture-key": "ptja-p02-replay" });
  assert.equal(captured.status, 201);
  const booked = await call("../app/api/sitting-bookings/route.ts", "POST", "/api/sitting-bookings", {
    idempotencyKey: key, scheduleGroupId: ctx.groupId, sittingQuoteId: ctx.quote.quoteId,
    customer: ctx.customer, pets: ctx.pets, cityId: "blr", zoneId: "blr-east",
    packageCode: ctx.quote.packageCode, packageName: ctx.quote.packageName,
    scheduledStart: ctx.scheduledStart, scheduledEnd: ctx.scheduledEnd, provider: ctx.provider,
    totalAmount: ctx.quote.totalAmount, amountDueNow: ctx.quote.amountDueNow,
    payment: { method: "payment_link", mode: "prepaid", detail: "PTJA governed sitting capture" },
  }, ctx.cookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));

  const replay = await call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", {
    idempotencyKey: key, scheduleGroupId: ctx.groupId,
    customer: ctx.customer, pets: ctx.pets, cityId: "blr", zoneId: "blr-east",
    serviceCode: "pet_sitting", packageCode: ctx.quote.packageCode, packageName: ctx.quote.packageName,
    scheduledStart: ctx.scheduledStart, scheduledEnd: ctx.scheduledEnd, provider: ctx.provider,
    totalAmount: ctx.quote.totalAmount, amountDueNow: ctx.quote.amountDueNow,
    payment: { method: "upi", mode: "prepaid", status: "captured", detail: "replay" },
    pricing: { discount: 0 },
  }, ctx.cookie);
  assert.equal(replay.status, 200, `an existing Sitting booking must still replay: ${JSON.stringify(replay.body)}`);
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(replay.body.data.bookingId, booked.body.data.bookingId);
});
