/*
 * Dog Training coupons, executed end to end against the real routes and a real database.
 *
 * QA 2026-09-26: /mobile-app?service=dog_training, Review & pay, "Pay 100% upfront" -> UATCARE100 showed
 * "APPLIED · you save ₹100" (the governed coupon engine, /api/coupon-governance, returned valid), then every
 * Training quote refused the same code with 409 "Training coupon is not active or eligible" and Pay stayed on
 * "Refreshing server quote…". WELCOME behaved the same. The review step priced the coupon through the governed
 * engine while the Training quote only read training_coupon_rules, which nothing seeds - two coupon systems,
 * so no coupon the app offered could ever reach a Training booking.
 *
 * The Training quote now binds the governed coupon quote the review step obtained (reading it, spending
 * nothing), and the booking must redeem that same coupon quote in its own batch. These cases prove the
 * discount reaches the quote, the booking total and the payment exactly once, and every way around that fails.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const commercial = await import("../lib/training-commercial-governance.ts");

const TRAINER = "train_kiran";
const CUSTOMER = { id: "CUST-TRN-COUPON", name: "Asha Rao", phone: "+919900000801", pet: "PET-TRN-COUPON" };
const STRANGER = { id: "CUST-TRN-COUPON-OTHER", name: "Other Person", phone: "+919900000802", pet: "PET-TRN-COUPON-OTHER" };
const PACKAGE = "training-2-starter", PRICE = 3500;
const DAY = 24 * 60 * 60_000;

function futureStart(days) {
  const start = new Date(Date.now() + days * DAY);
  start.setUTCHours(5, 30, 0, 0);
  return start;
}

async function customerWorld(t) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  await seedOwnedPet(ctx.db, CUSTOMER.id, CUSTOMER.pet, "Bruno");
  await seedOwnedPet(ctx.db, STRANGER.id, STRANGER.pet, "Pepper");
  const cookie = await sessionCookie(ctx.db, "customer", CUSTOMER.id, `customer:${CUSTOMER.id}`);
  return { ...ctx, cookie };
}

/** Exactly what CouponField sends for the Training review step (coupon-field.tsx -> quoteGovernedCoupon). */
const couponQuote = (ctx, code, overrides = {}, cookie = ctx.cookie) => routeCall("../../app/api/coupon-governance/route.ts", "POST", "/api/coupon-governance", {
  action: "quote",
  input: { code, customerId: CUSTOMER.id, serviceCode: "dog_training", cityId: "blr", channel: "customer_app", packageCode: PACKAGE, orderValue: PRICE, paymentMode: "full", isSubscription: false, ...overrides },
}, cookie);
/** The anonymous Training quote route the review step calls next. */
const trainingQuote = (start, body = {}) => routeCall("../../app/api/training-commercial/route.ts", "POST", "/api/training-commercial", {
  packageCode: PACKAGE, petCount: 1, scheduledStart: start.toISOString(), paymentMode: "prepaid", ...body,
});
const schedule = (ctx, quote, start) => routeCall("../../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
  clientRequestId: `trn-coupon-${quote.quoteId}`, customerId: CUSTOMER.id, petIds: [CUSTOMER.pet],
  serviceCode: "dog_training", cityId: "blr", zoneId: "blr-east",
  serviceAddress: "14 Indiranagar 100 Feet Road, Bengaluru", servicePincode: "560038",
  scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
  occurrences: quote.sessions, cadenceDays: 7, preferredProviderId: TRAINER,
}, ctx.cookie);
/** The booking the review step's confirm() sends: amounts and coupon come from the server quote itself. */
const bookingPayload = (quote, scheduled, start, pricing = {}) => ({
  idempotencyKey: `training-coupon:${quote.quoteId}:${CUSTOMER.id}`, scheduleGroupId: scheduled.body.data.groupId,
  customer: { id: CUSTOMER.id, name: CUSTOMER.name, primaryPhone: CUSTOMER.phone },
  pets: [{ sourceId: CUSTOMER.pet, name: "Bruno", species: "dog", breed: "Indie", vaccinationStatus: "verified" }],
  cityId: "blr", zoneId: "blr-east", serviceCode: "dog_training", packageCode: quote.packageCode, packageName: quote.packageName,
  scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + quote.minutesPerSession * 60_000).toISOString(),
  provider: scheduled.body.data.provider, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow,
  payment: { method: "payment_link", mode: quote.paymentMode, status: "created", detail: "Awaiting a verified payment event" },
  pricing: { discount: quote.discount, couponCode: quote.couponCode || undefined, couponQuoteId: quote.couponQuoteId || undefined, trainingQuoteId: quote.quoteId, ...pricing },
});
const book = (ctx, payload) => routeCall("../../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", payload, ctx.cookie);
const count = (ctx, sql, ...args) => ctx.sqlite.prepare(sql).get(...args).n;

