/*
 * The Food vertical, executed end to end - one test per stage.
 *
 *   CUSTOMER  catalogue -> quote (pet-matched, stock-checked) -> order
 *   WAREHOUSE accept -> pick a traceable UAT lot -> pack (consumes inventory) -> dispatch -> deliver
 *   MONEY     inventory reservation -> cancellation with segregation of duties -> refund cap
 *   RECURRING subscription renewal: city gating, and no silent auto-charge
 *
 * Food is the only vertical that moves PHYSICAL STOCK, so the tests below care about the two things
 * that cannot be undone by an apology: shipping the wrong food to the wrong animal, and inventory
 * that says one thing while the warehouse holds another.
 *
 * Every test drives the REAL module against a real database. No source-text assertions and no
 * mocked business logic: the shim in helpers/execution-harness.mjs is an adapter from D1's API onto
 * node:sqlite, so each module runs its real SQL against a real engine.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__FOOD_DB__", "__FOOD_ENV__");

const CITY = "blr";
const ZONE = "blr-east";
const CUSTOMER = "FUD-CUS-001";
const DOG_SKU = "food-uat-dog-adult-2kg";
const CAT_SKU = "food-uat-cat-adult-1kg";
const DOG_PET = "FUD-PET-DOG";
const CAT_PET = "FUD-PET-CAT";

const STAGES = [];
const stage = (name, status, detail) => STAGES.push({ name, status, detail });

const PROD_ENV = { NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: "off" };
const foodWorld = (env = PROD_ENV) => world("__FOOD_DB__", "__FOOD_ENV__", env);

function seedCanonical(sqlite) {
  const now = Date.now();
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,name TEXT,primary_phone TEXT,email TEXT,city_id TEXT,consent_json TEXT,status TEXT,created_at INTEGER,updated_at INTEGER);
    CREATE TABLE IF NOT EXISTS canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT,name TEXT,species TEXT,breed TEXT,weight_kg REAL,created_at INTEGER,updated_at INTEGER);
  `);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_customers VALUES (?,?,?,?,?,?,'active',?,?)")
    .run(CUSTOMER, "Food Customer", "9800000666", "fud@example.test", CITY, '{}', now, now);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_pets VALUES (?,?,?,?,?,?,?,?)")
    .run(DOG_PET, CUSTOMER, "Bruno", "dog", "indie", 18, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_pets VALUES (?,?,?,?,?,?,?,?)")
    .run(CAT_PET, CUSTOMER, "Misha", "cat", "indie", 4, now, now);
  sqlite.prepare("INSERT OR REPLACE INTO canonical_pets VALUES (?,?,?,?,?,?,?,?)")
    .run("FUD-PET-OTHER", "FUD-CUS-OTHER", "Someone else's dog", "dog", "lab", 20, now, now);
}

async function foodOrderWorld() {
  const w = foodWorld();
  const gov = await import("../lib/food-governance.ts");
  await gov.ensureFoodGovernanceTables(w.db);
  seedCanonical(w.sqlite);
  return { ...w, gov };
}

// --- 1. CUSTOMER: catalogue, pet match, stock --------------------------------
test("FUD-01 catalogue: every item is stocked per zone and typed to a species", async () => {
  const { db } = await foodOrderWorld();
  const gov = await import("../lib/food-governance.ts");
  const listed = await attempt(() => gov.listFoodCatalogue(db, ZONE));
  assert.equal(listed.ok, true, `the catalogue must load: ${String(listed.body ?? "").slice(0, 160)}`);
  assert.ok(listed.value.length > 0, "the UAT catalogue must not be empty");

  const by = new Map(listed.value.map((i) => [String(i.sku), i]));
  const dog = by.get(DOG_SKU), cat = by.get(CAT_SKU);
  assert.ok(dog && cat, "both a dog and a cat item must be offered");
  assert.equal(String(dog.pet_type), "dog");
  assert.equal(String(cat.pet_type), "cat");
  assert.equal(Number(dog.unit_price), 799);

  for (const item of listed.value) {
    assert.ok(Number(item.max_qty_per_order) >= 1, `${item.sku} must cap how much one order may take`);
    assert.ok(Number(item.available_units) >= 0, `${item.sku} must not report negative stock`);
  }
  stage("Catalogue", "PASS", `${listed.value.length} SKUs, each species-typed, per-order capped and stocked for ${ZONE}`);
});

test("FUD-02 quote: food is matched to the customer's own pet of the right species", async () => {
  const { db } = await foodOrderWorld();
  const gov = await import("../lib/food-governance.ts");
  const quote = (over = {}) => attempt(() => gov.createFoodQuote(db, {
    sku: DOG_SKU, quantity: 1, zoneId: ZONE, paymentMode: "sandbox_deferred",
    customerId: CUSTOMER, petIds: [DOG_PET], ...over,
  }));

  const good = await quote();
  assert.equal(good.ok, true, `a dog food order for a dog must price: ${String(good.body ?? "").slice(0, 200)}`);
  assert.equal(good.value.totalAmount, 799, "the catalogue price, not the client's number");

  /* Shipping cat food to a dog is not a pricing error, it is a welfare one. */
  const wrongSpecies = await quote({ petIds: [CAT_PET] });
  assert.equal(wrongSpecies.ok, false, "dog food must not be ordered for a cat");

  /* And a customer must not order against somebody else's animal. */
  const notMine = await quote({ petIds: ["FUD-PET-OTHER"] });
  assert.equal(notMine.ok, false, "a customer must not order food against another customer's pet");

  const unknownPet = await quote({ petIds: ["FUD-PET-GHOST"] });
  assert.equal(unknownPet.ok, false, "a pet that does not exist cannot be fed");

  const noPet = await quote({ petIds: [] });
  assert.equal(noPet.ok, false, "food must be ordered for a named pet, not for nobody");

  const tooMany = await quote({ quantity: 99 });
  assert.equal(tooMany.ok, false, "an order must not exceed the per-order cap");

  const zero = await quote({ quantity: 0 });
  assert.equal(zero.ok, false, "a zero-quantity order is not an order");

  const prepaid = await quote({ paymentMode: "prepaid" });
  assert.equal(prepaid.ok, false, "Food must refuse a payment mode it does not govern");

  const coupon = await quote({ couponCode: "SAVE50" });
  assert.equal(coupon.ok, false, "Food must refuse a coupon rather than silently ignore it");

  const unknownSku = await quote({ sku: "food-uat-unicorn-1kg" });
  assert.equal(unknownSku.ok, false, "an unknown SKU must not be quotable");
  stage("Quote + pet match", "PASS", "wrong species, another customer's pet, unknown pet, no pet, over-cap, zero, prepaid, coupon and unknown SKU all refused");
});

