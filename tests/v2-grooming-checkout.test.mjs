import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";
installWorkersHooks("__V2_CHECKOUT_DB__", "__V2_CHECKOUT_ENV__");
const client = await import("../lib/v2/grooming-checkout-client.ts");
const care = await import("../lib/v2/grooming-client.ts");
const { readV2GroomingCheckoutReadiness } = await import("../lib/v2/grooming-checkout-readiness.ts");
const returns = await import("../app/api/v2/grooming-checkout-return/route.ts");
const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
function input() {
  const pet = { id: "PET-1", sourceId: "PET-1", name: "Bruno", species: "dog", breed: "Labrador", vaccinationStatus: "verified" };
  const bundle = { petCount: 1, packageCode: "dog-basic", price: 1899, currency: "INR", slotMinutes: 120, blockingMinutes: 150, effectiveFrom: "2020-01-01", effectiveTo: null };
  return { account: { customerId: "C1", name: "V2 customer", primaryPhone: "9000000901", pets: [pet] }, selectedPets: [pet],
    pkg: { code: "dog-basic", name: "Bath & Basic", audience: "dog", bundles: [bundle] }, bundle,
    quote: { price: 1899, source: "pricing_control" }, provider: { id: "PRV1", name: "Care Professional", model: "full_time" },
    address: "21 HSR Main Road", pincode: "560102", cityId: "blr", zoneId: "blr-south",
    scheduledStart: `${future}T05:30:00.000Z`, scheduledEnd: `${future}T07:30:00.000Z` };
}
function confirmation(patch = {}) {
  return { ready: true, bookingId: "B1", serviceCode: "grooming", packageName: "Bath & Basic", bookingStatus: "confirmed",
    paymentId: "P1", paymentMode: "prepaid", paymentStatus: "captured", transactionId: "pay_fixture", amountDueNow: 0,
    totalAmount: 1899, currency: "INR", providerId: "PRV1", providerName: "Care Professional", providerModel: "full_time",
    workOrderStatus: "assigned", scheduledStart: `${future}T05:30:00.000Z`, scheduledEnd: `${future}T07:30:00.000Z`, updatedAt: 1, ...patch };
}
const json = data => Response.json({ data });
function network(t, { canonicalStatus = "payment_pending", location = true, providerId = "PRV1", onReserve } = {}) {
  const calls = [], ids = new Map();
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    if (url === "/api/uat-scheduling") {
      if (onReserve) await onReserve();
      return json({ groupId: body.clientRequestId, provider: { id: providerId, name: "Care Professional", model: "full_time" } });
    }
    if (url === "/api/canonical-bookings") {
      if (!ids.has(body.idempotencyKey)) ids.set(body.idempotencyKey, `B${ids.size + 1}`);
      return json({ bookingId: ids.get(body.idempotencyKey), customerId: body.customer.id, petIds: ["PET-1"],
        scheduleGroupId: body.scheduleGroupId, workOrderId: "WO1", paymentId: "P1", status: canonicalStatus, duplicatePrevented: calls.filter(call => call.url === url).length > 1 });
    }
    if (url === "/api/grooming-service-location") {
      if (location === "error") return Response.json({ error: "Doorstep verification unavailable" }, { status: 503 });
      return json({ bookingId: body.bookingId, addressSaved: location, coordinatesSaved: location });
    }
    throw new Error(`Unexpected test network call ${url}`);
  });
  return { calls, ids };
}

test("V2 booking keys are deterministic, pet-order independent and scoped by material inputs", async () => {
  const original = input(), same = structuredClone(original);
  assert.equal(await client.v2GroomingIdempotencyKey(original), await client.v2GroomingIdempotencyKey(same));
  assert.match(await client.v2GroomingIdempotencyKey(original), /^v2-groom-[a-z0-9]+-[a-f0-9]{64}$/);
  for (const changed of [{ cityId: "maa" }, { address: "42 Other Main Road" }, { zoneId: "blr-east" }, { pincode: "560001" }]) {
    assert.notEqual(await client.v2GroomingIdempotencyKey(original), await client.v2GroomingIdempotencyKey({ ...original, ...changed }));
  }
  original.selectedPets.push({ ...original.selectedPets[0], id: "PET-2" });
  same.selectedPets = [...original.selectedPets].reverse();
  assert.equal(await client.v2GroomingIdempotencyKey(original), await client.v2GroomingIdempotencyKey(same));
});

