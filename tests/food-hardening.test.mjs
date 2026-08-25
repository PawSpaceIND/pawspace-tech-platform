import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, so the REAL food routes and libs execute unmodified.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__FOOD_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
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

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const results = []; for (const stmt of statements) results.push(await stmt.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__FOOD_DB__ = makeD1(sqlite); sqlite.exec("CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,species TEXT NOT NULL)"); sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,species) VALUES (?,?,?)").run("pet-dog-f1","cus_f1","dog"); sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,species) VALUES (?,?,?)").run("pet-cat-f1","cus_f1","cat"); }

const commercialRoute = await import("../app/api/food-commercial/route.ts");
const ordersRoute = await import("../app/api/food-orders/route.ts");
const fulfilmentRoute = await import("../app/api/food-fulfilment/route.ts");
const subscriptionsRoute = await import("../app/api/food-subscriptions/route.ts");
const proofRoute = await import("../app/api/food-proof/route.ts");
const opsRoute = await import("../app/api/food-ops/route.ts");
const financeRoute = await import("../app/api/food-finance/route.ts");
const customer360Route = await import("../app/api/customer-360/route.ts");
const { createFoodQuote, createFoodOrder } = await import("../lib/food-governance.ts");
const { createFoodSubscription } = await import("../lib/food-subscription-governance.ts");
const { mutateFoodFinance } = await import("../lib/food-finance-governance.ts");
const { quoteFoodCart, placeQuotedFoodOrders } = await import("../lib/food-client.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
// Preview actor (localhost + NODE_ENV!=production) resolves to a superuser; ownership checks pass.
const call = async (handler, method, bodyOrQuery, headers = {}) => {
  const url = `http://localhost/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const request = method === "GET"
    ? new Request(url, { headers })
    : new Request(url, { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  return { status: response.status, body: await parseBody(response) };
};
// Non-preview actor: forwarded-identity headers on a non-local host exercise the REAL role +
// ownership path (role "customer" carries scheduling.book but no manage overrides).
const callAs = async (handler, method, bodyOrQuery, email) => {
  const url = `https://app.pawspace.test/api/x${method === "GET" && bodyOrQuery ? `?${bodyOrQuery}` : ""}`;
  const headers = { "content-type": "application/json", "oai-authenticated-user-email": email };
  const request = method === "GET" ? new Request(url, { headers }) : new Request(url, { method, headers, body: JSON.stringify(bodyOrQuery) });
  const response = await handler(request);
  return { status: response.status, body: await parseBody(response) };
};

// The food-flow's client helpers (quoteFoodCart/placeQuotedFoodOrders) call fetch("/api/...").
// Dispatch those to the REAL route handlers so the exact customer path executes end to end.
const routesByPath = { "/api/food-commercial": commercialRoute, "/api/food-orders": ordersRoute };
function installFetchStub() {
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input), "http://localhost");
    const route = routesByPath[url.pathname];
    if (!route) throw new Error(`Unstubbed fetch: ${url.pathname}`);
    const method = String(init.method || "GET").toUpperCase();
    const request = new Request(url, { method, headers: init.headers, body: init.body });
    return method === "GET" ? route.GET(request) : route.POST(request);
  };
}

const CUSTOMER = { id: "cus_f1", name: "Farah Iyer", primaryPhone: "+91-9000000011", email: "farah@example.in" };
const DOG_SKU = "food-uat-dog-adult-2kg";   // seeded: 799/unit, max 5, 30 units in blr-east
const CAT_SKU = "food-uat-cat-adult-1kg";   // seeded: 499/unit, max 5, 30 units in blr-east
const NOW = Date.now();
const DAY = 86_400_000;

