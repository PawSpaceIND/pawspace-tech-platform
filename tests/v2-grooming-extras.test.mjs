/**
 * Owner decision (H4): V2 must offer the in-app extras before launch: add-ons (Tick & flea Rs 499, oil massage
 * Rs 299), a comfort profile and notes for the groomer. V2 sends them in the same fields as the in-app flow.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { d1 } from "./helpers/execution-harness.mjs";

installWorkersHooks("__V2_EXTRAS_DB__", "__V2_EXTRAS_ENV__");
const client = await import("../lib/v2/grooming-checkout-client.ts");
const { governGroomingBookingWithLiveMultiPet } = await import("../lib/live-grooming-governance.ts");
const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");

const future = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
function input(extra = {}) {
  const pet = { id: "PET-1", sourceId: "PET-1", name: "Bruno", species: "dog", breed: "Beagle", vaccinationStatus: "verified", ageYears: 3, profile: null };
  const bundle = { petCount: 1, packageCode: "dog-basic", price: 1899, currency: "INR", slotMinutes: 120, blockingMinutes: 150, effectiveFrom: "2020-01-01", effectiveTo: null };
  return { account: { customerId: "C1", name: "V2 customer", primaryPhone: "9000000901", pets: [pet] }, selectedPets: [pet],
    pkg: { code: "dog-basic", name: "Bath & Basic", audience: "dog", bundles: [bundle] }, bundle, quote: { price: 1899, source: "pricing_control" },
    provider: { id: "PRV1", name: "Care Professional", model: "full_time" }, address: "21 HSR Main Road", pincode: "560102", cityId: "blr", zoneId: "blr-south",
    scheduledStart: `${future}T05:30:00.000Z`, scheduledEnd: `${future}T07:30:00.000Z`, ...extra };
}
function network(t) {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null; calls.push({ url: String(url), body });
    const json = data => Response.json({ data });
    if (url === "/api/uat-scheduling") return json({ groupId: body.clientRequestId, provider: { id: "PRV1", name: "Care Professional", model: "full_time" } });
    if (url === "/api/canonical-bookings") return json({ bookingId: "B1", customerId: body.customer.id, scheduleGroupId: body.scheduleGroupId, status: "payment_pending" });
    if (url === "/api/grooming-service-location") return json({ bookingId: body.bookingId, addressSaved: true, coordinatesSaved: true });
    throw new Error(`Unexpected ${url}`);
  });
  return calls;
}

test("V2 sends add-ons, comfort and groomer notes, and charges the package plus add-ons", async t => {
  const calls = network(t);
  await client.createV2GroomingBooking(input({ addOns: ["Tick & flea treatment", "Full-body oil massage"], comfort: "anxious", specialInstructions: "Sensitive paws" }));
  const body = calls.find(call => call.url === "/api/canonical-bookings").body;
  assert.deepEqual(body.pricing.addOns, ["Tick & flea treatment", "Full-body oil massage"]);
  assert.deepEqual(body.pricing.requirements, ["grooming_safety:anxious", "grooming_special:Sensitive paws"]);
  assert.equal(body.totalAmount, 1899 + 499 + 299);
  assert.equal(body.amountDueNow, 1899 + 499 + 299);
  // The server governs the package part at the live price and adds the catalogue add-on prices on top.
  const sqlite = new DatabaseSync(":memory:"), db = d1(sqlite);
  await ensurePricingControlRuntime(db); sqlite.exec("UPDATE service_packages SET active=1 WHERE package_code='dog-basic'");
  const governed = await governGroomingBookingWithLiveMultiPet(db, { packageCode: body.packageCode, pets: body.pets, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-south",
    submittedTotal: body.totalAmount - 499 - 299, submittedAmountDueNow: body.amountDueNow - 499 - 299 });
  assert.equal(governed.totalAmount, 1899);
});

test("an add-on not offered for the pet's species is refused before a groomer is reserved", async t => {
  const calls = network(t);
  await assert.rejects(client.createV2GroomingBooking(input({ addOns: ["Unknown spa"] })), /add-ons available/);
  assert.equal(calls.length, 0);
});

test("without extras the booking is unchanged", async t => {
  const calls = network(t);
  await client.createV2GroomingBooking(input());
  const body = calls.find(call => call.url === "/api/canonical-bookings").body;
  assert.equal(body.totalAmount, 1899);
  assert.deepEqual(body.pricing, { discount: 0, addOns: [], requirements: [] });
});

// Owner decision (QA M10): same price, 30 extra minutes for a giant dog or an aggressive temperament.
const selection = await import("../lib/v2/grooming-selection.ts");
test("giant or aggressive pets get 30 extra minutes at the same price; others do not", () => {
  assert.match(selection.v2ExtraCareReason([{ name: "Tyson", profile: { weightBand: "45–60 kg", aggression: "Aggressive during bath" } }]), /Tyson gets 30 extra minutes \(45–60 kg, aggressive during bath\)/);
  assert.match(selection.v2ExtraCareReason([{ name: "Rex", profile: { weightBand: "20–45 kg", aggression: "Very aggressive" } }]), /Rex gets 30 extra minutes/);
  assert.equal(selection.v2ExtraCareReason([{ name: "Bruno", profile: { weightBand: "3–20 kg", aggression: "Friendly" } }]), null);
});
test("a booking with the extra-care slot reserves the longer window at the package price", async t => {
  const calls = network(t);
  const base = input();
  const longer = { ...base.bundle, slotMinutes: 150, blockingMinutes: 180 };
  await client.createV2GroomingBooking({ ...base, bundle: longer, pkg: { ...base.pkg, bundles: [longer] }, scheduledEnd: `${future}T08:00:00.000Z` });
  const reserve = calls.find(call => call.url === "/api/uat-scheduling").body;
  assert.equal(Date.parse(reserve.scheduledEnd) - Date.parse(reserve.scheduledStart), 150 * 60_000);
  assert.equal(calls.find(call => call.url === "/api/canonical-bookings").body.totalAmount, 1899);
});