test("V2 executes reserve -> canonical payment-pending booking -> verified location, without opening payment", async t => {
  const f = network(t), created = [];
  const result = await client.createV2GroomingBooking(input(), booking => created.push(booking));
  assert.deepEqual(f.calls.map(call => call.url), ["/api/uat-scheduling", "/api/canonical-bookings", "/api/grooming-service-location"]);
  assert.equal(f.calls[0].body.serviceAddress, input().address);
  assert.equal(f.calls[0].body.servicePincode, "560102");
  assert.equal(f.calls[1].body.payment.status, "created");
  assert.equal(f.calls[1].body.payment.mode, "prepaid");
  assert.equal(result.bookingId, "B1"); assert.equal(created[0].bookingId, "B1");
  const replay = await client.createV2GroomingBooking(input());
  assert.equal(replay.bookingId, "B1"); assert.equal(f.ids.size, 1);
});

test("V2 publishes durable booking identity before a later address save fails", async t => {
  const f = network(t, { location: "error" }), created = [];
  await assert.rejects(client.createV2GroomingBooking(input(), value => created.push(value)), /Doorstep/);
  assert.equal(created.length, 1); assert.equal(created[0].bookingId, "B1");
  assert.equal(f.calls.some(call => call.url === "/api/customer-checkout"), false);
});

test("V2 refuses a location success envelope that has no verified coordinates", async t => {
  network(t, { location: false });
  await assert.rejects(client.createV2GroomingBooking(input()), /doorstep was not verified/);
});

test("V2 replays an already confirmed booking without resaving its address or initiating payment", async t => {
  const f = network(t, { canonicalStatus: "confirmed" });
  const result = await client.createV2GroomingBooking(input());
  assert.equal(result.status, "confirmed");
  assert.deepEqual(f.calls.map(call => call.url), ["/api/uat-scheduling", "/api/canonical-bookings"]);
});

test("V2 freezes the submitted snapshot across asynchronous reservation work", async t => {
  const original = input();
  const f = network(t, { onReserve: async () => { original.address = "Different doorstep"; original.quote.price = 1; original.selectedPets[0].name = "Changed"; } });
  await client.createV2GroomingBooking(original);
  assert.equal(f.calls[1].body.totalAmount, 1899); assert.equal(f.calls[1].body.pets[0].name, "Bruno");
  assert.equal(f.calls[2].body.address, "21 HSR Main Road");
});

test("V2 rejects a changed provider before creating the canonical booking", async t => {
  const f = network(t, { providerId: "PRV-OTHER" });
  await assert.rejects(client.createV2GroomingBooking(input()), /selected groomer changed/);
  assert.equal(f.calls.length, 1);
});

for (const [name, change] of [
  ["fallback quote", value => value.quote.source = "fallback_default"],
  ["no pets", value => value.selectedPets = []],
  ["foreign pet", value => value.selectedPets = [{ ...value.selectedPets[0], id: "OTHER" }]],
  ["bundle mismatch", value => value.bundle.petCount = 2],
  ["invalid price", value => value.quote.price = NaN],
  ["invalid PIN", value => value.pincode = "invalid"],
  ["past time", value => value.scheduledStart = "2020-01-01T05:30:00.000Z"],
]) test(`V2 rejects ${name} before network mutations`, async t => {
  const f = network(t), value = input(); change(value);
  await assert.rejects(client.createV2GroomingBooking(value)); assert.equal(f.calls.length, 0);
});

