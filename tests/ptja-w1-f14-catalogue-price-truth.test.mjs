/**
 * PawSpace Total Journey Audit, Wave 1 F14 — the Boarding catalogue kept advertising the old per-pet
 * price after Pricing Control was activated, while the quote panel on the same screen charged the new
 * one.
 *
 * MEASURED before the fix, driving the real GET and POST handlers of
 * app/api/boarding-commercial/route.ts against one database:
 *
 *   BEFORE  GET packages: [{boarding-4h 499},{boarding-10h 599},{boarding-24h 699}]
 *   BEFORE  POST quote  : base 699, 2 units, 2 pets -> 2796
 *   -- ops activates 'Luxury Stay' at 2500 in Pricing Control --
 *   AFTER   GET packages: [{boarding-4h 499},{boarding-10h 599},{boarding-24h 699}]   <- unchanged
 *   AFTER   POST quote  : base 2500, 2 units, 2 pets -> 10000
 *
 * app/boarding/page.tsx renders `money(item.base_price_per_pet) / pet / unit` from that GET, and the
 * sticky quote panel directly underneath renders the POST's totalAmount. So a customer picked a card
 * saying Rs 699 per pet per unit and the panel beneath it said Rs 10,000 for the same stay, with no
 * third surface to arbitrate and nothing on the page explaining the difference - for as long as any
 * operator price was active in Pricing Control.
 *
 * The same split existed for Pet Sitting: app/sitting/page.tsx renders
 * `activePackage.base_price_per_pet` from listSittingPackages while POST /api/sitting-commercial
 * prices through createLiveSittingQuote.
 *
 * The rule is the platform's own. lib/live-pricing-resolver.ts is documented as the single bridge
 * between the operator's Pricing Control state and the customer price. The quote builders cross it;
 * the listing endpoints that feed the same screens did not. Nothing about what a price SHOULD be is
 * decided here - only that both halves of one screen read the same source.
 *
 * The fallback contract is preserved verbatim, quoted from that module: "If the row remains inactive,
 * callers get their pre-existing fallback unchanged." Case 3 locks it.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PTJA_F14_DB__", "__PTJA_F14_ENV__");

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

/** Twenty days out, two nights: comfortably inside every future-window rule on both verticals. */
const DAY = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
const START = `${DAY}T04:00:00.000Z`;
const END = new Date(new Date(START).getTime() + 2 * 86_400_000).toISOString();

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PTJA_F14_DB__ = db;
  globalThis.__PTJA_F14_ENV__ = { PAWSPACE_PAYMENT_ENV: "sandbox" };
  const { ensureBoardingGovernanceTables } = await import("../lib/boarding-governance.ts");
  const { ensureSittingGovernanceTables } = await import("../lib/sitting-governance.ts");
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensureBoardingGovernanceTables(db);
  await ensureSittingGovernanceTables(db);
  await ensurePricingControlRuntime(db);
  // Emptied so the number under test is unambiguously the operator's base price and not a rule on top.
  sqlite.exec("DELETE FROM dynamic_pricing_rules");

  const boarding = await import("../app/api/boarding-commercial/route.ts");
  const sitting = await import("../app/api/sitting-commercial/route.ts");

  const call = async (route, path, body) => {
    const response = body
      ? await route.POST(new Request(`https://uat.pawspace.in${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))
      : await route.GET(new Request(`https://uat.pawspace.in${path}`));
    let parsed = null;
    try { parsed = await response.clone().json(); } catch { /* non-JSON */ }
    return { status: response.status, body: parsed };
  };

  const advertised = async (route, path, packageCode) => {
    const listed = await call(route, path);
    assert.equal(listed.status, 200, `catalogue must load: ${JSON.stringify(listed.body).slice(0, 200)}`);
    const item = (listed.body?.data?.packages || []).find(entry => entry.package_code === packageCode);
    assert.ok(item, `${packageCode} must be listed: ${JSON.stringify(listed.body?.data?.packages)}`);
    return item;
  };

  /** Activates an operator price in Pricing Control, exactly as the console's own writes do. */
  const activate = (serviceCode, packageCode, basePrice) =>
    sqlite.prepare("INSERT OR REPLACE INTO service_packages (id,service_code,package_code,name,description,base_price,slot_minutes,blocking_minutes,tax_inclusive,active,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,?,?,'Operator price','',?,1440,1440,1,1,1,'2026-08-01',NULL,'ops',?)")
      .run(`SP-${packageCode}`, serviceCode, packageCode, basePrice, Date.now());

  return { sqlite, db, boarding, sitting, call, advertised, activate };
}

const BOARDING_CATALOGUE = `/api/boarding-commercial?cityId=blr&zoneId=blr-east&scheduledStart=${START}`;
const SITTING_CATALOGUE = `/api/sitting-commercial?cityId=blr&zoneId=blr-east&scheduledStart=${START}`;
const boardingQuoteBody = { packageCode: "boarding-24h", petCount: 2, scheduledStart: START, scheduledEnd: END, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" };
const sittingQuoteBody = { packageCode: "sitting-overnight", petCount: 1, scheduledStart: START, scheduledEnd: END, paymentMode: "prepaid", cityId: "blr", zoneId: "blr-east" };

test("W1-F14: the Boarding picker advertises the price the quote panel charges", async () => {
  const w = await world();
  w.activate("boarding", "boarding-24h", 2500);

  const card = await w.advertised(w.boarding, BOARDING_CATALOGUE, "boarding-24h");
  const quote = await w.call(w.boarding, "/api/boarding-commercial", boardingQuoteBody);
  assert.equal(quote.status, 201, `the quote must be produced: ${JSON.stringify(quote.body)}`);

  assert.equal(Number(card.base_price_per_pet), Number(quote.body.data.basePricePerPet),
    `the card advertises ${card.base_price_per_pet} / pet / unit while the quote charges ${quote.body.data.basePricePerPet}`);
  assert.equal(Number(card.base_price_per_pet), 2500, "both must be the operator's activated price");
  assert.equal(Number(quote.body.data.totalAmount), 2500 * 2 * 2, "2 pets across 2 billed units");
});

test("W1-F14: the Pet Sitting card advertises the price its quote charges", async () => {
  const w = await world();
  w.activate("pet_sitting", "sitting-overnight", 1777);

  const card = await w.advertised(w.sitting, SITTING_CATALOGUE, "sitting-overnight");
  const quote = await w.call(w.sitting, "/api/sitting-commercial", sittingQuoteBody);
  assert.equal(quote.status, 201, `the quote must be produced: ${JSON.stringify(quote.body)}`);

  assert.equal(Number(card.base_price_per_pet), Number(quote.body.data.basePricePerPet),
    `the card advertises ${card.base_price_per_pet} while the quote charges ${quote.body.data.basePricePerPet}`);
  assert.equal(Number(card.base_price_per_pet), 1777);
});

test("W1-F14: an inactive Pricing Control row leaves the catalogue price unchanged", async () => {
  // The fallback contract, quoted from lib/live-pricing-resolver.ts: "If the row remains inactive,
  // callers get their pre-existing fallback unchanged." Resolving every card must not become a way to
  // rewrite a catalogue price nobody activated.
  const w = await world();
  const seeded = Number(w.sqlite.prepare("SELECT base_price_per_pet FROM boarding_commercial_packages WHERE package_code='boarding-24h'").get().base_price_per_pet);

  const card = await w.advertised(w.boarding, BOARDING_CATALOGUE, "boarding-24h");
  const quote = await w.call(w.boarding, "/api/boarding-commercial", boardingQuoteBody);

  assert.equal(Number(card.base_price_per_pet), seeded, "with nothing activated the catalogue price is the seeded one");
  assert.equal(card.price_source, "fallback_default", "and it says which source it came from");
  assert.equal(Number(quote.body.data.basePricePerPet), seeded, "the quote agrees, as it did before this fix");
});

test("W1-F14: activating one package does not move the price of another", async () => {
  // Non-vacuity. Returning the operator's price for every card, or refusing to list, would satisfy the
  // cases above. Only the activated package may move.
  const w = await world();
  const untouched = Number(w.sqlite.prepare("SELECT base_price_per_pet FROM boarding_commercial_packages WHERE package_code='boarding-4h'").get().base_price_per_pet);
  w.activate("boarding", "boarding-24h", 2500);

  const moved = await w.advertised(w.boarding, BOARDING_CATALOGUE, "boarding-24h");
  const still = await w.advertised(w.boarding, BOARDING_CATALOGUE, "boarding-4h");

  assert.equal(Number(moved.base_price_per_pet), 2500);
  assert.equal(Number(still.base_price_per_pet), untouched, "an unactivated package keeps its catalogue price");
  assert.equal(still.price_source, "fallback_default");
});

test("W1-F14: the extra-pet price on a Sitting card follows Pricing Control too", async () => {
  // createLiveSittingQuote resolves `<code>__extra_pet` as a package of its own. The card renders a
  // second-pet price beside the first, so leaving it on the catalogue value reopens the same split one
  // pet later.
  const w = await world();
  w.activate("pet_sitting", "sitting-overnight__extra_pet", 611);

  const card = await w.advertised(w.sitting, SITTING_CATALOGUE, "sitting-overnight");
  const quote = await w.call(w.sitting, "/api/sitting-commercial", { ...sittingQuoteBody, petCount: 2 });
  assert.equal(quote.status, 201, `the quote must be produced: ${JSON.stringify(quote.body)}`);

  assert.equal(Number(card.extra_pet_price), 611);
  assert.equal(Number(card.extra_pet_price), Number(quote.body.data.extraPetPrice),
    "the advertised second-pet price and the charged one must agree");
});