test("the coupon the review step shows as applied is the discount the Training quote, booking and payment carry", async (t) => {
  const ctx = await customerWorld(t);
  const start = futureStart(5);

  const coupon = await couponQuote(ctx, "UATCARE100");
  assert.equal(coupon.status, 200, JSON.stringify(coupon.body));
  assert.equal(coupon.body.data.valid, true);
  assert.equal(coupon.body.data.discount, 100);

  // The defect: the same code, as a bare code, is still not a Training discount - the anonymous route has no
  // customer to check eligibility or limits against, so only the governed coupon quote can be honoured.
  const bare = await trainingQuote(start, { couponCode: "UATCARE100" });
  assert.equal(bare.status, 409, JSON.stringify(bare.body));

  const quoted = await trainingQuote(start, { couponCode: "UATCARE100", couponQuoteId: coupon.body.data.quoteId });
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  const quote = quoted.body.data;
  assert.deepEqual(
    { basePrice: quote.basePrice, discount: quote.discount, totalAmount: quote.totalAmount, amountDueNow: quote.amountDueNow, couponCode: quote.couponCode, couponQuoteId: quote.couponQuoteId },
    { basePrice: PRICE, discount: 100, totalAmount: PRICE - 100, amountDueNow: PRICE - 100, couponCode: "UATCARE100", couponQuoteId: coupon.body.data.quoteId },
    "the governed discount is bound into the Training quote the Pay button shows",
  );
  // Quoting read the coupon quote and spent nothing: the anonymous route consumes no coupon budget.
  assert.equal(ctx.sqlite.prepare("SELECT status FROM coupon_quotes WHERE id=?").get(quote.couponQuoteId).status, "open");
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM coupon_redemptions"), 0);

  const scheduled = await schedule(ctx, quote, start);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  const booked = await book(ctx, bookingPayload(quote, scheduled, start));
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const bookingId = booked.body.data.bookingId;
  assert.equal(booked.body.data.status, "payment_pending", "verify-first: the discounted booking still waits for a verified payment");

  const booking = ctx.sqlite.prepare("SELECT total_amount,pricing_json FROM canonical_bookings WHERE id=?").get(bookingId);
  assert.equal(booking.total_amount, PRICE - 100, "the booking total is the discounted server quote");
  const pricing = JSON.parse(booking.pricing_json);
  assert.deepEqual({ discount: pricing.discount, couponCode: pricing.couponCode, couponQuoteId: pricing.couponQuoteId }, { discount: 100, couponCode: "UATCARE100", couponQuoteId: quote.couponQuoteId });
  const payment = ctx.sqlite.prepare("SELECT amount,amount_due_now FROM booking_payments WHERE booking_id=?").get(bookingId);
  assert.deepEqual({ ...payment }, { amount: PRICE - 100, amount_due_now: PRICE - 100 }, "the payment the gateway order is built from carries the discount");

  const redemption = ctx.sqlite.prepare("SELECT quote_id,booking_id,customer_id,code,discount_amount,status FROM coupon_redemptions").all();
  assert.deepEqual(redemption.map((row) => ({ ...row })), [{ quote_id: quote.couponQuoteId, booking_id: bookingId, customer_id: CUSTOMER.id, code: "UATCARE100", discount_amount: 100, status: "consumed" }], "the coupon is redeemed once, by this booking, in the booking's own batch");
  assert.deepEqual({ ...ctx.sqlite.prepare("SELECT status,booking_id FROM coupon_quotes WHERE id=?").get(quote.couponQuoteId) }, { status: "consumed", booking_id: bookingId });
  assert.equal(ctx.sqlite.prepare("SELECT used_booking_id FROM training_commercial_quotes WHERE id=?").get(quote.quoteId).used_booking_id, bookingId);
  // Finance funds a Training booking only while its quote total equals the booking total (training-payment-eligibility).
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM canonical_bookings b JOIN training_booking_quote_links l ON l.booking_id=b.id JOIN training_commercial_quotes q ON q.id=l.quote_id WHERE b.id=? AND q.total_amount=b.total_amount", bookingId), 1);
  const funding = await commercial.trainingQuotePaymentState(ctx.db, quote.quoteId);
  assert.deepEqual({ status: funding.status, totalAmount: funding.totalAmount, remainingAmount: funding.remainingAmount }, { status: "UNPAID", totalAmount: PRICE - 100, remainingAmount: PRICE - 100 }, "the amount still owed is the discounted total");

  const replay = await book(ctx, bookingPayload(quote, scheduled, start));
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM coupon_redemptions"), 1, "a replayed booking never redeems twice");
});