for (const source of ["fallback_default", "unexpected"]) test(`V2 never labels ${source} as a verified live price`, async t => {
  t.mock.method(globalThis, "fetch", async () => json({ price: 1899, source }));
  await assert.rejects(care.quoteV2Grooming({ bundle: input().bundle, isoDate: future, slotIndex: 1, cityId: "blr", zoneId: "blr-south" }), /published live/);
});

test("V2 price quotes execute the canonical IST window and accept published pricing", async t => {
  let sent;
  t.mock.method(globalThis, "fetch", async (_, options) => { sent = JSON.parse(options.body); return json({ price: 1999, source: "pricing_control" }); });
  const result = await care.quoteV2Grooming({ bundle: input().bundle, isoDate: future, slotIndex: 1, cityId: "blr", zoneId: "blr-south" });
  assert.equal(result.scheduledStart, `${future}T05:30:00.000Z`); assert.equal(result.scheduledEnd, `${future}T07:30:00.000Z`);
  assert.equal(result.quote.price, 1999); assert.equal(sent.zoneId, "blr-south");
});

test("V2 preview uses its explicit doorstep instead of legacy session storage", async t => {
  let sent;
  const value = input();
  t.mock.method(globalThis, "fetch", async (_, options) => {
    sent = JSON.parse(options.body);
    return json({ providers: [value.provider], availabilityChecked: true, reserved: false,
      cityId: value.cityId, zoneId: value.zoneId, scheduledStart: value.scheduledStart, scheduledEnd: value.scheduledEnd });
  });
  await care.previewV2Groomers({ ...value, customerId: "C1", petIds: ["PET-1"], serviceAddress: value.address, servicePincode: value.pincode });
  assert.equal(sent.action, "preview"); assert.equal(sent.serviceAddress, value.address); assert.equal(sent.servicePincode, value.pincode);
});

test("V2 rejects a provider preview from a different zone or time", async t => {
  const value = input();
  t.mock.method(globalThis, "fetch", async () => json({ providers: [value.provider], availabilityChecked: true, reserved: false,
    cityId: "blr", zoneId: "blr-east", scheduledStart: value.scheduledStart, scheduledEnd: value.scheduledEnd }));
  await assert.rejects(care.previewV2Groomers({ ...value, customerId: "C1", petIds: ["PET-1"], serviceAddress: value.address, servicePincode: value.pincode }), /does not match/);
});

for (const [field, value] of Object.entries({ ready: false, bookingStatus: "payment_pending", workOrderStatus: "payment_pending",
  paymentStatus: "created", paymentMode: "pay_after_service", transactionId: "", providerId: "", providerModel: "unknown",
  scheduledStart: "invalid", totalAmount: NaN, serviceCode: "boarding", bookingId: "OTHER" })) {
  test(`V2 success remains closed when canonical ${field} is not ready`, () => {
    assert.equal(client.isV2GroomingConfirmationReady(confirmation({ [field]: value }), "B1"), false);
  });
}
test("V2 displays success from a complete matching canonical projection", () => {
  assert.equal(client.isV2GroomingConfirmationReady(confirmation(), "B1"), true);
});