async function quoteVia(sku, quantity, zoneId = "blr-east") {
  const petId = sku === CAT_SKU ? "pet-cat-f1" : "pet-dog-f1";
  const res = await call(commercialRoute.POST, "POST", { sku, quantity, zoneId, customerId: CUSTOMER.id, petIds: [petId] });
  return { status: res.status, quote: res.body.data, error: res.body.error };
}
async function orderVia(quote, key, customer = CUSTOMER, zoneId = "blr-east") {
  return call(ordersRoute.POST, "POST", { idempotencyKey: key, quoteId: quote.quoteId, customer, cityId: "blr", zoneId });
}
async function fulfil(orderId, action, extra = {}) {
  return call(fulfilmentRoute.POST, "POST", { orderId, action, idempotencyKey: `ff:${orderId}:${action}:${extra.k ?? "1"}`, ...extra });
}
function inventory(sku, zone = "blr-east") {
  return { ...sqlite.prepare("SELECT available_units,reserved_units FROM food_inventory_uat WHERE sku=? AND zone_id=?").get(sku, zone) };
}
function seedCustomerIdentity(email, customerId) {
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`usr-${email}`, email, email.split("@")[0], "customer", NOW, NOW);
  sqlite.prepare("INSERT INTO customer_identity_links (email,customer_id,status,verified_at,updated_at) VALUES (?,?,'active',?,?)")
    .run(email, customerId, NOW, NOW);
}
// Drives a fresh order through the full REAL fulfilment chain to delivered.
async function deliverOrder(orderId) {
  for (const [action, extra] of [
    ["accept_order", {}],
    ["pick_order", { lotId: "FLOT-DOG-A-01" }],
    ["pack_order", {}],
    ["dispatch_order", { dispatchReference: "UATDISPATCH-001" }],
    ["confirm_delivery", { handoverMethod: "customer" }],
  ]) {
    const res = await fulfil(orderId, action, extra);
    assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.body)}`);
  }
}

// ---- 1. Catalogue, quantity caps and zone scoping are server-enforced -------------------------

test("real execution: quantity caps and zone scoping are enforced server-side on the quote and order path", async () => {
  freshDb();
  const list = await call(commercialRoute.GET, "GET", "zoneId=blr-east");
  assert.equal(list.status, 200);
  assert.equal(list.body.data.items.length, 3, "the three governed UAT SKUs");
  assert.ok(list.body.data.items.every(i => i.production_inventory_verified === false));
  // Cap: max_qty_per_order = 5
  const over = await quoteVia(DOG_SKU, 6);
  assert.equal(over.status, 409, JSON.stringify(over));
  assert.match(String(over.error), /1-5/);
  assert.equal((await quoteVia(DOG_SKU, 0)).status, 409);
  // Zone without seeded inventory: no quote at all
  const wrongZone = await quoteVia(DOG_SKU, 1, "blr-north");
  assert.equal(wrongZone.status, 404, "a zone with no UAT inventory row must not quote");
  // Zone flip between quote and order is rejected
  const { quote } = await quoteVia(DOG_SKU, 1);
  const flipped = await orderVia(quote, "zone-flip", CUSTOMER, "blr-north");
  assert.equal(flipped.status, 409, JSON.stringify(flipped.body));
  // Oversell: drain availability, quote must refuse
  sqlite.prepare("UPDATE food_inventory_uat SET available_units=1 WHERE sku=? AND zone_id='blr-east'").run(CAT_SKU);
  assert.equal((await quoteVia(CAT_SKU, 2)).status, 409, "quote must not exceed available-reserved units");
});

// ---- 2. Order creation: server amounts, reservation, idempotency ------------------------------

test("real execution: order derives everything from the server quote, reserves inventory, and replays idempotently", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 2);
  assert.equal(quote.totalAmount, 1598, "2 x 799 server-computed");
  assert.equal(quote.amountDueNow, 0, "sandbox_deferred: nothing captured upfront");
  const created = await orderVia(quote, "ord-1");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const order = created.body.data;
  assert.equal(order.totalAmount, 1598);
  assert.equal(order.status, "uat_reserved");
  assert.equal(order.liveMoney, false);
  assert.deepEqual(inventory(DOG_SKU), { available_units: 30, reserved_units: 2 });
  assert.equal(sqlite.prepare("SELECT amount,amount_due_now,status FROM food_order_payments WHERE order_id=?").get(order.orderId).amount, 1598);
  // Replay same idempotency key: no second order, no second reservation
  const replay = await orderVia(quote, "ord-1");
  assert.equal(replay.status, 200);
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_orders").get().n, 1);
  assert.deepEqual(inventory(DOG_SKU), { available_units: 30, reserved_units: 2 });
});

test("real execution: a Food idempotency key is bound to its quote and delivery context", async () => {
  freshDb();
  const { quote: firstQuote } = await quoteVia(DOG_SKU, 1);
  const created = await orderVia(firstQuote, "food-context-key");
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const { quote: otherQuote } = await quoteVia(CAT_SKU, 1);
  const collision = await orderVia(otherQuote, "food-context-key");
  assert.equal(collision.status, 409);
  assert.equal(collision.body.error, "Unable to create canonical Food order");
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM food_orders").get().count, 1);
  assert.deepEqual(inventory(CAT_SKU), { available_units: 30, reserved_units: 0 });
  assert.equal(sqlite.prepare("SELECT status FROM food_commercial_quotes WHERE id=?").get(otherQuote.quoteId).status, "open");
});

test("REGRESSION lib/food-governance.ts: a single-use quote can no longer produce two orders under a concurrent double-submit", async () => {
  freshDb();
  const db = globalThis.__FOOD_DB__;
  const quote = await createFoodQuote(db, { sku: DOG_SKU, quantity: 2, zoneId: "blr-east", paymentMode: "sandbox_deferred", customerId: CUSTOMER.id, petIds: ["pet-dog-f1"] });
  // Two requests, DIFFERENT idempotency keys, same quote, in flight together (retry-after-timeout shape).
  // Pre-fix both passed the read-only status pre-check and both committed: 2 orders, 4 units reserved.
  const results = await Promise.allSettled([
    createFoodOrder(db, { idempotencyKey: "race-a", quoteId: quote.quoteId, customerId: CUSTOMER.id, cityId: "blr", zoneId: "blr-east", actorId: "a" }),
    createFoodOrder(db, { idempotencyKey: "race-b", quoteId: quote.quoteId, customerId: CUSTOMER.id, cityId: "blr", zoneId: "blr-east", actorId: "a" }),
  ]);
  const fulfilled = results.filter(r => r.status === "fulfilled");
  const rejected = results.filter(r => r.status === "rejected");
  assert.equal(fulfilled.length, 1, JSON.stringify(results.map(r => r.status)));
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason?.status, 409);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_orders").get().n, 1, "exactly one order per quote");
  assert.equal(inventory(DOG_SKU).reserved_units, 2, "inventory reserved exactly once (was 4 pre-fix)");
  const quoteRow = sqlite.prepare("SELECT status,used_order_id FROM food_commercial_quotes WHERE id=?").get(quote.quoteId);
  assert.equal(quoteRow.status, "used");
  assert.equal(quoteRow.used_order_id, fulfilled[0].value.orderId, "quote links the one order that actually won the claim");
});

// ---- 3. Full chain: order -> fulfilment run -> delivery proof -> completed --------------------

test("real execution: order -> accept -> pick(lot) -> pack(consumes stock) -> dispatch -> delivery creates the exact payment-due ledger", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 2);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  // Wrong lot (cat lot for a dog SKU) is refused
  await call(fulfilmentRoute.POST, "POST", { orderId: order.orderId, action: "accept_order", idempotencyKey: "a1" });
  const wrongLot = await fulfil(order.orderId, "pick_order", { lotId: "FLOT-CAT-A-01" });
  assert.equal(wrongLot.status, 409, "lot must match the exact ordered SKU and zone");
  const picked = await fulfil(order.orderId, "pick_order", { lotId: "FLOT-DOG-A-01" });
  assert.equal(picked.status, 200, JSON.stringify(picked.body));
  const packed = await fulfil(order.orderId, "pack_order");
  assert.equal(packed.status, 200, JSON.stringify(packed.body));
  assert.deepEqual(inventory(DOG_SKU), { available_units: 28, reserved_units: 0 }, "pack consumes stock and releases the reservation counter");
  assert.equal(sqlite.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").get(order.orderId).status, "consumed");
  // Cannot skip dispatch
  assert.equal((await fulfil(order.orderId, "confirm_delivery", { handoverMethod: "customer" })).status, 409);
  assert.equal((await fulfil(order.orderId, "dispatch_order", { dispatchReference: "UATDISPATCH-77" })).status, 200);
  const delivered = await fulfil(order.orderId, "confirm_delivery", { handoverMethod: "customer" });
  assert.equal(delivered.status, 200, JSON.stringify(delivered.body));
  assert.equal(delivered.body.data.amount, 1598, "payment-due amount equals the canonical order total");
  assert.equal(delivered.body.data.liveMoney, false);
  const due = { ...sqlite.prepare("SELECT amount,status FROM food_order_payment_events WHERE order_id=?").get(order.orderId) };
  assert.deepEqual(due, { amount: 1598, status: "due" });
  // Idempotent replay of delivery does not double-book the payment event
  const replay = await fulfil(order.orderId, "confirm_delivery", { handoverMethod: "customer" });
  assert.equal(replay.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_order_payment_events WHERE order_id=?").get(order.orderId).n, 1);
});

test("real execution: delivery proof pipeline is scan-gated and state-gated; finance payment + reconcile carry exact amounts", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 1);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  await call(fulfilmentRoute.POST, "POST", { orderId: order.orderId, action: "accept_order", idempotencyKey: "a1" });
  await fulfil(order.orderId, "pick_order", { lotId: "FLOT-DOG-A-01" });
  // Prepare + finalize + scan a package proof through the real media pipeline
  const prep = await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "prepare_media", idempotencyKey: "p1", purpose: "food_package", mimeType: "image/jpeg", sizeBytes: 2048, sha256: "a".repeat(64) });
  assert.equal(prep.status, 200, JSON.stringify(prep.body));
  const { mediaRef, upload } = prep.body.data;
  // REGRESSION lib/food-proof-governance.ts: prepare_media used to INSERT provider_id NULL into
  // service_media_assets whose owning DDL says NOT NULL — every food proof capture crashed.
  assert.equal(sqlite.prepare("SELECT provider_id FROM service_media_assets WHERE booking_id=?").get(order.orderId).provider_id, "food_ops_internal");
  const fin = await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "sandbox_finalize_media", idempotencyKey: "p2", uploadToken: upload.token, storageObjectId: "food/objects/abc12345" });
  assert.equal(fin.status, 200, JSON.stringify(fin.body));
  // Package proof before the scan verdict is refused
  await fulfil(order.orderId, "pack_order");
  const early = await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "record_package_proof", idempotencyKey: "p3", mediaRef, note: "sealed pack photo" });
  assert.equal(early.status, 409, "unscanned media must never count as proof");
  const scan = await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "record_media_scan", idempotencyKey: "p4", mediaRef, scanResult: "clean" });
  assert.equal(scan.status, 200);
  const pkg = await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "record_package_proof", idempotencyKey: "p5", mediaRef, note: "sealed pack photo" });
  assert.equal(pkg.status, 200, JSON.stringify(pkg.body));
  // Delivery proof requires delivered state
  assert.equal((await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "record_delivery_proof", idempotencyKey: "p6", mediaRef, note: "handover" })).status, 409);
  await fulfil(order.orderId, "dispatch_order", { dispatchReference: "UATDISPATCH-11" });
  await fulfil(order.orderId, "confirm_delivery", { handoverMethod: "customer" });
  // Finance: record the sandbox payment with a canonical reference, then reconcile with exact totals
  const pay = await call(financeRoute.POST, "POST", { orderId: order.orderId, action: "record_order_payment", idempotencyKey: "f1", paymentReference: "UATPAY-001" });
  assert.equal(pay.status, 200, JSON.stringify(pay.body));
  assert.equal(pay.body.data.amount, 799);
  // Same reference cannot pay a second order
  const { quote: q2 } = await quoteVia(CAT_SKU, 1);
  const { body: { data: o2 } } = await orderVia(q2, "ord-2");
  await deliverReplacementCat(o2.orderId);
  const reuse = await call(financeRoute.POST, "POST", { orderId: o2.orderId, action: "record_order_payment", idempotencyKey: "f2", paymentReference: "UATPAY-001" });
  assert.equal(reuse.status, 409, "payment reference reuse must be refused");
  const recon = await call(financeRoute.POST, "POST", { orderId: order.orderId, action: "reconcile", idempotencyKey: "f3" });
  assert.equal(recon.status, 200);
  assert.equal(recon.body.data.paidTotal, 799);
  assert.equal(recon.body.data.unpaidTotal, 0);
  assert.equal(recon.body.data.netPaidTotal, 799);
  assert.equal(recon.body.data.deliveryDueTotal, 799);
});
async function deliverReplacementCat(orderId) {
  await call(fulfilmentRoute.POST, "POST", { orderId, action: "accept_order", idempotencyKey: `c:${orderId}:a` });
  for (const [action, extra] of [["pick_order", { lotId: "FLOT-CAT-A-01" }], ["pack_order", {}], ["dispatch_order", { dispatchReference: "UATDISPATCH-22" }], ["confirm_delivery", { handoverMethod: "customer" }]]) {
    const res = await call(fulfilmentRoute.POST, "POST", { orderId, action, idempotencyKey: `c:${orderId}:${action}`, ...extra });
    assert.equal(res.status, 200, `${action}: ${JSON.stringify(res.body)}`);
  }
}

// ---- 4. Cancel path: segregation of duties, server-capped refund, inventory restored ----------

test("real execution: cancel path restores the inventory reservation, enforces segregation of duties, and refuses client-minted refunds", async () => {
  freshDb();
  const db = globalThis.__FOOD_DB__;
  const { quote } = await quoteVia(DOG_SKU, 3);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  await call(fulfilmentRoute.POST, "POST", { orderId: order.orderId, action: "accept_order", idempotencyKey: "a1" });
  assert.equal(inventory(DOG_SKU).reserved_units, 3);
  // Customer requests cancellation (distinct actor via lib so the preview approver differs)
  const req = await mutateFoodFinance(db, { orderId: order.orderId, action: "request_cancel", actorId: `customer:${CUSTOMER.id}`, idempotencyKey: "rc-1", reason: "ordered the wrong pack size" });
  assert.equal(req.status, "policy_review_required");
  // Requester cannot approve their own cancellation
  await assert.rejects(
    mutateFoodFinance(db, { orderId: order.orderId, action: "approve_cancel", actorId: `customer:${CUSTOMER.id}`, idempotencyKey: "ac-self", reason: "self approve", approvedRefundAmount: 0 }),
    (e) => e instanceof Response && e.status === 409);
  // Nothing was captured (sandbox_deferred): any positive refund exceeds paid value -> refused
  const minted = await call(financeRoute.POST, "POST", { orderId: order.orderId, action: "approve_cancel", idempotencyKey: "ac-minted", reason: "attempt refund", approvedRefundAmount: 500 });
  assert.equal(minted.status, 409, JSON.stringify(minted.body));
  const approved = await call(financeRoute.POST, "POST", { orderId: order.orderId, action: "approve_cancel", idempotencyKey: "ac-1", reason: "policy approved", approvedRefundAmount: 0 });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  assert.equal(approved.body.data.refundStatus, "not_required");
  assert.equal(approved.body.data.inventoryReservationReleased, true);
  assert.equal(inventory(DOG_SKU).reserved_units, 0, "cancellation must hand the reserved units back");
  assert.equal(sqlite.prepare("SELECT status FROM food_inventory_reservations WHERE order_id=?").get(order.orderId).status, "released");
  assert.equal(sqlite.prepare("SELECT status FROM food_orders WHERE id=?").get(order.orderId).status, "cancelled");
  // A packed order cannot take the finance cancel shortcut
  const { quote: q2 } = await quoteVia(DOG_SKU, 1);
  const { body: { data: o2 } } = await orderVia(q2, "ord-2");
  await call(fulfilmentRoute.POST, "POST", { orderId: o2.orderId, action: "accept_order", idempotencyKey: "b1" });
  await fulfil(o2.orderId, "pick_order", { lotId: "FLOT-DOG-A-01" });
  await fulfil(o2.orderId, "pack_order");
  const packedCancel = await call(financeRoute.POST, "POST", { orderId: o2.orderId, action: "request_cancel", idempotencyKey: "rc-2", reason: "changed my mind" });
  assert.equal(packedCancel.status, 409, "packed orders route through Operations, not direct finance cancel");
});

test("real execution: stock recovery preserves the order and re-reserves only the exact SKU", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 2);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  await call(fulfilmentRoute.POST, "POST", { orderId: order.orderId, action: "accept_order", idempotencyKey: "a1" });
  const issue = await fulfil(order.orderId, "report_stock_issue", { reason: "shelf damage found" });
  assert.equal(issue.status, 200, JSON.stringify(issue.body));
  assert.equal(issue.body.data.substitutionAllowed, false);
  assert.equal(sqlite.prepare("SELECT status FROM food_orders WHERE id=?").get(order.orderId).status, "stock_recovery_required");
  const resume = await call(opsRoute.POST, "POST", { orderId: order.orderId, action: "resume_same_sku_stock", idempotencyKey: "ops-1", reason: "replacement UAT stock arrived" });
  assert.equal(resume.status, 200, JSON.stringify(resume.body));
  assert.equal(resume.body.data.sku, DOG_SKU);
  assert.equal(resume.body.data.unitPrice, 799, "no silent repricing through recovery");
  assert.equal(inventory(DOG_SKU).reserved_units, 2, "reservation still counted exactly once after report+resume");
  assert.equal(sqlite.prepare("SELECT status FROM food_orders WHERE id=?").get(order.orderId).status, "accepted");
});

// ---- 5. Subscriptions: 7-90 interval, no auto-charge, pause/cancel ----------------------------

test("real execution: subscription interval is validated 7-90 through route and lib, including the NaN escape", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 1);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  for (const bad of [5, 91, 0]) {
    const res = await call(subscriptionsRoute.POST, "POST", { action: "create", sourceOrderId: order.orderId, renewalIntervalDays: bad });
    assert.equal(res.status, 400, `interval ${bad} must be rejected`);
  }
  // REGRESSION lib/food-subscription-governance.ts: a non-numeric interval with an explicit
  // firstRenewalAt used to slip past the 7-90 check as NaN and die on the NOT NULL column.
  const db = globalThis.__FOOD_DB__;
  await assert.rejects(
    createFoodSubscription(db, { sourceOrderId: order.orderId, customerId: CUSTOMER.id, renewalIntervalDays: "abc", firstRenewalAt: Date.now() + 10 * DAY, actorId: "a" }),
    (e) => e instanceof Response && e.status === 400, "NaN interval must be a governed 400, not a raw constraint crash");
  const ok = await call(subscriptionsRoute.POST, "POST", { action: "create", sourceOrderId: order.orderId, renewalIntervalDays: 30 });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.data.autoCharge, false, "policy pinned: subscriptions never auto-charge");
  assert.equal(ok.body.data.renewalIntervalDays, 30);
  // Duplicate create for the same source order is idempotent
  const dup = await call(subscriptionsRoute.POST, "POST", { action: "create", sourceOrderId: order.orderId, renewalIntervalDays: 30 });
  assert.equal(dup.body.data.duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_subscriptions").get().n, 1);
});

test("real execution: renewal generates a payment LINK (no auto-charge), payment advances the next delivery by the interval, pause/cancel govern the engine", async () => {
  freshDb();
  const { quote } = await quoteVia(CAT_SKU, 2);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  const created = await call(subscriptionsRoute.POST, "POST", { action: "create", sourceOrderId: order.orderId, renewalIntervalDays: 14 });
  const subscriptionId = created.body.data.subscriptionId, firstDue = created.body.data.nextRenewalAt;
  // Not due yet -> engine skips, no renewal row, no charge
  const early = await call(subscriptionsRoute.POST, "POST", { action: "process_due", subscriptionId });
  assert.equal(early.body.data.results[0].status, "not_due");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_subscription_renewals").get().n, 0);
  // Time-travel to due: a payment_pending renewal with a LINK is created; money is NOT moved
  const due = await call(subscriptionsRoute.POST, "POST", { action: "process_due", subscriptionId, at: firstDue + 1 });
  const renewal = due.body.data.results[0];
  assert.equal(renewal.status, "payment_pending", JSON.stringify(renewal));
  assert.equal(renewal.amount, 998, "2 x 499 at the approved signup price");
  assert.equal(renewal.autoCharge, false);
  assert.ok(String(renewal.paymentLinkPath).startsWith("/food/subscription-payment?"));
  // Replay is idempotent per cycle
  const replay = await call(subscriptionsRoute.POST, "POST", { action: "process_due", subscriptionId, at: firstDue + 1 });
  assert.equal(replay.body.data.results[0].duplicatePrevented, true);
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_subscription_renewals").get().n, 1);
  // Explicit payment reference confirms the cycle and advances next_renewal_at by EXACTLY the interval
  const paid = await call(subscriptionsRoute.POST, "POST", { action: "record_payment", renewalId: renewal.renewalId, paymentReference: "UATREF-9001" });
  assert.equal(paid.status, 200, JSON.stringify(paid.body));
  assert.equal(paid.body.data.status, "paid_invoiced");
  assert.equal(paid.body.data.amount, 998);
  assert.equal(paid.body.data.nextRenewalAt, firstDue + 14 * DAY, "next delivery = previous due + interval");
  assert.ok(paid.body.data.invoiceNumber);
  // Pause stops the engine; cancel is terminal
  const paused = await call(subscriptionsRoute.POST, "POST", { action: "pause", subscriptionId, reason: "travelling this month" });
  assert.equal(String(paused.body.data.subscription.status), "paused");
  const whilePaused = await call(subscriptionsRoute.POST, "POST", { action: "process_due", subscriptionId, at: firstDue + 15 * DAY });
  assert.equal(whilePaused.body.data.results[0].skipped, true, "paused subscription must not generate renewals");
  await call(subscriptionsRoute.POST, "POST", { action: "resume", subscriptionId, reason: "back home" });
  const cancelled = await call(subscriptionsRoute.POST, "POST", { action: "cancel", subscriptionId, reason: "switching diets" });
  assert.equal(String(cancelled.body.data.subscription.status), "cancelled");
  const reactivate = await call(subscriptionsRoute.POST, "POST", { action: "resume", subscriptionId, reason: "changed my mind" });
  assert.equal(reactivate.status, 409, "cancelled subscription cannot be reactivated");
  // No-auto-charge policy pinned end to end: the only paid renewal is the one with an explicit reference
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_subscription_renewals WHERE status='paid_invoiced' AND payment_reference IS NULL").get().n, 0);
  assert.equal(cancelled.body.data.truth.autoCharge, false);
});

// ---- 6. food-flow client full chain -> ops + finance with exact amounts -----------------------

test("full chain: quoteFoodCart/placeQuotedFoodOrders (the food-flow path) surface in food-ops and food-finance with exact amounts", async () => {
  freshDb(); installFetchStub();
  const cart = await quoteFoodCart([{ sku: DOG_SKU, quantity: 1, petIds: ["pet-dog-f1"] }, { sku: CAT_SKU, quantity: 2, petIds: ["pet-cat-f1"] }], "blr-east", CUSTOMER.id);
  assert.equal(cart.serverTotal, 1797, "799 + 2 x 499, all server-computed");
  const orders = await placeQuotedFoodOrders({ quotes: cart.quotes, customer: CUSTOMER });
  assert.equal(orders.length, 2);
  assert.deepEqual(orders.map(o => o.totalAmount).sort((a, b) => a - b), [799, 998]);
  // Retry of the same flow call is idempotent per quote (keys derive from quote IDs)
  const retry = await placeQuotedFoodOrders({ quotes: cart.quotes, customer: CUSTOMER });
  assert.ok(retry.every(o => o.duplicatePrevented === true));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_orders").get().n, 2);
  // Ops queue sees both canonical orders with the same money
  const ops = await call(opsRoute.GET, "GET");
  assert.equal(ops.status, 200);
  assert.equal(ops.body.data.metrics.total, 2);
  const opsTotals = ops.body.data.orders.map(o => Number(o.total_amount)).sort((a, b) => a - b);
  assert.deepEqual(opsTotals, [799, 998], "ops reads the same canonical rows the order path wrote");
  assert.equal(ops.body.data.readiness.productionReady, false);
  // Finance view per order carries the exact canonical total
  for (const placed of orders) {
    const fin = await call(financeRoute.GET, "GET", `orderId=${encodeURIComponent(placed.orderId)}`);
    assert.equal(fin.status, 200);
    assert.equal(Number(fin.body.data.order.total_amount), placed.totalAmount);
    assert.equal(fin.body.data.sandboxOnly, true);
  }
});

// ---- 7. Customer 360 surfaces real-path food orders --------------------------------------------

test("real execution: a food order created through the REAL order path surfaces in Customer 360 with its exact amount", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 2);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  const res = await call(customer360Route.GET, "GET", `customerId=${CUSTOMER.id}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const record = res.body.data.records.find(r => r.customerId === CUSTOMER.id);
  assert.ok(record, "the order path upserts canonical_customers, so the customer must exist in 360");
  const foodEntry = record.bookings.find(b => b.id === order.orderId);
  assert.ok(foodEntry, `food order ${order.orderId} must appear in the 360 bookings timeline`);
  assert.equal(foodEntry.serviceCode, "pet_food");
  assert.equal(foodEntry.totalAmount, 1598);
  assert.match(foodEntry.packageName, /Adult Dog Food/);
  assert.equal(record.lifetimeValue, 1598, "food order value counts toward lifetime value");
});