test("the auto-applied welcome coupon reaches the Training quote too", async (t) => {
  const ctx = await customerWorld(t);
  const offers = await routeCall("../../app/api/customer-offers/route.ts", "GET", `/api/customer-offers?customerId=${CUSTOMER.id}`, null, ctx.cookie);
  assert.equal(offers.status, 200, JSON.stringify(offers.body));
  assert.equal(offers.body.data.autoApply?.code, "WELCOME", "a new customer's review step auto-applies WELCOME");
  const coupon = await couponQuote(ctx, "WELCOME");
  assert.equal(coupon.status, 200, JSON.stringify(coupon.body));
  const quoted = await trainingQuote(futureStart(5), { couponCode: "WELCOME", couponQuoteId: coupon.body.data.quoteId });
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  assert.equal(quoted.body.data.discount, 300, "15% of the plan, capped at ₹300");
  assert.equal(quoted.body.data.totalAmount, PRICE - 300);
});

test("a governed Training discount is never booked without redeeming its own coupon quote", async (t) => {
  const ctx = await customerWorld(t);
  const coupon = await couponQuote(ctx, "UATCARE100");
  assert.equal(coupon.status, 200, JSON.stringify(coupon.body));
  const couponQuoteId = coupon.body.data.quoteId;
  const firstStart = futureStart(5), secondStart = futureStart(20);
  // Two Training quotes bound to the SAME coupon quote while it is still open.
  const first = (await trainingQuote(firstStart, { couponCode: "UATCARE100", couponQuoteId })).body.data;
  const second = (await trainingQuote(secondStart, { couponCode: "UATCARE100", couponQuoteId })).body.data;
  assert.equal(first.discount, 100);
  assert.equal(second.discount, 100);
  const bookings = () => count(ctx, "SELECT COUNT(*) n FROM canonical_bookings WHERE customer_id=?", CUSTOMER.id);

  const scheduled = await schedule(ctx, first, firstStart);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  const unredeemed = await book(ctx, bookingPayload(first, scheduled, firstStart, { couponQuoteId: undefined }));
  assert.equal(unredeemed.status, 409, JSON.stringify(unredeemed.body));
  assert.match(unredeemed.body.error, /Training coupon does not match the server quote/);
  assert.equal(bookings(), 0, "the discounted quote cannot be booked while skipping the redemption");
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM coupon_redemptions"), 0);

  const booked = await book(ctx, bookingPayload(first, scheduled, firstStart));
  assert.equal(booked.status, 201, JSON.stringify(booked.body));

  // The coupon is spent: the second quote that also priced it cannot buy a second discounted programme.
  const secondSchedule = await schedule(ctx, second, secondStart);
  assert.equal(secondSchedule.status, 200, JSON.stringify(secondSchedule.body));
  const reused = await book(ctx, bookingPayload(second, secondSchedule, secondStart));
  assert.notEqual(reused.status, 201, JSON.stringify(reused.body));
  assert.match(reused.body.error, /Coupon quote is no longer open/);
  const skipped = await book(ctx, bookingPayload(second, secondSchedule, secondStart, { couponQuoteId: undefined }));
  assert.equal(skipped.status, 409, "nor book the discount by leaving the spent coupon out");
  assert.equal(bookings(), 1);
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM coupon_redemptions"), 1);
  const late = await trainingQuote(futureStart(30), { couponCode: "UATCARE100", couponQuoteId });
  assert.equal(late.status, 409, JSON.stringify(late.body));
  assert.match(late.body.error, /expired or was already used/);

  // A coupon quote cannot ride on a Training quote that did not price it.
  const fresh = await couponQuote(ctx, "UATCARE100");
  const plain = (await trainingQuote(futureStart(40))).body.data;
  const plainStart = futureStart(40), plainSchedule = await schedule(ctx, plain, plainStart);
  const smuggled = await book(ctx, bookingPayload(plain, plainSchedule, plainStart, { couponQuoteId: fresh.body.data.quoteId, discount: 0 }));
  assert.notEqual(smuggled.status, 201, JSON.stringify(smuggled.body));
  assert.equal(bookings(), 1);
});

