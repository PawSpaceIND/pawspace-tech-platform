/*
 * Grooming customer integrity, executed against the governed routes and a real database.
 *
 * This file used to read app/mobile-app/grooming-flow.tsx as text and assert that identifiers such
 * as `customerId:customer.customerId`, `stableBookingInputKey([` and `provider-public-profile?providerId=`
 * appeared in it. Text proves a token was typed. It cannot prove that the booking the server keeps is
 * the signed-in customer's, that a second tap cannot book twice, that a stranger cannot replay a key,
 * or that the "1,248 services" proof a customer sees is computed rather than invented.
 *
 * Every case below drives the REAL scheduling, booking, service-location, payment-sandbox and
 * public-profile routes (and lib/partner-job-feed.ts, lib/grooming-governance.ts) against SQLite
 * through the D1 adapter, with platform-session cookies, and reads what was persisted.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { setupJourney, runCompletedJourney, routeCall, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const { listProviderJobs } = await import("../lib/partner-job-feed.ts");
const { resolveGroomingSubscriptionPlan } = await import("../lib/grooming-governance.ts");

const SCHEDULING = "../../app/api/uat-scheduling/route.ts";
const BOOKINGS = "../../app/api/canonical-bookings/route.ts";
const SANDBOX = "../../app/api/grooming-payment-sandbox/route.ts";
const PROFILE = "../../app/api/provider-public-profile/route.ts";
const DOORSTEP = { latitude: 12.9716, longitude: 77.5946 };
const DAY = 86_400_000;

function config(overrides = {}) {
  const start = new Date(Date.now() + 3 * DAY);
  start.setUTCHours(3, 30, 0, 0);
  return {
    customerId: "CUST-INTEGRITY", customerName: "Priya Nair", phone: "+919900000621", petSourceId: "PET-INTEGRITY", petName: "Simba",
    cityId: "blr", zoneId: "blr-east", pincode: "560038", latitude: DOORSTEP.latitude, longitude: DOORSTEP.longitude,
    preferredProviderId: "groom_arun", groupId: "GROOM-INTEGRITY", start: start.toISOString(), stopAfterCapture: true,
    ...overrides,
  };
}

async function world(t) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  return ctx;
}

/** The scheduling call the customer app makes, sent as the signed-in customer. */
async function schedule(ctx, c, cookie, overrides = {}) {
  const start = new Date(c.start), end = new Date(start.getTime() + 2 * 3_600_000);
  return routeCall(SCHEDULING, "POST", "/api/uat-scheduling", {
    clientRequestId: c.groupId, customerId: c.customerId, petIds: [c.petSourceId], serviceCode: "grooming", cityId: c.cityId, zoneId: c.zoneId,
    serviceAddress: `${c.customerName} service address`, servicePincode: c.pincode, scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(),
    preferredProviderId: c.preferredProviderId, ...overrides,
  }, cookie);
}

/** The booking payload the grooming flow submits, with the fields under test overridable. */
function bookingPayload(c, provider, { total = 1899, pricing = { discount: 0 }, payment, idempotencyKey, scheduleGroupId, customer } = {}) {
  const start = new Date(c.start), end = new Date(start.getTime() + 2 * 3_600_000);
  return {
    idempotencyKey: idempotencyKey ?? c.groupId, scheduleGroupId: scheduleGroupId ?? c.groupId,
    customer: customer ?? { id: c.customerId, name: c.customerName, primaryPhone: c.phone },
    pets: [{ sourceId: c.petSourceId, name: c.petName, species: "dog", breed: "Indie", vaccinationStatus: "vaccinated" }],
    cityId: c.cityId, zoneId: c.zoneId, serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic",
    scheduledStart: start.toISOString(), scheduledEnd: end.toISOString(), provider,
    totalAmount: total, amountDueNow: total,
    payment: payment ?? { method: "upi", mode: "prepaid", status: "created", detail: "grooming checkout" },
    pricing,
  };
}

