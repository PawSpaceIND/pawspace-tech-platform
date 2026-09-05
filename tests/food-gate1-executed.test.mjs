import test from "node:test";
import assert from "node:assert/strict";
import {
  freshFoodWorld,
  DOG_SKU,
  CUSTOMER_ID,
  DOG_PET_ID,
  listFoodCatalogue,
  createFoodQuote,
  createFoodOrder,
  expectResponse,
} from "./helpers/food-gate-harness.mjs";

test("Food Gate 1 executes catalogue, quote pricing, inventory and production-safety truth", async () => {
  const world = freshFoodWorld();
  const items = await listFoodCatalogue(world.db, "blr-east");
  assert.equal(items.length, 3);
  assert.ok(items.every((item) => item.inventory_mode === "uat_seed"));
  assert.ok(items.every((item) => item.production_inventory_verified === false));

  const quote = await createFoodQuote(world.db, {
    sku: DOG_SKU,
    quantity: 2,
    zoneId: "blr-east",
    paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_ID,
    petIds: [DOG_PET_ID],
  });
  assert.equal(quote.unitPrice, 799);
  assert.equal(quote.totalAmount, 1598);
  assert.equal(quote.deliveryFee, 0);
  assert.equal(quote.amountDueNow, 0);
  assert.equal(quote.liveMoney, false);
  assert.equal(quote.productionInventoryVerified, false);

  const order = await createFoodOrder(world.db, {
    idempotencyKey: "food-gate1-order",
    quoteId: quote.quoteId,
    customerId: CUSTOMER_ID,
    cityId: "blr",
    zoneId: "blr-east",
    actorId: "gate1",
  });
  assert.equal(order.status, "uat_reserved");
  const stored = world.sqlite.prepare("SELECT total_amount,commercial_status,inventory_mode,delivery_status FROM food_orders WHERE id=?").get(order.orderId);
  assert.equal(stored.total_amount, 1598);
  assert.equal(stored.commercial_status, "uat_only");
  assert.equal(stored.inventory_mode, "uat_seed");
  assert.equal(stored.delivery_status, "fulfilment_review_required");
  const inventory = world.sqlite.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id='blr-east'").get(DOG_SKU);
  assert.equal(inventory.available_units, 30);
  assert.equal(inventory.reserved_units, 2);
});

test("Food Gate 1 refuses unsupported payment, coupon, quantity, stock and ownership changes", async () => {
  const world = freshFoodWorld();
  await expectResponse(createFoodQuote(world.db, {
    sku: DOG_SKU,
    quantity: 1,
    zoneId: "blr-east",
    paymentMode: "prepaid",
    customerId: CUSTOMER_ID,
    petIds: [DOG_PET_ID],
  }), 409, /sandbox-deferred/i);
  await expectResponse(createFoodQuote(world.db, {
    sku: DOG_SKU,
    quantity: 1,
    zoneId: "blr-east",
    paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_ID,
    petIds: [DOG_PET_ID],
    couponCode: "SAVE10",
  }), 409, /coupon policy/i);
  await expectResponse(createFoodQuote(world.db, {
    sku: DOG_SKU,
    quantity: 6,
    zoneId: "blr-east",
    paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_ID,
    petIds: [DOG_PET_ID],
  }), 409, /1-5/);
  world.sqlite.prepare("UPDATE food_inventory_uat SET available_units=0 WHERE sku=? AND zone_id='blr-east'").run(DOG_SKU);
  await expectResponse(createFoodQuote(world.db, {
    sku: DOG_SKU,
    quantity: 1,
    zoneId: "blr-east",
    paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_ID,
    petIds: [DOG_PET_ID],
  }), 409, /inventory is insufficient/i);
  await expectResponse(createFoodQuote(world.db, {
    sku: DOG_SKU,
    quantity: 1,
    zoneId: "blr-east",
    paymentMode: "sandbox_deferred",
    customerId: "OTHER-CUSTOMER",
    petIds: [DOG_PET_ID],
  }), 403, /not owned/i);
});

test("Food Gate 1 binds one server quote to one canonical order and one idempotency context", async () => {
  const world = freshFoodWorld();
  const quote = await createFoodQuote(world.db, {
    sku: DOG_SKU,
    quantity: 1,
    zoneId: "blr-east",
    paymentMode: "sandbox_deferred",
    customerId: CUSTOMER_ID,
    petIds: [DOG_PET_ID],
  });
  const first = await createFoodOrder(world.db, {
    idempotencyKey: "food-gate1-same",
    quoteId: quote.quoteId,
    customerId: CUSTOMER_ID,
    cityId: "blr",
    zoneId: "blr-east",
    actorId: "gate1",
  });
  const replay = await createFoodOrder(world.db, {
    idempotencyKey: "food-gate1-same",
    quoteId: quote.quoteId,
    customerId: CUSTOMER_ID,
    cityId: "blr",
    zoneId: "blr-east",
    actorId: "gate1",
  });
  assert.equal(replay.orderId, first.orderId);
  assert.equal(replay.duplicatePrevented, true);
  await expectResponse(createFoodOrder(world.db, {
    idempotencyKey: "food-gate1-other",
    quoteId: quote.quoteId,
    customerId: CUSTOMER_ID,
    cityId: "blr",
    zoneId: "blr-east",
    actorId: "gate1",
  }), 409, /valid open server Food quote|already linked/i);
  assert.equal(world.sqlite.prepare("SELECT COUNT(*) count FROM food_orders").get().count, 1);
});
