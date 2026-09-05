/**
 * Dog Walking Gate 1 — EXECUTED. Catalogue truth, server-owned quotes, and the quote → canonical
 * session binding.
 *
 * WHAT THIS FILE USED TO BE. Eight tests, every assertion a regex over the source of
 * `lib/walking-governance.ts`, the routes, the clients and the customer page. "Dog Walking commercial
 * truth is server-owned and bounded" asserted that the string
 * "Dog Walking Gate 1 uses pay-after-service UAT billing only" appeared in a file — true whether or
 * not anything refuses a prepaid quote.
 *
 * Each test below calls the real function or drives the real route handler against a real
 * SQLite-backed D1. Requests are built on a NON-PREVIEW origin, because `npm test` runs with
 * PAWSPACE_LOCAL_PREVIEW=on and anything posted to localhost resolves to a superuser holding ["*"].
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, stayUrl, stayWindow } from "./helpers/stay-harness.mjs";

installWorkersHooks("__WALK_G1_DB__", "__WALK_G1_ENV__");

const governance = await import("../lib/walking-governance.ts");

/** A 30-minute window, which is what walking-30 prices. */
const walkWindow = (overrides = {}) => ({ ...stayWindow({ durationHours: 0.5 }), ...overrides });

async function walkingWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__WALK_G1_DB__ = db;
  globalThis.__WALK_G1_ENV__ = {};
  await governance.ensureWalkingGovernanceTables(db);
  return { sqlite, db };
}

const quoteFor = (db, overrides = {}) => governance.createWalkingQuote(db, {
  packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1,
  paymentMode: "pay_after_service", ...walkWindow(), ...overrides,
});

/**
 * Reservation rows are read with SNAKE_CASE keys by `governWalkingBooking`
 * (`provider_id`, `scheduled_start`, `scheduled_end`, `occurrence_number`) because they arrive
 * straight off the scheduling table. A camelCase body silently reads as `undefined` on every field,
 * which is exactly the shape confusion a source-text test could never have caught.
 */