const book = (payload, cookie) => routeCall(BOOKINGS, "POST", "/api/canonical-bookings", payload, cookie);
/** A request carrying no identity at all - no session cookie, no forwarded staff identity. */
async function bookAnonymously(payload) {
  const { POST } = await import("../app/api/canonical-bookings/route.ts");
  const response = await POST(new Request("https://uat.pawspace.in/api/canonical-bookings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) }));
  return { status: response.status, body: await response.json().catch(() => ({})) };
}
const bookingCount = (ctx, where = "1=1", ...args) => ctx.sqlite.prepare(`SELECT COUNT(*) n FROM canonical_bookings WHERE ${where}`).get(...args).n;

// --- identity ------------------------------------------------------------------------------------

test("the persisted customer identity is the signed-in session subject, never a generated placeholder", async (t) => {
  const ctx = await world(t);
  const c = config();
  const result = await runCompletedJourney(ctx, c);
  assert.equal(result.booked.status, 201, JSON.stringify(result.booked.body));
  const booking = ctx.sqlite.prepare("SELECT customer_id,created_by FROM canonical_bookings WHERE id=?").get(result.bookingId);
  assert.equal(booking.customer_id, c.customerId, "the booking belongs to the session's customer");
  const customer = ctx.sqlite.prepare("SELECT name,primary_phone FROM canonical_customers WHERE id=?").get(c.customerId);
  assert.deepEqual({ ...customer }, { name: c.customerName, primary_phone: c.phone }, "the normalized identity is stored, not a display placeholder");

  // The retired page generated `WEB-<timestamp>` customers and `PawSpace Customer` names when nobody
  // was signed in. The server refuses that identity outright because it is not the session subject.
  const placeholder = await book(bookingPayload({ ...c, groupId: "GROOM-PLACEHOLDER" }, result.provider, {
    customer: { id: `WEB-${Date.now()}`, name: "PawSpace Customer", primaryPhone: "9999999999" },
  }), result.customerCookie);
  assert.equal(placeholder.status, 403, JSON.stringify(placeholder.body));
  assert.equal(bookingCount(ctx, "customer_id LIKE 'WEB-%'"), 0);
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers WHERE id LIKE 'WEB-%' OR name='PawSpace Customer'").get().n, 0, "no placeholder customer is ever created");
  const anonymous = await bookAnonymously(bookingPayload({ ...c, groupId: "GROOM-ANON" }, result.provider));
  assert.ok([401, 403].includes(anonymous.status), `a signed-out booking is refused: ${anonymous.status} ${JSON.stringify(anonymous.body)}`);
  assert.equal(bookingCount(ctx), 1);
});

// --- what the groomer receives -------------------------------------------------------------------

test("the selected safety requirement and add-ons reach the assigned groomer as canonical job facts", async (t) => {
  const ctx = await world(t);
  const c = config();
  await seedOwnedPet(ctx.db, c.customerId, c.petSourceId, c.petName);
  const cookie = await sessionCookie(ctx.db, "customer", c.customerId, `customer:${c.customerId}`);
  const scheduled = await schedule(ctx, c, cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  const provider = scheduled.body.data.provider;

  const invalidAddOn = await book(bookingPayload(c, provider, { total: 1899, pricing: { discount: 0, addOns: ["Diamond spa"] } }), cookie);
  assert.equal(invalidAddOn.status, 409, JSON.stringify(invalidAddOn.body));
  const understated = await book(bookingPayload(c, provider, { total: 1899, pricing: { discount: 0, addOns: ["Tick & flea treatment"] } }), cookie);
  assert.equal(understated.status, 409, "an add-on the client does not pay for is refused");
  assert.match(understated.body.error, /does not match (the )?governed/);

  const booked = await book(bookingPayload(c, provider, {
    total: 1899 + 499,
    pricing: { discount: 0, addOns: ["Tick & flea treatment"], requirements: ["grooming_safety:Aggressive / bite history"] },
  }), cookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const bookingId = booked.body.data.bookingId;
  const pricing = JSON.parse(ctx.sqlite.prepare("SELECT pricing_json FROM canonical_bookings WHERE id=?").get(bookingId).pricing_json);
  assert.deepEqual(pricing.requirements, ["grooming_safety:Aggressive / bite history"], "the safety requirement is persisted on the canonical booking");
  assert.deepEqual(pricing.addOns, ["Tick & flea treatment"]);
  assert.equal(ctx.sqlite.prepare("SELECT total_amount FROM canonical_bookings WHERE id=?").get(bookingId).total_amount, 2398);

  const feed = await listProviderJobs(ctx.db, provider.id);
  const job = [...feed.today, ...feed.upcoming, ...feed.needsAction].find((item) => item.bookingId === bookingId);
  assert.ok(job, "the assigned groomer's feed carries the booking");
  assert.deepEqual(job.safetyRequirements, ["grooming_safety:Aggressive / bite history"]);
  assert.deepEqual(job.addOns, ["Tick & flea treatment"]);
  assert.equal(job.serviceCode, "grooming");
  assert.equal(job.customerFirstName, "Priya", "the groomer sees a first name only");
  assert.equal(JSON.stringify(feed).includes(c.phone), false, "no customer contact data reaches the partner feed");
  const otherFeed = await listProviderJobs(ctx.db, "groom_maa");
  assert.equal([...otherFeed.today, ...otherFeed.upcoming].some((item) => item.bookingId === bookingId), false, "another groomer never sees it");
});

// --- commercial truth --------------------------------------------------------------------------

test("grooming subscription copy is the governed 6 and 12 month commercial truth in D1", async (t) => {
  const ctx = await world(t);
  const six = await resolveGroomingSubscriptionPlan(ctx.db, "sub-6", "blr", "blr-east");
  const twelve = await resolveGroomingSubscriptionPlan(ctx.db, "sub-12", "blr", "blr-east");
  assert.deepEqual(
    { sessions: six.sessions, price: six.singlePrice, validity: six.validityValue, unit: six.validityUnit },
    { sessions: 6, price: 6594, validity: 6, unit: "months" },
  );
  assert.deepEqual(
    { sessions: twelve.sessions, price: twelve.singlePrice, validity: twelve.validityValue, unit: twelve.validityUnit },
    { sessions: 12, price: 11988, validity: 12, unit: "months" },
  );
  const validities = ctx.sqlite.prepare("SELECT DISTINCT validity_value FROM grooming_subscription_plans WHERE city_id='blr' AND active=1 ORDER BY validity_value").all().map((row) => row.validity_value);
  assert.ok(validities.includes(6) && validities.includes(12), `the 6 and 12 month plans are live: ${validities}`);
  assert.ok(!validities.includes(8) && !validities.includes(15), `no 8 or 15 month plan exists to be shown: ${validities}`);
  assert.equal(await resolveGroomingSubscriptionPlan(ctx.db, "sub-8", "blr", "blr-east"), null);
});

test("the coupon and service city come from the verified service location, not a hardcoded geography", async (t) => {
  const ctx = await world(t);
  const bengaluru = await runCompletedJourney(ctx, config());
  assert.equal(bengaluru.location.status, 201, JSON.stringify(bengaluru.location.body));
  assert.deepEqual({ city: bengaluru.location.body.data.cityId, zone: bengaluru.location.body.data.zoneId }, { city: "blr", zone: "blr-east" });
  const chennai = await runCompletedJourney(ctx, config({
    customerId: "CUST-CHENNAI", customerName: "Kavitha", phone: "+919900000622", petSourceId: "PET-CHENNAI", petName: "Rio",
    cityId: "maa", zoneId: "chennai-core", pincode: "600001", latitude: 13.0827, longitude: 80.2707, preferredProviderId: "groom_maa", groupId: "GROOM-CHENNAI",
  }));
  assert.equal(chennai.booked.status, 201, JSON.stringify(chennai.booked.body));
  assert.equal(chennai.location.status, 201, JSON.stringify(chennai.location.body));
  assert.deepEqual({ city: chennai.location.body.data.cityId, zone: chennai.location.body.data.zoneId }, { city: "maa", zone: "chennai-core" }, "the same flow resolves Chennai when the verified address is in Chennai");
  assert.equal(ctx.sqlite.prepare("SELECT city_id FROM canonical_bookings WHERE id=?").get(chennai.bookingId).city_id, "maa");
});

test("confirmation proof is the provider's public profile, computed live from completed work", async (t) => {
  const ctx = await world(t);
  const profile = () => routeCall(PROFILE, "GET", "/api/provider-public-profile?providerId=groom_arun", null, "");
  const fresh = await profile();
  assert.equal(fresh.status, 200, JSON.stringify(fresh.body));
  assert.equal(fresh.body.data.isNewProvider, true, "a provider with no completed work is new, not '1,248 services'");
  assert.equal(fresh.body.data.stats, null);
  assert.equal(fresh.body.data.providerId, "groom_arun");
  for (const key of ["rating", "qualityScore", "address", "phone"]) assert.equal(key in fresh.body.data, false, `${key} is never exposed`);
  assert.equal((await routeCall(PROFILE, "GET", "/api/provider-public-profile?providerId=nobody", null, "")).status, 404);

  let n = 0;
  for (const suffix of ["A", "B", "C"]) {
    const start = new Date(Date.now() + (3 + n) * DAY);
    start.setUTCHours(4, 30, 0, 0); // 10:00 IST; keep the 2-hour journey inside the seeded 09:00-19:00 UAT roster.
    const journey = await runCompletedJourney(ctx, config({ customerId: `CUST-PROOF-${suffix}`, phone: `+91990000063${n++}`, petSourceId: `PET-PROOF-${suffix}`, groupId: `GROOM-PROOF-${suffix}`, start: start.toISOString() }));
    assert.equal(journey.booked.status, 201, JSON.stringify(journey.booked.body));
    ctx.sqlite.prepare("UPDATE canonical_bookings SET status='completed' WHERE id=?").run(journey.bookingId);
  }
  const proven = await profile();
  assert.deepEqual(proven.body.data.stats, { completedServices: 3, happyPets: 3 }, "stats are counted from completed canonical bookings");
  assert.equal(proven.body.data.isNewProvider, false);
});

// --- submission integrity ----------------------------------------------------------------------

test("a second submission of the same booking cannot create two bookings, and an idempotency key is scoped to its customer", async (t) => {
  const ctx = await world(t);
  const c = config();
  await seedOwnedPet(ctx.db, c.customerId, c.petSourceId, c.petName);
  const cookie = await sessionCookie(ctx.db, "customer", c.customerId, `customer:${c.customerId}`);
  const scheduled = await schedule(ctx, c, cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  const payload = bookingPayload(c, scheduled.body.data.provider);

  const first = await book(payload, cookie);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.equal(first.body.data.duplicatePrevented, false);
  const replay = await book(payload, cookie);
  assert.equal(replay.status, 200, JSON.stringify(replay.body));
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(bookingCount(ctx, "idempotency_key=?", c.groupId), 1);

  // The same key from another customer is a conflict, never a replay of somebody else's booking.
  const stranger = { ...c, customerId: "CUST-REPLAY", customerName: "Nikhil", phone: "+919900000641", petSourceId: "PET-REPLAY" };
  await seedOwnedPet(ctx.db, stranger.customerId, stranger.petSourceId, "Coco");
  const strangerCookie = await sessionCookie(ctx.db, "customer", stranger.customerId, `customer:${stranger.customerId}`);
  const foreign = await book(bookingPayload(stranger, scheduled.body.data.provider), strangerCookie);
  assert.equal(foreign.status, 409, JSON.stringify(foreign.body));
  assert.equal(bookingCount(ctx, "customer_id=?", stranger.customerId), 0);
  assert.equal(bookingCount(ctx), 1);
});

test("a schedule preview never reserves capacity; only confirmation does", async (t) => {
  const ctx = await world(t);
  const c = config();
  await seedOwnedPet(ctx.db, c.customerId, c.petSourceId, c.petName);
  const reservations = () => ctx.sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='scheduling_reservations'").get()
    ? ctx.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=?").get(c.groupId).n : 0;
  // A preview is a staff-side read of what the scheduler would do; it holds nothing.
  const preview = await schedule(ctx, c, "", { action: "preview" });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.ok(preview.body.data?.provider || preview.body.data?.candidates || preview.body.data, "a preview still answers with the scheduling decision");
  assert.equal(reservations(), 0, "a preview reserves nothing");
  const cookie = await sessionCookie(ctx.db, "customer", c.customerId, `customer:${c.customerId}`);
  const reserved = await schedule(ctx, c, cookie);
  assert.equal(reserved.status, 200, JSON.stringify(reserved.body));
  assert.ok(reservations() >= 1, "confirmation holds capacity");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM scheduling_reservations WHERE group_id=?").get(c.groupId).status, "assigned");
});

test("pay-now is gated by verified payment and cannot self-confirm", async (t) => {
  const ctx = await world(t);
  const c = config();
  await seedOwnedPet(ctx.db, c.customerId, c.petSourceId, c.petName);
  const cookie = await sessionCookie(ctx.db, "customer", c.customerId, `customer:${c.customerId}`);
  const scheduled = await schedule(ctx, c, cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  // The client claims the money is already captured. The server records a hold and waits for the gateway.
  const claimed = await book(bookingPayload(c, scheduled.body.data.provider, { payment: { method: "upi", mode: "prepaid", status: "captured", detail: "Paid in UAT sandbox" } }), cookie);
  assert.equal(claimed.status, 201, JSON.stringify(claimed.body));
  const bookingId = claimed.body.data.bookingId;
  assert.equal(claimed.body.data.status, "payment_pending", "a self-declared capture does not confirm a booking");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status, "created");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status, "payment_pending");

  await routeCall(SANDBOX, "POST", "/api/grooming-payment-sandbox", { action: "link_order", bookingId, gatewayOrderId: `order_${c.groupId}` });
  const capture = { action: "simulate_event", bookingId, eventType: "payment.captured", eventId: `evt_${c.groupId}`, gatewayPaymentId: `pay_${c.groupId}`, amount: 1899, currency: "INR" };
  const captured = await routeCall(SANDBOX, "POST", "/api/grooming-payment-sandbox", capture);
  assert.equal(captured.status, 201, JSON.stringify(captured.body));
  assert.equal(captured.body.data.result.duplicate, false);
  assert.equal(ctx.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(bookingId).status, "captured", "only gateway evidence marks the payment captured");
  assert.equal(ctx.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(bookingId).status, "confirmed");
  const replay = await routeCall(SANDBOX, "POST", "/api/grooming-payment-sandbox", capture);
  assert.ok([200, 201].includes(replay.status), JSON.stringify(replay.body));
  assert.equal(replay.body.data.result.duplicate, true, "the same gateway event is recognised as a replay");
  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) c FROM payment_gateway_events WHERE provider='razorpay' AND event_id=?").get(`evt_${c.groupId}`).c, 1, "a replayed gateway event is recorded once");
});

test("a base service plus add-on coupon creates the discounted booking and consumes only once",async(t)=>{
  const ctx=await world(t),c=config();
  await seedOwnedPet(ctx.db,c.customerId,c.petSourceId,c.petName);
  const cookie=await sessionCookie(ctx.db,"customer",c.customerId,`customer:${c.customerId}`);
  const scheduled=await schedule(ctx,c,cookie);
  assert.equal(scheduled.status,200,JSON.stringify(scheduled.body));
  const {quoteCoupon}=await import("../lib/coupon-governance.ts");
  const quote=await quoteCoupon(ctx.db,{code:"UATCARE100",customerId:c.customerId,serviceCode:"grooming",cityId:"blr",channel:"customer_app",packageCode:"dog-basic",orderValue:2398,paymentMode:"full",isSubscription:false});
  assert.equal(quote.valid,true,JSON.stringify(quote));
  const payload=bookingPayload(c,scheduled.body.data.provider,{total:2298,pricing:{addOns:["Tick & flea treatment"],couponCode:quote.code,couponQuoteId:quote.quoteId,discount:100}});
  const result=await book(payload,cookie);
  assert.equal(result.status,201,JSON.stringify(result.body));
  const stored=ctx.sqlite.prepare("SELECT total_amount,pricing_json FROM canonical_bookings WHERE id=?").get(result.body.data.bookingId);
  assert.equal(stored.total_amount,2298);
  assert.equal(JSON.parse(stored.pricing_json).addOnTotal,499);
  const replay=await book(payload,cookie);
  assert.ok([200,201].includes(replay.status),JSON.stringify(replay.body));
  assert.equal(ctx.sqlite.prepare("SELECT count(*) n FROM coupon_redemptions WHERE quote_id=?").get(quote.quoteId).n,1);
});

for(const species of ["dog","cat"])test(`young ${species} package validates the saved DOB and rejects an adult before booking writes`,async(t)=>{
  const ctx=await world(t),c=config();
  await seedOwnedPet(ctx.db,c.customerId,c.petSourceId,c.petName);
  const dob=new Date(c.start);dob.setUTCFullYear(dob.getUTCFullYear()-2);
  ctx.sqlite.prepare("UPDATE canonical_pets SET species=?,profile_json=? WHERE id=?").run(species,JSON.stringify({dateOfBirth:dob.toISOString().slice(0,10)}),c.petSourceId);
  const cookie=await sessionCookie(ctx.db,"customer",c.customerId,`customer:${c.customerId}`);
  const scheduled=await schedule(ctx,c,cookie);
  assert.equal(scheduled.status,200,JSON.stringify(scheduled.body));
  const payload=bookingPayload(c,scheduled.body.data.provider,{total:999});
  payload.packageCode="young-basic";payload.packageName="Puppy / Kitten Bath & Basic";payload.pets[0].species=species;
  const refused=await book(payload,cookie);
  assert.equal(refused.status,409,JSON.stringify(refused.body));
  assert.match(refused.body.error,/Adult/);
  assert.equal(bookingCount(ctx),0);
  const youngDob=new Date(c.start);youngDob.setUTCMonth(youngDob.getUTCMonth()-3);
  ctx.sqlite.prepare("UPDATE canonical_pets SET profile_json=? WHERE id=?").run(JSON.stringify({dateOfBirth:youngDob.toISOString().slice(0,10)}),c.petSourceId);
  const allowed=await book(payload,cookie);
  assert.equal(allowed.status,201,JSON.stringify(allowed.body));
});

test("a cat cannot receive tick treatment even if the client calls the saved animal a dog",async(t)=>{
  const ctx=await world(t),c=config();
  await seedOwnedPet(ctx.db,c.customerId,c.petSourceId,c.petName);
  ctx.sqlite.prepare("UPDATE canonical_pets SET species='cat' WHERE id=?").run(c.petSourceId);
  const cookie=await sessionCookie(ctx.db,"customer",c.customerId,`customer:${c.customerId}`);
  const scheduled=await schedule(ctx,c,cookie);
  assert.equal(scheduled.status,200,JSON.stringify(scheduled.body));
  const result=await book(bookingPayload(c,scheduled.body.data.provider,{total:2398,pricing:{discount:0,addOns:["Tick & flea treatment"]}}),cookie);
  assert.equal(result.status,409,JSON.stringify(result.body));
  assert.match(result.body.error,/species|Tick/);
  assert.equal(bookingCount(ctx),0);
});

// ---------------------------------------------------------------------------------------------------
// CodeQL alert #55, js/user-controlled-bypass (CWE-290 / CWE-807). /api/grooming-payment-sandbox is one
// endpoint serving five actions, and the caller supplies the action in the request body. That value
// selects the authorization branch: "request_after_service" runs under bookings.view plus provider
// ownership, everything else under payments.manage. Each branch does enforce the permission its own
// work needs, so there is no escalation — but the action itself was only checked for emptiness, so an
// unrecognised value fell past every branch and was served by the gateway-event simulator at the end.
//
// The remedy CodeQL itself prescribes is to validate against a fixed list of expected values before the
// value can reach a security decision. These cases execute that: the route is driven with real bodies
// and the persisted state is read back.
// ---------------------------------------------------------------------------------------------------

test("an unrecognised payment-sandbox action is refused, not silently treated as a gateway event", async (t) => {
  const ctx = await world(t), c = config();
  const { bookingId } = await runCompletedJourney(ctx, c);
  const before = ctx.sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_events").get().n;

  for (const action of ["escalate", "SIMULATE_EVENT", "simulate_event ", "", "__proto__"]) {
    const response = await routeCall(SANDBOX, "POST", "/api/grooming-payment-sandbox", {
      action, bookingId, eventType: "payment.captured", eventId: `evt_reject_${action || "empty"}`, amount: 1899, currency: "INR",
    });
    assert.equal(response.status, 400, `${JSON.stringify(action)} must be refused, got ${response.status}: ${JSON.stringify(response.body)}`);
  }

  assert.equal(ctx.sqlite.prepare("SELECT COUNT(*) n FROM payment_gateway_events").get().n, before,
    "a refused action must not reach the gateway-event simulator");
});

test("the five supported payment-sandbox actions are a fixed list the request body cannot extend", () => {
  const source = fs.readFileSync(new URL("../app/api/grooming-payment-sandbox/route.ts", import.meta.url), "utf8");
  assert.match(source, /const POST_ACTIONS=\["create_order","initiate_refund","link_order","simulate_event","request_after_service"\] as const;/);
  assert.match(source, /const action=POST_ACTIONS\.find\(candidate=>candidate===input\.action\);/,
    "the body value must be resolved against the fixed list before it decides anything");
  // Every branch, including the authorization fork, must read the validated literal - never the raw
  // body field, which is what made this a user-controlled security decision.
  const post = source.slice(source.indexOf("export async function POST"));
  assert.doesNotMatch(post, /if\(input\.action===/, "no branch may dispatch on the unvalidated body field");
  for (const branch of ["request_after_service", "create_order", "initiate_refund", "link_order"]) {
    assert.match(post, new RegExp(`if\\(action==="${branch}"\\)`), `${branch} must dispatch on the validated action`);
  }
  assert.match(post, /if\(action!=="simulate_event"\)return json\(\{error:"Unsupported action"\},400\);/,
    "the final branch must be named, so a newly added action cannot inherit the gateway-event simulator");
});
