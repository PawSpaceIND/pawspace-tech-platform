/**
 * Fresh Food CLOSURE — EXECUTED. One canonical order carried the whole way: quote → reserve →
 * accept → pick → pack → sandbox dispatch → delivery handover → sandbox payment → supplier
 * settlement → reconciliation, plus the stock-recovery path and the gateway's authority split.
 *
 * WHAT THIS FILE USED TO BE. Five tests, every assertion a regex over source files. "Food closes one
 * canonical customer to fulfilment to Ops to Finance path" read four files and checked that each one
 * mentioned the next. Nothing in it ever created an order.
 *
 * This file runs the journey. The point of a closure suite is that the SAME order id, the SAME SKU,
 * the SAME price and the SAME reserved units survive every hand-off, so most assertions here are
 * about continuity between stages rather than about a single function's refusal.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import {
  FOOD_SKUS, customerSessionCookie, foodUrl, freshSqlite, makeD1, nextKey, refusal, seedFoodOrder,
} from "./helpers/food-harness.mjs";

installWorkersHooks("__FOOD_CLOSE_DB__", "__FOOD_CLOSE_ENV__");

const governance = await import("../lib/food-governance.ts");
const fulfilment = await import("../lib/food-fulfilment-governance.ts");
const finance = await import("../lib/food-finance-governance.ts");
const ops = await import("../lib/food-ops-governance.ts");

const STAFF = "ops.fulfilment@pawspace.test";
const OPS_STAFF = "ops.duty@pawspace.test";
const FINANCE_STAFF = "finance.checker@pawspace.test";
const CUSTOMER = "CUST-FOOD-1";
const LOT = "FLOT-DOG-A-01";
const ZONE = "blr-east";

async function world(options = {}) {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FOOD_CLOSE_DB__ = db;
  globalThis.__FOOD_CLOSE_ENV__ = {};
  const order = await seedFoodOrder(db, sqlite, options);
  await ops.ensureFoodOpsTables(db);
  // The gateway's denial path writes an audit row and only calls ensureGatewayTables() on the
  // staff-email branch, so a platform-session customer reaches the insert without it. On a real
  // database lib/server-auth.ts has already created this table; the DDL is copied verbatim from
  // lib/api-gateway.ts.
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL)");
  return { sqlite, db, order };
}

const fulfil = (db, order, action, extra = {}) => fulfilment.mutateFoodFulfilment(db, {
  orderId: order.orderId, action, actorId: STAFF, idempotencyKey: nextKey(), ...extra,
});
const money = (db, order, action, extra = {}) => finance.mutateFoodFinance(db, {
  orderId: order.orderId, action, actorId: FINANCE_STAFF, idempotencyKey: nextKey(), ...extra,
});
const opsAct = (db, order, action, extra = {}) => ops.mutateFoodOps(db, {
  orderId: order.orderId, action, actorId: OPS_STAFF, idempotencyKey: nextKey(), ...extra,
});

const stock = (db, sku = FOOD_SKUS.dogAdult.sku) =>
  db.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").bind(sku, ZONE).first();

// ---------------------------------------------------------------------------------------------
test("Fresh Food closes one canonical customer to fulfilment to Ops to Finance path", async () => {
  const { db, sqlite, order } = await world({ quantity: 2 });

  // 1. CUSTOMER. The order came from a real server quote, and the price is the quoted price.
  assert.equal(order.quote.unitPrice, 799);
  assert.equal(order.totalAmount, 1598);
  assert.equal(order.status, "uat_reserved");
  assert.equal(Number((await stock(db)).reserved_units), 2);

  // 2. FULFILMENT. Accept, pick a governed lot, pack (stock leaves the shelf here), dispatch, deliver.
  await fulfil(db, order, "accept_order");
  await fulfil(db, order, "pick_order", { lotId: LOT });
  await fulfil(db, order, "pack_order");
  await fulfil(db, order, "dispatch_order", { dispatchReference: "UATDISP-CLOSURE" });
  const delivered = await fulfil(db, order, "confirm_delivery", { handoverMethod: "customer" });
  assert.equal(delivered.paymentStatus, "due");
  assert.equal(delivered.amount, order.totalAmount, "the amount owed is the amount quoted");
  assert.equal(delivered.liveMoney, false);

  const afterPack = await stock(db);
  assert.equal(Number(afterPack.available_units), 28);
  assert.equal(Number(afterPack.reserved_units), 0);

  // 3. FINANCE. Sandbox payment, supplier settlement readiness, reconciliation.
  const paid = await money(db, order, "record_order_payment", { paymentReference: "SBX-CLOSURE-1" });
  assert.equal(paid.amount, order.totalAmount);
  await money(db, order, "prepare_supplier_settlement", {});
  const reconciled = await money(db, order, "reconcile", {});
  assert.equal(reconciled.deliveryDueTotal, order.totalAmount);
  assert.equal(reconciled.paidTotal, order.totalAmount);
  assert.equal(reconciled.unpaidTotal, 0);
  assert.equal(reconciled.netPaidTotal, order.totalAmount);

  // 4. THE POINT OF CLOSURE. One order id all the way through, and every stage's rows agree.
  assert.equal(delivered.orderId, order.orderId);
  assert.equal(reconciled.orderId, order.orderId);
  const finalOrder = await db.prepare("SELECT status,total_amount,delivery_status FROM food_orders WHERE id=?").bind(order.orderId).first();
  assert.equal(finalOrder.status, "delivered");
  assert.equal(Number(finalOrder.total_amount), order.totalAmount, "the price never changed after the quote");
  assert.equal(finalOrder.delivery_status, "uat_delivered");
  const line = await db.prepare("SELECT sku,quantity,unit_price FROM food_order_lines WHERE order_id=?").bind(order.orderId).first();
  assert.equal(line.sku, FOOD_SKUS.dogAdult.sku, "the SKU never changed either");
  assert.equal(Number(line.quantity), 2);

  // 5. OPERATIONS sees the same order, with only the un-approved settlement outstanding.
  const snapshot = await ops.getFoodOpsSnapshot(db);
  const entry = snapshot.orders.find((row) => row.id === order.orderId);
  assert.equal(entry.status, "delivered");
  assert.equal(entry.sku, FOOD_SKUS.dogAdult.sku);
  assert.ok(!entry.exceptionFlags.includes("stock_recovery_required"), "a clean order is not in the recovery queue");
  assert.ok(!entry.exceptionFlags.includes("payment_due"), "nothing is left owing");
  assert.equal(snapshot.readiness.productionReady, false);

  // A pet from the original quote is still associated with the delivered order.
  const pets = sqlite.prepare("SELECT pet_id FROM food_order_pets WHERE order_id=?").all(order.orderId);
  assert.deepEqual(pets.map((row) => row.pet_id), [order.petId]);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food stock recovery restores the exact SKU, quantity and price", async () => {
  const { db, order } = await world({ quantity: 2 });
  await fulfil(db, order, "accept_order");
  await fulfil(db, order, "report_stock_issue", { reason: "Chiller failure on the ordered lot" });

  assert.equal((await db.prepare("SELECT status FROM food_orders WHERE id=?").bind(order.orderId).first()).status, "stock_recovery_required");
  const queued = await ops.getFoodOpsSnapshot(db);
  const entry = queued.orders.find((row) => row.id === order.orderId);
  assert.ok(entry.exceptionFlags.includes("stock_recovery_required"), "the broken order is in the Operations queue");

  const thin = await refusal(opsAct(db, order, "resume_same_sku_stock", { reason: "ok" }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /A stock recovery reason is required/);

  // Operations cannot resume while the exact SKU is still short. Substitution is not an option.
  await db.prepare("UPDATE food_inventory_uat SET available_units=1 WHERE sku=? AND zone_id=?").bind(FOOD_SKUS.dogAdult.sku, ZONE).run();
  const stillShort = await refusal(opsAct(db, order, "resume_same_sku_stock", { reason: "Trying to push it through anyway" }));
  assert.equal(stillShort?.status, 409);
  assert.match(stillShort.message, /exact ordered SKU still lacks enough UAT stock; substitution and repricing are blocked/);
  assert.equal(
    (await db.prepare("SELECT status FROM food_orders WHERE id=?").bind(order.orderId).first()).status,
    "stock_recovery_required",
    "a refused resume leaves the order in recovery",
  );

  await db.prepare("UPDATE food_inventory_uat SET available_units=30 WHERE sku=? AND zone_id=?").bind(FOOD_SKUS.dogAdult.sku, ZONE).run();
  const resumed = await opsAct(db, order, "resume_same_sku_stock", { reason: "Replacement pallet of the same SKU arrived" });
  assert.equal(resumed.orderId, order.orderId, "recovery keeps the SAME canonical order id");

  // Same SKU, same quantity, same price, reservation restored.
  const line = await db.prepare("SELECT sku,quantity,unit_price,line_total FROM food_order_lines WHERE order_id=?").bind(order.orderId).first();
  assert.equal(line.sku, FOOD_SKUS.dogAdult.sku);
  assert.equal(Number(line.quantity), 2);
  assert.equal(Number(line.unit_price), 799);
  assert.equal(Number(line.line_total), 1598);
  assert.equal(Number((await db.prepare("SELECT total_amount FROM food_orders WHERE id=?").bind(order.orderId).first()).total_amount), 1598);
  assert.equal(
    (await db.prepare("SELECT status,quantity FROM food_inventory_reservations WHERE order_id=?").bind(order.orderId).first()).status,
    "reserved",
  );
  assert.equal(Number((await stock(db)).reserved_units), 2, "the exact ordered quantity is reserved again");

  /*
   * The case above never lost its reservation: report_stock_issue deliberately leaves it 'reserved'.
   * The resume path also handles an order whose reservation HAS been released, and that branch is
   * where the units are genuinely put back. No action in the module produces that state today (a
   * release only happens on a cancellation approval, which also closes the order), so it is staged
   * directly here -- otherwise the restore could be deleted and nothing would notice.
   */
  const released = await world({ customerId: "CUST-FOOD-4", petId: "PET-FOOD-4", quantity: 2 });
  await fulfil(released.db, released.order, "accept_order");
  await fulfil(released.db, released.order, "report_stock_issue", { reason: "Chiller failure on the ordered lot" });
  await released.db.prepare("UPDATE food_inventory_uat SET reserved_units=0 WHERE sku=? AND zone_id=?").bind(FOOD_SKUS.dogAdult.sku, ZONE).run();
  await released.db.prepare("UPDATE food_inventory_reservations SET status='released' WHERE order_id=?").bind(released.order.orderId).run();

  await opsAct(released.db, released.order, "resume_same_sku_stock", { reason: "Replacement pallet of the same SKU arrived" });
  assert.equal(Number((await stock(released.db)).reserved_units), 2, "the released units are reserved again, at the ordered quantity");
  const restored = await released.db.prepare("SELECT status,quantity FROM food_inventory_reservations WHERE order_id=?").bind(released.order.orderId).first();
  assert.equal(restored.status, "reserved");
  assert.equal(Number(restored.quantity), 2);

  // Recovery is not a licence to resume an order that was never in recovery.
  const clean = await world({ customerId: "CUST-FOOD-2", petId: "PET-FOOD-2" });
  const notInRecovery = await refusal(opsAct(clean.db, clean.order, "resume_same_sku_stock", { reason: "Nothing was wrong with this one" }));
  assert.equal(notInRecovery?.status, 409);
  assert.match(notInRecovery.message, /not in stock recovery/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food Operations notes are canonical, bounded and replay safe", async () => {
  const { db, order } = await world();

  const thin = await refusal(opsAct(db, order, "add_note", { note: "hmm" }));
  assert.equal(thin?.status, 400);
  assert.match(thin.message, /meaningful Operations note is required/);

  const key = nextKey();
  const noted = await ops.mutateFoodOps(db, {
    orderId: order.orderId, action: "add_note", actorId: OPS_STAFF, idempotencyKey: key,
    note: "Customer asked for a later delivery window",
  });
  assert.equal(noted.status, "noted");

  const replay = await ops.mutateFoodOps(db, {
    orderId: order.orderId, action: "add_note", actorId: OPS_STAFF, idempotencyKey: key,
    note: "Customer asked for a later delivery window",
  });
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.noteId, noted.noteId);
  assert.equal(
    Number((await db.prepare("SELECT COUNT(*) AS n FROM food_ops_notes WHERE order_id=?").bind(order.orderId).first()).n),
    1,
    "a replayed note is written once",
  );

  const unsupported = await refusal(opsAct(db, order, "delete_order", {}));
  assert.equal(unsupported?.status, 400);
  assert.match(unsupported.message, /Unsupported Food Operations action/);

  const missing = await refusal(ops.mutateFoodOps(db, {
    orderId: "PS-UAT-FOOD-NOPE", action: "add_note", actorId: OPS_STAFF, idempotencyKey: nextKey(), note: "Nothing here",
  }));
  assert.equal(missing?.status, 404);
  assert.match(missing.message, /Canonical Food order not found/);
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food gateway routes every gate to specialist authority", async () => {
  const { db, order } = await world();
  const gateway = await import("../lib/api-gateway.ts");
  const env = { DB: db };
  const { cookie } = await customerSessionCookie(db, { principalKey: "+919800000010", customerId: order.customerId });

  const ask = async (path, action, headers = {}) => {
    const init = action
      ? { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ action }) }
      : { headers };
    const decision = await gateway.authorizeApiRequest(new Request(foodUrl(path), init), env);
    return decision instanceof Response ? decision.status : (decision.permission ?? "public");
  };
  const asCustomer = (path, action) => ask(path, action, { cookie });

  // Pricing food is public; ordering is not.
  assert.equal(await ask("/api/food-commercial"), "public");
  assert.equal(await ask("/api/food-orders", "create"), 401, "an anonymous caller cannot order");

  // The customer owns their order and their cancellation request, and nothing else.
  assert.equal(await asCustomer("/api/food-orders", "create"), "scheduling.book");
  assert.equal(await asCustomer("/api/food-finance", "request_cancel"), "scheduling.book");
  for (const [path, action] of [
    ["/api/food-fulfilment", "pack_order"],
    ["/api/food-fulfilment", "dispatch_order"],
    ["/api/food-finance", "approve_cancel"],
    ["/api/food-finance", "record_order_payment"],
    ["/api/food-finance", "record_refund"],
    ["/api/food-finance", "prepare_supplier_settlement"],
    ["/api/food-ops", "resume_same_sku_stock"],
  ]) {
    assert.equal(await asCustomer(path, action), 403, `${path} ${action} must be refused to a customer`);
  }

  // Inside the staff surfaces, a fulfilment operator is not Finance and not Operations.
  const now = Date.now();
  await gateway.authorizeApiRequest(
    new Request(foodUrl("/api/food-ops"), { headers: { "oai-authenticated-user-email": "nobody@pawspace.test" } }),
    env,
  );
  const staff = async (email, roleCode) => {
    await db.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
      .bind(`U-${roleCode}`, email, roleCode, roleCode, now, now).run();
    return (path, action) => ask(path, action, { "oai-authenticated-user-email": email });
  };
  const asProvider = await staff("packer@pawspace.test", "service_provider");
  const asFinance = await staff("finance@pawspace.test", "finance");

  assert.equal(await asProvider("/api/food-finance", "record_order_payment"), 403, "a fulfilment operator does not take money");
  assert.equal(await asProvider("/api/food-finance", "approve_cancel"), 403);
  assert.equal(await asFinance("/api/food-ops", "resume_same_sku_stock"), 403, "Finance does not run Operations");
  for (const action of ["approve_cancel", "record_order_payment", "record_refund", "prepare_supplier_settlement", "reconcile"]) {
    assert.equal(await asFinance("/api/food-finance", action), "finance.manage", action);
  }
});