// ---- 8. Ownership: customer-scoped surfaces deny other customers ------------------------------

test("real execution: order creation, subscription create and cancel request are denied for a customer who does not own the target (403)", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 1);
  const { body: { data: order } } = await orderVia(quote, "ord-owner");
  seedCustomerIdentity("mallory@pawspace.test", "cus_other");
  // Creating an order against someone else's customer identity
  const { quote: q2 } = await quoteVia(CAT_SKU, 1);
  const foreignOrder = await callAs(ordersRoute.POST, "POST", { idempotencyKey: "mal-1", quoteId: q2.quoteId, customer: CUSTOMER, cityId: "blr", zoneId: "blr-east" }, "mallory@pawspace.test");
  assert.equal(foreignOrder.status, 403, JSON.stringify(foreignOrder.body));
  // Subscribing to someone else's order
  const foreignSub = await callAs(subscriptionsRoute.POST, "POST", { action: "create", sourceOrderId: order.orderId, renewalIntervalDays: 30 }, "mallory@pawspace.test");
  assert.equal(foreignSub.status, 403, JSON.stringify(foreignSub.body));
  // Requesting cancellation of someone else's order
  const foreignCancel = await callAs(financeRoute.POST, "POST", { orderId: order.orderId, action: "request_cancel", idempotencyKey: "mal-2", reason: "not mine" }, "mallory@pawspace.test");
  assert.equal(foreignCancel.status, 403, JSON.stringify(foreignCancel.body));
  // Reading someone else's order in customer scope
  const foreignRead = await callAs(fulfilmentRoute.GET, "GET", `orderId=${encodeURIComponent(order.orderId)}&scope=customer`, "mallory@pawspace.test");
  assert.equal(foreignRead.status, 403, JSON.stringify(foreignRead.body));
  // The rightful owner passes the same paths
  seedCustomerIdentity("farah@pawspace.test", CUSTOMER.id);
  const ownRead = await callAs(fulfilmentRoute.GET, "GET", `orderId=${encodeURIComponent(order.orderId)}&scope=customer`, "farah@pawspace.test");
  assert.equal(ownRead.status, 200, JSON.stringify(ownRead.body));
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM food_orders").get().n, 1, "no foreign order was created");
});

