/*
 * Grooming customer integrity, EXECUTED.
 *
 * This file used to read app/mobile-app/grooming-flow.tsx, lib/partner-job-feed.ts and
 * lib/test-transaction.ts as strings and regex-match them: `customerId:customer.customerId`,
 * `safetyRequirements:pricingList(...)`, `"payment_pending"`. A regex over source proves that text is
 * present; it cannot prove that a booking carries the signed-in customer, that a groomer sees the
 * safety requirement, or that a prepaid booking waits for verification.
 *
 * Every property the old file described is asserted here against the thing that actually does it:
 * the real booking routes on a real SQLite-backed D1 as a signed-in customer session, the real job
 * feed, the real public-profile assembly, the real fingerprint function, and the flow component itself
 * rendered with react-dom/server. The one client-only property that cannot be executed (a useRef
 * double-click lock inside an event handler) keeps a single source-text assertion, marked as such.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { setupJourney, sessionCookie } from "./helpers/grooming-journey-harness.mjs";
import { seedOwnedPet } from "./helpers/saved-pet-fixture.mjs";

const ORIGIN = "https://uat.pawspace.in";
const CUSTOMER = { id: "CUST-GI-1", name: "Mira Rao", phone: "+919900000515", petId: "PET-GI-1" };
const GROOMER = "groom_arun";

const feed = await import("../lib/partner-job-feed.ts");
const fingerprint = await import("../lib/booking-input-fingerprint.ts");
const governance = await import("../lib/grooming-governance.ts");
const coupons = await import("../lib/coupon-governance.ts");
const profile = await import("../lib/provider-public-profile.ts");

async function call(modulePath, method, path, body, cookie) {
  const route = await import(modulePath);
  const request = new Request(`${ORIGIN}${path}`, {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const response = await route[method](request);
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { error: text }; }
  return { status: response.status, body: parsed };
}

/** A signed-in customer with one saved dog, as the platform session presents them to the flow. */
async function signedIn(t, customer = CUSTOMER) {
  const ctx = await setupJourney();
  t.after(ctx.close);
  await seedOwnedPet(ctx.db, customer.id, customer.petId, "Milo");
  const cookie = await sessionCookie(ctx.db, "customer", customer.id, `customer:${customer.id}`);
  return { ...ctx, customer, cookie };
}

function slot(daysAhead = 3) {
  const start = new Date(Date.now() + daysAhead * 86_400_000);
  start.setUTCHours(3, 30, 0, 0);
  return { scheduledStart: start.toISOString(), scheduledEnd: new Date(start.getTime() + 2 * 3_600_000).toISOString() };
}

/** The payloads the governed flow sends: a reservation, then the canonical booking bound to it. */
async function reserve(f, requestId, window = slot()) {
  const scheduled = await call("../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    clientRequestId: requestId, customerId: f.customer.id, petIds: [f.customer.petId], serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", serviceAddress: "12 MG Road", servicePincode: "560038", ...window, preferredProviderId: GROOMER,
  }, f.cookie);
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.body));
  return { ...window, decision: scheduled.body.data };
}

const bookingPayload = (f, requestId, held, overrides = {}) => ({
  idempotencyKey: requestId, scheduleGroupId: held.decision.groupId,
  customer: { id: f.customer.id, name: f.customer.name, primaryPhone: f.customer.phone },
  pets: [{ sourceId: f.customer.petId, name: "Milo", species: "dog" }],
  cityId: "blr", zoneId: "blr-east", serviceCode: "grooming", packageCode: "dog-basic", packageName: "Bath & Basic",
  scheduledStart: held.scheduledStart, scheduledEnd: held.scheduledEnd, provider: held.decision.provider,
  totalAmount: 1899, amountDueNow: 0,
  payment: { method: "cash", mode: "pay_after_service", status: "created", detail: "Pay after service" },
  pricing: { discount: 0, addOns: [], requirements: ["grooming_safety:aggressive"] },
  ...overrides,
});