const walkReservation = (id, providerId, start, end, occurrence = 1) => ({
  id, provider_id: providerId, scheduled_start: start, scheduled_end: end, occurrence_number: occurrence,
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking commercial truth is server-owned and bounded", async () => {
  const { db } = await walkingWorld();
  const packages = await governance.listWalkingPackages(db);

  assert.deepEqual(
    packages.map((row) => [row.package_code, row.duration_minutes, row.amount_per_walk, row.max_pets]),
    [["walking-30", 30, 349, 1], ["walking-60", 60, 549, 1]],
  );
  for (const row of packages) assert.equal(row.currency, "INR");

  const quote = await quoteFor(db);
  assert.equal(quote.perWalkAmount, 349, "the per-walk price comes from the catalogue, not the caller");
  assert.equal(quote.totalAmount, 349);
  assert.equal(quote.amountDueNow, 0, "pay-after-service takes nothing up front");
  assert.equal(quote.durationMinutes, 30);
  assert.equal(quote.packageVersion, 1, "the quote pins the catalogue version it was priced against");

  const stored = await db.prepare("SELECT total_amount,amount_due_now,status FROM walking_commercial_quotes WHERE id=?").bind(quote.quoteId).first();
  assert.equal(Number(stored.total_amount), 349);
  assert.equal(Number(stored.amount_due_now), 0);
  assert.equal(stored.status, "open");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 1 uses pay-after-service billing only, and one dog per booking", async () => {
  const { db } = await walkingWorld();

  // Both of these were previously asserted only as sentences in the file.
  const prepaid = await refusal(quoteFor(db, { paymentMode: "prepaid" }));
  assert.equal(prepaid?.status, 409);
  assert.match(prepaid.message, /pay-after-service UAT billing only/);

  const twoDogs = await refusal(quoteFor(db, { petCount: 2 }));
  assert.equal(twoDogs?.status, 409);
  assert.match(twoDogs.message, /one registered dog per canonical booking/);

  const coupon = await refusal(quoteFor(db, { couponCode: "SAVE10" }));
  assert.equal(coupon?.status, 409);
  assert.match(coupon.message, /coupon policy is not enabled/);

  const quotes = await db.prepare("SELECT COUNT(*) AS n FROM walking_commercial_quotes").all();
  assert.equal(Number(quotes.results[0].n), 0, "a refused quote leaves no priced row behind");
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking quote binds the scheduling shape it was priced for", async () => {
  const { db } = await walkingWorld();

  // A 30-minute package priced against a 60-minute window is a different service.
  const wrongDuration = await refusal(governance.createWalkingQuote(db, {
    packageCode: "walking-30", mode: "one_time", petCount: 1, walkCount: 1,
    paymentMode: "pay_after_service", ...stayWindow({ durationHours: 1 }),
  }));
  assert.equal(wrongDuration?.status, 409);
  assert.match(wrongDuration.message, /duration does not match the canonical package/);

  // One-time means exactly one walk. The canonical mode token is "once", not "one_time".
  const manyWalks = await refusal(quoteFor(db, { walkCount: 3 }));
  assert.equal(manyWalks?.status, 409);
  assert.match(manyWalks.message, /One-time Dog Walking requires exactly one walk/);

  // Recurring has both a weekday requirement and a bounded walk count.
  const noWeekdays = await refusal(governance.createWalkingQuote(db, {
    packageCode: "walking-60", mode: "recurring", petCount: 1, walkCount: 4, weekdays: [],
    paymentMode: "pay_after_service", ...stayWindow({ durationHours: 1 }),
  }));
  assert.equal(noWeekdays?.status, 409);
  assert.match(noWeekdays.message, /Recurring Dog Walking requires valid selected weekdays/);

  const tooMany = await refusal(governance.createWalkingQuote(db, {
    packageCode: "walking-60", mode: "recurring", petCount: 1, walkCount: 40, weekdays: [1, 3],
    paymentMode: "pay_after_service", ...stayWindow({ durationHours: 1 }),
  }));
  assert.equal(tooMany?.status, 409);
  assert.match(tooMany.message, /2-12 reserved walks per UAT booking/);

  const recurring = await governance.createWalkingQuote(db, {
    packageCode: "walking-60", mode: "recurring", petCount: 1, walkCount: 4, weekdays: [1, 3],
    paymentMode: "pay_after_service", ...stayWindow({ durationHours: 1 }),
  });
  assert.equal(recurring.perWalkAmount, 549);
  assert.equal(recurring.totalAmount, 549 * 4, "a recurring quote prices every reserved walk");
  assert.equal(recurring.amountDueNow, 0);
  assert.deepEqual(recurring.weekdays, [1, 3]);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking booking refuses a body that disagrees with the server quote", async () => {
  const { db } = await walkingWorld();
  const quote = await quoteFor(db);
  const reservation = walkReservation("RES-W1", "walker_dev", quote.scheduledStart, quote.scheduledEnd);
  const valid = (overrides = {}) => ({
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: 1, walkCount: 1, weekdays: [], scheduledStart: quote.scheduledStart,
    scheduledEnd: quote.scheduledEnd, submittedTotal: quote.totalAmount,
    submittedAmountDueNow: quote.amountDueNow, paymentMode: quote.paymentMode,
    reservations: [reservation], ...overrides,
  });

  const cheaper = await refusal(governance.governWalkingBooking(db, valid({ submittedTotal: 1 })));
  assert.equal(cheaper?.status, 409);
  assert.match(cheaper.message, /amount does not match the server quote/);

  const otherPackage = await refusal(governance.governWalkingBooking(db, valid({ packageCode: "walking-60" })));
  assert.match(otherPackage.message, /package does not match the server quote/);

  const otherWindow = await refusal(governance.governWalkingBooking(db, valid({
    scheduledStart: new Date(new Date(quote.scheduledStart).getTime() + 3_600_000).toISOString(),
  })));
  assert.match(otherWindow.message, /first walk window changed after quote|booking shape changed after quote/);

  const wrongCount = await refusal(governance.governWalkingBooking(db, valid({ reservations: [reservation, reservation] })));
  assert.match(wrongCount.message, /reservation count does not match the server quote/);

  // Every occurrence must belong to ONE walker — a booking split across walkers is a different product.
  const recurringQuote = await governance.createWalkingQuote(db, {
    packageCode: "walking-60", mode: "recurring", petCount: 1, walkCount: 2, weekdays: [1, 3],
    paymentMode: "pay_after_service", ...stayWindow({ durationHours: 1 }),
  });
  const shift = (iso, hours) => new Date(new Date(iso).getTime() + hours * 3_600_000).toISOString();
  const recurringBody = (reservations) => ({
    quoteId: recurringQuote.quoteId, packageCode: recurringQuote.packageCode, packageName: recurringQuote.packageName,
    petCount: 1, walkCount: 2, weekdays: [1, 3], scheduledStart: recurringQuote.scheduledStart,
    scheduledEnd: recurringQuote.scheduledEnd, submittedTotal: recurringQuote.totalAmount,
    submittedAmountDueNow: 0, paymentMode: "pay_after_service", reservations,
  });
  const first = walkReservation("RES-W2", "walker_dev", recurringQuote.scheduledStart, recurringQuote.scheduledEnd, 1);

  const splitWalkers = await refusal(governance.governWalkingBooking(db, recurringBody([
    first,
    walkReservation("RES-W3", "walker_other", shift(recurringQuote.scheduledStart, 48), shift(recurringQuote.scheduledEnd, 48), 2),
  ])));
  assert.equal(splitWalkers?.status, 409);
  assert.match(splitWalkers.message, /must use one canonical walker/);

  // A later occurrence that quietly runs short is a different package, even under one walker.
  const shortOccurrence = await refusal(governance.governWalkingBooking(db, recurringBody([
    first,
    walkReservation("RES-W4", "walker_dev", shift(recurringQuote.scheduledStart, 48), shift(recurringQuote.scheduledEnd, 47.5), 2),
  ])));
  assert.equal(shortOccurrence?.status, 409);
  assert.match(shortOccurrence.message, /reservation duration does not match the canonical package/);

  // The same body, honestly assembled, is accepted and reports the one canonical walker.
  const governed = await governance.governWalkingBooking(db, recurringBody([
    first,
    walkReservation("RES-W5", "walker_dev", shift(recurringQuote.scheduledStart, 48), shift(recurringQuote.scheduledEnd, 48), 2),
  ]));
  assert.equal(governed.providerId, "walker_dev");
  assert.equal(governed.totalAmount, 549 * 2);
  assert.equal(governed.catalogueVersion, "walking-v1");

  assert.equal(
    (await db.prepare("SELECT status FROM walking_commercial_quotes WHERE id=?").bind(quote.quoteId).first()).status,
    "open",
    "every refusal above must leave the quote unconsumed",
  );
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking quote expires and cannot be reused", async () => {
  const { db } = await walkingWorld();
  const quote = await quoteFor(db);
  const reservation = walkReservation("RES-WX", "walker_dev", quote.scheduledStart, quote.scheduledEnd);
  const body = {
    quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName,
    petCount: 1, walkCount: 1, weekdays: [], scheduledStart: quote.scheduledStart,
    scheduledEnd: quote.scheduledEnd, submittedTotal: quote.totalAmount,
    submittedAmountDueNow: 0, paymentMode: quote.paymentMode, reservations: [reservation],
  };

  await db.prepare("UPDATE walking_commercial_quotes SET expires_at=? WHERE id=?").bind(Date.now() - 1000, quote.quoteId).run();
  const expired = await refusal(governance.governWalkingBooking(db, body));
  assert.equal(expired?.status, 409);
  assert.match(expired.message, /quote expired; refresh price and availability/);

  await db.prepare("UPDATE walking_commercial_quotes SET expires_at=?,status='used' WHERE id=?").bind(Date.now() + 900_000, quote.quoteId).run();
  const used = await refusal(governance.governWalkingBooking(db, body));
  assert.equal(used?.status, 409);
  assert.match(used.message, /already been used|already linked to a booking/);
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking Gate 1 permissions separate public price from authenticated booking", async () => {
  const { db } = await walkingWorld();
  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };

  const quoteDecision = await gateway.authorizeApiRequest(new Request(stayUrl("/api/walking-commercial")), env);
  assert.ok(!(quoteDecision instanceof Response), "the public price surface must not be refused outright");
  assert.equal(quoteDecision.permission, null, "quoting a walk prices nothing customer-specific");

  const bookingDecision = await gateway.authorizeApiRequest(
    new Request(stayUrl("/api/walking-bookings"), { method: "POST", headers: { "content-type": "application/json" } }),
    env,
  );
  if (bookingDecision instanceof Response) {
    assert.equal(bookingDecision.status, 401, "an unauthenticated booking attempt is refused");
  } else {
    assert.ok(bookingDecision.permission, "creating a Dog Walking booking is a guarded route");
  }
});