// ---- 9. Delivered orders cannot be cancelled; quality incident feeds the ops queue -------------

test("real execution: delivered orders refuse cancellation; quality incidents flag the ops queue without inventing refunds", async () => {
  freshDb();
  const { quote } = await quoteVia(DOG_SKU, 1);
  const { body: { data: order } } = await orderVia(quote, "ord-1");
  await deliverOrder(order.orderId);
  const late = await call(financeRoute.POST, "POST", { orderId: order.orderId, action: "request_cancel", idempotencyKey: "rc-late", reason: "too late now" });
  assert.equal(late.status, 409);
  const incident = await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "report_quality_incident", idempotencyKey: "qi-1", severity: "urgent", summary: "kibble bag arrived torn", actionTaken: "customer sent photos" });
  assert.equal(incident.status, 202, JSON.stringify(incident.body));
  assert.equal(incident.body.data.automaticRefund, false, "incidents never mint refunds automatically");
  const ops = await call(opsRoute.GET, "GET");
  const row = ops.body.data.orders.find(o => o.id === order.orderId);
  assert.ok(row.exceptionFlags.includes("urgent_quality_incident"), JSON.stringify(row.exceptionFlags));
  const resolved = await call(proofRoute.POST, "POST", { orderId: order.orderId, action: "resolve_incident", idempotencyKey: "qi-2", incidentId: incident.body.data.incidentId, resolution: "replacement pack dispatched free" });
  assert.equal(resolved.status, 200);
});

