/**
 * Fresh Food Gate 2 — EXECUTED. The fulfilment lifecycle: accept → pick a UAT lot → pack (which is
 * where reserved stock is actually consumed) → sandbox dispatch → delivery handover that creates a
 * payment DUE, plus the stock-recovery path.
 *
 * WHAT THIS FILE USED TO BE. Seven tests, every assertion a regex over the source of
 * `lib/food-fulfilment-governance.ts`, the route and the workspace page. "Gate 2 consumes inventory
 * reservation exactly at pack" asserted that the string `status='consumed'` appeared in the file. It
 * appears whether stock is consumed at pack, at accept, twice, or never.
 *
 * Each test below drives the real `mutateFoodFulfilment` against a real SQLite-backed D1, over an
 * order created by the real Gate 1 quote and order functions, and asserts on the rows it wrote.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  FOOD_SKUS, customerSessionCookie, foodUrl, freshSqlite, makeD1, nextKey, refusal, seedFoodOrder,
} from "./helpers/food-harness.mjs";

installWorkersHooks("__FOOD_G2_DB__", "__FOOD_G2_ENV__");

const fulfilment = await import("../lib/food-fulfilment-governance.ts");

const STAFF = "ops.fulfilment@pawspace.test";
const LOT = "FLOT-DOG-A-01";
const ZONE = "blr-east";

async function foodWorld(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FOOD_G2_DB__ = db;
  globalThis.__FOOD_G2_ENV__ = {};
  const order = await seedFoodOrder(db, sqlite, options);
  await fulfilment.ensureFoodFulfilmentTables(db);
  return { sqlite, db, order };
}

const act = (db, order, action, extra = {}) => fulfilment.mutateFoodFulfilment(db, {
  orderId: order.orderId, action, actorId: STAFF, idempotencyKey: nextKey(), ...extra,
});

/** Take an order all the way to packed, which is the state most later steps require. */
async function packOrder(db, order) {
  await act(db, order, "accept_order");
  await act(db, order, "pick_order", { lotId: LOT });
  return act(db, order, "pack_order");
}

const stock = (db, sku = FOOD_SKUS.dogAdult.sku) =>
  db.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").bind(sku, ZONE).first();

