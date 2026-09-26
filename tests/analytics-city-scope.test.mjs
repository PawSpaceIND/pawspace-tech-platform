/**
 * VisualAnalytics now sits on the Team home, Finance, People reports, Daily revenue and Control, and every one of
 * them reads /api/company-analytics with reports.view. A city-scoped operations manager could read the whole
 * company's GMV and collections there, while the booking drill-down beside it already enforced their city.
 * The aggregate now takes the same scope: a manager sees their city, an unscoped role sees every city.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__CITY_SCOPE_DB__", "__CITY_SCOPE_ENV__");

function makeD1(sqlite, { failOn } = {}) {
  function statement(sql, args) {
    const guard = () => {
      if (failOn && failOn.test(sql)) throw new Error("D1_ERROR: too many SQL variables at offset 0: SQLITE_ERROR");
    };
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { guard(); const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { guard(); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => { guard(); return { results: sqlite.prepare(sql).all(...args) }; },
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => { const out = []; for (const item of statements) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

// Verbatim from drizzle/0011_serious_shaman.sql and scripts/staging-seed.sql.
const BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id text PRIMARY KEY NOT NULL, idempotency_key text NOT NULL, customer_id text NOT NULL, pet_ids_json text NOT NULL, source_pet_ids_json text NOT NULL, city_id text NOT NULL, zone_id text NOT NULL, service_code text NOT NULL, package_code text NOT NULL, package_name text NOT NULL, schedule_group_id text NOT NULL, provider_id text NOT NULL, scheduled_start text NOT NULL, scheduled_end text NOT NULL, status text DEFAULT 'confirmed' NOT NULL, channel text DEFAULT 'customer_app' NOT NULL, total_amount real NOT NULL, currency text DEFAULT 'INR' NOT NULL, pricing_json text DEFAULT '{}' NOT NULL, created_by text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)";
const PAYMENTS = "CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(BOOKINGS);
  sqlite.exec(PAYMENTS);
  const now = Date.now();
  const rows = [["blr", 1000], ["blr", 1000], ["blr", 1000], ["hyd", 700]];
  rows.forEach(([city, amount], index) => {
    const id = `BK-${city}-${index}`;
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]',?,'zone-1','grooming','pkg','Full groom',?,'PRV-1','2026-07-01T09:00:00.000Z','2026-07-01T10:00:00.000Z','completed','customer_app',?,'INR','{}','seed',?,?)")
      .run(id, `${id}-idem`, `CUS${index}`, city, `SG-${id}`, amount, now, now);
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','card','prepaid','captured','uat_sandbox',?,'{}',?,?)")
      .run(`PAY-${id}`, id, `CUS${index}`, amount, amount, `pidem-${id}`, now, now);
  });
  globalThis.__CITY_SCOPE_DB__ = makeD1(sqlite);
  globalThis.__CITY_SCOPE_ENV__ = {};
  return globalThis.__CITY_SCOPE_DB__;
}

test("a scoped city sees only its own bookings and money; no scope sees every city", async () => {
  const db = seed();
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const company = await buildCompanyAnalytics(db, { from: "2026-07-01", to: "2026-07-31" });
  assert.equal(company.bookings.total, 4);
  assert.equal(company.money.gmv, 3700);
  const hyderabad = await buildCompanyAnalytics(db, { from: "2026-07-01", to: "2026-07-31", cityId: "HYD" });
  assert.equal(hyderabad.bookings.total, 1, "a Hyderabad manager does not see Bengaluru bookings");
  assert.equal(hyderabad.money.gmv, 700, "nor Bengaluru revenue");
  assert.equal(hyderabad.filters.cityId, "HYD", "the report says which city it covers");
});

test("the analytics route resolves the caller's manager scope and passes its city", async () => {
  const route = await readFile(new URL("../app/api/company-analytics/route.ts", import.meta.url), "utf8");
  assert.match(route, /const scope=await resolveManagerOrganizationalScope\(db,actor\)/);
  assert.match(route, /buildCompanyAnalytics\(db,\{cityId:scope\?\.cityId,/);
});
