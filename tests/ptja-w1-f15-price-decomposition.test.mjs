/**
 * PawSpace Total Journey Audit, Wave 1 F15 — a confirmed Sitting or Boarding booking stored a price
 * decomposition that did not add up to the amount charged.
 *
 * MEASURED before the fix, executing the real quote and governance libraries:
 *
 *   SITTING  quote returned : {basePricePerPet:1200, billableUnits:2, totalAmount:2400}
 *            GOVERNED       : {basePricePerPet:799,  billableUnits:2, totalAmount:2400}
 *            799 x 2 = 1598 against 2400 actually charged - Rs 802 short.
 *
 *   BOARDING quote returned : {basePricePerPet:2500, stayUnits:2, totalAmount:5000}
 *            GOVERNED       : {basePricePerPet:699,  stayUnits:2, totalAmount:5000}
 *            699 x 2 = 1398 against 5000 actually charged.
 *
 * That governed object is exactly what app/api/sitting-bookings/route.ts and
 * app/api/canonical-bookings/route.ts serialise into canonical_bookings.pricing_json. So a booking
 * that charged Rs 2,400 was recorded as "Rs 799 per night x 2 nights", with no marker that the two
 * disagree - for a finance reviewer, an invoice line, a support agent explaining a disputed charge, or
 * any report that recomputes revenue from the unit breakdown. It appeared only once an operator
 * activated a live price, which is precisely when someone is most likely to be checking the numbers.
 *
 * The cause: createLiveSittingQuote / createLiveBoardingQuote overwrote the quote row's total_amount
 * with the Pricing-Control-resolved figure but never wrote the priced UNIT back, so governSittingBooking
 * and governBoardingBooking - which join the package table for price - could only ever return the stale
 * catalogue number.
 *
 * No product decision is involved. The two fields are claims about the same transaction, written by the
 * same route, and they contradicted each other.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F15_DB__", "__PTJA_F15_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
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

const DAY = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const START = `${DAY}T04:00:00.000Z`;
const END = new Date(new Date(START).getTime() + 2 * 86_400_000).toISOString();

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_F15_DB__ = db;
  globalThis.__PTJA_F15_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const sitting = await import("../lib/sitting-governance.ts");
  const boarding = await import("../lib/boarding-governance.ts");
  const quotes = await import("../lib/live-commercial-quotes.ts");
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  const { seedProviderCapacityDefaults } = await import("../lib/provider-capacity-governance.ts");
  await seedProviderCapacityDefaults(db);
  await sitting.ensureSittingGovernanceTables(db);
  await boarding.ensureBoardingGovernanceTables(db);
  await ensurePricingControlRuntime(db);
  // Emptied so the unit under test is unambiguously the operator's base price, not a rule on top of it.
  sqlite.exec("DELETE FROM dynamic_pricing_rules");

  const activate = (serviceCode, packageCode, basePrice) =>
    sqlite.prepare("INSERT OR REPLACE INTO service_packages (id,service_code,package_code,name,description,base_price,slot_minutes,blocking_minutes,tax_inclusive,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,'Operator price','',?,1440,1440,1,1,1,'2026-08-01',NULL,'ops',?)")
      .run(`SP-${packageCode}`, serviceCode, packageCode, basePrice, Date.now());

  const host = sqlite.prepare("SELECT h.provider_id,h.city_id,h.zone_id,h.species_json FROM boarding_host_profiles h JOIN provider_capacity_profiles p ON p.id=h.provider_id WHERE h.active=1 AND p.live=1 AND p.status='active' AND h.home_verified=1 AND h.kyc_status='verified' AND h.background_check_status='verified' LIMIT 1").get();
  assert.ok(host, "a governed Boarding host must be seeded for this suite to mean anything");

  const sittingBooking = async (petCount = 1) => {
    const quote = await quotes.createLiveSittingQuote(db, { packageCode: "sitting-overnight", petCount, scheduledStart: START, scheduledEnd: END, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" });
    const governed = await sitting.governSittingBooking(db, {
      quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName, petCount: quote.petCount,
      scheduledStart: START, scheduledEnd: END, submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
      paymentMode: "prepaid", paymentStatus: "captured", reservationCount: 1, cityId: "blr", zoneId: "blr-east",
    });
    return { quote, governed };
  };

  const boardingBooking = async (petCount = 1) => {
    const quote = await quotes.createLiveBoardingQuote(db, { packageCode: "boarding-24h", petCount, scheduledStart: START, scheduledEnd: END, paymentMode: "prepaid", cityId: host.city_id, zoneId: host.zone_id });
    const governed = await boarding.governBoardingBooking(db, {
      quoteId: quote.quoteId, packageCode: quote.packageCode, packageName: quote.packageName, petCount: quote.petCount,
      scheduledStart: START, scheduledEnd: END, submittedTotal: quote.totalAmount, submittedAmountDueNow: quote.amountDueNow,
      paymentMode: "prepaid", paymentStatus: "captured", reservationCount: 1, providerId: host.provider_id,
      cityId: host.city_id, zoneId: host.zone_id, species: [JSON.parse(host.species_json)[0]], vaccinationStatuses: ["verified"],
    });
    return { quote, governed };
  };

  return { sqlite, db, activate, sittingBooking, boardingBooking };
}

test("W1-F15: a governed Sitting booking's unit price is the one that produced its total", async () => {
  const w = await world();
  w.activate("pet_sitting", "sitting-overnight", 1200);

  const { quote, governed } = await w.sittingBooking();

  assert.equal(governed.totalAmount, quote.totalAmount, "the governed total is the charged total");
  assert.equal(governed.basePricePerPet * governed.billableUnits, governed.totalAmount,
    `the persisted decomposition must add up: ${governed.basePricePerPet} x ${governed.billableUnits} = ${governed.basePricePerPet * governed.billableUnits} against ${governed.totalAmount} charged`);
  assert.equal(governed.basePricePerPet, 1200, "and it is the operator's activated price, not the catalogue one");
});

test("W1-F15: a governed Boarding booking's unit price is the one that produced its total", async () => {
  const w = await world();
  w.activate("boarding", "boarding-24h", 2500);

  const { quote, governed } = await w.boardingBooking();

  assert.equal(governed.totalAmount, quote.totalAmount);
  assert.equal(governed.basePricePerPet * governed.stayUnits, governed.totalAmount,
    `the persisted decomposition must add up: ${governed.basePricePerPet} x ${governed.stayUnits} = ${governed.basePricePerPet * governed.stayUnits} against ${governed.totalAmount} charged`);
  assert.equal(governed.basePricePerPet, 2500);
});

test("W1-F15: the Sitting extra-pet price is the one charged for the second pet", async () => {
  // The decomposition for more than one pet is base + (n-1) x extra, per billable unit. Persisting a
  // stale extra_pet_price reopens the same contradiction one pet later.
  const w = await world();
  w.activate("pet_sitting", "sitting-overnight", 1200);
  w.activate("pet_sitting", "sitting-overnight__extra_pet", 611);

  const { governed } = await w.sittingBooking(2);

  assert.equal(governed.extraPetPrice, 611, "the persisted extra-pet price is the activated one");
  assert.equal((governed.basePricePerPet + governed.extraPetPrice) * governed.billableUnits, governed.totalAmount,
    `base ${governed.basePricePerPet} + extra ${governed.extraPetPrice} over ${governed.billableUnits} units must equal ${governed.totalAmount}`);
});

test("W1-F15: with nothing activated the governed record is the catalogue price, unchanged", async () => {
  // Non-vacuity, and the backward-compatibility guarantee: the new quote columns are nullable, and a
  // quote that was never repriced falls back to the package column exactly as before this fix. If the
  // fallback were broken, every booking made without Pricing Control would record a wrong unit price.
  const w = await world();
  const catalogue = Number(w.sqlite.prepare("SELECT base_price_per_pet FROM sitting_commercial_packages WHERE package_code='sitting-overnight'").get().base_price_per_pet);

  const { governed } = await w.sittingBooking();

  assert.equal(governed.basePricePerPet, catalogue, "no Pricing Control row means the catalogue price stands");
  assert.equal(governed.basePricePerPet * governed.billableUnits, governed.totalAmount,
    "and it still adds up, because it was the price that produced the total all along");
});

test("W1-F15: the priced unit is what the quote row itself carries", async () => {
  // The fix works by writing the priced unit back to the quote row rather than by recomputing it from
  // total/units at read time. Recomputation would hide a genuine mismatch behind arithmetic; the row is
  // the record. This asserts the durable state, not just the returned object.
  const w = await world();
  w.activate("pet_sitting", "sitting-overnight", 1200);
  const { quote } = await w.sittingBooking();

  const row = w.sqlite.prepare("SELECT total_amount,priced_base_price_per_pet FROM sitting_commercial_quotes WHERE id=?").get(quote.quoteId);
  assert.equal(Number(row.priced_base_price_per_pet), 1200,
    "the quote row carries the unit price Pricing Control resolved");
  assert.equal(Number(row.total_amount), 2400);
});
