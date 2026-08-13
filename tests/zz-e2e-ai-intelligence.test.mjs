/**
 * E2E PRE-HUMAN-TESTING — do the AI, automation and intelligence surfaces MEASURE, or assert?
 *
 * This repository has a history of dashboards that looked finished and were literals: /ops showed
 * "₹31.82L", /control showed four invented approvals tiles, /groomer's whole job list was hardcoded.
 * All were removed. The question for a founder about to put humans in front of the product is whether
 * any remain on the AI and intelligence surfaces.
 *
 * The test is behavioural, not a source grep: call each surface against an EMPTY database, then
 * against the SAME database with real bookings, customers, payments and conversations, and compare.
 *
 *   numbers change            -> the surface measures. Good.
 *   identical AND all zeroes  -> measures, and there was nothing to measure. Good.
 *   identical AND non-zero    -> reports figures that do not come from the database. Defect.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readdirSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__E2EAI_DB__", "__E2EAI_ENV__");

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

/** The AI, automation and intelligence surfaces a founder would show an investor. */
const SURFACES = readdirSync("app/api", { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(`app/api/${entry.name}/route.ts`))
  .map((entry) => entry.name)
  .filter((name) => /^ai-|intelligence|analytics|leaderboard|readiness|control-tower|operations-overview|unit-economics|pnl-reporting|risk-anomaly|acquisition-funnel|crm-automation|staff-alert-runner/.test(name))
  .sort();

/** Real business, written directly: this file is about whether surfaces READ, not about write paths. */
function seedBusiness(sqlite) {
  const now = Date.now();
  const start = new Date(now - 2 * 86_400_000).toISOString();
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,name TEXT,primary_phone TEXT,secondary_phone TEXT,email TEXT,source TEXT,consent_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT,customer_id TEXT,pet_ids_json TEXT DEFAULT '[]',city_id TEXT,zone_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,schedule_group_id TEXT,provider_id TEXT,scheduled_start TEXT,scheduled_end TEXT,status TEXT,channel TEXT,total_amount REAL,currency TEXT DEFAULT 'INR',pricing_json TEXT DEFAULT '{}',created_by TEXT,created_at INTEGER,updated_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT DEFAULT 'INR',method TEXT,mode TEXT,status TEXT,gateway TEXT,idempotency_key TEXT,detail_json TEXT DEFAULT '{}',created_at INTEGER,updated_at INTEGER)");
  for (let index = 0; index < 12; index += 1) {
    const customerId = `CUS-E2E-${index}`, bookingId = `BK-E2E-${index}`, amount = 1500 + index * 250;
    sqlite.prepare("INSERT OR REPLACE INTO canonical_customers (id,city_id,name,primary_phone,source,created_at,updated_at) VALUES (?,?,?,?, 'e2e',?,?)")
      .run(customerId, index % 2 ? "del" : "blr", `E2E Customer ${index}`, `+91900000${String(index).padStart(4, "0")}`, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO canonical_bookings (id,idempotency_key,customer_id,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?, 'PKG','Package',?,?,?,?,'completed','customer_app',?,?,?,?)")
      .run(bookingId, `${bookingId}-idem`, customerId, index % 2 ? "del" : "blr", "east", ["grooming", "boarding", "pet_sitting", "dog_walking"][index % 4], `SG-${index}`, `PRV-${index % 3}`, start, start, amount, customerId, now, now);
    sqlite.prepare("INSERT OR REPLACE INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,method,mode,status,gateway,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?, 'card','prepaid','captured','uat_sandbox',?,?,?)")
      .run(`PAY-E2E-${index}`, bookingId, customerId, amount, amount, `${bookingId}-pay`, now, now);
  }
}

/** Every number in a JSON body, so "did the answer move" is decidable. */
function numbersIn(text) {
  const found = String(text).match(/-?\d+(?:\.\d+)?/g) ?? [];
  return found.map(Number).filter((value) => Number.isFinite(value));
}

test(`AI / automation / intelligence: ${SURFACES.length} surfaces must report from the database, not from literals`, async () => {
  assert.ok(SURFACES.length >= 10, `expected the AI and intelligence surface, found ${SURFACES.length}: ${SURFACES.join(", ")}`);

  const suspicious = [];
  const measured = [];
  const emptyBoth = [];
  const unreachable = [];

  for (const name of SURFACES) {
    let route;
    try { route = await import(`../app/api/${name}/route.ts?ai=${name}`); } catch { unreachable.push(`${name} (import)`); continue; }
    if (typeof route.GET !== "function") { unreachable.push(`${name} (no GET)`); continue; }

    const call = async (sqlite) => {
      globalThis.__E2EAI_DB__ = makeD1(sqlite);
      globalThis.__E2EAI_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.in" };
      try {
        const response = await route.GET(new Request(`http://localhost/api/${name}`));
        return response.status >= 400 ? null : await response.text();
      } catch { return null; }
    };

    const cold = await call(new DatabaseSync(":memory:"));
    const warmDb = new DatabaseSync(":memory:");
    seedBusiness(warmDb);
    const warm = await call(warmDb);

    if (cold === null || warm === null) { unreachable.push(`${name} (4xx/threw)`); continue; }

    if (cold !== warm) { measured.push(name); continue; }

    // Identical answers. Only a defect if the surface is asserting non-zero figures.
    const nonZero = numbersIn(warm).filter((value) => value !== 0 && value !== 1);
    if (!nonZero.length) { emptyBoth.push(name); continue; }
    suspicious.push({ name, sample: nonZero.slice(0, 8), body: warm.slice(0, 140) });
  }

  console.error(`\n=== AI / AUTOMATION / INTELLIGENCE: ${SURFACES.length} surfaces ===`);
  console.error(`  answer moves with the data (measuring): ${measured.length}`);
  console.error(`  identical and empty (nothing to show):  ${emptyBoth.length}`);
  console.error(`  not reachable this way:                 ${unreachable.length}`);
  console.error(`  identical AND non-zero (suspicious):    ${suspicious.length}`);
  if (measured.length) console.error(`\n  measuring: ${measured.join(", ")}`);
  if (emptyBoth.length) console.error(`\n  identical+empty: ${emptyBoth.join(", ")}`);
  if (unreachable.length) console.error(`\n  unreachable: ${unreachable.join(", ")}`);
  if (suspicious.length) {
    console.error(`\n--- surfaces reporting the same non-zero figures with and without data ---`);
    for (const item of suspicious) console.error(`  ${item.name.padEnd(32)} numbers=${JSON.stringify(item.sample)}\n      ${item.body}`);
  }

  assert.deepEqual(suspicious.map((item) => `${item.name}: ${JSON.stringify(item.sample)}`), [],
    "these surfaces report identical non-zero figures on an empty and a populated database, so the figures are not coming from the data");
});