test("grooming checkout persists the session-owned customer identity instead of generated placeholders", async (t) => {
  const f = await signedIn(t);
  const held = await reserve(f, "gi-identity");
  const booked = await call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", bookingPayload(f, "gi-identity", held), f.cookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(booked.body.data.customerId, CUSTOMER.id, "the booking belongs to the session subject");

  const stored = f.sqlite.prepare("SELECT id,name,primary_phone FROM canonical_customers WHERE id=?").get(CUSTOMER.id);
  assert.deepEqual({ ...stored }, { id: CUSTOMER.id, name: CUSTOMER.name, primary_phone: CUSTOMER.phone }, "the customer record carries the real name and number");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers WHERE name LIKE 'PawSpace Customer%' OR id LIKE 'WEB-%'").get().n, 0, "no placeholder identity was constructed");

  // A payload naming a customer the session does not own cannot construct an identity at all.
  const forged = await call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", bookingPayload(f, "gi-forged", held, { customer: { id: "CUST-SOMEONE-ELSE", name: "Placeholder", primaryPhone: "+910000000000" } }), f.cookie);
  assert.equal(forged.status, 403, JSON.stringify(forged.body));
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_customers WHERE id='CUST-SOMEONE-ELSE'").get().n, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings").get().n, 1);
});

test("the entry page derives the customer from the platform session, never from a generated web id", async (t) => {
  const f = await signedIn(t);
  f.sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,created_at,updated_at) VALUES (?,?,?,?,?,?)").run(CUSTOMER.id, "blr", CUSTOMER.name, CUSTOMER.phone, Date.now(), Date.now());
  const mine = await call("../app/api/customer-account/route.ts", "GET", "/api/customer-account", null, f.cookie);
  assert.equal(mine.status, 200, JSON.stringify(mine.body));
  assert.deepEqual({ id: mine.body.data.customerId, name: mine.body.data.name }, { id: CUSTOMER.id, name: CUSTOMER.name }, "no id is sent; the server names the subject");
  const anonymous = await call("../app/api/customer-account/route.ts", "GET", "/api/customer-account", null, "");
  assert.equal(anonymous.status, 401, "without a verified session there is no customer to book as");
  assert.match(String(anonymous.body.error), /Authentication required|Verified customer identity is required/);
});

test("grooming checkout persists the selected safety requirement and the assigned groomer receives it with the add-ons", async (t) => {
  const f = await signedIn(t);
  const held = await reserve(f, "gi-safety");
  const booked = await call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", bookingPayload(f, "gi-safety", held, {
    totalAmount: 1899 + 499, pricing: { discount: 0, addOns: ["Tick & flea treatment"], requirements: ["grooming_safety:aggressive", "grooming_special:Muzzle available at home"] },
  }), f.cookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  const pricing = JSON.parse(f.sqlite.prepare("SELECT pricing_json FROM canonical_bookings WHERE id=?").get(booked.body.data.bookingId).pricing_json);
  assert.deepEqual({ requirements: pricing.requirements, addOns: pricing.addOns, addOnTotal: pricing.addOnTotal }, { requirements: ["grooming_safety:aggressive", "grooming_special:Muzzle available at home"], addOns: ["Tick & flea treatment"], addOnTotal: 499 });

  const jobs = await feed.listProviderJobs(f.db, GROOMER);
  const job = [...jobs.upcoming, ...jobs.today, ...jobs.needsAction].find((item) => item.bookingId === booked.body.data.bookingId);
  assert.ok(job, "the booking reaches the assigned groomer's feed");
  assert.deepEqual({ service: job.serviceCode, safety: job.safetyRequirements, addOns: job.addOns, customer: job.customerFirstName }, { service: "grooming", safety: ["grooming_safety:aggressive", "grooming_special:Muzzle available at home"], addOns: ["Tick & flea treatment"], customer: "Mira" });
  assert.doesNotMatch(JSON.stringify(job), /9900000515|MG Road|Rao/, "the partner surface never carries the customer's contact data");
  assert.deepEqual((await feed.listProviderJobs(f.db, "groom_priya")).upcoming.map((item) => item.bookingId), [], "another groomer does not see the job");
});

