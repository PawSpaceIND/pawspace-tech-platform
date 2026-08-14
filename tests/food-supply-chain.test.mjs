import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, so the REAL route and libs execute unmodified.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__FSC_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__FSC_DB__ = makeD1(sqlite); }

const route = await import("../app/api/food-supply-chain/route.ts");
const { saveFoodSupplier, saveFoodKitchen, createFoodPurchaseOrder, receiveFoodPurchaseOrder, recordFoodWastage, sweepExpiredFoodBatches, setFoodReorderPolicy, foodSupplyChainSnapshot } = await import("../lib/food-supply-chain.ts");
const { createFoodQuote } = await import("../lib/food-governance.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
const call = async (method, bodyOrQuery) => {
  const url = `http://localhost/api/food-supply-chain${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url)
    : new Request(url, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(bodyOrQuery) });
  const response = await (method === "GET" ? route.GET(request) : route.POST(request));
  return { status: response.status, body: await parseBody(response) };
};

const DOG_SKU = "food-uat-dog-adult-2kg"; // seeded by food governance: 30 units in blr-east, max 5/order
function inventory(sku = DOG_SKU, zone = "blr-east") {
  return { ...sqlite.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").get(sku, zone) };
}
async function seedSupplierAndPo(db, { quantity = 20, zone = "blr-east", sku = DOG_SKU } = {}) {
  const supplier = await saveFoodSupplier(db, { name: "Fresh Farm Kitchens", contactPhone: "+91-9000000051", actorId: "ops:uat" });
  const kitchen = await saveFoodKitchen(db, { name: "Indiranagar kitchen", zoneId: zone, actorId: "ops:uat" });
  const po = await createFoodPurchaseOrder(db, { supplierId: supplier.supplierId, kitchenId: kitchen.kitchenId, sku, zoneId: zone, quantity, unitCost: 120, idempotencyKey: `po-${sku}-${quantity}`, actorId: "ops:uat" });
  return { supplier, kitchen, po };
}

// ---- 1. Procurement -> dated batch -> sellable stock ---------------------------------------------

test("real execution: receiving a purchase order creates a dated batch and raises the SAME inventory the customer quote path reads", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  const { po, kitchen } = await seedSupplierAndPo(db, { quantity: 20 });
  assert.equal(po.status, "ordered");
  assert.equal(inventory().available_units, 30, "seeded stock before receiving");
  const received = await receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2026-09-10", actorId: "ops:uat" });
  assert.equal(received.status, "received");
  assert.equal(received.quantityReceived, 20);
  assert.equal(inventory().available_units, 50, "30 seeded + 20 received");
  const batch = { ...sqlite.prepare("SELECT * FROM food_stock_batches WHERE id=?").get(received.batchId) };
  assert.equal(batch.quantity_remaining, 20);
  assert.equal(batch.preparation_date, "2026-08-10");
  assert.equal(batch.expiry_date, "2026-09-10");
  assert.equal(batch.kitchen_id, kitchen.kitchenId, "batch is traceable to its kitchen");
  assert.equal(batch.status, "available");
  // FULL CHAIN: the increased stock is immediately quotable through the REAL customer path
  const quote = await createFoodQuote(db, { sku: DOG_SKU, quantity: 5, zoneId: "blr-east", paymentMode: "sandbox_deferred" });
  assert.equal(quote.totalAmount, 5 * 799, "the customer quote engine sees the received stock");
});

test("real execution: receive is idempotent and race-safe — one PO can never become double stock", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  const { po } = await seedSupplierAndPo(db, { quantity: 10 });
  const race = await Promise.all([
    receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2026-09-10", actorId: "ops:a" }),
    receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2026-09-10", actorId: "ops:b" }),
  ]);
  assert.equal(race.filter(result => !result.duplicatePrevented).length, 1, "exactly one receive wins");
  assert.equal(inventory().available_units, 40, "30 + 10 exactly once, not 50");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_stock_batches").get().n, 1);
  const replay = await receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2026-09-10", actorId: "ops:c" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(inventory().available_units, 40);
  // PO creation itself is idempotent per key
  const supplierId = String(sqlite.prepare("SELECT supplier_id FROM food_purchase_orders LIMIT 1").get().supplier_id);
  const again = await createFoodPurchaseOrder(db, { supplierId, sku: DOG_SKU, zoneId: "blr-east", quantity: 10, unitCost: 120, idempotencyKey: `po-${DOG_SKU}-10`, actorId: "ops:uat" });
  assert.equal(again.duplicatePrevented, true);
});

test("real execution: purchase orders are validated — unknown SKU, paused supplier and bad dates are refused", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  const supplier = await saveFoodSupplier(db, { name: "Fresh Farm", contactPhone: "+91-9000000052", actorId: "ops:uat" });
  await assert.rejects(createFoodPurchaseOrder(db, { supplierId: supplier.supplierId, sku: "sku-not-in-catalogue", zoneId: "blr-east", quantity: 5, unitCost: 100, idempotencyKey: "po-x", actorId: "a" }), (e) => e instanceof Response && e.status === 404);
  await saveFoodSupplier(db, { id: supplier.supplierId, name: "Fresh Farm", contactPhone: "+91-9000000052", status: "paused", actorId: "ops:uat" });
  await assert.rejects(createFoodPurchaseOrder(db, { supplierId: supplier.supplierId, sku: DOG_SKU, zoneId: "blr-east", quantity: 5, unitCost: 100, idempotencyKey: "po-y", actorId: "a" }), (e) => e instanceof Response && e.status === 409, "paused suppliers take no POs");
  await saveFoodSupplier(db, { id: supplier.supplierId, name: "Fresh Farm", contactPhone: "+91-9000000052", status: "active", actorId: "ops:uat" });
  const po = await createFoodPurchaseOrder(db, { supplierId: supplier.supplierId, sku: DOG_SKU, zoneId: "blr-east", quantity: 5, unitCost: 100, idempotencyKey: "po-z", actorId: "a" });
  await assert.rejects(receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-09-10", expiryDate: "2026-09-10", actorId: "a" }), (e) => e instanceof Response && e.status === 400, "expiry must be after preparation");
});

// ---- 2. Wastage and expiry: guarded stock-out, never negative, exactly once ---------------------

test("real execution: wastage decrements batch + zone inventory, refuses over-wastage, and replays idempotently", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  const { po } = await seedSupplierAndPo(db, { quantity: 10 });
  const received = await receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2026-09-10", actorId: "ops:uat" });
  const wasted = await recordFoodWastage(db, { batchId: received.batchId, quantity: 4, reason: "packaging damaged in transit", idempotencyKey: "waste-1", actorId: "ops:uat" });
  assert.equal(wasted.quantity, 4);
  assert.equal(sqlite.prepare("SELECT quantity_remaining FROM food_stock_batches WHERE id=?").get(received.batchId).quantity_remaining, 6);
  assert.equal(inventory().available_units, 36, "40 - 4");
  const replay = await recordFoodWastage(db, { batchId: received.batchId, quantity: 4, reason: "packaging damaged in transit", idempotencyKey: "waste-1", actorId: "ops:uat" });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(inventory().available_units, 36, "replay must not double-waste");
  await assert.rejects(recordFoodWastage(db, { batchId: received.batchId, quantity: 7, reason: "attempting to waste more than remains", idempotencyKey: "waste-2", actorId: "ops:uat" }),
    (e) => e instanceof Response && e.status === 409, "wastage can never exceed the batch remainder");
  // Wasting the exact remainder exhausts the batch
  await recordFoodWastage(db, { batchId: received.batchId, quantity: 6, reason: "spoiled after cold-chain break", idempotencyKey: "waste-3", actorId: "ops:uat" });
  assert.equal(sqlite.prepare("SELECT status,quantity_remaining FROM food_stock_batches WHERE id=?").get(received.batchId).status, "exhausted");
  assert.equal(inventory().available_units, 30, "back to the seeded base");
});

test("real execution: the expiry sweep expires past-dated batches exactly once with auto-wastage of the remainder", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  const { po } = await seedSupplierAndPo(db, { quantity: 8 });
  const received = await receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-01", expiryDate: "2026-08-05", actorId: "ops:uat" });
  assert.equal(inventory().available_units, 38);
  const sweep = await sweepExpiredFoodBatches(db, { actorId: "ops:uat", asOfDate: "2026-08-06" });
  assert.equal(sweep.expiredBatches, 1);
  assert.equal(sweep.unitsWasted, 8);
  assert.equal(inventory().available_units, 30, "expired remainder leaves sellable stock");
  const batch = { ...sqlite.prepare("SELECT status,quantity_remaining FROM food_stock_batches WHERE id=?").get(received.batchId) };
  assert.deepEqual(batch, { status: "expired", quantity_remaining: 0 });
  const wastage = { ...sqlite.prepare("SELECT quantity,source,idempotency_key FROM food_wastage_events WHERE batch_id=?").get(received.batchId) };
  assert.equal(wastage.quantity, 8);
  assert.equal(wastage.source, "expiry_sweep");
  // Re-running the sweep is a no-op
  const again = await sweepExpiredFoodBatches(db, { actorId: "ops:uat", asOfDate: "2026-08-07" });
  assert.equal(again.expiredBatches, 0);
  assert.equal(inventory().available_units, 30);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_wastage_events").get().n, 1);
});

// ---- 3. Reorder governance ------------------------------------------------------------------------

test("real execution: reorder suggestions appear when available-reserved drops below the policy floor and clear after receiving", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  await setFoodReorderPolicy(db, { sku: DOG_SKU, zoneId: "blr-east", minAvailableUnits: 25, reorderQuantity: 30, actorId: "ops:uat" });
  let snapshot = await foodSupplyChainSnapshot(db);
  assert.equal(snapshot.reorderSuggestions.length, 0, "30 seeded units sit above the 25 floor");
  // Reservations eat into availability: 30 available - 8 reserved = 22 < 25
  sqlite.prepare("UPDATE food_inventory_uat SET reserved_units=8 WHERE sku=? AND zone_id='blr-east'").run(DOG_SKU);
  snapshot = await foodSupplyChainSnapshot(db);
  assert.equal(snapshot.reorderSuggestions.length, 1);
  assert.deepEqual(snapshot.reorderSuggestions[0], { sku: DOG_SKU, zoneId: "blr-east", available: 22, minAvailableUnits: 25, suggestedQuantity: 30 });
  assert.equal(snapshot.metrics.skusBelowReorderLevel, 1);
  // Receiving the suggested PO clears the suggestion
  const { po } = await seedSupplierAndPo(db, { quantity: 30 });
  await receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2026-09-10", actorId: "ops:uat" });
  snapshot = await foodSupplyChainSnapshot(db);
  assert.equal(snapshot.reorderSuggestions.length, 0, "52 available clears the floor");
});

// ---- 4. Route + snapshot + contracts ----------------------------------------------------------------

test("real execution: the route drives the full supplier -> PO -> receive -> wastage cycle and reports expiry buckets", async () => {
  freshDb();
  const supplier = await call("POST", { action: "save_supplier", name: "Fresh Farm Kitchens", contactPhone: "+91-9000000053" });
  assert.equal(supplier.status, 200, JSON.stringify(supplier.body));
  const po = await call("POST", { action: "create_po", supplierId: supplier.body.data.supplierId, sku: DOG_SKU, zoneId: "blr-east", quantity: 12, unitCost: 110, idempotencyKey: "po-route-1" });
  assert.equal(po.status, 200, JSON.stringify(po.body));
  const soon = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10); // expires tomorrow -> 48h bucket
  const received = await call("POST", { action: "receive_po", purchaseOrderId: po.body.data.purchaseOrderId, preparationDate: "2026-08-01", expiryDate: soon });
  assert.equal(received.status, 200, JSON.stringify(received.body));
  const snapshot = await call("GET");
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.data.metrics.availableBatchUnits, 12);
  assert.equal(snapshot.body.data.expiry.expiringWithin48h.length, 1, "tomorrow's expiry lands in the 48h bucket");
  assert.equal(snapshot.body.data.truth.autoPurchase, false);
  const waste = await call("POST", { action: "record_wastage", batchId: received.body.data.batchId, quantity: 2, reason: "sample opened for QC", idempotencyKey: "waste-route-1" });
  assert.equal(waste.status, 200, JSON.stringify(waste.body));
  const bad = await call("POST", { action: "create_po", supplierId: supplier.body.data.supplierId, sku: DOG_SKU, zoneId: "blr-east", quantity: 0, unitCost: 110, idempotencyKey: "po-route-2" });
  assert.equal(bad.status, 400, "zero-quantity purchase orders are refused");
});

test("contract: gateway permission line, DB access rule, and the team surface exist", () => {
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /food-supply-chain"\)return "bookings\.manage"/);
  const source = fs.readFileSync(new URL("../app/api/food-supply-chain/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /globalThis/, "the route must get the DB via cloudflare:workers env, never globalThis");
  const page = fs.readFileSync(new URL("../app/team/operations/food/supply-chain/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\/api\/food-supply-chain/);
  const lib = fs.readFileSync(new URL("../lib/food-supply-chain.ts", import.meta.url), "utf8");
  assert.match(lib, /autoPurchase:false/, "reorder stays a governed suggestion, never an automatic purchase");
});

// ---------------------------------------------------------------------------
// Expired stock and the sweep window. food_inventory_uat is the counter the
// customer quote and the ops reservation path both read, and neither is
// expiry-aware. So the honest question is: how long can an expired batch stay
// sellable, and does the system say so while it is?
// ---------------------------------------------------------------------------
test("real execution: an expired batch stops being sellable once swept, and is declared while it waits", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  const { po } = await seedSupplierAndPo(db, { quantity: 20 });
  const before = inventory().available_units;
  // Received with an expiry date already in the past.
  await receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2026-09-10", actorId: "ops:uat" });
  assert.equal(inventory().available_units, before + 20, "receiving raises the shared counter");

  // Before the sweep the units are still in the shared counter - the module must not pretend
  // otherwise, and must report the exposure rather than hide it.
  const waiting = await foodSupplyChainSnapshot(db, { asOfDate: "2026-09-15" });
  assert.equal(waiting.expiry.pastExpiryAwaitingSweep, 1, "an expired-but-unswept batch is declared, not hidden");
  assert.ok(waiting.expiry.expiringWithin48h.every(item => item.expiryDate >= "2026-09-15"), "past-expiry stock is not reported as merely expiring soon");

  // The sweep is what removes it from sellable stock, and it removes exactly the remainder.
  const swept = await sweepExpiredFoodBatches(db, { actorId: "system", asOfDate: "2026-09-15" });
  assert.equal(swept.expiredBatches, 1);
  assert.equal(swept.unitsWasted, 20, "the whole remaining batch is written off");
  assert.equal(inventory().available_units, before, "expired units are removed from the counter the customer path reads");
  const batch = sqlite.prepare("SELECT status, quantity_remaining FROM food_stock_batches WHERE purchase_order_id=?").get(po.purchaseOrderId);
  assert.equal(batch.status, "expired");
  assert.equal(batch.quantity_remaining, 0, "the remainder is written off, not left dangling");

  // Sweeping again changes nothing: no double write-off of the same batch.
  const again = await sweepExpiredFoodBatches(db, { actorId: "system", asOfDate: "2026-09-15" });
  assert.equal(again.expiredBatches, 0);
  assert.equal(again.unitsWasted, 0);
  assert.equal(inventory().available_units, before);
});

test("real execution: concurrent stock-outs on one batch can never drive stock negative", async () => {
  freshDb();
  const db = globalThis.__FSC_DB__;
  const { po } = await seedSupplierAndPo(db, { quantity: 10 });
  const before = inventory().available_units;
  await receiveFoodPurchaseOrder(db, { purchaseOrderId: po.purchaseOrderId, preparationDate: "2026-08-10", expiryDate: "2027-01-01", actorId: "ops:uat" });
  const batchId = sqlite.prepare("SELECT id FROM food_stock_batches WHERE purchase_order_id=?").get(po.purchaseOrderId).id;

  // Six simultaneous wastage claims of 3 units against a batch holding 10: at most three can win.
  const attempts = await Promise.all(Array.from({ length: 6 }, (_, index) =>
    recordFoodWastage(db, { batchId, quantity: 3, reason: "cold chain break in transit", idempotencyKey: `waste-race-${index}`, actorId: "ops:uat" })
      .then(() => "ok").catch(() => "refused")));
  const won = attempts.filter(result => result === "ok").length;
  assert.ok(won <= 3, `at most three 3-unit claims can succeed against 10 units, ${won} succeeded`);

  const remaining = sqlite.prepare("SELECT quantity_remaining FROM food_stock_batches WHERE id=?").get(batchId).quantity_remaining;
  assert.ok(remaining >= 0, `batch quantity must never go negative, got ${remaining}`);
  assert.equal(remaining, 10 - won * 3, "the batch reflects exactly the claims that won");
  assert.equal(inventory().available_units, before + 10 - won * 3, "the shared counter matches the batch exactly");
  assert.ok(inventory().available_units >= 0, "the shared inventory counter must never go negative");
});

test("contract: the supply chain module never writes a customer money table", () => {
  const source = fs.readFileSync("lib/food-supply-chain.ts", "utf8");
  for (const table of ["booking_payments", "canonical_bookings", "food_order_payments", "food_refund_ledger", "pawspace_wallet_ledger"]) {
    assert.ok(!new RegExp(`(INSERT INTO|UPDATE|DELETE FROM)\\s+${table}`).test(source), `procurement must never write ${table}`);
  }
});
