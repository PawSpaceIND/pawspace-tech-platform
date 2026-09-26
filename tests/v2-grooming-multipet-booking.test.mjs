/**
 * V2 multi-pet grooming reached "Reserve & review payment", reserved a groomer, then failed with
 * "Grooming package is not active for this city/zone": V2 sent the Pricing Control bundle code
 * (dog-basic__2_pets) while the booking governance only knows base codes and prices 2-4 pets itself.
 * These cases execute the real governance against real SQL.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__V2_MULTIPET_DB__", "__V2_MULTIPET_ENV__");
const { quoteGroomingBookingWithLiveMultiPet } = await import("../lib/live-grooming-governance.ts");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
const client = await import("../lib/v2/grooming-checkout-client.ts");

// Next Wednesday at 11:00 IST: the published weekday rule (-8%) applies, as it did in the browser run.
function nextWednesdayStart() {
  const day = new Date(Date.now() + 86400000);
  while (day.getUTCDay() !== 3) day.setUTCDate(day.getUTCDate() + 1);
  return `${day.toISOString().slice(0, 10)}T05:30:00.000Z`;
}

async function world() {
  const sqlite = new DatabaseSync(":memory:"), db = d1(sqlite);
  await ensurePricingControlRuntime(db);
  sqlite.exec("UPDATE service_packages SET active=1 WHERE service_code='grooming'");
  sqlite.prepare(`INSERT INTO dynamic_pricing_rules (id,name,service_code,package_code,city_id,zone_id,rule_type,days_json,start_time,end_time,effective_from,effective_to,adjustment_type,adjustment_value,coupon_policy,priority,status,version,updated_by,updated_at)
    VALUES ('rule_weekday_value','Weekday value pricing','grooming',NULL,'blr',NULL,'weekday','[1,2,3,4,5]',NULL,NULL,'2026-01-01',NULL,'percent',-8,'stackable',30,'published',1,'test',0)`).run();
  return { sqlite, db };
}

const quote = (db, packageCode, pets) => quoteGroomingBookingWithLiveMultiPet(db, {
  packageCode, pets, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east", scheduledStart: nextWednesdayStart(),
});

test("two dogs on the base code are governed at the published 2-pet weekday price V2 quotes", async () => {
  const { db } = await world();
  const governed = await quote(db, "dog-basic", [{ species: "dog" }, { species: "dog" }]);
  assert.equal(governed.packageCode, "dog-basic");
  assert.equal(governed.petCount, 2);
  assert.equal(governed.totalAmount, 3034); // Rs 3,298 bundle row - 8% weekday, as shown by V2
  assert.equal(governed.amountDueNow, 3034);
});

test("three and four pets price from their own Pricing Control rows", async () => {
  const { db } = await world();
  assert.equal((await quote(db, "dog-makeover", [{ species: "dog" }, { species: "dog" }, { species: "dog" }])).totalAmount, 5931);
  assert.equal((await quote(db, "cat-routine", Array.from({ length: 4 }, () => ({ species: "cat" })))).totalAmount, 3676);
});

test("the bundle code V2 used to send has no governed catalogue entry", async () => {
  const { db } = await world();
  await assert.rejects(quote(db, "dog-basic__2_pets", [{ species: "dog" }, { species: "dog" }]), /not active for this city\/zone/);
});

// Client side: what V2 submits, and that nothing is reserved for a booking the server would refuse.
const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
function checkoutInput({ pets = 1, pkg = "dog-basic", audience = "dog", price = 1899, profile } = {}) {
  const list = Array.from({ length: pets }, (_, index) => ({ id: `PET-${index + 1}`, sourceId: `PET-${index + 1}`, name: index ? `Pet ${index + 1}` : "Tiny",
    species: "dog", breed: "Beagle", vaccinationStatus: "verified", ageYears: audience === "young" ? 0.25 : 3, profile: profile ?? null }));
  const single = { petCount: 1, packageCode: pkg, price, currency: "INR", slotMinutes: 120, blockingMinutes: 150, effectiveFrom: "2020-01-01", effectiveTo: null };
  const bundle = pets === 1 ? single : { ...single, petCount: pets, packageCode: `${pkg}__${pets}_pets` };
  return { account: { customerId: "C1", name: "V2 customer", primaryPhone: "9000000901", pets: list }, selectedPets: list,
    pkg: { code: pkg, name: "Bath & Basic", audience, bundles: pets === 1 ? [single] : [single, bundle] }, bundle,
    quote: { price, source: "pricing_control" }, provider: { id: "PRV1", name: "Care Professional", model: "full_time" },
    address: "21 HSR Main Road", pincode: "560102", cityId: "blr", zoneId: "blr-south",
    scheduledStart: `${future}T05:30:00.000Z`, scheduledEnd: `${future}T07:30:00.000Z` };
}
function network(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url: String(url), body });
    const json = data => Response.json({ data });
    if (url === "/api/uat-scheduling") return json({ groupId: body.clientRequestId, provider: { id: "PRV1", name: "Care Professional", model: "full_time" } });
    if (url === "/api/canonical-bookings") return json({ bookingId: "B1", customerId: body.customer.id, petIds: body.pets.map(pet => pet.sourceId),
      scheduleGroupId: body.scheduleGroupId, workOrderId: "WO1", paymentId: "P1", status: "payment_pending", duplicatePrevented: false });
    if (url === "/api/grooming-service-location") return json({ bookingId: body.bookingId, addressSaved: true, coordinatesSaved: true });
    throw new Error(`Unexpected test network call ${url}`);
  });
  return calls;
}
const canonicalBody = calls => calls.find(call => call.url === "/api/canonical-bookings").body;
const bornDaysBefore = days => new Date(Date.parse(`${future}T00:00:00Z`) - days * 86400000).toISOString().slice(0, 10);

test("V2 multi-pet bookings send the governed base package code with every pet and the quoted bundle price", async t => {
  const calls = network(t);
  await client.createV2GroomingBooking(checkoutInput({ pets: 2, price: 3034 }));
  const body = canonicalBody(calls);
  assert.equal(body.packageCode, "dog-basic");
  assert.equal(body.pets.length, 2);
  assert.equal(body.totalAmount, 3034); assert.equal(body.amountDueNow, 3034);
});

test("V2 refuses a young package for a pet without a date of birth before reserving a groomer", async t => {
  const calls = network(t);
  await assert.rejects(client.createV2GroomingBooking(checkoutInput({ pkg: "young-basic", audience: "young", price: 919, profile: { ageBand: "< 6 months" } })), /date of birth/);
  assert.equal(calls.length, 0);
});

test("V2 refuses a young package when the date of birth is over six months before the service date", async t => {
  const calls = network(t);
  await assert.rejects(client.createV2GroomingBooking(checkoutInput({ pkg: "young-basic", audience: "young", price: 919, profile: { ageBand: "6–12 months", dateOfBirth: bornDaysBefore(200) } })), /up to 6 months/);
  assert.equal(calls.length, 0);
});

test("V2 books a young package when the date of birth is within six months of the service date", async t => {
  const calls = network(t);
  await client.createV2GroomingBooking(checkoutInput({ pkg: "young-basic", audience: "young", price: 919, profile: { ageBand: "< 6 months", dateOfBirth: bornDaysBefore(90) } }));
  assert.equal(canonicalBody(calls).packageCode, "young-basic");
});