test("grooming subscription copy matches governed 6 and 12 month commercial truth", async (t) => {
  const f = await signedIn(t);
  const plans = {};
  for (const code of ["sub-6", "sub-12"]) plans[code] = await governance.resolveGroomingSubscriptionPlan(f.db, code, "blr", "blr-east");
  assert.deepEqual(
    Object.fromEntries(Object.entries(plans).map(([code, plan]) => [code, { sessions: plan.sessions, price: plan.singlePrice, validity: `${plan.validityValue} ${plan.validityUnit}` }])),
    { "sub-6": { sessions: 6, price: 6594, validity: "6 months" }, "sub-12": { sessions: 12, price: 11988, validity: "12 months" } },
  );
  const purchase = await governance.governGroomingBooking(f.db, { packageCode: "sub-6", pets: [{ species: "dog" }], submittedTotal: 6594, submittedAmountDueNow: 6594, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" });
  assert.equal(purchase.subscriptionPlan?.validityValue, 6);

  // The flow's plan cards, rendered: each governed plan appears with exactly the governed price and
  // validity, and no invented validity survives.
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: GroomingFlow } = await import("../app/mobile-app/grooming-flow.tsx");
  const text = renderToStaticMarkup(React.createElement(GroomingFlow, { customer: null, initial: { type: "dog", packId: "basic" } })).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const money = (value) => new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 }).format(value);
  for (const plan of Object.values(plans)) {
    assert.ok(text.includes(`${plan.sessions} sessions ${money(plan.singlePrice)}`), `${plan.code} renders the governed price`);
    assert.ok(text.includes(`Valid ${plan.validityValue} months`), `${plan.code} renders the governed validity`);
  }
  assert.doesNotMatch(text, /Valid (8|15) months/, "no plan carries a validity the ledger does not");
});

test("coupon quote is governed by the verified service-location city rather than a hardcoded geography", async (t) => {
  const f = await signedIn(t);
  const quote = (cityId) => coupons.quoteCoupon(f.db, { code: "UATCARE100", customerId: CUSTOMER.id, serviceCode: "grooming", cityId, channel: "customer_app", packageCode: "dog-basic", orderValue: 1899, paymentMode: "after_service", isSubscription: false });
  const bengaluru = await quote("blr");
  assert.deepEqual({ valid: bengaluru.valid, discount: bengaluru.discount }, { valid: true, discount: 100 });
  const chennai = await quote("maa");
  assert.deepEqual({ valid: chennai.valid, discount: chennai.discount, error: chennai.error }, { valid: false, discount: 0, error: "Coupon is not eligible in this city" }, "the same coupon prices differently by city, so the flow must pass the verified one");
  const unverified = await quote("");
  assert.equal(unverified.valid, false, "an unverified location yields no quote rather than a default city's");
});

test("confirmation proof is derived from the public provider profile, not invented tenure", async (t) => {
  const f = await signedIn(t);
  const fresh = await profile.getProviderPublicProfile(f.db, GROOMER);
  assert.deepEqual({ id: fresh.providerId, stats: fresh.stats, isNew: fresh.isNewProvider }, { id: GROOMER, stats: null, isNew: true }, "a provider with no completed work is shown as new, not with a fabricated count");

  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    f.sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,'blr','blr-east','grooming','dog-basic','Bath & Basic',?,?,'2026-08-01T04:00:00.000Z','2026-08-01T06:00:00.000Z','completed','customer_app',1899,'INR','{}','uat',?,?)")
      .run(`BK-DONE-${i}`, `idem-done-${i}`, `CUST-DONE-${i}`, JSON.stringify([`PET-DONE-${i}`]), JSON.stringify([`PET-DONE-${i}`]), `SG-DONE-${i}`, GROOMER, now, now);
  }
  const proven = await profile.getProviderPublicProfile(f.db, GROOMER);
  assert.deepEqual({ stats: proven.stats, isNew: proven.isNewProvider }, { stats: { completedServices: 3, happyPets: 3 }, isNew: false }, "stats are counted from completed canonical bookings");
  assert.ok(!("rating" in proven) && !("qualityScore" in proven), "no unearned rating is surfaced");

  const served = await call("../app/api/provider-public-profile/route.ts", "GET", `/api/provider-public-profile?providerId=${GROOMER}`, null);
  assert.equal(served.status, 200);
  assert.equal(served.body.data.stats.completedServices, 3);
  assert.equal((await call("../app/api/provider-public-profile/route.ts", "GET", "/api/provider-public-profile?providerId=nobody", null)).status, 404, "an unknown provider yields no proof rather than an invented one");
});

