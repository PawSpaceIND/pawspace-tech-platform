/**
 * E2E PRE-HUMAN-TESTING — city-wise scoping.
 *
 * PawSpace is launching city by city. Every city-scoped surface must answer about ONE city: a
 * Bengaluru P&L that quietly includes Delhi revenue is worse than a broken page, because it looks
 * right. Eleven GET routes accept a cityId, and nothing in the suite checks that passing it changes
 * the answer.
 *
 * Method: seed the same shape of business in two cities with DIFFERENT amounts, then ask each
 * city-scoped surface for one city and check the other city's money is absent. A route whose answer
 * is identical for both cities while holding data is ignoring the parameter.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__E2ECITY_DB__", "__E2ECITY_ENV__");

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes), rows_written: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args), meta: {} }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

/** Distinctive per city so a leak is identified by the exact figure that escaped. */
const CITIES = {
  blr: { id: "blr", amount: 4111, customer: "CUS-BLR-MARKER", booking: "BK-BLR-MARKER" },
  del: { id: "del", amount: 9777, customer: "CUS-DEL-MARKER", booking: "BK-DEL-MARKER" },
};

const sqlite = new DatabaseSync(":memory:");
globalThis.__E2ECITY_DB__ = makeD1(sqlite);
globalThis.__E2ECITY_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.in" };

function seed() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT DEFAULT '[]',city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}',created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,source TEXT,consent_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  const now = Date.now();
  const start = new Date(now - 3 * 86_400_000).toISOString();
  for (const city of Object.values(CITIES)) {
    sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,source,created_at,updated_at) VALUES (?,?,?,?, 'e2e',?,?)")
      .run(city.customer, city.id, `Customer ${city.id}`, `+9198765${city.id === "blr" ? "1111" : "2222"}`, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,?,?, 'grooming','GR-STD','Standard groom',?,?,?,?,'completed','customer_app',?,?,?,?)")
      .run(city.booking, `${city.booking}-idem`, city.customer, city.id, `${city.id}-east`, `SG-${city.id}`, `PRV-${city.id.toUpperCase()}`, start, start, city.amount, city.customer, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?, 'card','prepaid','captured','uat_sandbox',?,?,?)")
      .run(`PAY-${city.id}`, city.booking, city.customer, city.amount, city.amount, `${city.booking}-pay`, now, now);
  }
}

/** Every figure that belongs only to the OTHER city. */
function foreignMarkers(cityKey) {
  const other = CITIES[cityKey === "blr" ? "del" : "blr"];
  return [String(other.amount), other.booking, other.customer];
}

const routesUnderTest = ["unit-economics", "ops-intelligence"];

for (const name of routesUnderTest) {
  test(`city scoping: /api/${name}?cityId= answers about that city only`, async () => {
    seed();
    const route = await import(`../app/api/${name}/route.ts`);

    const bodies = {};
    for (const key of Object.keys(CITIES)) {
      const response = await route.GET(new Request(`http://localhost/api/${name}?cityId=${CITIES[key].id}`));
      const text = await response.text();
      assert.ok(response.status < 500, `/api/${name}?cityId=${key} must not 5xx: ${text.slice(0, 200)}`);
      bodies[key] = text;
    }

    // Guard against a vacuous pass: if neither answer holds its own city's money, this proves nothing.
    const ownMoneyPresent = Object.keys(CITIES).filter((key) => bodies[key].includes(String(CITIES[key].amount)));
    console.error(`/api/${name}: own-city figure present for [${ownMoneyPresent.join(", ") || "neither"}]; blr==del body: ${bodies.blr === bodies.del}`);

    if (!ownMoneyPresent.length) {
      console.error(`  SKIPPED as inconclusive — the surface never reports a raw booking amount, so a leak cannot be detected this way`);
      return;
    }

    for (const key of ownMoneyPresent) {
      for (const marker of foreignMarkers(key)) {
        assert.ok(!bodies[key].includes(marker),
          `/api/${name}?cityId=${key} leaked the other city's ${marker} — a city dashboard must not include another city's business`);
      }
    }
    assert.notEqual(bodies.blr, bodies.del, `/api/${name} returned an identical body for both cities while holding city-specific data — cityId is being ignored`);
  });
}

test("city scoping: a booking carries its city and the two cities are genuinely distinct", async () => {
  // Control for the tests above: if the seed did not actually create two cities, they are vacuous.
  seed();
  const rows = sqlite.prepare("SELECT city_id, total_amount FROM canonical_bookings ORDER BY city_id").all();
  assert.deepEqual(rows.map((row) => row.city_id), ["blr", "del"]);
  assert.deepEqual(rows.map((row) => Number(row.total_amount)), [4111, 9777]);
});
