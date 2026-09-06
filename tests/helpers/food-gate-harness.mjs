import { installWorkersHooks } from "./module-hooks.mjs";
import { makeD1, freshSqlite } from "./taxi-harness.mjs";

installWorkersHooks("__FOOD_GATE_DB__", "__FOOD_GATE_ENV__");

export const CUSTOMER_ID = "CUST-FOOD-GATE-1";
export const DOG_PET_ID = "PET-FOOD-DOG-1";
export const CAT_PET_ID = "PET-FOOD-CAT-1";
export const DOG_SKU = "food-uat-dog-adult-2kg";
export const CAT_SKU = "food-uat-cat-adult-1kg";
export const DOG_LOT = "FLOT-DOG-A-01";
export const CAT_LOT = "FLOT-CAT-A-01";

const governance = await import("../../lib/food-governance.ts");
const fulfilment = await import("../../lib/food-fulfilment-governance.ts");
const finance = await import("../../lib/food-finance-governance.ts");
const proof = await import("../../lib/food-proof-governance.ts");
const ops = await import("../../lib/food-ops-governance.ts");

export const {
  ensureFoodGovernanceTables,
  listFoodCatalogue,
  createFoodQuote,
  createFoodOrder,
} = governance;
export const {
  ensureFoodFulfilmentTables,
  listFoodOrders,
  mutateFoodFulfilment,
} = fulfilment;
export const {
  ensureFoodFinanceTables,
  mutateFoodFinance,
} = finance;
export const {
  ensureFoodProofTables,
  mutateFoodProof,
} = proof;
export const {
  ensureFoodOpsTables,
  getFoodOpsSnapshot,
  mutateFoodOps,
} = ops;

export function freshFoodWorld() {
  const sqlite = freshSqlite();
  const db = makeD1(sqlite);
  globalThis.__FOOD_GATE_DB__ = db;
  globalThis.__FOOD_GATE_ENV__ = { DB: db };
  sqlite.exec("CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,species TEXT NOT NULL)");
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,name TEXT,city_id TEXT,primary_phone TEXT,updated_at INTEGER)");
  sqlite.prepare("INSERT INTO canonical_customers (id,name,city_id,primary_phone,updated_at) VALUES (?,?,?,?,?)")
    .run(CUSTOMER_ID, "Food Gate Customer", "blr", "+919000000011", Date.now());
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,species) VALUES (?,?,?)").run(DOG_PET_ID, CUSTOMER_ID, "dog");
  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,species) VALUES (?,?,?)").run(CAT_PET_ID, CUSTOMER_ID, "cat");
  return { sqlite, db };
}

export function petForSku(sku) {
  return sku === CAT_SKU ? CAT_PET_ID : DOG_PET_ID;
}

export async function createFoodOrderFixture(world, {
  sku = DOG_SKU,
  quantity = 1,
  zoneId = "blr-east",
  idempotencyKey = `food-order-${crypto.randomUUID()}`,
  customerId = CUSTOMER_ID,
} = {}) {
  const quote = await createFoodQuote(world.db, {
    sku,
    quantity,
    zoneId,
    paymentMode: "sandbox_deferred",
    customerId,
    petIds: [petForSku(sku)],
  });
  const order = await createFoodOrder(world.db, {
    idempotencyKey,
    quoteId: quote.quoteId,
    customerId,
    cityId: "blr",
    zoneId,
    actorId: "food-gate-harness",
  });
  return { quote, order, orderId: order.orderId, sku, quantity, zoneId, customerId };
}

export async function fulfilTo(world, fixture, target = "delivered") {
  const orderId = fixture.orderId;
  const steps = [
    ["accept_order", {}],
    ["pick_order", { lotId: fixture.sku === CAT_SKU ? CAT_LOT : DOG_LOT }],
    ["pack_order", {}],
    ["dispatch_order", { dispatchReference: `UAT-${orderId.slice(-8)}` }],
    ["confirm_delivery", { handoverMethod: "customer" }],
  ];
  const results = [];
  for (const [action, extra] of steps) {
    const result = await mutateFoodFulfilment(world.db, {
      orderId,
      action,
      actorId: "food-ops@example.in",
      idempotencyKey: `${orderId}:${action}`,
      ...extra,
    });
    results.push(result);
    if (String(result.status) === target) break;
  }
  return results;
}

export async function prepareCleanMedia(world, fixture, {
  purpose = "food_package",
  submitter = "food-media@example.in",
  scanner = "food-scanner@example.in",
} = {}) {
  const sha256 = "a".repeat(64);
  const prepared = await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "prepare_media",
    actorId: submitter,
    idempotencyKey: `${fixture.orderId}:prepare:${purpose}`,
    purpose,
    mimeType: "image/jpeg",
    sizeBytes: 1024,
    sha256,
  });
  await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "sandbox_finalize_media",
    actorId: submitter,
    idempotencyKey: `${fixture.orderId}:finalize:${purpose}`,
    uploadToken: prepared.upload.token,
    storageObjectId: `uat/${fixture.orderId}/${prepared.mediaId}.jpg`,
  });
  const scanned = await mutateFoodProof(world.db, {
    orderId: fixture.orderId,
    action: "record_media_scan",
    actorId: scanner,
    idempotencyKey: `${fixture.orderId}:scan:${purpose}`,
    mediaRef: prepared.mediaRef,
    scanResult: "clean",
  });
  return { prepared, scanned, mediaRef: prepared.mediaRef };
}

export async function expectResponse(promise, status, pattern) {
  try {
    await promise;
  } catch (error) {
    if (!(error instanceof Response)) throw error;
    if (error.status !== status) throw new Error(`Expected HTTP ${status}, got ${error.status}: ${await error.text()}`);
    const body = await error.text();
    if (pattern && !pattern.test(body)) throw new Error(`Response did not match ${pattern}: ${body}`);
    return body;
  }
  throw new Error(`Expected Response(${status}) rejection`);
}