function world(t) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  sqlite.exec(`CREATE TABLE canonical_bookings(id TEXT PRIMARY KEY,customer_id TEXT,status TEXT,service_code TEXT,package_name TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,total_amount REAL,currency TEXT,pet_ids_json TEXT);
    CREATE TABLE booking_payments(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,status TEXT,amount REAL,amount_due_now REAL,currency TEXT,mode TEXT);
    CREATE TABLE provider_work_orders(id TEXT PRIMARY KEY,booking_id TEXT,provider_id TEXT,provider_name TEXT,provider_model TEXT,status TEXT);
    CREATE TABLE payment_intents(id TEXT PRIMARY KEY,booking_id TEXT,customer_id TEXT,payment_id TEXT,gateway_order_id TEXT,provider TEXT,environment TEXT,amount_paise INTEGER,currency TEXT);
    CREATE TABLE payment_gateway_events(id TEXT PRIMARY KEY,booking_id TEXT,payment_id TEXT,gateway_order_id TEXT,gateway_payment_id TEXT,provider TEXT,environment TEXT,signature_verified INTEGER,processing_status TEXT,event_type TEXT,amount_subunits INTEGER,currency TEXT,detail_json TEXT,received_at INTEGER);
    CREATE TABLE canonical_pets(id TEXT,customer_id TEXT,name TEXT,species TEXT,breed TEXT);
    CREATE TABLE booking_service_locations(booking_id TEXT,customer_id TEXT,provider_id TEXT,latitude REAL,longitude REAL,status TEXT,source TEXT);
    INSERT INTO canonical_bookings VALUES('B1','C1','payment_pending','grooming','Bath & Basic','PRV1','${future}T05:30:00.000Z','${future}T07:30:00.000Z',1899,'INR','["PET-1"]');
    INSERT INTO booking_payments VALUES('P1','B1','C1','created',1899,1899,'INR','prepaid');
    INSERT INTO provider_work_orders VALUES('WO1','B1','PRV1','Care Professional','full_time','payment_pending');
    INSERT INTO payment_intents VALUES('I1','B1','C1','P1','order_fixture','razorpay','sandbox',189900,'INR');
    INSERT INTO canonical_pets VALUES('PET-1','C1','Bruno','dog','Labrador');
    INSERT INTO booking_service_locations VALUES('B1','C1','PRV1',12.91,77.64,'active','server_geocode');`);
  const db = d1(sqlite); enterWorkersDbScope(db); globalThis.__V2_CHECKOUT_DB__ = db;
  globalThis.__V2_CHECKOUT_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox", FORBID_PRODUCTION: "true", PAWSPACE_PAYMENT_LIVE_APPROVED: "false" };
  return { sqlite, db };
}
function capture(sqlite, { signature = 1, detail = "{}", amount = 189900, environment = "sandbox", orderId = "order_fixture" } = {}) {
  sqlite.exec("UPDATE canonical_bookings SET status='confirmed'; UPDATE booking_payments SET status='captured'; UPDATE provider_work_orders SET status='assigned'");
  sqlite.prepare("INSERT INTO payment_gateway_events VALUES('E1','B1','P1',?,'pay_fixture','razorpay',?,?,'processed','payment.captured',?,'INR',?,1)").run(orderId, environment, signature, amount, detail);
}

test("V2 recovery reads execute real SQL and never create booking/payment records", async t => {
  const { sqlite, db } = world(t), before = sqlite.prepare("SELECT total_changes() n").get().n;
  const result = await readV2GroomingCheckoutReadiness(db, "C1", "B1");
  assert.equal(result.locationReady, true); assert.equal(result.confirmation.ready, false);
  assert.equal(result.confirmation.totalAmount, 1899); assert.equal(result.confirmation.pets[0].name, "Bruno");
  assert.equal(sqlite.prepare("SELECT total_changes() n").get().n, before);
  await assert.rejects(readV2GroomingCheckoutReadiness(db, "C2", "B1"), error => error.status === 404);
});
for (const sql of ["UPDATE booking_service_locations SET source='browser'", "UPDATE booking_service_locations SET provider_id='OTHER'",
  "UPDATE booking_service_locations SET customer_id='C2'", "UPDATE booking_service_locations SET latitude=NULL", "UPDATE booking_service_locations SET latitude=200",
  "DROP TABLE booking_service_locations"]) test(`V2 payment stays closed for unverified doorstep: ${sql}`, async t => {
  const { sqlite, db } = world(t); sqlite.exec(sql);
  assert.equal((await readV2GroomingCheckoutReadiness(db, "C1", "B1")).locationReady, false);
});
for (const authority of ["webhook_signature", "provider_api"]) test(`V2 confirmation accepts verified ${authority} evidence on the exact stored order`, async t => {
  const { sqlite, db } = world(t);
  capture(sqlite, { signature: authority === "webhook_signature" ? 1 : 0, detail: JSON.stringify({ captureAuthority: authority }) });
  const result = await readV2GroomingCheckoutReadiness(db, "C1", "B1");
  assert.equal(result.confirmation.ready, true); assert.equal(result.confirmation.transactionId, "pay_fixture");
});
for (const patch of [{ signature: 0 }, { amount: 1 }, { environment: "live" }, { orderId: "order_OTHER" }]) {
  test(`V2 canonical capture mismatch stays unconfirmed: ${JSON.stringify(patch)}`, async t => {
    const { sqlite, db } = world(t); capture(sqlite, patch);
    assert.equal((await readV2GroomingCheckoutReadiness(db, "C1", "B1")).confirmation.ready, false);
  });
}