// --- 2. WAREHOUSE: the fulfilment chain and the stock it moves ----------------
/** Quote -> order, returning the order id and the inventory snapshot before and after. */
async function placeOrder(db, over = {}) {
  const gov = await import("../lib/food-governance.ts");
  const q = await gov.createFoodQuote(db, {
    sku: over.sku ?? DOG_SKU, quantity: over.quantity ?? 1, zoneId: ZONE,
    paymentMode: "sandbox_deferred", customerId: CUSTOMER, petIds: over.petIds ?? [DOG_PET],
  });
  const order = await gov.createFoodOrder(db, {
    idempotencyKey: over.idempotencyKey ?? `fud-idem-${Math.random()}`,
    quoteId: String(q.quoteId ?? q.id), customerId: CUSTOMER, cityId: CITY, zoneId: ZONE,
    actorId: over.actorId ?? CUSTOMER,
  });
  return { quote: q, orderId: String(order.orderId ?? order.id), order };
}

const stock = (sqlite, sku = DOG_SKU) =>
  sqlite.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").get(sku, ZONE);

test("FUD-03 ordering: placing an order reserves stock, and one key is one order", async () => {
  const { db, sqlite } = await foodOrderWorld();
  const before = stock(sqlite);

  const { orderId } = await placeOrder(db, { quantity: 2, idempotencyKey: "fud-key-1" });
  assert.ok(orderId, "an order must be created");
  const after = stock(sqlite);
  assert.equal(Number(after.reserved_units), Number(before.reserved_units) + 2,
    "placing an order must RESERVE the units, so another customer cannot be sold the same bags");
  assert.equal(Number(after.available_units), Number(before.available_units),
    "reservation must not yet consume availability - the food is still on the shelf until it is packed");

  /* One idempotency key is one order: a retried request must not reserve a second time. */
  const gov = await import("../lib/food-governance.ts");
  const q2 = await gov.createFoodQuote(db, {
    sku: DOG_SKU, quantity: 2, zoneId: ZONE, paymentMode: "sandbox_deferred",
    customerId: CUSTOMER, petIds: [DOG_PET],
  });
  const replay = await attempt(() => gov.createFoodOrder(db, {
    idempotencyKey: "fud-key-1", quoteId: String(q2.quoteId ?? q2.id),
    customerId: CUSTOMER, cityId: CITY, zoneId: ZONE, actorId: CUSTOMER,
  }));
  assert.equal(replay.ok, false, "the same key against a DIFFERENT quote must be refused, not silently reused");

  /* And a key that belongs to another customer must never resolve to their order. */
  const stolen = await attempt(() => gov.createFoodOrder(db, {
    idempotencyKey: "fud-key-1", quoteId: String(q2.quoteId ?? q2.id),
    customerId: "FUD-CUS-OTHER", cityId: CITY, zoneId: ZONE, actorId: "FUD-CUS-OTHER",
  }));
  assert.equal(stolen.ok, false, "one customer must not reach another customer's order through its key");
  assert.equal(stolen.status, 403);
  assert.equal(Number(stock(sqlite).reserved_units), Number(before.reserved_units) + 2,
    "neither refused attempt may have reserved more stock");
  stage("Ordering + reservation", "PASS", "2 units reserved without consuming availability; a reused key across quotes and a cross-customer key both refused");
});

