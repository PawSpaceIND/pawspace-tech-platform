/**
 * Pet Taxi Gate 1 — EXECUTED. Route classes, server-owned quotes, and the quote→reservation binding.
 *
 * WHAT THIS FILE USED TO BE. Seven tests that read `lib/taxi-governance.ts`, the taxi routes, the
 * gateway and the customer page as STRINGS and regex-matched them. "Pet Taxi quote binds one canonical
 * trip reservation and normalizes timestamps" asserted that the phrase "exactly one canonical trip
 * reservation" appeared somewhere in the source. Every one of them would have stayed green with the
 * guard deleted and the sentence left behind in a comment, which is the opposite of what a test is for.
 *
 * Each test below now calls the real function (or drives the real route handler) against a real
 * SQLite-backed D1 and asserts on the rows and responses it actually produced. The test names are
 * unchanged so the intent stays traceable to the gate they came from.
 *
 * Requests are built on a NON-PREVIEW origin. `npm test` runs with NODE_ENV=test and
 * PAWSPACE_LOCAL_PREVIEW=on, so a request to localhost resolves to a superuser holding ["*"] and any
 * authorization assertion against it proves nothing — see tests/helpers/taxi-harness.mjs.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { freshSqlite, makeD1, refusal, taxiUrl, validQuoteInput, futurePickup } from "./helpers/taxi-harness.mjs";

installWorkersHooks("__TAXI_G1_DB__", "__TAXI_G1_ENV__");

const governance = await import("../lib/taxi-governance.ts");
const commercialRoute = await import("../app/api/taxi-commercial/route.ts");

function taxiWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__TAXI_G1_DB__ = db;
  globalThis.__TAXI_G1_ENV__ = {};
  return { sqlite, db };
}

const postQuote = async (body, { origin } = {}) => {
  const headers = { "content-type": "application/json", ...(origin ? { origin } : {}) };
  const response = await commercialRoute.POST(new Request(taxiUrl("/api/taxi-commercial"), { method: "POST", headers, body: JSON.stringify(body) }));
  return { status: response.status, body: await response.json().catch(() => null) };
};

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 1 extends the shared scheduler and governed provider model", async () => {
  const { scheduleRules } = await import("../backend/src/scheduling.ts");
  assert.equal(scheduleRules.pet_taxi.label, "Pet Taxi");
  assert.equal(scheduleRules.pet_taxi.durationMinutes, 45, "a changed taxi slot length must fail this test, not just re-word a string");
  assert.equal(scheduleRules.pet_taxi.maxOccurrences, 1, "Gate 1 is one canonical trip per reservation");
  assert.equal(scheduleRules.pet_taxi.capacityMode, "appointment", "a taxi trip is an appointment, not an overnight or care-mode hold");

  const { db } = taxiWorld();
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const drivers = await capacity.loadGovernedProviders(db, "blr", "blr-east", "pet_taxi");
  const ids = drivers.map((provider) => String(provider.id ?? provider.provider_id)).sort();
  for (const expected of ["taxi_imran", "taxi_meera", "taxi_rahul"]) {
    assert.ok(ids.includes(expected), `${expected} must be a governed pet_taxi provider, found: ${ids.join(", ")}`);
  }
  for (const driver of drivers) {
    const services = typeof driver.services === "string" ? JSON.parse(driver.services) : driver.services;
    assert.ok(Array.isArray(services) && services.includes("pet_taxi"), `${driver.id} was returned for pet_taxi without serving it`);
  }
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi commercial truth is server-owned UAT route-class truth", async () => {
  const { db } = taxiWorld();
  const routes = await governance.listTaxiRouteClasses(db);
  assert.equal(routes.length, 3, "three seeded UAT route classes");
  assert.deepEqual(routes.map((route) => String(route.route_code)),
    ["taxi-blr-east-short", "taxi-blr-east-medium", "taxi-blr-east-long"],
    "ordered by synthetic distance, which is what the customer picker relies on");

  const listed = await commercialRoute.GET(new Request(taxiUrl("/api/taxi-commercial")));
  const listedBody = await listed.json();
  assert.equal(listed.status, 200);
  assert.equal(listedBody.data.source, "canonical_taxi_governance");
  assert.equal(listedBody.data.routeSource, "uat_route_class");
  assert.equal(listedBody.data.productionMapsVerified, false, "Gate 1 must never claim a verified production Maps route");
  assert.equal(listedBody.data.liveMoney, false, "nor live money");
  assert.equal(listed.headers.get("cache-control"), "no-store", "a priced quote surface must not be cached");

  const quote = await governance.createTaxiQuote(db, validQuoteInput());
  assert.equal(quote.totalAmount, 449, "the short route's seeded amount");
  assert.equal(quote.amountDueNow, 0, "Gate 1 collects nothing up front");
  assert.equal(quote.paymentMode, "sandbox_deferred");
  assert.equal(quote.routeSource, "uat_route_class");
  assert.equal(quote.productionMapsVerified, false);
  const stored = await db.prepare("SELECT total_amount,amount_due_now,status FROM taxi_commercial_quotes WHERE id=?").bind(quote.quoteId).first();
  assert.equal(Number(stored.total_amount), 449, "and the stored quote agrees with what was returned");
  assert.equal(Number(stored.amount_due_now), 0);
  assert.equal(String(stored.status), "open");

  const live = await refusal(governance.createTaxiQuote(db, validQuoteInput({ paymentMode: "live" })));
  assert.equal(live?.status, 409, "sandbox-deferred UAT payment only");
  assert.match(live.message, /sandbox-deferred UAT payment only/);

  const coupon = await refusal(governance.createTaxiQuote(db, validQuoteInput({ couponCode: "SAVE10" })));
  assert.equal(coupon?.status, 409, "coupon policy is not enabled for taxi");
  assert.match(coupon.message, /coupon policy is not enabled/);

  const twoPets = await refusal(governance.createTaxiQuote(db, validQuoteInput({ petCount: 2 })));
  assert.equal(twoPets?.status, 409, "one registered pet per canonical trip");
  assert.match(twoPets.message, /one registered pet per canonical trip/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi quote binds one canonical trip reservation and normalizes timestamps", async () => {
  const { db } = taxiWorld();
  const input = validQuoteInput();
  const quote = await governance.createTaxiQuote(db, input);

  const reservation = (overrides = {}) => ({
    id: "RES-1", service_code: "pet_taxi", provider_id: "taxi_rahul",
    scheduled_start: quote.scheduledStart, scheduled_end: quote.scheduledEnd, ...overrides,
  });
  const bookingInput = (overrides = {}) => ({
    quoteId: quote.quoteId, routeCode: quote.routeCode, originLabel: quote.originLabel,
    destinationLabel: quote.destinationLabel, petCount: 1, scheduledStart: quote.scheduledStart,
    scheduledEnd: quote.scheduledEnd, submittedTotal: quote.totalAmount, submittedAmountDueNow: 0,
    paymentMode: "sandbox_deferred", reservations: [reservation()], ...overrides,
  });

  const governed = await governance.governTaxiBooking(db, bookingInput());
  assert.equal(governed.quoteId, quote.quoteId);
  assert.equal(governed.providerId, "taxi_rahul");
  assert.equal(governed.catalogueVersion, "taxi-v1");
  assert.equal(governed.productionMapsVerified, false);

  for (const reservations of [[], [reservation(), reservation({ id: "RES-2" })]]) {
    const many = await refusal(governance.governTaxiBooking(db, bookingInput({ reservations })));
    assert.equal(many?.status, 409, `${reservations.length} reservations must be refused`);
    assert.match(many.message, /exactly one canonical trip reservation/);
  }

  const wrongService = await refusal(governance.governTaxiBooking(db, bookingInput({ reservations: [reservation({ service_code: "grooming" })] })));
  assert.equal(wrongService?.status, 409);
  assert.match(wrongService.message, /not a Pet Taxi reservation/);

  const drifted = await refusal(governance.governTaxiBooking(db, bookingInput({
    reservations: [reservation({ scheduled_start: futurePickup(600) })],
  })));
  assert.equal(drifted?.status, 409);
  assert.match(drifted.message, /reservation does not match the canonical quote/);

  const secondQuote = await governance.createTaxiQuote(db, validQuoteInput({ originLabel: "Koramangala pickup point" }));
  const offsetForm = new Date(secondQuote.scheduledStart).toLocaleString("sv-SE", { timeZone: "Asia/Kolkata" }).replace(" ", "T") + "+05:30";
  assert.notEqual(offsetForm, secondQuote.scheduledStart, "the two spellings really do differ as strings");
  const normalised = await governance.governTaxiBooking(db, {
    ...bookingInput(), quoteId: secondQuote.quoteId, originLabel: secondQuote.originLabel,
    scheduledStart: secondQuote.scheduledStart, scheduledEnd: secondQuote.scheduledEnd,
    submittedTotal: secondQuote.totalAmount,
    reservations: [reservation({ scheduled_start: offsetForm, scheduled_end: secondQuote.scheduledEnd })],
  });
  assert.equal(normalised.quoteId, secondQuote.quoteId, "an equivalent instant in another offset must bind, not be refused as drift");
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi booking creates one canonical bundle and one trip row", async () => {
  const { db } = taxiWorld();
  const quote = await governance.createTaxiQuote(db, validQuoteInput());
  const reservations = [{ id: "RES-1", service_code: "pet_taxi", provider_id: "taxi_rahul", scheduled_start: quote.scheduledStart, scheduled_end: quote.scheduledEnd }];
  const bookingInput = {
    quoteId: quote.quoteId, routeCode: quote.routeCode, originLabel: quote.originLabel,
    destinationLabel: quote.destinationLabel, petCount: 1, scheduledStart: quote.scheduledStart,
    scheduledEnd: quote.scheduledEnd, submittedTotal: quote.totalAmount, submittedAmountDueNow: 0,
    paymentMode: "sandbox_deferred", reservations,
  };

  await governance.governTaxiBooking(db, bookingInput);
  await db.prepare("INSERT INTO taxi_booking_quote_links (quote_id,booking_id,created_at) VALUES (?,?,?)")
    .bind(quote.quoteId, "BKG-TAXI-1", Date.now()).run();
  const relink = await refusal(governance.governTaxiBooking(db, bookingInput));
  assert.equal(relink?.status, 409, "a quote already linked to a booking cannot be spent twice");
  assert.match(relink.message, /already linked to a booking/);

  const spent = await governance.createTaxiQuote(db, validQuoteInput({ originLabel: "HSR pickup point" }));
  await db.prepare("UPDATE taxi_commercial_quotes SET status='used' WHERE id=?").bind(spent.quoteId).run();
  const used = await refusal(governance.governTaxiBooking(db, { ...bookingInput, quoteId: spent.quoteId, originLabel: spent.originLabel, scheduledStart: spent.scheduledStart, scheduledEnd: spent.scheduledEnd, submittedTotal: spent.totalAmount, reservations: [{ ...reservations[0], scheduled_start: spent.scheduledStart, scheduled_end: spent.scheduledEnd }] }));
  assert.equal(used?.status, 409);
  assert.match(used.message, /already been used/);

  const stale = await governance.createTaxiQuote(db, validQuoteInput({ originLabel: "Jayanagar pickup point" }));
  await db.prepare("UPDATE taxi_commercial_quotes SET expires_at=? WHERE id=?").bind(Date.now() - 1, stale.quoteId).run();
  const expired = await refusal(governance.governTaxiBooking(db, { ...bookingInput, quoteId: stale.quoteId, originLabel: stale.originLabel, scheduledStart: stale.scheduledStart, scheduledEnd: stale.scheduledEnd, submittedTotal: stale.totalAmount, reservations: [{ ...reservations[0], scheduled_start: stale.scheduledStart, scheduled_end: stale.scheduledEnd }] }));
  assert.equal(expired?.status, 409);
  assert.match(expired.message, /expired/);

  const fresh = await governance.createTaxiQuote(db, validQuoteInput({ originLabel: "Hebbal pickup point" }));
  const underpaid = await refusal(governance.governTaxiBooking(db, { ...bookingInput, quoteId: fresh.quoteId, originLabel: fresh.originLabel, scheduledStart: fresh.scheduledStart, scheduledEnd: fresh.scheduledEnd, submittedTotal: 1, reservations: [{ ...reservations[0], scheduled_start: fresh.scheduledStart, scheduled_end: fresh.scheduledEnd }] }));
  assert.equal(underpaid?.status, 409, "a client-supplied price must never win");
  assert.match(underpaid.message, /does not match the server quote/);
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi customer UI uses route class quote scheduler and canonical booking", async () => {
  const { db } = taxiWorld();
  await governance.listTaxiRouteClasses(db);
  const created = await postQuote(validQuoteInput());
  assert.equal(created.status, 201, `the page's quote call must succeed: ${JSON.stringify(created).slice(0, 300)}`);
  for (const field of ["quoteId", "routeCode", "routeName", "syntheticDistanceKm", "estimatedDurationMinutes", "scheduledStart", "scheduledEnd", "totalAmount"]) {
    assert.ok(created.body.data[field] !== undefined, `the customer page renders ${field}, so the quote must carry it`);
  }
  assert.equal(created.body.data.amountDueNow, 0, "the page's ₹0 due now is the server's number, not copy");
  assert.equal(created.body.data.liveMoney, false);
  assert.equal(created.body.data.productionMapsVerified, false, "the page's \"not a live Maps distance/ETA\" disclosure must match the server");

  const before = (await db.prepare("SELECT COUNT(*) AS c FROM taxi_commercial_quotes").first()).c;
  const crossOrigin = await postQuote(validQuoteInput(), { origin: "https://evil.example" });
  assert.equal(crossOrigin.status, 403, `cross-origin Pet Taxi quote must be blocked: ${JSON.stringify(crossOrigin).slice(0, 200)}`);
  const after = (await db.prepare("SELECT COUNT(*) AS c FROM taxi_commercial_quotes").first()).c;
  assert.equal(Number(after), Number(before), "and must write nothing");
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 1 gateway keeps public quote separate from authenticated booking", async () => {
  const { db } = taxiWorld();
  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };

  const quoteDecision = await gateway.authorizeApiRequest(new Request(taxiUrl("/api/taxi-commercial")), env);
  assert.ok(!(quoteDecision instanceof Response), "the public quote surface must not be refused outright");
  assert.equal(quoteDecision.permission, null, "quoting a route is public — it prices nothing customer-specific");

  const bookingDecision = await gateway.authorizeApiRequest(new Request(taxiUrl("/api/taxi-bookings"), { method: "POST", headers: { "content-type": "application/json" } }), env);
  if (bookingDecision instanceof Response) {
    assert.equal(bookingDecision.status, 401, `an unauthenticated booking attempt is refused: ${bookingDecision.status}`);
  } else {
    assert.equal(bookingDecision.permission, "scheduling.book", "booking a trip requires scheduling.book");
  }
});

// ---------------------------------------------------------------------------------------------
test("Pet Taxi Gate 1 remains UAT honest about Maps and payment", async () => {
  const { db } = taxiWorld();
  const quote = await governance.createTaxiQuote(db, validQuoteInput());

  assert.equal(quote.routeSource, "uat_route_class", "the distance is a route class, never a live Maps lookup");
  assert.equal(quote.productionMapsVerified, false);
  assert.equal(quote.amountDueNow, 0, "no money is taken at quote time");
  assert.equal(quote.paymentMode, "sandbox_deferred");

  const routes = await governance.listTaxiRouteClasses(db);
  const short = routes.find((route) => String(route.route_code) === "taxi-blr-east-short");
  assert.equal(quote.syntheticDistanceKm, Number(short.synthetic_distance_km));
  assert.equal(quote.estimatedDurationMinutes, Number(short.estimated_duration_minutes));

  const spanMinutes = (new Date(quote.scheduledEnd) - new Date(quote.scheduledStart)) / 60_000;
  assert.equal(spanMinutes, Number(short.estimated_duration_minutes), "the drop-off time is the server's arithmetic");
});