// ---------------------------------------------------------------------------------------------
test("Fresh Food Gate 2 owns an idempotent fulfilment lifecycle in strict order", async () => {
  const { db, order } = await foodWorld();

  // Every step refuses until its predecessor has happened.
  const pickFirst = await refusal(act(db, order, "pick_order", { lotId: LOT }));
  assert.equal(pickFirst?.status, 409);
  assert.match(pickFirst.message, /must be accepted before picking/);

  const key = nextKey();
  const accepted = await fulfilment.mutateFoodFulfilment(db, {
    orderId: order.orderId, action: "accept_order", actorId: STAFF, idempotencyKey: key,
  });
  assert.equal(accepted.status, "accepted");

  const replay = await fulfilment.mutateFoodFulfilment(db, {
    orderId: order.orderId, action: "accept_order", actorId: STAFF, idempotencyKey: key,
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM food_fulfilment_events WHERE order_id=? AND event_type='fulfilment_accepted'").bind(order.orderId).first()).n),
    1,
    "a replayed acceptance logs nothing new",
  );

  // A fresh key on an already-accepted order is a real second attempt, refused on state.
  const twice = await refusal(act(db, order, "accept_order"));
  assert.equal(twice?.status, 409);
  assert.match(twice.message, /not awaiting fulfilment acceptance/);

  const packBeforePick = await refusal(act(db, order, "pack_order"));
  assert.match(packBeforePick.message, /Picked UAT lot is required before packing/);

  await act(db, order, "pick_order", { lotId: LOT });
  const dispatchBeforePack = await refusal(act(db, order, "dispatch_order", { dispatchReference: "UATDISP-1" }));
  assert.match(dispatchBeforePack.message, /must be packed before dispatch/);

  await act(db, order, "pack_order");
  const deliverBeforeDispatch = await refusal(act(db, order, "confirm_delivery", { handoverMethod: "customer" }));
  assert.match(deliverBeforeDispatch.message, /Sandbox dispatch is required before Food delivery handover/);

  const unsupported = await refusal(act(db, order, "teleport_order"));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Food fulfilment action/);

  const incomplete = await refusal(fulfilment.mutateFoodFulfilment(db, { orderId: order.orderId, action: "accept_order" }));
  assert.equal(incomplete?.status, 400);
  assert.match(incomplete.message, /Order, action, actor and idempotency key are required/);

  const missing = await refusal(fulfilment.mutateFoodFulfilment(db, {
    orderId: "PS-UAT-FOOD-NOPE", action: "accept_order", actorId: STAFF, idempotencyKey: nextKey(),
  }));
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /Canonical Food order not found/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food Gate 2 picks the exact ordered SKU and zone, and only unverified UAT lots", async () => {
  const { db, order } = await foodWorld();
  await act(db, order, "accept_order");

  // A lot for a different SKU is not this order's stock.
  const wrongSku = await refusal(act(db, order, "pick_order", { lotId: "FLOT-CAT-A-01" }));
  assert.equal(wrongSku?.status, 409);
  assert.match(wrongSku.message, /available UAT lot for the exact ordered SKU and zone/);

  const invented = await refusal(act(db, order, "pick_order", { lotId: "FLOT-MADE-UP" }));
  assert.match(invented.message, /exact ordered SKU and zone/);

  const noLot = await refusal(act(db, order, "pick_order", {}));
  assert.match(noLot.message, /exact ordered SKU and zone/);

  // A lot in another zone cannot be picked for this order.
  await db.prepare("INSERT INTO food_uat_lots (id,sku,zone_id,lot_label,expiry_date,status,production_lot_verified,created_at,updated_at) VALUES ('FLOT-WEST-1',?,'blr-west','West lot','2027-12-31','uat_available',0,?,?)")
    .bind(FOOD_SKUS.dogAdult.sku, Date.now(), Date.now()).run();
  const wrongZone = await refusal(act(db, order, "pick_order", { lotId: "FLOT-WEST-1" }));
  assert.match(wrongZone.message, /exact ordered SKU and zone/);

  // A lot claiming production traceability is refused: Gate 2 is explicitly NOT production.
  await db.prepare("INSERT INTO food_uat_lots (id,sku,zone_id,lot_label,expiry_date,status,production_lot_verified,created_at,updated_at) VALUES ('FLOT-PROD-1',?,?,'Production lot','2027-12-31','uat_available',1,?,?)")
    .bind(FOOD_SKUS.dogAdult.sku, ZONE, Date.now(), Date.now()).run();
  const productionLot = await refusal(act(db, order, "pick_order", { lotId: "FLOT-PROD-1" }));
  assert.equal(productionLot?.status, 409);
  assert.match(productionLot.message, /explicitly non-production UAT lot traceability/);

  const picked = await act(db, order, "pick_order", { lotId: LOT });
  assert.equal(picked.status, "picked");
  assert.equal(picked.lotId, LOT);
  assert.equal(picked.productionLotVerified, false, "the picked lot never claims production verification");

  const row = await db.prepare("SELECT status,lot_id FROM food_order_fulfilment WHERE order_id=?").bind(order.orderId).first();
  assert.equal(row.status, "picked");
  assert.equal(row.lot_id, LOT);
  assert.equal((await db.prepare("SELECT status FROM food_orders WHERE id=?").bind(order.orderId).first()).status, "picked");
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food Gate 2 consumes the inventory reservation exactly at pack", async () => {
  const { db, order } = await foodWorld({ quantity: 2 });

  const before = await stock(db);
  assert.equal(Number(before.available_units), 30, "ordering reserved but did not consume");
  assert.equal(Number(before.reserved_units), 2);

  await act(db, order, "accept_order");
  const afterAccept = await stock(db);
  assert.deepEqual(
    [Number(afterAccept.available_units), Number(afterAccept.reserved_units)], [30, 2],
    "accepting an order moves no stock",
  );

  await act(db, order, "pick_order", { lotId: LOT });
  const afterPick = await stock(db);
  assert.deepEqual(
    [Number(afterPick.available_units), Number(afterPick.reserved_units)], [30, 2],
    "picking a lot moves no stock either",
  );

  const packed = await act(db, order, "pack_order");
  assert.equal(packed.status, "packed");
  assert.equal(packed.inventoryReservation, "consumed");
  assert.equal(packed.liveInventory, false);

  const afterPack = await stock(db);
  assert.equal(Number(afterPack.available_units), 28, "pack consumes the ordered quantity from available stock");
  assert.equal(Number(afterPack.reserved_units), 0, "and releases the reservation it consumed");
  assert.equal(
    (await db.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").bind(order.orderId).first()).status,
    "consumed",
  );

  // The reservation is consumed ONCE: a second pack is refused on state, so stock cannot drift.
  const twice = await refusal(act(db, order, "pack_order"));
  assert.equal(twice?.status, 409);
  const afterSecond = await stock(db);
  assert.deepEqual([Number(afterSecond.available_units), Number(afterSecond.reserved_units)], [28, 0]);

  // If stock has been drained behind the reservation, packing refuses rather than going negative.
  const other = await foodWorld({ quantity: 2 });
  await act(other.db, other.order, "accept_order");
  await act(other.db, other.order, "pick_order", { lotId: LOT });
  await other.db.prepare("UPDATE food_inventory_uat SET available_units=1 WHERE sku=? AND zone_id=?").bind(FOOD_SKUS.dogAdult.sku, ZONE).run();
  const unpackable = await refusal(act(other.db, other.order, "pack_order"));
  assert.equal(unpackable?.status, 409);
  assert.match(unpackable.message, /reservation is no longer packable/);
  assert.equal(Number((await stock(other.db)).available_units), 1, "the refused pack consumed nothing");
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food dispatch is sandbox-only and delivery creates a payment DUE", async () => {
  const { db, order } = await foodWorld();
  await packOrder(db, order);

  for (const dispatchReference of ["", "abc", "https://courier.example/track/1", "http://x.example"]) {
    const bad = await refusal(act(db, order, "dispatch_order", { dispatchReference }));
    assert.equal(bad?.status, 400);
    assert.match(bad.message, /opaque UAT dispatch reference is required/);
  }

  const dispatched = await act(db, order, "dispatch_order", { dispatchReference: "UATDISP-000123" });
  assert.equal(dispatched.status, "dispatched");
  assert.equal(dispatched.deliveryAdapterConnected, false, "no courier adapter is claimed");
  const fulfilmentRow = await db.prepare("SELECT dispatch_reference,delivery_adapter_status FROM food_order_fulfilment WHERE order_id=?").bind(order.orderId).first();
  assert.equal(fulfilmentRow.dispatch_reference, "UATDISP-000123");
  assert.equal(fulfilmentRow.delivery_adapter_status, "not_connected");
  assert.equal((await db.prepare("SELECT delivery_status FROM food_orders WHERE id=?").bind(order.orderId).first()).delivery_status, "sandbox_dispatched");

  // Handover is a governed vocabulary, not free text.
  for (const handoverMethod of [undefined, "left_at_door", "drone"]) {
    const bad = await refusal(act(db, order, "confirm_delivery", { handoverMethod }));
    assert.equal(bad?.status, 400);
    assert.match(bad.message, /governed UAT Food delivery handover method is required/);
  }
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM food_order_payment_events WHERE order_id=?").bind(order.orderId).first()).n),
    0,
    "a refused handover creates no payment event",
  );

  const delivered = await act(db, order, "confirm_delivery", { handoverMethod: "building_staff" });
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.paymentStatus, "due", "delivery makes money DUE, it never takes it");
  assert.equal(delivered.amount, order.totalAmount);
  assert.equal(delivered.liveMoney, false);
  assert.equal(delivered.otpConnected, false);

  const payment = await db.prepare("SELECT amount,status,gateway,reference,detail_json FROM food_order_payment_events WHERE order_id=?").bind(order.orderId).first();
  assert.equal(Number(payment.amount), order.totalAmount);
  assert.equal(payment.status, "due");
  assert.equal(payment.gateway, "uat_sandbox");
  assert.equal(payment.reference, null, "no gateway reference is invented at delivery");
  assert.deepEqual(JSON.parse(payment.detail_json), {
    captureRequired: true, liveMoney: false, productionPaymentTimingPolicy: "pending",
    trigger: "canonical_food_uat_delivery",
  });

  const handover = await db.prepare("SELECT method,status,otp_status FROM food_delivery_handover_events WHERE order_id=?").bind(order.orderId).first();
  assert.equal(handover.method, "building_staff");
  assert.equal(handover.status, "uat_confirmed");
  assert.equal(handover.otp_status, "not_connected", "the handover attestation never claims a live OTP");
  assert.equal((await db.prepare("SELECT delivery_status FROM food_orders WHERE id=?").bind(order.orderId).first()).delivery_status, "uat_delivered");
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food stock recovery preserves the order and forbids silent substitution or repricing", async () => {
  const { db, order } = await foodWorld();
  await act(db, order, "accept_order");

  const thin = await refusal(act(db, order, "report_stock_issue", { reason: "gone" }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /Food stock recovery reason is required/);

  const reported = await act(db, order, "report_stock_issue", { reason: "Lot damaged in the chiller overnight" });
  assert.equal(reported.status, "stock_recovery_required");
  assert.equal(reported.orderPreserved, true);
  assert.equal(reported.substitutionAllowed, false, "fulfilment never swaps the SKU on its own");
  assert.equal(reported.priceChangeAllowed, false, "and never reprices the order on its own");
  assert.equal(reported.orderId, order.orderId, "recovery keeps the SAME canonical order id");

  // The audit event Operations actually reads says the same thing as the returned result.
  const logged = await db.prepare("SELECT detail_json FROM food_fulfilment_events WHERE order_id=? AND event_type='stock_issue_reported'").bind(order.orderId).first();
  const detail = JSON.parse(logged.detail_json);
  assert.equal(detail.substitutionAllowed, false);
  assert.equal(detail.priceChangeAllowed, false);
  assert.equal(detail.orderPreserved, true);
  assert.equal(detail.reason, "Lot damaged in the chiller overnight");

  const recovery = await db.prepare("SELECT sku,status,substitution_allowed,resolved_at FROM food_stock_recovery_cases WHERE order_id=?").bind(order.orderId).first();
  assert.equal(recovery.sku, FOOD_SKUS.dogAdult.sku, "the case is pinned to the ordered SKU");
  assert.equal(recovery.status, "ops_review_required", "recovery escalates to Operations, it does not resolve itself");
  assert.equal(Number(recovery.substitution_allowed), 0);
  assert.equal(recovery.resolved_at, null);

  // The order, its line, its price and its reservation are all untouched.
  const line = await db.prepare("SELECT sku,quantity,unit_price,line_total FROM food_order_lines WHERE order_id=?").bind(order.orderId).first();
  assert.equal(line.sku, FOOD_SKUS.dogAdult.sku);
  assert.equal(Number(line.unit_price), 799);
  assert.equal(Number(line.line_total), order.totalAmount);
  assert.equal(
    (await db.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").bind(order.orderId).first()).status,
    "reserved",
    "recovery does not quietly release the reservation",
  );
  assert.equal(Number((await stock(db)).reserved_units), 1);

  // A packed order is past the point of stock recovery.
  const packed = await foodWorld({ customerId: "CUST-FOOD-2", petId: "PET-FOOD-2" });
  await packOrder(packed.db, packed.order);
  const tooLate = await refusal(act(packed.db, packed.order, "report_stock_issue", { reason: "Realised the lot was wrong" }));
  assert.equal(tooLate?.status, 409);
  assert.match(tooLate.message, /Packed\/closed Food order cannot enter stock recovery/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food fulfilment reads separate a customer's own orders from everyone else's", async () => {
  const { db, sqlite, order } = await foodWorld();
  await packOrder(db, order);
  await act(db, order, "dispatch_order", { dispatchReference: "UATDISP-777777" });
  await act(db, order, "confirm_delivery", { handoverMethod: "customer" });

  const other = await seedFoodOrder(db, sqlite, {
    customerId: "CUST-FOOD-2", petId: "PET-FOOD-2", sku: FOOD_SKUS.catAdult.sku, species: "cat",
  });

  const mine = await fulfilment.listFoodOrders(db, { customerId: order.customerId });
  assert.equal(mine.length, 1, "a customer sees only their own orders");
  assert.equal(mine[0].id, order.orderId);
  assert.equal(mine[0].fulfilment_status, "delivered");
  assert.equal(mine[0].lot_id, LOT);
  assert.equal(mine[0].dispatch_reference, "UATDISP-777777");
  assert.equal(mine[0].delivery_adapter_status, "not_connected");
  assert.equal(mine[0].deliveryPayment.status, "due");
  assert.equal(Number(mine[0].deliveryPayment.amount), order.totalAmount);
  assert.ok(mine[0].events.some((row) => row.event_type === "food_delivered"));

  const theirs = await fulfilment.listFoodOrders(db, { customerId: "CUST-FOOD-2" });
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].id, other.orderId);
  assert.equal(theirs[0].deliveryPayment, null, "an undelivered order owes nothing yet");

  const everything = await fulfilment.listFoodOrders(db, {});
  assert.equal(everything.length, 2, "the unscoped staff read sees both");
  assert.equal(everything[0].sku !== everything[1].sku, true);
});