// ---------------------------------------------------------------------------------------------
test("Fresh Food closure remains UAT-only and does not claim production launch", async () => {
  const { db, order } = await world();
  await fulfil(db, order, "accept_order");
  await fulfil(db, order, "pick_order", { lotId: LOT });
  await fulfil(db, order, "pack_order");
  await fulfil(db, order, "dispatch_order", { dispatchReference: "UATDISP-UATONLY" });
  await fulfil(db, order, "confirm_delivery", { handoverMethod: "customer" });

  // The catalogue never claims verified production stock.
  for (const row of await governance.listFoodCatalogue(db, ZONE)) {
    assert.equal(row.commercial_status, "uat_only");
    assert.equal(row.inventory_mode, "uat_seed");
    assert.equal(row.production_inventory_verified, false);
  }

  // The picked lot is explicitly unverified, and the dispatch adapter is not connected.
  const lot = await db.prepare("SELECT production_lot_verified FROM food_uat_lots WHERE id=?").bind(LOT).first();
  assert.equal(Number(lot.production_lot_verified), 0);
  const fulfilmentRow = await db.prepare("SELECT delivery_adapter_status FROM food_order_fulfilment WHERE order_id=?").bind(order.orderId).first();
  assert.equal(fulfilmentRow.delivery_adapter_status, "not_connected");
  assert.equal(
    (await db.prepare("SELECT otp_status FROM food_delivery_handover_events WHERE order_id=?").bind(order.orderId).first()).otp_status,
    "not_connected",
  );

  // Money is sandbox-gated and no gateway reference is invented.
  const payment = await db.prepare("SELECT gateway,status,reference FROM food_order_payment_events WHERE order_id=?").bind(order.orderId).first();
  assert.equal(payment.gateway, "uat_sandbox");
  assert.equal(payment.status, "due");
  assert.equal(payment.reference, null);

  // The Operations readiness block is honest about every disconnected dependency.
  const snapshot = await ops.getFoodOpsSnapshot(db);
  assert.equal(snapshot.readiness.productionReady, false);
  assert.equal(snapshot.readiness.engineeringGate, "gate_5_closed_uat_contract");
  assert.deepEqual(snapshot.readiness.externalDependencies, {
    productionCatalogue: "disconnected", productionInventory: "disconnected",
    productionLotTraceability: "disconnected", deliveryPartner: "disconnected", otp: "disconnected",
    objectStorage: "disconnected", malwareScanner: "disconnected", payments: "sandbox_only",
    refunds: "sandbox_only", cogs: "configuration_required", supplierSettlement: "rule_pending",
    tax: "configuration_required",
  });
  for (const value of Object.values(snapshot.readiness.externalDependencies)) {
    assert.notEqual(value, "connected", "no external dependency is ever reported as connected");
    assert.notEqual(value, "live");
  }
});