test("FUD-04 fulfilment: accept, pick a traceable non-production lot, pack, dispatch, deliver - in order", async () => {
  const { db, sqlite } = await foodOrderWorld();
  const { orderId } = await placeOrder(db, { quantity: 2 });
  const ful = await import("../lib/food-fulfilment-governance.ts");
  await ful.ensureFoodFulfilmentTables(db);
  const act = (action, over = {}) => attempt(() => ful.mutateFoodFulfilment(db, {
    orderId, action, actorId: "ops@pawspace.test", idempotencyKey: `fud-f-${Math.random()}`, ...over,
  }));

  /* Nothing may be skipped. */
  const pickFirst = await act("pick_order", { lotId: "FUD-LOT-1" });
  assert.equal(pickFirst.ok, false, "an order must be accepted before it is picked");
  assert.match(String(pickFirst.body ?? ""), /must be accepted before picking/i);

  const accepted = await act("accept_order");
  assert.equal(accepted.ok, true, `the order must be acceptable: ${String(accepted.body ?? "").slice(0, 200)}`);

  const packFirst = await act("pack_order");
  assert.equal(packFirst.ok, false, "an order cannot be packed before a lot is picked");

  /* The lot must exist, match the exact SKU and zone, be available, and be explicitly
   * NON-production - this is food traceability, so a wrong or unverified lot is a recall risk. */
  const lot = (id, over = {}) => sqlite
    .prepare("INSERT OR REPLACE INTO food_uat_lots (id,sku,zone_id,lot_label,expiry_date,status,production_lot_verified,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, over.sku ?? DOG_SKU, over.zoneId ?? ZONE, `LOT-${id}`, "2027-01-31",
         over.status ?? "uat_available", over.productionVerified ?? 0, Date.now(), Date.now());
  lot("FUD-LOT-OK");
  lot("FUD-LOT-WRONG-SKU", { sku: CAT_SKU });
  lot("FUD-LOT-WRONG-ZONE", { zoneId: "blr-west" });
  lot("FUD-LOT-CONSUMED", { status: "uat_consumed" });
  lot("FUD-LOT-PRODUCTION", { productionVerified: 1 });

  for (const [label, lotId, pattern] of [
    ["a lot for a different SKU", "FUD-LOT-WRONG-SKU", /exact ordered SKU and zone/i],
    ["a lot from a different zone", "FUD-LOT-WRONG-ZONE", /exact ordered SKU and zone/i],
    ["an already-consumed lot", "FUD-LOT-CONSUMED", /exact ordered SKU and zone/i],
    ["a lot that does not exist", "FUD-LOT-GHOST", /exact ordered SKU and zone/i],
    ["a production-traceable lot", "FUD-LOT-PRODUCTION", /explicitly non-production/i],
  ]) {
    const res = await act("pick_order", { lotId });
    assert.equal(res.ok, false, `${label} must not be pickable`);
    assert.match(String(res.body ?? ""), pattern, `${label} must be refused for its own reason`);
  }

  const picked = await act("pick_order", { lotId: "FUD-LOT-OK" });
  assert.equal(picked.ok, true, `a matching available UAT lot must be pickable: ${String(picked.body ?? "").slice(0, 200)}`);

  /* Packing is where reserved stock actually leaves the shelf. */
  /* If the reservation has gone - another process consumed it, or a correction reset the shelf -
   * packing must REFUSE rather than drive the counters negative. My first version only ever packed
   * against healthy stock, so deleting this guard changed nothing and the test stayed green. */
  const held = stock(sqlite);
  sqlite.prepare("UPDATE food_inventory_uat SET reserved_units=0,available_units=0 WHERE sku=? AND zone_id=?").run(DOG_SKU, ZONE);
  const starved = await act("pack_order");
  assert.equal(starved.ok, false, "packing must refuse when the reservation it needs is no longer there");
  assert.match(String(starved.body ?? ""), /reservation is no longer packable/i);
  const afterRefusal = stock(sqlite);
  assert.equal(Number(afterRefusal.available_units), 0, "a refused pack must not move stock");
  assert.equal(Number(afterRefusal.reserved_units), 0, "a refused pack must not drive reserved units negative");
  sqlite.prepare("UPDATE food_inventory_uat SET reserved_units=?,available_units=? WHERE sku=? AND zone_id=?")
    .run(Number(held.reserved_units), Number(held.available_units), DOG_SKU, ZONE);

  const beforePack = stock(sqlite);
  const packed = await act("pack_order");
  assert.equal(packed.ok, true, `a picked order must be packable: ${String(packed.body ?? "").slice(0, 200)}`);
  const afterPack = stock(sqlite);
  assert.equal(Number(afterPack.available_units), Number(beforePack.available_units) - 2,
    "packing must consume availability - the bags have physically left");
  assert.equal(Number(afterPack.reserved_units), Number(beforePack.reserved_units) - 2,
    "packing must release the reservation it just consumed, never double-count it");

  const deliverEarly = await act("confirm_delivery");
  assert.equal(deliverEarly.ok, false, "an order cannot be delivered before it is dispatched");

  const dispatched = await act("dispatch_order", { dispatchReference: "FUD-DISPATCH-1" });
  assert.equal(dispatched.ok, true, `a packed order must be dispatchable: ${String(dispatched.body ?? "").slice(0, 200)}`);
  /* Who took the delivery is a governed fact here too, not free text. */
  const inventedMethod = await act("confirm_delivery", { handoverMethod: "left_at_door" });
  assert.equal(inventedMethod.ok, false, "an invented delivery handover method must be refused");
  assert.match(String(inventedMethod.body ?? ""), /governed UAT Food delivery handover method/i);
  const noMethod = await act("confirm_delivery");
  assert.equal(noMethod.ok, false, "a delivery with no stated handover method must be refused");

  const delivered = await act("confirm_delivery", { handoverMethod: "customer" });
  assert.equal(delivered.ok, true, `a dispatched order must be deliverable: ${String(delivered.body ?? "").slice(0, 200)}`);
  assert.equal(sqlite.prepare("SELECT status FROM food_order_fulfilment WHERE order_id=?").get(orderId).status, "delivered");
  stage("Fulfilment chain", "PASS", "each step refused out of order; wrong SKU, wrong zone, consumed, missing and production lots refused; packing against a vanished reservation refused without going negative; invented delivery handover refused; packing moved 2 units off the shelf exactly once");
});

