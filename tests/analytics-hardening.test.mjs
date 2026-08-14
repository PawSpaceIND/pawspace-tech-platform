import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// Task 17 audit — reports & analytics. Real execution over real SQLite with
// exact seeded values: every number the dashboards show must be derivable by
// hand from the seeds, and the different report modules must agree with each
// other for identical data (company-analytics GMV === P&L turnover).
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite) => createD1(sqlite);

function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE customer_experience_tickets (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,booking_id TEXT,lead_id TEXT,category TEXT NOT NULL,priority TEXT NOT NULL,subject TEXT NOT NULL,detail TEXT NOT NULL,owner TEXT NOT NULL,manager TEXT NOT NULL,sla_due_at INTEGER NOT NULL,status TEXT NOT NULL,escalation_level INTEGER NOT NULL DEFAULT 0,customer_status TEXT NOT NULL,resolution TEXT,resolution_evidence TEXT,root_cause TEXT,reopened_count INTEGER NOT NULL DEFAULT 0,resolved_at INTEGER,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE provider_capacity_profiles (id TEXT PRIMARY KEY,city_id TEXT NOT NULL,name TEXT NOT NULL,provider_model TEXT NOT NULL,services_json TEXT NOT NULL,zones_json TEXT NOT NULL,live INTEGER NOT NULL DEFAULT 1,rating REAL NOT NULL DEFAULT 0,quality_score REAL NOT NULL DEFAULT 0,capacity INTEGER NOT NULL DEFAULT 1,travel_buffer_minutes INTEGER NOT NULL DEFAULT 30,max_daily_jobs INTEGER NOT NULL DEFAULT 6,acceptance_timeout_minutes INTEGER NOT NULL DEFAULT 3,status TEXT NOT NULL DEFAULT 'active',version INTEGER NOT NULL DEFAULT 1,effective_from TEXT NOT NULL,effective_to TEXT,updated_by TEXT NOT NULL,updated_at INTEGER NOT NULL)");
  return { sqlite, db };
}

const NOW = 1770000000000;
function seedBooking(sqlite, id, service, status, amount, start) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `ik-${id}`, `CUS-${id}`, "[]", "[]", "blr", "blr-east", service, "pkg", "Package", `grp-${id}`, "PROV-1", start, start, status, "customer_app", amount, "INR", "{}", "test", NOW, NOW);
}
function seedPayment(sqlite, bookingId, amount, status) {
  sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(`PAY-${bookingId}`, bookingId, `CUS-${bookingId}`, amount, amount, "INR", "upi", "prepaid", status, "uat_sandbox", `ik-pay-${bookingId}`, "{}", NOW, NOW);
}

// The exact-seed universe used by both the analytics test and the P&L
// reconciliation test. All bookings are in July 2026.
function seedJulyUniverse(sqlite) {
  seedBooking(sqlite, "B1", "boarding", "completed", 5000, "2026-07-03T09:00:00.000Z");
  seedBooking(sqlite, "B2", "pet_sitting", "completed", 3000, "2026-07-10T09:00:00.000Z");
  seedBooking(sqlite, "B3", "boarding", "cancelled", 2000, "2026-07-15T09:00:00.000Z");
  seedBooking(sqlite, "B4", "dog_walking", "confirmed", 1000, "2026-07-20T09:00:00.000Z");
  seedBooking(sqlite, "B5", "boarding", "draft", 800, "2026-07-25T09:00:00.000Z");
  seedPayment(sqlite, "B1", 5000, "captured");
  seedPayment(sqlite, "B2", 1500, "captured"); // partial collection
  seedPayment(sqlite, "B3", 2000, "refunded"); // refunded money must not count as collected
  seedPayment(sqlite, "B4", 1000, "initiated"); // not yet captured
  // B5 (draft) deliberately has no payment row -> dataQuality.paymentsMissing
}