test("another customer's coupon quote cannot discount this customer's Training booking", async (t) => {
  const ctx = await customerWorld(t);
  const strangerCookie = await sessionCookie(ctx.db, "customer", STRANGER.id, `customer:${STRANGER.id}`);
  const theirs = await couponQuote(ctx, "UATCARE100", { customerId: STRANGER.id }, strangerCookie);
  assert.equal(theirs.status, 200, JSON.stringify(theirs.body));
  const start = futureStart(5);
  const quote = (await trainingQuote(start, { couponCode: "UATCARE100", couponQuoteId: theirs.body.data.quoteId })).body.data;
  const scheduled = await schedule(ctx, quote, start);
  const booked = await book(ctx, bookingPayload(quote, scheduled, start));
  assert.notEqual(booked.status, 201, JSON.stringify(booked.body));
  assert.match(booked.body.error, /customer mismatch/);
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM canonical_bookings"), 0);
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM coupon_redemptions"), 0);
});

test("the Training quote refuses a governed coupon it cannot honour, and writes no quote", async (t) => {
  const ctx = await customerWorld(t);
  const start = futureStart(5);
  const quotes = () => count(ctx, "SELECT COUNT(*) n FROM training_commercial_quotes");
  const refused = async (body, pattern, message) => {
    const response = await trainingQuote(start, body);
    assert.equal(response.status, 409, `${message}: ${JSON.stringify(response.body)}`);
    assert.match(response.body.error, pattern, message);
  };
  const coupon = await couponQuote(ctx, "UATCARE100");
  const couponQuoteId = coupon.body.data.quoteId;

  await refused({ paymentMode: "split", couponCode: "UATCARE100", couponQuoteId }, /Training coupons require full prepaid payment/, "coupons stay prepaid-only");
  await refused({ paymentMode: "split", couponQuoteId }, /Training coupons require full prepaid payment/, "with or without the code");
  await refused({ packageCode: "training-4-puppy", couponCode: "UATCARE100", couponQuoteId }, /different plan or price/, "a coupon quoted for another plan");
  await refused({ couponCode: "WELCOME", couponQuoteId }, /not active or eligible/, "a code that is not the coupon quote's code");
  await refused({ couponQuoteId: "CPQ-NOT-A-QUOTE" }, /not active or eligible/, "an unknown coupon quote");

  const otherPrice = await couponQuote(ctx, "UATCARE100", { orderValue: PRICE + 500 });
  await refused({ couponCode: "UATCARE100", couponQuoteId: otherPrice.body.data.quoteId }, /different plan or price/, "a coupon quoted against a different price");
  const groomingCoupon = await couponQuote(ctx, "UATCARE100", { serviceCode: "grooming" });
  await refused({ couponCode: "UATCARE100", couponQuoteId: groomingCoupon.body.data.quoteId }, /not active or eligible/, "a coupon quoted for another service");

  ctx.sqlite.prepare("UPDATE coupon_quotes SET expires_at=? WHERE id=?").run(Date.now() - 1, couponQuoteId);
  await refused({ couponCode: "UATCARE100", couponQuoteId }, /expired or was already used/, "an expired coupon quote");
  ctx.sqlite.prepare("UPDATE coupon_quotes SET expires_at=? WHERE id=?").run(Date.now() + 60_000, couponQuoteId);
  ctx.sqlite.prepare("UPDATE coupon_campaigns SET status='paused' WHERE code='UATCARE100'").run();
  await refused({ couponCode: "UATCARE100", couponQuoteId }, /not active or eligible/, "a paused campaign");

  assert.equal(quotes(), 0, "no refused request left a Training quote behind");
  assert.equal(count(ctx, "SELECT COUNT(*) n FROM coupon_redemptions"), 0);
});