test("booking submission is guarded against concurrent double clicks", async (t) => {
  const f = await signedIn(t);
  const held = await reserve(f, "gi-double");
  const payload = bookingPayload(f, "gi-double", held);
  const submit = () => call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", payload, f.cookie);
  // Both submits in flight at once, the shape a double tap produces when the client-side lock is absent.
  // The first request's booking batch is held until the second has ALSO reached its booking batch, which
  // means both passed the idempotency lookup before either inserted; the UNIQUE keys on the booking and
  // its confirmation guards are then what stop the second insert, and the route must turn that
  // constraint error into a replay of the winner rather than a 500 or a second booking. Time-boxed so a
  // request that never reaches its batch fails the assertions instead of hanging.
  let arrived = 0; let releaseBoth; const bothArrived = new Promise((resolve) => { releaseBoth = resolve; });
  f.db.beforeBatch = async (items) => {
    if (!items.some((item) => String(item._sql || "").startsWith("INSERT INTO booking_reservation_confirmation_guards"))) return;
    if (++arrived === 2) releaseBoth();
    await Promise.race([bothArrived, new Promise((resolve) => setTimeout(resolve, 2000))]);
  };
  const raced = await Promise.all([submit(), submit()]);
  f.db.beforeBatch = null;
  assert.equal(arrived, 2, "both submits reached their booking batch, so both passed the idempotency lookup before either inserted");
  assert.deepEqual(raced.map((response) => response.status).sort(), [200, 201], JSON.stringify(raced.map((response) => response.body)));
  const first = raced.find((response) => response.status === 201), second = raced.find((response) => response.status === 200);
  assert.deepEqual({ id: second.body.data.bookingId, duplicate: second.body.data.duplicatePrevented }, { id: first.body.data.bookingId, duplicate: true }, "the loser of the race is acknowledged as a replay of the winner");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE idempotency_key='gi-double'").get().n, 1, "a raced request never creates a second booking");
  const later = await submit();
  assert.equal(later.status, 200, "a later resubmit is the plain idempotent replay");
  assert.deepEqual({ id: later.body.data.bookingId, duplicate: later.body.data.duplicatePrevented }, { id: first.body.data.bookingId, duplicate: true });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM canonical_bookings WHERE idempotency_key='gi-double'").get().n, 1);
  /*
   * The ONE source-text assertion this file keeps: the client-side lock that stops a second tap from
   * even reaching the server lives in a React event handler, which react-dom/server cannot execute.
   * The server-side half of the same guarantee is proven just above.
   */
  const source = readFileSync(new URL("../app/mobile-app/grooming-flow.tsx", import.meta.url), "utf8");
  assert.match(source, /confirm=async\(\)=>\{if\(actionLock\.current\|\|scheduling\)return;/);
  assert.match(source, /finally\{actionLock\.current=false;setScheduling\(false\);\}/);
});

test("provider preview never reserves capacity before confirmation", async (t) => {
  const f = await signedIn(t);
  const window = slot();
  const preview = await call("../app/api/uat-scheduling/route.ts", "POST", "/api/uat-scheduling", {
    action: "preview", clientRequestId: "gi-preview", customerId: f.customer.id, petIds: [f.customer.petId], serviceCode: "grooming",
    cityId: "blr", zoneId: "blr-east", serviceAddress: "12 MG Road", servicePincode: "560038", ...window,
  }, f.cookie);
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.deepEqual({ reserved: preview.body.data.reserved, checked: preview.body.data.availabilityChecked }, { reserved: false, checked: true });
  assert.ok(preview.body.data.providers.some((provider) => provider.id === GROOMER), "the preview shows who could take the slot");
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations").get().n, 0, "previewing holds nothing");

  const held = await reserve(f, "gi-preview-then-book", window);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) n FROM scheduling_reservations WHERE group_id=?").get(held.decision.groupId).n, 1, "only confirmation reserves the slot, and only once");
});