// ---------------------------------------------------------------------------
// 1. Company analytics: exact seeded values. GMV must recognize the same
//    bookings as the P&L (no cancelled, no draft) while cancellation counts
//    and rates still report the cancelled booking. This was the Task-17
//    defect: cancelled + draft total_amount was silently included in GMV.
// ---------------------------------------------------------------------------
test("company analytics: GMV excludes cancelled+draft, collected counts only captured money", async () => {
  const { sqlite, db } = fresh();
  seedJulyUniverse(sqlite);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,status,customer_status,reopened_count,resolved_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-1", "CUS-B1", "B1", "Service quality", "high", "Late host", "Host late", "CX", "Mgr", NOW, "resolved", "resolved", 1, NOW + 60000, "test", NOW, NOW + 60000);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,status,customer_status,reopened_count,resolved_at,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("TKT-2", "CUS-B2", "B2", "Billing", "medium", "Refund query", "Question", "CX", "Mgr", NOW, "open", "open", 0, null, "test", NOW, NOW);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,status,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("PROV-1", "blr", "Active Host", "home_boarder", "[]", "[]", 1, 4.5, 4.2, "active", "2026-01-01", "test", NOW);
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,status,effective_from,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("PROV-2", "blr", "Pending Host", "home_boarder", "[]", "[]", 0, 0, 0, "pending_verification", "2026-01-01", "test", NOW);

  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const data = await buildCompanyAnalytics(globalThis.__PAWSPACE_TEST_ENV.DB, { from: "2026-07-01", to: "2026-08-01" });

  // GMV: 5000 (completed) + 3000 (completed) + 1000 (confirmed) = 9000.
  // NOT 11800 — the cancelled 2000 and draft 800 must be excluded, matching P&L recognition.
  assert.equal(data.money.gmv, 9000);
  // Collected: 5000 + 1500 captured. Refunded 2000 and initiated 1000 do not count.
  assert.equal(data.money.collected, 6500);
  assert.equal(data.bookings.total, 5);
  assert.equal(data.bookings.completed, 2);
  assert.equal(data.bookings.cancelled, 1); // cancellation still visibly reported
  assert.equal(data.bookings.completionRate, 2 / 5);
  assert.equal(data.bookings.cancellationRate, 1 / 5);

  // Per-service: boarding has 3 bookings (completed+cancelled+draft) but GMV only 5000.
  assert.equal(data.services.boarding.bookings, 3);
  assert.equal(data.services.boarding.cancelled, 1);
  assert.equal(data.services.boarding.gmv, 5000);
  assert.equal(data.services.boarding.collected, 5000);
  assert.equal(data.services.pet_sitting.gmv, 3000);
  assert.equal(data.services.pet_sitting.collected, 1500);
  assert.equal(data.services.dog_walking.gmv, 1000);
  assert.equal(data.services.dog_walking.collected, 0);

  // Cost honesty: boarding is cost-tracked but no settlement ledger exists here,
  // so cost/margin must be null (unknown), never fabricated.
  assert.equal(data.services.boarding.costTracked, true);
  assert.equal(data.services.boarding.costAmount, null);
  assert.equal(data.services.boarding.marginAmount, null);

  // CX from real rows: 2 tickets, 1 open, 1 reopen, exact 60s average resolution.
  assert.equal(data.cx.tickets, 2);
  assert.equal(data.cx.open, 1);
  assert.equal(data.cx.reopened, 1);
  assert.equal(data.cx.averageResolutionMs, 60000);

  // Providers: 2 profiles, only the live+active one counts as active.
  assert.equal(data.providers.profiles, 2);
  assert.equal(data.providers.active, 1);

  // Data quality: B5 has no payment row.
  assert.equal(data.dataQuality.paymentsMissing, 1);
});

test("company analytics: period + service filters bound the aggregates", async () => {
  const { sqlite } = fresh();
  seedJulyUniverse(sqlite);
  seedBooking(sqlite, "B6", "boarding", "completed", 7777, "2026-06-15T09:00:00.000Z"); // outside period
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const july = await buildCompanyAnalytics(globalThis.__PAWSPACE_TEST_ENV.DB, { from: "2026-07-01", to: "2026-08-01" });
  assert.equal(july.money.gmv, 9000, "June booking must not leak into July");
  const boardingOnly = await buildCompanyAnalytics(globalThis.__PAWSPACE_TEST_ENV.DB, { from: "2026-07-01", to: "2026-08-01", serviceCode: "boarding" });
  assert.equal(boardingOnly.money.gmv, 5000);
  assert.equal(boardingOnly.bookings.total, 3);
});

