import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// Test-only resolve hooks: "cloudflare:workers" resolves to a stub whose env.DB is the current
// per-test SQLite-backed D1 shim, so the REAL route and lib execute unmodified.
const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__UE_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
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

// The bind cap now comes from the shared harness (tests/helpers/d1-harness.mjs) so every suite
// models the same database. It exists because /api/unit-economics returned "D1_ERROR: too many SQL
// variables at offset 301" on staging while this suite stayed green: node:sqlite accepts thousands
// of bound parameters and D1 caps them near 100.
import { createD1 } from "./helpers/d1.mjs";
// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite) => createD1(sqlite);

let sqlite;
function freshDb() { sqlite = new DatabaseSync(":memory:"); globalThis.__UE_DB__ = makeD1(sqlite); }

const route = await import("../app/api/unit-economics/route.ts");
const { buildUnitEconomics } = await import("../lib/unit-economics.ts");

async function parseBody(response) {
  const text = await response.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}
const call = async (query) => {
  const response = await route.GET(new Request(`http://localhost/api/unit-economics${query ? `?${query}` : ""}`));
  return { status: response.status, body: await parseBody(response) };
};

const NOW = Date.now();
// Deterministic booking window: fixed dates well inside the query range.
const at = (day, hour) => new Date(Date.UTC(2026, 6, day, hour, 0, 0)).toISOString(); // July 2026
const FROM = "2026-07-01", TO = "2026-07-31";