// --- 3. MONEY: cancellation, refund cap, and released stock -------------------
test("FUD-05 cancellation: no self-approval, no over-refund, and the reserved stock goes back", async () => {
  const { db, sqlite } = await foodOrderWorld();
  const before = stock(sqlite);
  const { orderId } = await placeOrder(db, { quantity: 2 });
  assert.equal(Number(stock(sqlite).reserved_units), Number(before.reserved_units) + 2);

  const fin = await import("../lib/food-finance-governance.ts");
  await fin.ensureFoodFinanceTables(db);
  const call = (action, over = {}) => attempt(() => fin.mutateFoodFinance(db, {
    orderId, action, actorId: CUSTOMER, idempotencyKey: `fud-m-${Math.random()}`,
    reason: "customer changed their mind about this order", ...over,
  }));

  const requested = await call("request_cancel", { idempotencyKey: "fud-rc-1" });
  assert.equal(requested.ok, true, `a cancellation request must open: ${String(requested.body ?? "").slice(0, 220)}`);

  const replay = await call("request_cancel", { idempotencyKey: "fud-rc-1" });
  assert.equal(replay.value.duplicatePrevented, true, "a replayed key must not open a second request");

  /* Segregation of duties: the requester must not approve their own refund. */
  const selfApprove = await call("approve_cancel", { action: "approve_cancel", approvedRefundAmount: 1598 });
  assert.equal(selfApprove.ok, false, "the requester must not approve their own cancellation");
  assert.match(String(selfApprove.body ?? ""), /segregation of duties/i);

  /* A refund can never exceed what was actually paid. */
  const over = await call("approve_cancel", { actorId: "finance@pawspace.test", approvedRefundAmount: 999999 });
  assert.equal(over.ok, false, "a refund larger than the money collected must be refused");

  const approved = await call("approve_cancel", { actorId: "finance@pawspace.test", approvedRefundAmount: 0, idempotencyKey: "fud-ac-1" });
  assert.equal(approved.ok, true, `finance must be able to approve the cancellation: ${String(approved.body ?? "").slice(0, 220)}`);
  assert.equal(sqlite.prepare("SELECT status FROM food_orders WHERE id=?").get(orderId).status, "cancelled");

  /* The stock a cancelled order was holding must return to the shelf, or the warehouse slowly
   * starves itself of sellable inventory that physically exists. */
  const after = stock(sqlite);
  assert.equal(Number(after.reserved_units), Number(before.reserved_units),
    "cancelling must RELEASE the reservation, not strand it");
  assert.equal(Number(after.available_units), Number(before.available_units),
    "a cancelled order that never shipped must leave availability untouched");
  stage("Cancellation + stock release", "PASS", "self-approval and over-refund refused; the cancelled order released its 2 reserved units back to the shelf");
});

