/**
 * WAVE 3C - the three verticals the Wave 2 hunt never exercised. [PTJA-W3C]
 *
 * THE GAP, verbatim (ptja/PTJA-FINDINGS.json, domain 02-booking):
 *
 *   "Food, relocation and funeral verticals were NOT exercised... app/api/food-commercial and the
 *    relocation enquiry path were read but not executed for lack of time. They likely share the
 *    resolveLivePrice defect (F1) if they call it — unverified."
 *
 * PROBED. The hypothesis is REFUTED at the structural level and then at the behavioural one:
 *
 *   None of the three calls resolveLivePrice, so none can share a defect in it. Relocation and funeral
 *   carry no price at all - they are case workflows, which is what business decision 1 says Relocation
 *   should be. Food prices from a single versioned table, and its quote-to-order path is FAIL-CLOSED in
 *   a way the original F14 defect was not: the order lookup joins the quote to the catalogue on
 *   `c.version = q.item_version`, so a catalogue change after quoting makes the quote unconvertible
 *   rather than silently charging the old or the new price.
 *
 * F14 was "the catalogue advertised one price while the quote charged another". VERT-02 is the same
 * question asked of Food, and the answer is that the stale quote is refused outright.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3C_VERT_DB__", "__W3C_VERT_ENV__");

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
      try { const out = []; for (const i of items) out.push(await i.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (e) { if (outer) sqlite.exec("ROLLBACK"); throw e; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
const SKU = "FOOD-CHICKEN-1KG";
const CUSTOMER = "CUST-FOOD-1";
const PET = "PET-FOOD-1";

async function foodWorld({ unitPrice = 900 } = {}) {
  sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3C_VERT_DB__ = db;
  globalThis.__W3C_VERT_ENV__ = {};
  const food = await import("../lib/food-governance.ts");
  await food.ensureFoodGovernanceTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,species TEXT NOT NULL,name TEXT)");
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,species,name) VALUES (?,?,?,?)").run(PET, CUSTOMER, "dog", "Bruno");
  sqlite.prepare("INSERT INTO food_catalogue_items (sku,name,pet_type,pack_size,unit_price,max_qty_per_order,active,version,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,1,'2026-01-01','w3c',?)")
    .run(SKU, "Chicken 1kg", "dog", "1kg", unitPrice, 5, Date.now());
  sqlite.prepare("INSERT INTO food_inventory_uat (sku,zone_id,available_units,reserved_units,status,updated_at) VALUES (?,?,?,0,'active',?)").run(SKU, "blr-east", 50, Date.now());
  return { db, food };
}

const quoteInput = { sku: SKU, quantity: 1, zoneId: "blr-east", paymentMode: "sandbox_deferred", customerId: CUSTOMER, petIds: [PET] };
const attempt = (p) => p.then((value) => ({ ok: true, value }), async (error) => ({
  ok: false, status: error instanceof Response ? error.status : null,
  message: error instanceof Response ? await error.clone().text() : String(error?.message ?? error),
}));

test("VERT-01: none of the three verticals calls resolveLivePrice, so none can share a defect in it", async () => {
  // The recorded hypothesis, tested directly.
  for (const file of ["lib/food-governance.ts", "lib/relocation-governance.ts", "lib/funeral-memorial-governance.ts"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /resolveLivePrice|live-pricing-resolver/,
      `${file} does not go through the Pricing Control bridge - if that changes, the F1 question becomes live for it`);
  }
});

test("VERT-02: a Food quote cannot be converted after its catalogue item changes", async () => {
  // The F14 question asked of Food: can the advertised price and the charged price diverge? The order
  // lookup joins quote to catalogue on c.version = q.item_version, so the answer is that the stale
  // quote stops being convertible at all.
  const { db, food } = await foodWorld({ unitPrice: 900 });
  const quote = await food.createFoodQuote(db, quoteInput);
  assert.equal(Number(quote.unitPrice), 900, "quoted at the catalogue price");

  // The operator reprices. Version bumps, exactly as a real catalogue edit does.
  sqlite.prepare("UPDATE food_catalogue_items SET unit_price=?, version=version+1 WHERE sku=?").run(1500, SKU);

  const order = await attempt(food.createFoodOrder(db, {
    idempotencyKey: "idem-vert-02", quoteId: quote.quoteId, customerId: CUSTOMER,
    cityId: "blr", zoneId: "blr-east", actorId: "w3c",
  }));
  assert.equal(order.ok, false,
    `a quote whose catalogue item has been repriced must not convert - neither at the old price nor the new: ${JSON.stringify(order.value ?? {}).slice(0, 250)}`);

  // And nothing was charged either way.
  assert.equal(Number(sqlite.prepare("SELECT COUNT(*) c FROM food_order_lines").get().c), 0,
    "no order line may be written from a stale quote");
});

test("VERT-03 (non-vacuity): an unchanged Food quote DOES convert, at the price it was quoted", async () => {
  // Without this, VERT-02 would pass on a path that refuses every order.
  const { db, food } = await foodWorld({ unitPrice: 900 });
  const quote = await food.createFoodQuote(db, quoteInput);
  const order = await attempt(food.createFoodOrder(db, {
    idempotencyKey: "idem-vert-03", quoteId: quote.quoteId, customerId: CUSTOMER,
    cityId: "blr", zoneId: "blr-east", actorId: "w3c",
  }));
  assert.equal(order.ok, true, `an unchanged quote must convert: ${JSON.stringify(order).slice(0, 250)}`);
  const line = sqlite.prepare("SELECT unit_price,item_version FROM food_order_lines").get();
  assert.equal(Number(line.unit_price), 900, "and charges exactly what was quoted");
  assert.equal(Number(line.item_version), 1, "carrying the catalogue version it was quoted from");
});

test("VERT-04: Relocation and Funeral carry no price, so no advertised/charged divergence exists", async () => {
  // Business decision 1 says Relocation stays a case workflow. This pins it: if either vertical ever
  // grows a price, that is a deliberate change that must be reviewed against Pricing Control, not a
  // quiet addition of a second uncontrolled pricing source.
  for (const file of ["lib/relocation-governance.ts", "lib/funeral-memorial-governance.ts"]) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /\b(unit_price|base_price|total_amount|amount_due_now)\b/,
      `${file} is a case workflow and must not acquire pricing without a deliberate decision`);
  }
});
