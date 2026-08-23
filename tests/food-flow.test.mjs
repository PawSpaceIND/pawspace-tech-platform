import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const flow = read("app/mobile-app/food-flow.tsx");
const flowCss = read("app/mobile-app/food-flow.module.css");
const foodClient = read("lib/food-client.ts");
const subscriptionGovernance = read("lib/food-subscription-governance.ts");
const subscriptionRoute = read("app/api/food-subscriptions/route.ts");

// --- Contract: catalogue and pricing come from the server, never the component ---

test("flow loads the catalogue through the client lib and never fetches any API directly", () => {
  assert.match(flow, /loadFoodCatalogue/);
  assert.match(flow, /from "\.\.\/\.\.\/lib\/food-client"/);
  assert.doesNotMatch(flow, /fetch\(/, "the component must not call fetch — every API interaction goes through the client libs");
});

test("flow hardcodes no catalogue prices — money is rendered from server fields only", () => {
  assert.doesNotMatch(flow, /\b(799|849|1349|1899|2399)\b/, "no seed-catalogue price literal may appear in the flow");
  assert.doesNotMatch(flow, /price:\s*\d/, "no local price constants");
  assert.match(flow, /item\.unit_price/, "cart display reads the server catalogue unit_price");
  assert.match(flow, /quote\.totalAmount|serverTotal/, "review totals come from server quotes");
});

test("order creation goes through the client lib order path, not a direct endpoint call", () => {
  assert.match(flow, /placeQuotedFoodOrders/);
  assert.match(flow, /quoteFoodCart/);
  assert.doesNotMatch(flow, /\/api\/food-orders/, "the component never references the order endpoint directly");
  // The lib helpers compose the existing createFoodQuote/createCanonicalFoodOrder contract.
  assert.match(foodClient, /export async function quoteFoodCart/);
  assert.match(foodClient, /export async function placeQuotedFoodOrders/);
  assert.match(foodClient, /createCanonicalFoodOrder\(\{idempotencyKey:`food-flow:\$\{input\.customer\.id\}:\$\{quote\.quoteId\}`/);
});

test("subscription options offered by the flow are all supported by the real API contract", () => {
  // The route + governance accept any explicit customer-selected 7-90 day interval.
  assert.match(subscriptionRoute, /renewalIntervalDays/);
  assert.match(subscriptionGovernance, /if\(!Number\.isFinite\(interval\)\|\|interval<7\|\|interval>90\)/, "governance validates the 7-90 day window, rejecting non-finite values");
  const offered = [...flow.matchAll(/intervalDays:\s*(\d+)/g)].map((match) => Number(match[1]));
  assert.ok(offered.length >= 2, "flow offers a choice of repeat intervals");
  for (const days of offered) {
    assert.ok(days >= 7 && days <= 90, `offered interval ${days} must sit inside the API's validated 7-90 day range`);
  }
  assert.match(flow, /createFoodSubscription/);
  assert.match(flow, /from "\.\.\/\.\.\/lib\/food-subscription-client"/);
});

test("flow is standalone: no imports from other flow/checkout files, no globalThis", () => {
  assert.doesNotMatch(flow, /from\s*"\.\/(grooming-flow|stay-flow|training-flow|page)/, "must not import other flows or the app shell");
  assert.match(flow, /from "\.\/customer-login"/, "shares only the LoggedInCustomer type, like every flow");
  assert.match(flow, /\{ customer, onCompleted \}: \{ customer: LoggedInCustomer/, "mirrors the flows' prop contract");
  assert.doesNotMatch(flow, /globalThis/);
  assert.doesNotMatch(foodClient, /globalThis/);
  assert.doesNotMatch(flowCss, /globalThis/);
});

test("flow styling uses the Emerald/Gold palette with system fonts", () => {
  assert.match(flowCss, /#01261f/i);
  assert.match(flowCss, /#e6b34e/i);
  assert.match(flowCss, /system-ui/);
});

// --- Real execution: the new cart helpers drive the REAL food governance code over real SQLite ---
// A minimal D1Database shim over node:sqlite (a real SQLite engine). global fetch is shimmed to
// dispatch to the real, unmodified lib/food-governance.ts functions, so quoteFoodCart and
// placeQuotedFoodOrders are proven against the actual CREATE TABLE statements and pricing rules.

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
  };
}

async function withFoodBackend(run) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const governance = await import("../lib/food-governance.ts");
  await governance.ensureFoodGovernanceTables(db);
  sqlite.exec("CREATE TABLE canonical_pets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,species TEXT NOT NULL)");
  for (const pet of [["pet-dog-1","cus-food-1","dog"],["pet-cat-1","cus-food-1","cat"],["pet-dog-2","cus-food-2","dog"]]) sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,species) VALUES (?,?,?)").run(...pet);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    const body = init.body ? JSON.parse(String(init.body)) : {};
    const reply = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
    try {
      if (path.startsWith("/api/food-commercial") && init.method === "POST") {
        const quote = await governance.createFoodQuote(db, { sku: body.sku, quantity: Number(body.quantity || 0), zoneId: body.zoneId || "blr-east", paymentMode: body.paymentMode || "sandbox_deferred", customerId: body.customerId, petIds: body.petIds, couponCode: body.couponCode });
        return reply({ data: quote }, 201);
      }
      if (path.startsWith("/api/food-commercial")) {
        const items = await governance.listFoodCatalogue(db, "blr-east");
        return reply({ data: { items } });
      }
      if (path.startsWith("/api/food-orders") && init.method === "POST") {
        const result = await governance.createFoodOrder(db, { idempotencyKey: body.idempotencyKey, quoteId: body.quoteId, customerId: body.customer?.id, cityId: body.cityId || "blr", zoneId: body.zoneId || "blr-east", actorId: "test-actor" });
        return reply({ data: result }, result.duplicatePrevented ? 200 : 201);
      }
      return reply({ error: `Unhandled test route ${path}` }, 500);
    } catch (error) {
      if (error instanceof Response) return reply({ error: await error.text().catch(() => "request failed") }, error.status || 500);
      throw error;
    }
  };
  try {
    return await run({ sqlite, db });
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("real execution: quoteFoodCart returns server-priced quotes summing to the DB unit prices", async () => {
  await withFoodBackend(async ({ sqlite }) => {
    const { quoteFoodCart } = await import("../lib/food-client.ts");
    const dogPrice = sqlite.prepare("SELECT unit_price FROM food_catalogue_items WHERE sku=?").get("food-uat-dog-adult-2kg").unit_price;
    const catPrice = sqlite.prepare("SELECT unit_price FROM food_catalogue_items WHERE sku=?").get("food-uat-cat-adult-1kg").unit_price;

    const { quotes, serverTotal } = await quoteFoodCart([
      { sku: "food-uat-dog-adult-2kg", quantity: 2, petIds: ["pet-dog-1"] },
      { sku: "food-uat-cat-adult-1kg", quantity: 1, petIds: ["pet-cat-1"] },
    ], "blr-east", "cus-food-1");

    assert.equal(quotes.length, 2, "one server quote per cart line");
    assert.equal(serverTotal, dogPrice * 2 + catPrice * 1, "total is the sum of DB-priced server quotes");
    const stored = sqlite.prepare("SELECT COUNT(*) c FROM food_commercial_quotes WHERE status='open'").get();
    assert.equal(stored.c, 2, "quotes are persisted server-side");
  });
});

test("real execution: placeQuotedFoodOrders creates one canonical order per quote with reservations", async () => {
  await withFoodBackend(async ({ sqlite }) => {
    const { quoteFoodCart, placeQuotedFoodOrders } = await import("../lib/food-client.ts");
    const { quotes, serverTotal } = await quoteFoodCart([
      { sku: "food-uat-dog-adult-2kg", quantity: 2, petIds: ["pet-dog-1"] },
      { sku: "food-uat-cat-adult-1kg", quantity: 1, petIds: ["pet-cat-1"] },
    ], "blr-east", "cus-food-1");

    const customer = { id: "cus-food-1", name: "Asha", primaryPhone: "9999900001" };
    const orders = await placeQuotedFoodOrders({ quotes, customer });

    assert.equal(orders.length, 2, "one canonical order per quote");
    const orderRows = sqlite.prepare("SELECT * FROM food_orders ORDER BY created_at").all();
    assert.equal(orderRows.length, 2);
    assert.ok(orderRows.every((row) => row.customer_id === "cus-food-1"));
    assert.equal(orderRows.reduce((sum, row) => sum + row.total_amount, 0), serverTotal, "persisted order totals match the server-quoted total");

    const lines = sqlite.prepare("SELECT * FROM food_order_lines").all();
    assert.deepEqual(lines.map((line) => line.quantity).sort(), [1, 2], "line quantities persist from the quotes");

    const reservations = sqlite.prepare("SELECT COUNT(*) c FROM food_inventory_reservations WHERE status='reserved'").get();
    assert.equal(reservations.c, 2, "inventory reservations exist for each order");

    const usedQuotes = sqlite.prepare("SELECT COUNT(*) c FROM food_commercial_quotes WHERE status='used'").get();
    assert.equal(usedQuotes.c, 2, "quotes are consumed by their orders");
  });
});

test("real execution: retrying placeQuotedFoodOrders is idempotent (no duplicate orders)", async () => {
  await withFoodBackend(async ({ sqlite }) => {
    const { quoteFoodCart, placeQuotedFoodOrders } = await import("../lib/food-client.ts");
    const { quotes } = await quoteFoodCart([{ sku: "food-uat-dog-puppy-2kg", quantity: 1, petIds: ["pet-dog-2"] }], "blr-east", "cus-food-2");
    const customer = { id: "cus-food-2", name: "Ravi", primaryPhone: "9999900002" };

    const first = await placeQuotedFoodOrders({ quotes, customer });
    const second = await placeQuotedFoodOrders({ quotes, customer });

    assert.equal(first[0].duplicatePrevented, false);
    assert.equal(second[0].duplicatePrevented, true, "the retry is served from the idempotency key");
    assert.equal(second[0].orderId, first[0].orderId, "the same canonical order is returned");
    const count = sqlite.prepare("SELECT COUNT(*) c FROM food_orders").get();
    assert.equal(count.c, 1, "no duplicate order rows");
  });
});

test("real execution: quantity above the per-order cap is rejected by the server, not the UI", async () => {
  await withFoodBackend(async () => {
    const { quoteFoodCart } = await import("../lib/food-client.ts");
    await assert.rejects(
      () => quoteFoodCart([{ sku: "food-uat-dog-adult-2kg", quantity: 99, petIds: ["pet-dog-1"] }], "blr-east", "cus-food-1"),
      /quantity must be 1-/,
      "the real governance quantity rule fires through the client lib"
    );
  });
});