// Exact DDL copied verbatim from the owning sources (never guessed): canonical_bookings from
// app/api/canonical-bookings/route.ts, coupon_redemptions from lib/coupon-governance.ts,
// paw_points_ledger from lib/paw-points-governance.ts, pawspace_wallet_ledger from
// lib/pawspace-wallet-governance.ts, provider_order_payouts from
// lib/provider-commission-governance.ts, booking_refund_cases from the grooming refund surface,
// service_reviews + customer_experience_tickets + scheduling tables from their owning surfaces.
function seedTables() {
  sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS coupon_redemptions (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,quote_id TEXT NOT NULL UNIQUE,campaign_id TEXT NOT NULL,code TEXT NOT NULL,customer_id TEXT NOT NULL,booking_id TEXT NOT NULL UNIQUE,discount_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'consumed',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS paw_points_ledger (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,entry_type TEXT NOT NULL,points INTEGER NOT NULL,reason TEXT,source_type TEXT,booking_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS pawspace_wallet_ledger (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,entry_type TEXT NOT NULL,amount REAL NOT NULL,bonus_amount REAL NOT NULL DEFAULT 0,applied_value REAL NOT NULL DEFAULT 0,source_type TEXT NOT NULL,source_id TEXT,idempotency_key TEXT NOT NULL UNIQUE,note TEXT,balance_after REAL NOT NULL,actor_id TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS provider_order_payouts (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',rail TEXT NOT NULL DEFAULT 'razorpayx',environment TEXT NOT NULL DEFAULT 'sandbox',status TEXT NOT NULL DEFAULT 'queued_sandbox',due_at INTEGER NOT NULL,razorpayx_contact_id TEXT,razorpayx_fund_account_id TEXT,provider_reference TEXT,idempotency_key TEXT NOT NULL UNIQUE,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS booking_refund_cases (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,payment_id TEXT,amount REAL NOT NULL DEFAULT 0,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'requested',requested_by TEXT NOT NULL,approved_by TEXT,gateway_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS service_reviews (id TEXT PRIMARY KEY,request_id TEXT NOT NULL UNIQUE,booking_id TEXT NOT NULL,customer_id TEXT NOT NULL,stars INTEGER NOT NULL,answers_json TEXT NOT NULL,created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY, customer_id TEXT, booking_id TEXT, lead_id TEXT, category TEXT NOT NULL, priority TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, sla_due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', escalation_level INTEGER NOT NULL DEFAULT 0, customer_status TEXT NOT NULL DEFAULT 'x', resolution TEXT, root_cause TEXT, resolution_evidence TEXT, reopened_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_reservations (id TEXT PRIMARY KEY,group_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,capacity_units INTEGER NOT NULL DEFAULT 1,occurrence_number INTEGER NOT NULL DEFAULT 1,care_mode TEXT,status TEXT NOT NULL DEFAULT 'assigned',explanation_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS scheduling_availability (id TEXT PRIMARY KEY,provider_id TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,date TEXT NOT NULL,windows_json TEXT NOT NULL,source TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS marketing_attribution_facts (id TEXT PRIMARY KEY,campaign_id TEXT NOT NULL,customer_id TEXT,lead_id TEXT,booking_id TEXT,collection_id TEXT,source TEXT NOT NULL,medium TEXT,spend_amount REAL,booked_revenue REAL,collected_revenue REAL,contribution_margin REAL,attribution_model TEXT,created_at INTEGER)");
}

function booking(id, { customer, service = "grooming", total, status = "confirmed", day = 10, provider = "prov_1" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Pkg',?,?,?,?,?,'customer_app',?,'INR','{}','uat',?,?)")
    .run(id, `k-${id}`, customer, service, `g-${id}`, provider, at(day, 10), at(day, 12), status, total, NOW, NOW);
}

function seedKnownAmounts() {
  // Grooming: B1 (cus_1) 1000 + B2 (cus_1) 2000 active, B3 (cus_2) 500 cancelled
  booking("B1", { customer: "cus_1", total: 1000, day: 5 });
  booking("B2", { customer: "cus_1", total: 2000, day: 12 });
  booking("B3", { customer: "cus_2", total: 500, status: "cancelled", day: 13 });
  // Boarding: B4 (cus_2) 4000 active
  booking("B4", { customer: "cus_2", service: "boarding", total: 4000, day: 15, provider: "prov_2" });
  // Discounts on grooming: coupon 100 (B1) + 100 PawPoints = Rs.50 (B1) + wallet applied 110 (B2)
  sqlite.prepare("INSERT INTO coupon_redemptions (id,idempotency_key,quote_id,campaign_id,code,customer_id,booking_id,discount_amount,status,created_at,updated_at) VALUES ('CR1','ik1','Q1','C1','CODE','cus_1','B1',100,'consumed',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO paw_points_ledger (id,customer_id,entry_type,points,booking_id,idempotency_key,created_by,created_at) VALUES ('PP1','cus_1','redeemed',-100,'B1','redeem:booking:B1','cus_1',?)").run(NOW);
  sqlite.prepare("INSERT INTO pawspace_wallet_ledger (id,customer_id,entry_type,amount,bonus_amount,applied_value,source_type,source_id,idempotency_key,balance_after,actor_id,created_at) VALUES ('WL1','cus_1','redeem',-100,10,110,'booking','B2','wallet-redeem:B2',0,'cus_1',?)").run(NOW);
  // Provider payouts: 600 on B1, 900 on B2 (grooming), 2400 on B4 (boarding)
  const payout = sqlite.prepare("INSERT INTO provider_order_payouts (id,booking_id,provider_id,amount,due_at,idempotency_key,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)");
  payout.run("PO1", "B1", "prov_1", 600, NOW, "po1", "uat", NOW, NOW);
  payout.run("PO2", "B2", "prov_1", 900, NOW, "po2", "uat", NOW, NOW);
  payout.run("PO3", "B4", "prov_2", 2400, NOW, "po3", "uat", NOW, NOW);
  // Refund processed 300 on B2; a merely REQUESTED refund on B4 must not count
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,amount,reason,status,requested_by,created_at,updated_at) VALUES ('RC1','B2',300,'partial service issue','processed','finance',?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO booking_refund_cases (id,booking_id,amount,reason,status,requested_by,created_at,updated_at) VALUES ('RC2','B4',4000,'pending request','requested','customer',?,?)").run(NOW, NOW);
  // Reviews: grooming 5★ (B1) and 2★ (B2); one CX ticket on B1
  sqlite.prepare("INSERT INTO service_reviews (id,request_id,booking_id,customer_id,stars,answers_json,created_at) VALUES ('RV1','RQ1','B1','cus_1',5,'{}',?)").run(NOW);
  sqlite.prepare("INSERT INTO service_reviews (id,request_id,booking_id,customer_id,stars,answers_json,created_at) VALUES ('RV2','RQ2','B2','cus_1',2,'{}',?)").run(NOW);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,status,created_by,created_at,updated_at) VALUES ('T1','cus_1','B1','complaint','high','Late arrival','d','o','m',?,'open','uat',?,?)").run(NOW, NOW, NOW);
}

// ---- 1. The money ladder is exact -----------------------------------------------------------------

test("real execution: per-service ladder derives exactly from seeded canonical amounts", async () => {
  freshDb(); seedTables(); seedKnownAmounts();
  const report = await buildUnitEconomics(globalThis.__UE_DB__, { from: FROM, to: TO });
  const grooming = report.services.grooming;
  assert.equal(grooming.gmv, 3000, "1000 + 2000; the cancelled 500 never counts");
  assert.equal(grooming.orders, 2);
  assert.equal(grooming.cancelled, 1);
  assert.equal(grooming.discounts, 260, "coupon 100 + 100 points x Rs.0.50 + wallet applied 110");
  assert.equal(grooming.providerPayout, 1500, "600 + 900");
  assert.equal(grooming.refunds, 300, "only the PROCESSED refund counts");
  assert.equal(grooming.contributionKnown, 940, "3000 - 260 - 1500 - 300");
  assert.equal(grooming.contributionPctOfGmv, 31.3);
  assert.equal(grooming.avgOrderValue, 1500);
  const boarding = report.services.boarding;
  assert.equal(boarding.gmv, 4000);
  assert.equal(boarding.providerPayout, 2400);
  assert.equal(boarding.refunds, 0, "a requested-but-unprocessed refund is not money out");
  assert.equal(boarding.contributionKnown, 1600);
  // Unconfigured cost lines stay explicit nulls, never zeroes that fake profitability
  assert.equal(grooming.tax, null);
  assert.equal(grooming.paymentFee, null);
  assert.equal(grooming.variableCost, null);
  assert.match(report.dataCoverage.tax, /configuration_required/);
  assert.equal(report.truth.syntheticNumbers, false);
  // Company rollup
  assert.equal(report.company.gmv, 7000);
  assert.equal(report.company.contributionKnown, 940 + 1600);
  assert.equal(report.company.cancellationRatePct, 25, "1 of 4 bookings");
});

// ---- 2. Monitors ----------------------------------------------------------------------------------

test("real execution: repeat rate, CSAT, complaints/100, revenue per provider-day and LTV are exact", async () => {
  freshDb(); seedTables(); seedKnownAmounts();
  const report = await buildUnitEconomics(globalThis.__UE_DB__, { from: FROM, to: TO });
  const grooming = report.services.grooming;
  assert.equal(grooming.repeatRatePct, 100, "cus_1 booked grooming twice; cus_2's only grooming booking was cancelled");
  assert.equal(grooming.csatAvgStars, 3.5, "(5 + 2) / 2");
  assert.equal(grooming.csatPct, 50, "one of two reviews is >=4 stars");
  assert.equal(grooming.complaintsPer100, 50, "1 ticket across 2 orders");
  assert.equal(grooming.revenuePerProviderDay, 1500, "3000 over 2 distinct provider-days");
  const boarding = report.services.boarding;
  assert.equal(boarding.repeatRatePct, 0);
  assert.equal(boarding.csatAvgStars, null, "no reviews -> null, not a made-up score");
  assert.equal(report.company.activeCustomers, 2);
  assert.equal(report.company.ltvPerActiveCustomer, 3500, "(cus_1 3000 + cus_2 4000) / 2 across all time");
});

test("real execution: roster utilisation and CAC derive only from real rows", async () => {
  freshDb(); seedTables(); seedKnownAmounts();
  const db = globalThis.__UE_DB__;
  // 8 rostered hours on one day, 2 booked reservation hours -> 25%
  sqlite.prepare("INSERT INTO scheduling_availability (id,provider_id,city_id,zone_id,date,windows_json,source,updated_at) VALUES ('AV1','prov_1','blr','blr-east','2026-07-05','[\"09:00-17:00\"]','uat',?)").run(NOW);
  sqlite.prepare("INSERT INTO scheduling_reservations (id,group_id,provider_id,service_code,city_id,zone_id,customer_id,pet_ids_json,scheduled_start,scheduled_end,occurrence_number,status,created_at) VALUES ('R1','g-B1','prov_1','grooming','blr','blr-east','cus_1','[]',?,?,1,'assigned',?)").run(at(5, 10), at(5, 12), NOW);
  let report = await buildUnitEconomics(db, { from: FROM, to: TO });
  assert.equal(report.company.utilisationPct, 25, "2 booked hours of 8 rostered");
  // No spend rows -> CAC is configuration_required, never invented
  assert.equal(report.company.cac.status, "configuration_required");
  assert.equal(report.company.cac.cacPerNewCustomer, null);
  // Recorded spend -> CAC = spend / customers whose FIRST booking is in the window
  sqlite.prepare("INSERT INTO marketing_attribution_facts (id,campaign_id,source,spend_amount,created_at) VALUES ('MF1','CAMP1','meta',3000,?)").run(NOW);
  report = await buildUnitEconomics(db, { from: FROM, to: TO });
  assert.equal(report.company.cac.status, "derived_from_recorded_spend");
  assert.equal(report.company.cac.spend, 3000);
  assert.equal(report.company.cac.newCustomers, 2, "both customers' first active booking falls in July");
  assert.equal(report.company.cac.cacPerNewCustomer, 1500);
});

// ---- 3. Filters, cold DB, route -------------------------------------------------------------------

test("real execution: the date window filters the ladder and a cold database reports empty, not crash", async () => {
  freshDb(); seedTables(); seedKnownAmounts();
  const db = globalThis.__UE_DB__;
  const narrow = await buildUnitEconomics(db, { from: "2026-07-01", to: "2026-07-06" });
  assert.equal(narrow.services.grooming.gmv, 1000, "only B1 (July 5) is in the narrow window");
  assert.equal(narrow.services.boarding, undefined);
  freshDb();
  const cold = await buildUnitEconomics(globalThis.__UE_DB__, {});
  assert.deepEqual(cold.services, {});
  assert.equal(cold.company.gmv, 0);
});

test("real execution: the route serves the report under reports.view and validates dates", async () => {
  freshDb(); seedTables(); seedKnownAmounts();
  const res = await call(`from=${FROM}&to=${TO}`);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.services.grooming.contributionKnown, 940);
  assert.equal(res.body.data.company.gmv, 7000);
  const bad = await call("from=07-01-2026");
  assert.equal(bad.status, 400);
});

// ---- 4. Contracts ---------------------------------------------------------------------------------

test("contract: gateway permission line, DB access rule, and the finance surface exist", () => {
  const gateway = fs.readFileSync(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(gateway, /unit-economics"\)return "reports\.view"/);
  const source = fs.readFileSync(new URL("../app/api/unit-economics/route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /globalThis/, "the route must get the DB via cloudflare:workers env, never globalThis");
  const page = fs.readFileSync(new URL("../app/team/finance/unit-economics/page.tsx", import.meta.url), "utf8");
  assert.match(page, /\/api\/unit-economics/);
  const lib = fs.readFileSync(new URL("../lib/unit-economics.ts", import.meta.url), "utf8");
  assert.match(lib, /configuration_required/, "unconfigured cost lines must stay explicit, never silently zero");
});

test("a month with more bookings than D1's bind limit still reports, instead of erroring", async () => {
  // The per-booking money lookups used to build one "?" per booking in the window. With no date
  // filter that is every booking ever, so the statement width grew without bound and D1 rejected it:
  // "D1_ERROR: too many SQL variables at offset 301". It passed every test because tests used a
  // handful of rows. 250 bookings is comfortably past the 100-parameter cap.
  freshDb();
  seedTables();
  const COUNT = 250;
  for (let index = 0; index < COUNT; index += 1) {
    booking(`BULK-${index}`, { customer: `cus_bulk_${index % 40}`, total: 1000, day: 10 });
  }
  // One real discount, so the chunked lookup is proven to still find its rows rather than silently
  // returning nothing once it is split into batches.
  sqlite.prepare("INSERT INTO coupon_redemptions (id,idempotency_key,quote_id,campaign_id,code,customer_id,booking_id,discount_amount,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'consumed',?,?)")
    .run("CR-1", "ik-CR-1", "q-CR-1", "camp", "SAVE", "cus_bulk_0", `BULK-${COUNT - 1}`, 300, NOW, NOW);

  const result = await buildUnitEconomics(globalThis.__UE_DB__, { from: FROM, to: TO });
  assert.equal(result.services.grooming.orders, COUNT, "every booking in the window is counted");
  assert.equal(result.services.grooming.gmv, COUNT * 1000);
  assert.equal(result.services.grooming.discounts, 300, "a discount on the LAST booking is still found after chunking");
});