test("pay-now is gated by the shared payment page and cannot self-confirm", async (t) => {
  const f = await signedIn(t);
  const held = await reserve(f, "gi-paynow");
  const booked = await call("../app/api/canonical-bookings/route.ts", "POST", "/api/canonical-bookings", bookingPayload(f, "gi-paynow", held, {
    amountDueNow: 1899, payment: { method: "upi", mode: "prepaid", status: "created", detail: "Pay now · sandbox authorization pending; live capture not connected" },
  }), f.cookie);
  assert.equal(booked.status, 201, JSON.stringify(booked.body));
  assert.equal(booked.body.data.status, "payment_pending", "an online booking enters payment_pending, which is what sends the flow to the payment page");
  assert.deepEqual(
    { booking: f.sqlite.prepare("SELECT status FROM canonical_bookings WHERE id=?").get(booked.body.data.bookingId).status, work: f.sqlite.prepare("SELECT status FROM provider_work_orders WHERE booking_id=?").get(booked.body.data.bookingId).status, payment: f.sqlite.prepare("SELECT status FROM booking_payments WHERE booking_id=?").get(booked.body.data.bookingId).status },
    { booking: "payment_pending", work: "payment_pending", payment: "created" },
    "nothing is confirmed or dispatched until a verified capture arrives",
  );
  const account = await call("../app/api/customer-account/route.ts", "GET", "/api/customer-account", null, f.cookie);
  assert.equal(account.status, 200, JSON.stringify(account.body));
  assert.equal(account.body.data.bookings.find((item) => item.id === booked.body.data.bookingId)?.status, "payment_pending", "the customer's own account shows the hold as unpaid");

  // The synthetic customer ledger the flow writes after verification speaks the same vocabulary: a
  // pay-now transaction starts payment_pending, not paid.
  const storage = new Map();
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, dispatchEvent: () => true, addEventListener: () => {}, removeEventListener: () => {} };
  t.after(() => { delete globalThis.window; });
  const ledger = await import("../lib/test-transaction.ts");
  const transaction = ledger.createTestTransaction({
    customerId: CUSTOMER.id, customerName: CUSTOMER.name, primary: CUSTOMER.phone, secondary: "", pets: "Milo", petCount: 1, service: "Grooming", packageName: "Bath & Basic",
    area: "Indiranagar", slot: held.scheduledStart, duration: "2h", amount: 1899, payment: "Paid online", provider: "Arun K.", providerModel: "Full-time",
    subscription: "None", creditsBefore: 0, crmOwner: "Unassigned", crmNextAction: "Verify payment", reminder: "queued", initialPaymentStatus: "payment_pending",
  }, booked.body.data.bookingId);
  assert.deepEqual({ id: transaction.id, paymentStatus: transaction.paymentStatus }, { id: booked.body.data.bookingId, paymentStatus: "payment_pending" });
  assert.equal(ledger.readTestTransaction()?.paymentStatus, "payment_pending");
});

test("mutable persisted booking inputs participate in the idempotency fingerprint", () => {
  const { stableBookingInputKey } = fingerprint;
  const inputs = { customerId: CUSTOMER.id, date: "2026-11-04", slotIndex: "1", count: "1", type: "dog", packId: "basic", plan: "single", pay: "after", safetyNotes: "friendly", total: "1899", discount: "0", coupon: "", sub: "", addons: "", pets: "PET-GI-1", provider: "", zone: "blr-east", address: "12 MG Road", name: "Mira Rao", phone: "+919900000515", alt: "", notes: "" };
  const key = (values) => stableBookingInputKey(Object.values(values));
  assert.equal(key(inputs), key({ ...inputs }), "the same inputs always fingerprint to the same key");
  for (const [field, value] of [["customerId", "CUST-OTHER"], ["date", "2026-11-05"], ["slotIndex", "2"], ["count", "2"], ["pay", "online"], ["safetyNotes", "aggressive"], ["total", "2398"], ["packId", "makeover"], ["addons", "Tick & flea treatment"], ["pets", "PET-OTHER"]]) {
    assert.notEqual(key({ ...inputs, [field]: value }), key(inputs), `changing ${field} changes the key`);
  }
  assert.notEqual(stableBookingInputKey(["ab", "c"]), stableBookingInputKey(["a", "bc"]), "field boundaries are part of the fingerprint");
  assert.match(key(inputs), /^[0-9a-z]+$/, "the key is a compact base-36 digest, not the inputs themselves");
});

test("grooming schedule copy does not claim unobserved live capacity, and the safety choice is offered", async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const React = await import("react");
  const { default: GroomingFlow } = await import("../app/mobile-app/grooming-flow.tsx");
  const render = (props) => renderToStaticMarkup(React.createElement(GroomingFlow, props)).replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const signedInScreen = render({ customer: { customerId: CUSTOMER.id, customerName: CUSTOMER.name, phone: CUSTOMER.phone } });
  const packagesScreen = render({ customer: null, initial: { type: "dog", packId: "basic" } });
  assert.ok(signedInScreen.includes("Aggressive / bite history"), "the safety requirement is a real choice on the first screen");
  assert.ok(signedInScreen.includes("Anxious or first grooming"));
  for (const screen of [signedInScreen, packagesScreen]) {
    assert.doesNotMatch(screen, /Live groomer calendar|update automatically from groomer calendars|\b2 groomers\b/, "no screen claims a live calendar nobody observed");
    assert.doesNotMatch(screen, /1,248 services|4 years with PawSpace/, "no invented provider tenure");
  }
  assert.ok(packagesScreen.includes("These reference prices are checked against the city catalogue before a booking is accepted"), "the copy tells the truth about where prices come from");
});
