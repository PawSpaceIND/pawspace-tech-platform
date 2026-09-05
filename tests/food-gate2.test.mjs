import test from "node:test";
import assert from "node:assert/strict";
import {
  freshFoodWorld,
  createFoodOrderFixture,
  mutateFoodFulfilment,
  fulfilTo,
  DOG_LOT,
  expectResponse,
} from "./helpers/food-gate-harness.mjs";

test("Food Gate 2 executes the canonical fulfilment lifecycle and consumes stock exactly at pack", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { quantity: 2, idempotencyKey: "gate2-order" });

  const accepted = await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "accept_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-accept",
  });
  assert.equal(accepted.status, "accepted");
  let inventory = world.sqlite.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").get(fixture.sku, fixture.zoneId);
  assert.deepEqual(inventory, { available_units: 30, reserved_units: 2 });

  const picked = await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "pick_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-pick",
    lotId: DOG_LOT,
  });
  assert.equal(picked.status, "picked");
  assert.equal(picked.productionLotVerified, false);

  const packed = await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "pack_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-pack",
  });
  assert.equal(packed.status, "packed");
  inventory = world.sqlite.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").get(fixture.sku, fixture.zoneId);
  assert.deepEqual(inventory, { available_units: 28, reserved_units: 0 });
  assert.equal(world.sqlite.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").get(fixture.orderId).status, "consumed");

  const replay = await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "pack_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-pack",
  });
  assert.equal(replay.duplicatePrevented, true);
  inventory = world.sqlite.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").get(fixture.sku, fixture.zoneId);
  assert.deepEqual(inventory, { available_units: 28, reserved_units: 0 });
});

test("Food Gate 2 keeps dispatch sandbox-only and creates the delivery payment-due ledger", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate2-delivery-order" });
  const results = await fulfilTo(world, fixture, "delivered");
  const delivered = results.at(-1);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.otpConnected, false);
  assert.equal(delivered.liveMoney, false);
  assert.equal(delivered.paymentStatus, "due");

  const fulfilment = world.sqlite.prepare("SELECT status,delivery_adapter_status,handover_status,dispatch_reference FROM food_order_fulfilment WHERE order_id=?").get(fixture.orderId);
  assert.equal(fulfilment.status, "delivered");
  assert.equal(fulfilment.delivery_adapter_status, "not_connected");
  assert.equal(fulfilment.handover_status, "uat_confirmed");
  assert.ok(fulfilment.dispatch_reference);
  const payment = world.sqlite.prepare("SELECT amount,status,gateway FROM food_order_payment_events WHERE order_id=?").get(fixture.orderId);
  assert.equal(payment.amount, fixture.quote.totalAmount);
  assert.equal(payment.status, "due");
  assert.equal(payment.gateway, "uat_sandbox");
});

test("Food Gate 2 refuses wrong lots and non-opaque dispatch references", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate2-refusal-order" });
  await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "accept_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-refusal-accept",
  });
  await expectResponse(mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "pick_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-wrong-lot",
    lotId: "FLOT-CAT-A-01",
  }), 409, /exact ordered SKU and zone/i);

  await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "pick_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-good-lot",
    lotId: DOG_LOT,
  });
  await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "pack_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-pack-good",
  });
  await expectResponse(mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "dispatch_order",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-public-url",
    dispatchReference: "https://courier.example/track/123",
  }), 400, /opaque UAT dispatch reference/i);
});

test("Food Gate 2 stock recovery preserves the order and forbids substitution or repricing", async () => {
  const world = freshFoodWorld();
  const fixture = await createFoodOrderFixture(world, { idempotencyKey: "gate2-stock-order" });
  const recovery = await mutateFoodFulfilment(world.db, {
    orderId: fixture.orderId,
    action: "report_stock_issue",
    actorId: "ops@example.in",
    idempotencyKey: "gate2-stock-report",
    reason: "Exact ordered SKU unavailable at pick station",
  });
  assert.equal(recovery.status, "stock_recovery_required");
  assert.equal(recovery.orderPreserved, true);
  assert.equal(recovery.substitutionAllowed, false);
  assert.equal(recovery.priceChangeAllowed, false);
  const row = world.sqlite.prepare("SELECT id,status,total_amount FROM food_orders WHERE id=?").get(fixture.orderId);
  assert.equal(row.id, fixture.orderId);
  assert.equal(row.status, "stock_recovery_required");
  assert.equal(row.total_amount, fixture.quote.totalAmount);
});
