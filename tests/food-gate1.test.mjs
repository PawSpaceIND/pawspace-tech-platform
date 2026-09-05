/**
 * Fresh Food Gate 1 — EXECUTED. Catalogue and UAT inventory truth, pet-bound quotes, and the atomic
 * reserve-and-order path.
 *
 * WHAT THIS FILE USED TO BE. Five tests, every assertion a regex over the source of
 * `lib/food-governance.ts`, the routes and the customer page. "Food order atomically reserves UAT
 * stock and creates canonical order/payment ledgers" asserted that the words
 * `food_inventory_reservations` and `food_order_payments` appeared in the file. They appear whether
 * the reservation is atomic, whether it is released when the order fails, or whether stock is
 * decremented at all.
 *
 * Each test below calls the real function against a real SQLite-backed D1 and asserts on the rows it
 * wrote. Requests are built on a NON-PREVIEW origin, because `npm test` runs with
 * PAWSPACE_LOCAL_PREVIEW=on and anything posted to localhost resolves to a superuser holding ["*"].
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { FOOD_SKUS, foodUrl, freshSqlite, makeD1, refusal, seedFoodPet } from "./helpers/food-harness.mjs";

installWorkersHooks("__FOOD_G1_DB__", "__FOOD_G1_ENV__");

const governance = await import("../lib/food-governance.ts");

const CUSTOMER = "CUST-FOOD-1";
const PET = "PET-FOOD-1";
const ZONE = "blr-east";

async function foodWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FOOD_G1_DB__ = db;
  globalThis.__FOOD_G1_ENV__ = {};
  await governance.ensureFoodGovernanceTables(db);
  seedFoodPet(sqlite, { petId: PET, customerId: CUSTOMER, species: "dog" });
  return { sqlite, db };
}

const quoteFor = (db, overrides = {}) => governance.createFoodQuote(db, {
  sku: FOOD_SKUS.dogAdult.sku, quantity: 1, zoneId: ZONE, paymentMode: "sandbox_deferred",
  customerId: CUSTOMER, petIds: [PET], ...overrides,
});

const orderFor = (db, quote, overrides = {}) => governance.createFoodOrder(db, {
  idempotencyKey: `idem-${quote.quoteId}`, quoteId: quote.quoteId, customerId: CUSTOMER,
  cityId: "blr", zoneId: ZONE, actorId: CUSTOMER, ...overrides,
});

const availability = (db, sku = FOOD_SKUS.dogAdult.sku) =>
  db.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").bind(sku, ZONE).first();

// ---------------------------------------------------------------------------------------------
test("Fresh Food Gate 1 owns an explicit UAT catalogue and inventory truth", async () => {
  const { db } = await foodWorld();
  const catalogue = await governance.listFoodCatalogue(db, ZONE);

  assert.deepEqual(
    catalogue.map((row) => [row.sku, row.unit_price, row.pet_type, row.pack_size, row.uat_available_units]),
    [
      [FOOD_SKUS.catAdult.sku, 499, "cat", "1 kg", 30],
      [FOOD_SKUS.dogAdult.sku, 799, "dog", "2 kg", 30],
      [FOOD_SKUS.dogPuppy.sku, 849, "dog", "2 kg", 24],
    ],
    "the catalogue is priced and stocked from the database, ordered by price",
  );
  for (const row of catalogue) {
    assert.equal(row.currency, "INR");
    assert.equal(row.commercial_status, "uat_only", "no SKU is presented as a production line");
    assert.equal(row.inventory_mode, "uat_seed");
    assert.equal(row.production_inventory_verified, false, "stock is never claimed to be verified against a warehouse");
    assert.equal(row.max_qty_per_order, 5);
  }

  // Availability is available MINUS reserved, so an in-flight order reduces what the next customer sees.
  const quote = await quoteFor(db);
  await orderFor(db, quote);
  const afterOrder = await governance.listFoodCatalogue(db, ZONE);
  assert.equal(afterOrder.find((row) => row.sku === FOOD_SKUS.dogAdult.sku).uat_available_units, 29);

  // A zone with no seeded inventory reports nothing available rather than the raw catalogue stock.
  const elsewhere = await governance.listFoodCatalogue(db, "mumbai-central");
  assert.equal(elsewhere.length, 3, "the catalogue is national");
  for (const row of elsewhere) assert.equal(row.uat_available_units, 0, "but stock is per zone");
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food quotes are bound to a canonical pet of the right species", async () => {
  const { db, sqlite } = await foodWorld();

  const noPet = await refusal(quoteFor(db, { petIds: [] }));
  assert.equal(noPet?.status, 400);
  assert.match(noPet.message, /requires at least one selected canonical pet/);

  const ghost = await refusal(quoteFor(db, { petIds: ["PET-NOPE"] }));
  assert.equal(ghost?.status, 404);
  assert.match(ghost.message, /pet was not found/);

  // Somebody else's pet cannot be used to buy food, even by a customer who knows its id.
  seedFoodPet(sqlite, { petId: "PET-OTHER", customerId: "CUST-OTHER", species: "dog" });
  const notMine = await refusal(quoteFor(db, { petIds: ["PET-OTHER"] }));
  assert.equal(notMine?.status, 403);
  assert.match(notMine.message, /not owned by this customer/);

  // A cat cannot be quoted dog food.
  seedFoodPet(sqlite, { petId: "PET-CAT", customerId: CUSTOMER, species: "cat" });
  const wrongSpecies = await refusal(quoteFor(db, { petIds: ["PET-CAT"] }));
  assert.equal(wrongSpecies?.status, 409);
  assert.match(wrongSpecies.message, /not eligible for dog food/);

  const catQuote = await quoteFor(db, { sku: FOOD_SKUS.catAdult.sku, petIds: ["PET-CAT"] });
  assert.equal(catQuote.petType, "cat");
  assert.equal(catQuote.unitPrice, 499);
  assert.deepEqual(catQuote.petIds, ["PET-CAT"]);

  // The association is stored, not just returned.
  const stored = await db.prepare("SELECT pet_id,customer_id,pet_type FROM food_quote_pets WHERE quote_id=?").bind(catQuote.quoteId).first();
  assert.equal(stored.pet_id, "PET-CAT");
  assert.equal(stored.customer_id, CUSTOMER);
  assert.equal(stored.pet_type, "cat");
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food quotes check UAT inventory and leave production policy un-invented", async () => {
  const { db } = await foodWorld();

  const prepaid = await refusal(quoteFor(db, { paymentMode: "prepaid" }));
  assert.equal(prepaid?.status, 409);
  assert.match(prepaid.message, /sandbox-deferred UAT payment only/);

  const coupon = await refusal(quoteFor(db, { couponCode: "SAVE10" }));
  assert.equal(coupon?.status, 409);
  assert.match(coupon.message, /coupon policy is not enabled/);

  const unknown = await refusal(quoteFor(db, { sku: "food-uat-unicorn-9kg" }));
  assert.equal(unknown?.status, 404);
  assert.match(unknown.message, /Active UAT Food item not found/);

  for (const quantity of [0, -1, 6, 99]) {
    const bad = await refusal(quoteFor(db, { quantity }));
    assert.equal(bad?.status, 409);
    assert.match(bad.message, /quantity must be 1-5/);
  }

  // Inventory is checked against the ZONE, not the catalogue.
  await db.prepare("UPDATE food_inventory_uat SET available_units=2 WHERE sku=? AND zone_id=?").bind(FOOD_SKUS.dogAdult.sku, ZONE).run();
  const overStock = await refusal(quoteFor(db, { quantity: 3 }));
  assert.equal(overStock?.status, 409);
  assert.match(overStock.message, /inventory is insufficient for this quote/);

  const quote = await quoteFor(db, { quantity: 2 });
  assert.equal(quote.unitPrice, 799, "the price comes from the catalogue, not the caller");
  assert.equal(quote.totalAmount, 1598);
  assert.equal(quote.deliveryFee, 0, "no delivery fee is invented while the policy is unconfigured");
  assert.equal(quote.amountDueNow, 0, "sandbox-deferred takes nothing up front");
  assert.equal(quote.inventoryMode, "uat_seed");
  assert.equal(quote.productionInventoryVerified, false);
  assert.equal(quote.liveMoney, false);
  assert.equal(quote.version, 1, "the quote pins the catalogue version it was priced against");
  assert.ok(quote.expiresAt - Date.now() <= 15 * 60_000);

  // A refused quote reserves nothing.
  const stock = await availability(db);
  assert.equal(Number(stock.reserved_units), 0, "quoting reserves no stock at all");
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food orders atomically reserve UAT stock and write the canonical ledgers", async () => {
  const { db } = await foodWorld();
  const quote = await quoteFor(db, { quantity: 2 });

  const order = await orderFor(db, quote);
  assert.equal(order.status, "uat_reserved");
  assert.match(order.orderId, /^PS-UAT-FOOD-/, "the order id says UAT on its face");
  assert.equal(order.totalAmount, 1598);
  assert.equal(order.amountDueNow, 0);
  assert.equal(order.liveMoney, false);
  assert.equal(order.deliveryStatus, "fulfilment_review_required", "an order is not a promise to deliver");
  assert.deepEqual(order.petIds, [PET]);

  // Stock moved by exactly the ordered quantity, and only reserved -- nothing was consumed yet.
  const stock = await availability(db);
  assert.equal(Number(stock.available_units), 30, "available stock is untouched until the pack step");
  assert.equal(Number(stock.reserved_units), 2);

  const reservation = await db.prepare("SELECT sku,zone_id,quantity,status,inventory_mode FROM food_inventory_reservations WHERE order_id=?").bind(order.orderId).first();
  assert.equal(reservation.sku, FOOD_SKUS.dogAdult.sku);
  assert.equal(reservation.zone_id, ZONE);
  assert.equal(Number(reservation.quantity), 2);
  assert.equal(reservation.status, "reserved");
  assert.equal(reservation.inventory_mode, "uat_seed");

  // The order row itself is stamped UAT on every axis, not just the catalogue it came from.
  const stored = await db.prepare("SELECT total_amount,commercial_status,inventory_mode,delivery_status FROM food_orders WHERE id=?").bind(order.orderId).first();
  assert.equal(Number(stored.total_amount), 1598);
  assert.equal(stored.commercial_status, "uat_only");
  assert.equal(stored.inventory_mode, "uat_seed");
  assert.equal(stored.delivery_status, "fulfilment_review_required");

  const line = await db.prepare("SELECT sku,item_name,quantity,unit_price,line_total FROM food_order_lines WHERE order_id=?").bind(order.orderId).first();
  assert.equal(Number(line.unit_price), 799);
  assert.equal(Number(line.line_total), 1598, "the line total is the server price times quantity");

  const payment = await db.prepare("SELECT amount,amount_due_now,mode,status,gateway,detail_json FROM food_order_payments WHERE order_id=?").bind(order.orderId).first();
  assert.equal(Number(payment.amount), 1598);
  assert.equal(Number(payment.amount_due_now), 0);
  assert.equal(payment.mode, "sandbox_deferred");
  assert.equal(payment.status, "created", "an order creates a payment record, it does not take money");
  assert.equal(payment.gateway, "uat_sandbox");
  assert.deepEqual(JSON.parse(payment.detail_json), {
    liveMoney: false, productionPaymentPolicy: "pending", deliveryFeePolicy: "configuration_required",
  });

  const event = await db.prepare("SELECT event_type,detail_json FROM food_order_events WHERE order_id=?").bind(order.orderId).first();
  assert.equal(event.event_type, "food_order_reserved");
  assert.equal(JSON.parse(event.detail_json).productionInventoryVerified, false);

  // The pet association is carried onto the order, not left behind on the quote.
  const pets = await db.prepare("SELECT pet_id,source_quote_id FROM food_order_pets WHERE order_id=?").bind(order.orderId).all();
  assert.deepEqual(pets.results.map((row) => row.pet_id), [PET]);
  assert.equal(pets.results[0].source_quote_id, quote.quoteId);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food quotes are single use, expiring, customer-bound and stock-rechecked", async () => {
  const { db } = await foodWorld();

  // One quote, one order.
  const once = await quoteFor(db);
  const onceOrder = await orderFor(db, once);
  const twice = await refusal(governance.createFoodOrder(db, {
    idempotencyKey: "idem-second-attempt", quoteId: once.quoteId, customerId: CUSTOMER,
    cityId: "blr", zoneId: ZONE, actorId: CUSTOMER,
  }));
  assert.equal(twice?.status, 409);
  // A spent quote is marked 'used', so a sequential second attempt is caught by the status check
  // rather than by the link check. The "already linked to an order" refusal exists for the race where
  // two orders claim an open quote at once, and is not reachable from a sequential caller.
  assert.match(twice.message, /A valid open server Food quote is required/);
  assert.equal(Number((await availability(db)).reserved_units), 1, "the refused second order reserved nothing more");
  const spent = await db.prepare("SELECT status,used_order_id FROM food_commercial_quotes WHERE id=?").bind(once.quoteId).first();
  assert.equal(spent.status, "used");
  assert.equal(spent.used_order_id, onceOrder.orderId, "the quote records the one order it was spent on");

  // Expired.
  const stale = await quoteFor(db);
  await db.prepare("UPDATE food_commercial_quotes SET expires_at=? WHERE id=?").bind(Date.now() - 1000, stale.quoteId).run();
  const expired = await refusal(orderFor(db, stale));
  assert.equal(expired?.status, 409);
  assert.match(expired.message, /quote expired; refresh catalogue and UAT inventory/);

  // The delivery zone cannot be swapped after pricing.
  const zoned = await quoteFor(db);
  const movedZone = await refusal(orderFor(db, zoned, { zoneId: "blr-west" }));
  assert.equal(movedZone?.status, 409);
  assert.match(movedZone.message, /delivery zone changed after quote/);

  // Another customer cannot spend this customer's quote.
  const mine = await quoteFor(db);
  const stranger = await refusal(orderFor(db, mine, { customerId: "CUST-OTHER" }));
  assert.equal(stranger?.status, 403);
  assert.match(stranger.message, /quote belongs to a different customer/);

  /*
   * Stock is re-checked at order time, not trusted from the quote. Two guards enforce this: a read
   * before the quote is claimed, and the `reserved_units+? <= available_units` predicate on the
   * reservation UPDATE itself. They are DEFENCE IN DEPTH, and sequentially redundant -- removing
   * either one alone leaves the other refusing with the same status and the same message, so a
   * mutation of one guard survives on its own. Removing BOTH is what this assertion catches, which is
   * the property that actually matters: no path reserves stock that is not there.
   */
  const optimistic = await quoteFor(db, { quantity: 3 });
  await db.prepare("UPDATE food_inventory_uat SET available_units=1 WHERE sku=? AND zone_id=?").bind(FOOD_SKUS.dogAdult.sku, ZONE).run();
  const soldOut = await refusal(orderFor(db, optimistic));
  assert.equal(soldOut?.status, 409);
  assert.match(soldOut.message, /inventory changed after quote; refresh before ordering/);
  assert.equal(
    (await db.prepare("SELECT status FROM food_commercial_quotes WHERE id=?").bind(optimistic.quoteId).first()).status,
    "open",
    "a quote that failed to reserve is released, not burned",
  );
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food order idempotency keys are bound to one customer and one order context", async () => {
  const { db } = await foodWorld();
  const quote = await quoteFor(db);
  const key = "idem-food-shared";

  const first = await governance.createFoodOrder(db, {
    idempotencyKey: key, quoteId: quote.quoteId, customerId: CUSTOMER, cityId: "blr", zoneId: ZONE, actorId: CUSTOMER,
  });
  assert.equal(first.duplicatePrevented, false);

  const replay = await governance.createFoodOrder(db, {
    idempotencyKey: key, quoteId: quote.quoteId, customerId: CUSTOMER, cityId: "blr", zoneId: ZONE, actorId: CUSTOMER,
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.orderId, first.orderId);
  assert.equal(Number((await availability(db)).reserved_units), 1, "a replay reserves no extra stock");
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM food_orders").first()).n),
    1,
    "a replay creates no second order",
  );

  // The same key from a different customer is an impersonation attempt, not a replay.
  const stolen = await refusal(governance.createFoodOrder(db, {
    idempotencyKey: key, quoteId: quote.quoteId, customerId: "CUST-OTHER", cityId: "blr", zoneId: ZONE, actorId: "CUST-OTHER",
  }));
  assert.equal(stolen?.status, 403);
  assert.match(stolen.message, /idempotency key belongs to a different customer/);

  // The same key with a different order context is a caller bug, not a replay.
  const second = await quoteFor(db);
  const different = await refusal(governance.createFoodOrder(db, {
    idempotencyKey: key, quoteId: second.quoteId, customerId: CUSTOMER, cityId: "blr", zoneId: ZONE, actorId: CUSTOMER,
  }));
  assert.equal(different?.status, 409);
  assert.match(different.message, /already used for a different order context/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food Gate 1 routes are same-origin and claim no production stock or payment", async () => {
  const { db } = await foodWorld();
  const route = await import("../app/api/food-commercial/route.ts");

  const listed = await route.GET(new Request(foodUrl(`/api/food-commercial?zoneId=${ZONE}`)));
  assert.equal(listed.status, 200);
  const data = (await listed.json()).data;
  assert.equal(data.liveMoney ?? false, false);
  assert.equal(data.productionInventoryVerified ?? false, false, "the catalogue never claims verified production stock");
  assert.equal(listed.headers.get("cache-control"), "no-store", "stock and price are never cached");

  const body = {
    sku: FOOD_SKUS.dogAdult.sku, quantity: 1, zoneId: ZONE, paymentMode: "sandbox_deferred",
    customerId: CUSTOMER, petIds: [PET],
  };
  const crossOrigin = await route.POST(new Request(foodUrl("/api/food-commercial"), {
    method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify(body),
  }));
  assert.equal(crossOrigin.status, 403);
});