test("an operator-configured training_coupon_rules code still prices and books without a governed coupon quote", async (t) => {
  const ctx = await customerWorld(t);
  await commercial.ensureTrainingCommercialTables(ctx.db);
  ctx.sqlite.prepare("INSERT INTO training_coupon_rules (code,discount_type,value,max_discount,status,effective_from,effective_to,updated_by,updated_at) VALUES ('TRAIN10','percent',10,300,'active','2026-01-01',NULL,'ops',?)").run(Date.now());
  const start = futureStart(5);
  const quoted = await trainingQuote(start, { couponCode: "train10" });
  assert.equal(quoted.status, 201, JSON.stringify(quoted.body));
  const quote = quoted.body.data;
  assert.deepEqual({ discount: quote.discount, totalAmount: quote.totalAmount, couponCode: quote.couponCode, couponQuoteId: quote.couponQuoteId }, { discount: 300, totalAmount: PRICE - 300, couponCode: "TRAIN10", couponQuoteId: null });
  const scheduled = await schedule(ctx, quote, start);
  const booked = await book(ctx, bookingPayload(quote, scheduled, start));
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(ctx.sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id=?").get(booked.body.data.bookingId).total_amount, PRICE - 300);
});

test("an existing database gains the coupon link column without losing its Training quotes", async (t) => {
  const ctx = await customerWorld(t);
  ctx.sqlite.exec("CREATE TABLE training_commercial_quotes (id TEXT PRIMARY KEY,package_code TEXT NOT NULL,package_version INTEGER NOT NULL,pet_count INTEGER NOT NULL,scheduled_start TEXT NOT NULL,payment_mode TEXT NOT NULL,coupon_code TEXT,discount REAL NOT NULL DEFAULT 0,total_amount REAL NOT NULL,amount_due_now REAL NOT NULL,minutes_per_session INTEGER NOT NULL,sessions INTEGER NOT NULL,validity_days INTEGER NOT NULL,expires_at INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,used_at INTEGER,used_booking_id TEXT)");
  ctx.sqlite.prepare("INSERT INTO training_commercial_quotes (id,package_code,package_version,pet_count,scheduled_start,payment_mode,discount,total_amount,amount_due_now,minutes_per_session,sessions,validity_days,expires_at,created_at) VALUES ('TQ-LEGACY','training-2-starter',1,1,?,'prepaid',0,3500,3500,60,2,31,?,?)").run(futureStart(5).toISOString(), Date.now() + 60_000, Date.now());
  await commercial.ensureTrainingCommercialTables(ctx.db);
  await commercial.ensureTrainingCommercialTables(ctx.db);
  const columns = ctx.sqlite.prepare("PRAGMA table_info(training_commercial_quotes)").all().map((column) => String(column.name));
  assert.ok(columns.includes("coupon_quote_id"));
  assert.equal(ctx.sqlite.prepare("SELECT coupon_quote_id FROM training_commercial_quotes WHERE id='TQ-LEGACY'").get().coupon_quote_id, null, "a pre-existing quote carries no governed coupon");
});

/*
 * One residual source pin. No server call can observe what the review step sends, and the defect was exactly
 * a UI mismatch: the coupon was quoted for the default "uat-default" package and its quote id was dropped, so
 * nothing the Training quote or booking could redeem ever left the screen.
 */
test("the Training review step quotes the coupon for the programme and forwards the governed coupon quote", () => {
  const flow = readFileSync(new URL("../app/mobile-app/training-flow.tsx", import.meta.url), "utf8");
  const field = flow.slice(flow.indexOf("<CouponField"), flow.indexOf("/>", flow.indexOf("<CouponField")));
  assert.match(field, /packageCode=\{plan\.packageCode\}/, "the coupon is quoted for the programme being booked");
  assert.match(field, /cityId=\{coverage\?\.cityId\}/, "and for the customer's service city");
  assert.match(field, /setCouponQuoteId\(quoteId\|\|""\)/, "the governed coupon quote id is kept");
  assert.match(flow, /couponQuoteId:withCoupon\?couponQuoteId:undefined/, "the Training quote is asked to honour that coupon quote");
  const confirm = flow.slice(flow.indexOf("confirm = async"), flow.indexOf("if (confirmed)"));
  assert.match(confirm, /couponQuoteId:quote\.couponQuoteId\|\|undefined/, "the booking redeems the coupon quote the server quote bound");
  assert.doesNotMatch(confirm, /couponCode:couponCode\|\|undefined/, "the booking records the server quote's coupon, not screen state");
});