// ---- 10. Contracts: gateway permission map, DB rule, team surfaces -----------------------------

test("contract: gateway permission map, DB access rule, and team surfaces for the food stack", () => {
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /food-orders"\)return "scheduling\.book"/);
  assert.match(gateway, /food-ops"\)return "bookings\.manage"/);
  assert.match(gateway, /food-subscriptions"[\s\S]{0,250}\["process_due","record_payment"\]\.includes\(action\)\?"finance\.manage":"scheduling\.book"/);
  assert.match(gateway, /food-finance"[\s\S]{0,250}"request_cancel"\?"scheduling\.book":"finance\.manage"/);
  assert.match(gateway, /food-fulfilment"[\s\S]{0,200}scope"\)==="customer"\?"scheduling\.book":"bookings\.view"/);
  assert.match(gateway, /food-proof"[\s\S]{0,300}acknowledge_incident"\?"scheduling\.book":"bookings\.manage"/);
  for (const route of ["food-commercial", "food-orders", "food-fulfilment", "food-subscriptions", "food-proof", "food-ops", "food-finance"]) {
    const source = fs.readFileSync(new URL(`../app/api/${route}/route.ts`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /globalThis/, `${route} must get the DB via cloudflare:workers env, never globalThis`);
  }
  // The fixes stay in place
  const governance = fs.readFileSync(new URL("../lib/food-governance.ts", import.meta.url), "utf8");
  assert.match(governance, /WHERE id=\? AND status='open'"\)\.bind\(now,orderId,input\.quoteId\)\.run\(\)/, "quote claim must stay an atomic checked UPDATE");
  assert.match(governance, /reserved_units\+\?<=available_units/, "inventory reservation must be capacity-guarded in the mutation");
  assert.match(governance, /reservation\.meta\?\.changes/, "the capacity claim must be checked before order records are created");
  const subscription = fs.readFileSync(new URL("../lib/food-subscription-governance.ts", import.meta.url), "utf8");
  assert.match(subscription, /!Number\.isFinite\(interval\)\|\|interval<7\|\|interval>90/, "interval validation must reject non-finite values");
  // Team surfaces wire to the food APIs through the client libs
  for (const [client, api] of [["food-ops-client", "/api/food-ops"], ["food-fulfilment-client", "/api/food-fulfilment"], ["food-finance-client", "/api/food-finance"], ["food-proof-client", "/api/food-proof"]]) {
    assert.match(fs.readFileSync(new URL(`../lib/${client}.ts`, import.meta.url), "utf8"), new RegExp(`"${api.replaceAll("/", "\\/")}"`));
  }
  assert.match(fs.readFileSync(new URL("../app/team/operations/food/page.tsx", import.meta.url), "utf8"), /food-ops-client/);
  assert.match(fs.readFileSync(new URL("../app/team/operations/food/fulfilment/page.tsx", import.meta.url), "utf8"), /food-fulfilment-client/);
  assert.match(fs.readFileSync(new URL("../app/team/operations/food/proof/page.tsx", import.meta.url), "utf8"), /food-proof-client/);
  assert.match(fs.readFileSync(new URL("../app/team/finance/food/food-finance-workspace.tsx", import.meta.url), "utf8"), /food-finance-client/);
});