// --- 4. RECURRING: subscriptions renew, but nothing charges itself ------------
test("FUD-06 subscriptions: renewals are city-gated and never silently charge a customer", async () => {
  /* This is the highest-risk surface in Food: money that moves on a schedule with nobody present.
   * The two properties that matter are that a closed market cannot renew customers into itself, and
   * that the engine does not claim to have taken money. */
  const { db, sqlite } = await foodOrderWorld();
  const subs = await import("../lib/food-subscription-governance.ts");
  await subs.ensureFoodSubscriptionTables(db);
  const { orderId } = await placeOrder(db, { quantity: 1 });

  /* The interval is the customer's explicit choice, bounded 7-90 days - a subscription that renews
   * on a cadence nobody chose is the classic recurring-billing complaint. Both bounds pinned. */
  const create = (over = {}) => attempt(() => subs.createFoodSubscription(db, {
    sourceOrderId: orderId, customerId: CUSTOMER, renewalIntervalDays: 30,
    communicationChannel: "whatsapp", actorId: CUSTOMER, ...over,
  }));
  for (const [label, days] of [["a 3-day", 3], ["a 365-day", 365], ["a zero", 0], ["a negative", -30]]) {
    const res = await create({ renewalIntervalDays: days });
    assert.equal(res.ok, false, `${label} renewal interval must be refused`);
    assert.match(String(res.body ?? ""), /explicit customer-selected 7-90 days/i);
  }
  /* A fractional interval is FLOORED to whole days rather than refused - which is right, but it
   * must not be stored fractionally, or the next renewal date drifts by hours every cycle.
   * On its OWN order: a subscription is one-per-source-order, so reusing this order here would
   * hand the main assertions below a cancelled subscription that never enters the sweep. */
  const second = await placeOrder(db, { idempotencyKey: "fud-sub-frac" });
  const fractional = await create({ renewalIntervalDays: 30.5, sourceOrderId: second.orderId });
  if (fractional.ok) {
    const storedInterval = sqlite.prepare("SELECT renewal_interval_days FROM food_subscriptions WHERE id=?")
      .get(String(fractional.value.subscriptionId ?? fractional.value.id)).renewal_interval_days;
    assert.equal(Number(storedInterval), 30, "a fractional interval must be floored to whole days, never stored as 30.5");
    await subs.setFoodSubscriptionStatus(db, {
      subscriptionId: String(fractional.value.subscriptionId ?? fractional.value.id),
      status: "cancelled", actorId: CUSTOMER, reason: "fixture cleanup for the interval check",
    });
    assert.equal(sqlite.prepare("SELECT status FROM food_subscriptions WHERE id=?")
      .get(String(fractional.value.subscriptionId ?? fractional.value.id)).status, "cancelled");
  }
  const created = await create();
  assert.equal(created.ok, true, `a subscription must be creatable: ${String(created.body ?? "").slice(0, 220)}`);
  const subscriptionId = String(created.value.subscriptionId ?? created.value.id);

  /* Nothing is due yet, so nothing renews. */
  const early = await attempt(() => subs.processDueFoodSubscriptionRenewals(db, {
    actorId: "scheduler", at: Date.now(),
  }));
  assert.equal(early.ok, true);
  assert.equal(early.value.processed, 0, "a subscription that is not yet due must not renew");

  /* THE CITY GATE, in both directions.
   *
   * CORRECTED. I first asserted that an UNCONFIGURED city blocks renewals. It does not, and that is
   * deliberate: lib/city-status-authority.ts returns allowed for a city with no launch config
   * ("no_launch_governance"), because a first draft that blocked there took every second city
   * offline - the comment in that file says so, and another test pins it. What the gate actually
   * governs is a city that HAS been launched and then paused or closed. That is what is tested here.
   */
  const authority = await import("../lib/city-status-authority.ts");
  const gov2 = await import("../lib/city-governance.ts");
  const setCity = async (status) => {
    await gov2.seedDefaultCityLaunchConfigs(db);
    await db.prepare("UPDATE city_launch_configs SET status=?,updated_at=? WHERE city_code=?")
      .bind(status, Date.now(), CITY).run();
  };

  sqlite.prepare("UPDATE food_subscriptions SET next_renewal_at=? WHERE id=?").run(Date.now() - 1000, subscriptionId);
  await setCity("Paused");
  const paused = await attempt(() => subs.processDueFoodSubscriptionRenewals(db, { actorId: "scheduler" }));
  assert.equal(paused.ok, true);
  assert.equal(paused.value.processed, 0, "a PAUSED city must not renew anybody into itself");
  assert.deepEqual(paused.value.skippedForCity, [subscriptionId],
    "the skip must be recorded against this subscription, not silently swallowed");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_subscription_renewals WHERE subscription_id=?").get(subscriptionId).n, 0,
    "a city-skipped subscription must raise no renewal at all");

  await setCity("Closed");
  const closed = await attempt(() => subs.processDueFoodSubscriptionRenewals(db, { actorId: "scheduler" }));
  assert.equal(closed.value.processed, 0, "a CLOSED city must not renew anybody into itself either");

  /* Reopen the market. Without this direction the gate above would pass by refusing everything. */
  await setCity("Live");
  const due = await attempt(() => subs.processDueFoodSubscriptionRenewals(db, { actorId: "scheduler" }));
  assert.equal(due.ok, true, `a due subscription in a live city must renew: ${String(due.body ?? "").slice(0, 220)}`);
  assert.equal(due.value.processed, 1, `a live city must renew the due subscription, skipped: ${JSON.stringify(due.value.skippedForCity)}`);
  assert.equal(due.value.autoCharge, false,
    "the renewal engine must NOT claim to charge the customer automatically");
  assert.equal(due.value.liveMoney, false, "no live money may be claimed by a renewal");
  assert.equal(due.value.schedulerConnected, false,
    "the engine must say plainly that no scheduler is connected rather than implying one is");

  /* Running the sweep again must not raise a second renewal for the same period. */
  const again = await attempt(() => subs.processDueFoodSubscriptionRenewals(db, { actorId: "scheduler" }));
  assert.equal(again.ok, true);
  const renewalCount = sqlite.prepare("SELECT COUNT(*) n FROM food_subscription_renewals WHERE subscription_id=?").get(subscriptionId).n;
  assert.equal(renewalCount, 1, "a repeated sweep must not bill the customer twice for one period");

  /* A paused subscription stops renewing. */
  await subs.setFoodSubscriptionStatus(db, { subscriptionId, status: "paused", actorId: CUSTOMER, reason: "customer travelling" });
  sqlite.prepare("UPDATE food_subscriptions SET next_renewal_at=? WHERE id=?").run(Date.now() - 1000, subscriptionId);
  const pausedSub = await attempt(() => subs.processDueFoodSubscriptionRenewals(db, { actorId: "scheduler" }));
  assert.equal(pausedSub.ok, true);
  assert.equal(pausedSub.value.processed, 0, "a paused subscription must not renew");
  stage("Subscription renewal", "PASS", "7-90 day interval enforced and floored; Paused and Closed cities renew nobody; a Live city renews once, not twice; a paused subscription stops; autoCharge false, liveMoney false, no scheduler claimed");
});

// --- SCOPE REPORT -------------------------------------------------------------
test("FUD-99 food vertical scope report", () => {
  const by = (s) => STAGES.filter((x) => x.status === s).length;
  console.log("\n===== FOOD VERTICAL =====\n" +
    STAGES.map((x) => `  ${x.status.padEnd(7)} ${x.name}${x.detail ? ` — ${x.detail}` : ""}`).join("\n") +
    `\n\nPASS ${by("PASS")}  GAP ${by("GAP")}  HARNESS ${by("HARNESS")}\n`);
  assert.ok(STAGES.length > 0);
});