// ---------------------------------------------------------------------------
// 2. Cross-report reconciliation: for identical seeds and the same period,
//    the company-analytics GMV and the P&L total turnover are the same
//    number. Before the Task-17 fix these disagreed by exactly the
//    cancelled+draft amounts (2800 here).
// ---------------------------------------------------------------------------
test("reconciliation: company-analytics GMV === P&L total turnover for identical seeds", async () => {
  const { sqlite } = fresh();
  seedJulyUniverse(sqlite);
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const { generatePnlReport } = await import("../lib/pnl-reporting.ts");
  const db = globalThis.__PAWSPACE_TEST_ENV.DB;
  const analytics = await buildCompanyAnalytics(db, { from: "2026-07-01", to: "2026-08-01" });
  const pnl = await generatePnlReport(db, { fromMonth: "2026-07", toMonth: "2026-07" });
  assert.equal(pnl.totalTurnoverAmount, 9000, "P&L recognizes non-cancelled, non-draft revenue only");
  assert.equal(analytics.money.gmv, pnl.totalTurnoverAmount, "dashboard GMV and P&L turnover must be the same number for the same period");
});

// ---------------------------------------------------------------------------
// 3. Fabrication sweep: no report/analytics module may synthesize numbers.
// ---------------------------------------------------------------------------
test("no Math.random or fabricated metrics in report/analytics modules", () => {
  const modules = [
    "lib/company-analytics.ts", "lib/pnl-reporting.ts", "lib/ai-analytics.ts",
    "lib/people-reports.ts", "lib/manager-dashboard.ts", "lib/cash-flow-statement.ts",
    "lib/growth-intelligence-governance.ts", "lib/ops-intelligence-governance.ts",
    "lib/finance-intelligence-governance.ts", "lib/app-to-revenue-funnel.ts",
    "lib/revenue-mission-command-center.ts", "lib/grooming-cost-attribution.ts",
  ];
  for (const path of modules) {
    const source = read(path);
    assert.ok(!/Math\.random/.test(source), `${path} must not fabricate values with Math.random`);
    assert.ok(!/globalThis\.__D1__/.test(source), `${path} must not use the banned globalThis D1 pattern`);
  }
});

// ---------------------------------------------------------------------------
// 4. Gateway contract: report routes stay behind reports permissions.
// ---------------------------------------------------------------------------
test("report routes stay behind gateway permissions", () => {
  const companyRoute = read("app/api/company-analytics/route.ts");
  assert.ok(/authorize\(request,\s*"reports\.view"\)/.test(companyRoute), "company-analytics requires reports.view");
  // P&L is enforced centrally by the worker gateway (worker/index.ts -> authorizeApiRequest):
  // the mapping below is the actual production control, so pin it.
  const gateway = read("lib/api-gateway.ts");
  assert.ok(/url\.pathname==="\/api\/pnl-reporting"\)return "finance\.view"/.test(gateway), "gateway maps /api/pnl-reporting to finance.view");
  assert.ok(/url\.pathname==="\/api\/company-analytics"\)return "reports\.view"/.test(gateway), "gateway maps /api/company-analytics to reports.view");
  assert.ok(/authorizeApiRequest/.test(read("worker/index.ts")), "worker entry enforces the gateway");
});

// ---------------------------------------------------------------------------
// 5. Source-status honesty: unconnected sources must say so, not report 0.
// ---------------------------------------------------------------------------
test("company analytics declares unconnected sources honestly", async () => {
  const { sqlite } = fresh();
  seedJulyUniverse(sqlite);
  const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
  const data = await buildCompanyAnalytics(globalThis.__PAWSPACE_TEST_ENV.DB, { from: "2026-07-01", to: "2026-08-01" });
  assert.equal(data.sourceStatus.marketingSpend, "not_connected");
  assert.equal(data.money.refundsStatus, "service_finance_sources_required");
});