// ---------------------------------------------------------------------------------------------
/**
 * The fulfilment ROUTE, driven for real. This covers the cross-tenant read documented in the handler
 * (PTJA W2-17-F02): the ownership guard used to hang off the request PARAMETER, so asking by orderId
 * instead of customerId returned the very row the customerId form had just refused. The test asks
 * both ways, as a customer who owns the order and as one who does not.
 */
test("Fresh Food fulfilment route separates a customer read from staff mutations", async () => {
  const { db, sqlite, order } = await foodWorld();
  const route = await import("../app/api/food-fulfilment/route.ts");
  await packOrder(db, order);

  const owner = await customerSessionCookie(db, { principalKey: "+919800000001", customerId: order.customerId });
  const stranger = await customerSessionCookie(db, { principalKey: "+919800000002", customerId: "CUST-FOOD-STRANGER" });

  const read = (cookie, query) => route.GET(new Request(foodUrl(`/api/food-fulfilment?${query}`), { headers: { cookie } }));

  const mine = await read(owner.cookie, `scope=customer&orderId=${order.orderId}`);
  assert.equal(mine.status, 200);
  const rows = (await mine.json()).data;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, order.orderId);
  assert.equal(rows[0].fulfilment_status, "packed");

  // The same order, asked for by id, by a customer who does not own it.
  const intruder = await read(stranger.cookie, `scope=customer&orderId=${order.orderId}`);
  assert.ok([401, 403].includes(intruder.status), `another customer must be refused: ${intruder.status}`);

  // And anonymously.
  const anonymous = await route.GET(new Request(foodUrl(`/api/food-fulfilment?scope=customer&orderId=${order.orderId}`)));
  assert.ok([401, 403].includes(anonymous.status));

  // The STAFF read is a different permission, and a customer does not hold it.
  const staffScope = await read(owner.cookie, `orderId=${order.orderId}`);
  assert.ok([401, 403].includes(staffScope.status), "a customer cannot use the staff read scope");

  // Mutations are staff-only, whoever asks.
  const mutate = (cookie) => route.POST(new Request(foodUrl("/api/food-fulfilment"), {
    method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ orderId: order.orderId, action: "dispatch_order", idempotencyKey: nextKey(), dispatchReference: "UATDISP-999999" }),
  }));
  const customerMutation = await mutate(owner.cookie);
  assert.ok([401, 403].includes(customerMutation.status), "a customer cannot dispatch their own order");
  const anonymousMutation = await mutate(null);
  assert.ok([401, 403].includes(anonymousMutation.status));

  assert.equal(
    (await db.prepare("SELECT status FROM food_order_fulfilment WHERE order_id=?").bind(order.orderId).first()).status,
    "packed",
    "no refused request moved the order",
  );

  // A malformed staff mutation is rejected before any authority is even considered.
  const malformed = await route.POST(new Request(foodUrl("/api/food-fulfilment"), {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orderId: order.orderId }),
  }));
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /Order, action and idempotency key are required/);
});
