import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__PRICE_WINDOW_DB__", "__PRICE_WINDOW_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => {
      const info = sqlite.prepare(sql).run(...args);
      return { success: true, meta: { changes: Number(info.changes) } };
    },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => {
      const results = [];
      for (const item of items) results.push(await item.run());
      return results;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PRICE_WINDOW_DB__ = db;
  globalThis.__PRICE_WINDOW_ENV__ = {};
  const { ensurePricingControlRuntime } = await import("../lib/pricing-control-runtime.ts");
  await ensurePricingControlRuntime(db);
  return { sqlite, db };
}

async function quoteRoute(body) {
  const route = await import("../app/api/pricing-quote/route.ts");
  return route.POST(new Request("https://app.pawspace.in/api/pricing-quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
}

function activate(sqlite, { price, from, to = null }) {
  sqlite.prepare("UPDATE service_packages SET active=1,base_price=?,effective_from=?,effective_to=? WHERE package_code='dog-bath'")
    .run(price, from, to);
}

test("future Pricing Control package rows cannot override an earlier customer quote", async () => {
  const { sqlite, db } = await world();
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  activate(sqlite, { price: 9999, from: "2027-01-01" });

  const beforeWindow = await resolveLivePrice(db, {
    packageCode: "dog-bath",
    fallbackPrice: 1349,
    scheduledStart: "2026-08-31T05:00:00.000Z",
    cityId: "blr",
  });
  assert.deepEqual(beforeWindow, { price: 1349, source: "fallback_default" });

  const refused = await quoteRoute({ packageCode: "dog-bath", scheduledStart: "2026-08-31T05:00:00.000Z", cityId: "blr", zoneId: "blr-east" });
  assert.equal(refused.status, 404, await refused.text());

  const insideWindow = await resolveLivePrice(db, {
    packageCode: "dog-bath",
    fallbackPrice: 1349,
    scheduledStart: "2027-01-02T05:00:00.000Z",
    cityId: "blr",
  });
  assert.deepEqual(insideWindow, { price: 9999, source: "pricing_control" });

  const accepted = await quoteRoute({ packageCode: "dog-bath", scheduledStart: "2027-01-02T05:00:00.000Z", cityId: "blr", zoneId: "blr-east" });
  const acceptedText = await accepted.text();
  assert.equal(accepted.status, 200, acceptedText);
  const body = JSON.parse(acceptedText);
  assert.equal(body.data.finalPrice, 9999);
});

test("expired Pricing Control package rows cannot override a later customer quote", async () => {
  const { sqlite, db } = await world();
  const { resolveLivePrice } = await import("../lib/live-pricing-resolver.ts");
  activate(sqlite, { price: 499, from: "2026-01-01", to: "2026-01-31" });

  const afterWindow = await resolveLivePrice(db, {
    packageCode: "dog-bath",
    fallbackPrice: 1349,
    scheduledStart: "2026-08-31T05:00:00.000Z",
    cityId: "blr",
  });
  assert.deepEqual(afterWindow, { price: 1349, source: "fallback_default" });

  const refused = await quoteRoute({ packageCode: "dog-bath", scheduledStart: "2026-08-31T05:00:00.000Z", cityId: "blr", zoneId: "blr-east" });
  assert.equal(refused.status, 404, await refused.text());

  const insideWindow = await resolveLivePrice(db, {
    packageCode: "dog-bath",
    fallbackPrice: 1349,
    scheduledStart: "2026-01-15T05:00:00.000Z",
    cityId: "blr",
  });
  assert.deepEqual(insideWindow, { price: 499, source: "pricing_control" });

  const accepted = await quoteRoute({ packageCode: "dog-bath", scheduledStart: "2026-01-15T05:00:00.000Z", cityId: "blr", zoneId: "blr-east" });
  const acceptedText = await accepted.text();
  assert.equal(accepted.status, 200, acceptedText);
  const body = JSON.parse(acceptedText);
  assert.equal(body.data.finalPrice, 499);
});