// ---------------------------------------------------------------------------------------------
test("Dog Walking commercial route is same-origin and honest about UAT money", async () => {
  const { db } = await walkingWorld();
  const route = await import("../app/api/walking-commercial/route.ts");
  const body = { packageCode: "walking-30", mode: "once", petCount: 1, walkCount: 1, paymentMode: "pay_after_service", ...walkWindow() };

  const quoted = await route.POST(new Request(stayUrl("/api/walking-commercial"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }));
  assert.equal(quoted.status, 201, "a same-origin quote is created");
  const payload = (await quoted.json()).data;
  assert.equal(payload.liveMoney, false, "the route never reports live money in UAT");
  assert.equal(payload.totalAmount, 349, "the route returns the catalogue price, not anything the caller sent");
  assert.equal(payload.amountDueNow, 0);
  assert.equal(quoted.headers.get("cache-control"), "no-store", "a price quote is never cached");

  // The catalogue read is equally honest about what it does and does not know.
  const listed = await route.GET(new Request(stayUrl("/api/walking-commercial")));
  const catalogue = (await listed.json()).data;
  assert.equal(catalogue.liveMoney, false);
  assert.equal(catalogue.liveAvailability, false, "the catalogue never claims verified live availability");
  assert.equal(catalogue.availabilityVerified, false);
  assert.equal(catalogue.source, "canonical_walking_governance");

  const crossOrigin = await route.POST(new Request(stayUrl("/api/walking-commercial"), {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(body),
  }));
  assert.equal(crossOrigin.status, 403);

  // A refusal from governance reaches the caller as its own status, not a blanket 500.
  const prepaid = await route.POST(new Request(stayUrl("/api/walking-commercial"), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...body, paymentMode: "prepaid" }),
  }));
  assert.equal(prepaid.status, 409);
  assert.match((await prepaid.json()).error, /pay-after-service UAT billing only/);
});