test("V2 checkout route enforces real customer sessions and record ownership", async t => {
  const { db } = world(t);
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
  const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await import("../lib/platform-session.ts");
  const route = await import("../app/api/v2/grooming-checkout/route.ts");
  await ensureSecurityTables(db);
  const url = "https://pawspace.test/api/v2/grooming-checkout?bookingId=B1";
  assert.equal((await route.GET(new Request(url))).status, 401);
  for (const customerId of ["C1", "C2"]) {
    const binding = await upsertIdentityBinding(db, { identitySource: "customer_otp", principalType: "identity_subject", principalKey: customerId,
      subjectType: "customer", subjectId: customerId, verificationState: "verified", actorId: "test", reason: "V2 executable ownership test" });
    const session = await issuePlatformSession(db, { bindingId: binding.id, identitySource: "customer_otp", principalType: "identity_subject",
      principalKey: customerId, subjectType: "customer", subjectId: customerId });
    const response = await route.GET(new Request(url, { headers: { cookie: `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(session.token)}` } }));
    assert.equal(response.status, customerId === "C1" ? 200 : 404, await response.text());
  }
});

test("V2 Razorpay callback reuses bounded validation and returns only to the same-origin V2 page", async () => {
  const response = await returns.POST(new Request("https://pawspace.test/api/v2/grooming-checkout-return?bookingId=B1&next=https://evil.test", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ razorpay_order_id: "order_fixture", razorpay_payment_id: "pay_fixture", razorpay_signature: "a".repeat(64) }),
  }));
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.origin, "https://pawspace.test"); assert.equal(target.pathname, "/v2/grooming");
  assert.equal(target.searchParams.get("bookingId"), "B1"); assert.equal(target.searchParams.get("payment"), "returned");
  assert.equal(target.searchParams.has("next"), false); assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(client.v2GroomingCheckoutReturnUrl("B1", "https://pawspace.test"), "https://pawspace.test/api/v2/grooming-checkout-return?bookingId=B1");
  assert.equal(client.v2GroomingCheckoutReturnUrl("B1", "javascript:invalid"), undefined);
});

test("V2 Razorpay callback accepts its scoped redirect target", async () => {
  const response = await returns.GET(new Request("https://pawspace.test/api/v2/grooming-checkout-return?bookingId=B1&scope=v2"));
  assert.equal(response.status, 303);
  const target = new URL(response.headers.get("location"));
  assert.equal(target.origin, "https://pawspace.test");
  assert.equal(target.pathname, "/v2/grooming");
  assert.equal(target.searchParams.get("bookingId"), "B1");
});

test("V2 presentation remains isolated from legacy UI and shared engine writes", async () => {
  const page = await readFile(new URL("../app/v2/grooming/page.tsx", import.meta.url), "utf8");
  const panel = await readFile(new URL("../app/v2/grooming/payment-panel.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page + panel, /from ["'][^"']*mobile-app\//);
  assert.match(page, /coverageVersion/); assert.match(page, /careVersion/); assert.match(page, /checkoutLock/);
  assert.match(panel, /isV2GroomingConfirmationReady/); assert.match(panel, /loadV2GroomingCheckoutReadiness/);
  assert.doesNotMatch(panel, /createCanonicalLifecycle|reserveUatSchedule/);
});
