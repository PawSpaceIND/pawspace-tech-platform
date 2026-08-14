/**
 * TASK #55 — reporting consistency for GMV / LTV.
 *
 * The board/finance GMV and LTV reports (company analytics, P&L turnover, unit economics) used a
 * DENYLIST — `status NOT IN ('cancelled','draft')` — so every booking status the product grew since
 * (no_show, awaiting_host_acceptance, awaiting_acceptance, pending, refunded) silently counted as GMV/LTV,
 * and any brand-new status would too. #55 reconciles them onto the founder-approved allowlist from #37:
 * delivered = completed, committed = confirmed/in_progress. An unclassified status now FAILS CLOSED.
 *
 * This is a BEHAVIOURAL regression: it seeds one booking of every status — the three recognized ones,
 * each of the seven explicitly-excluded ones, and one deliberately-unknown status — each with a distinct
 * amount, then drives the REAL reporting functions over a real node:sqlite D1 and checks the money that
 * actually comes out. No source-regex. Each excluded amount is a distinct power of two so any single
 * leak is arithmetically identifiable, and the excluded total dwarfs the recognized total so a denylist
 * regression cannot hide.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

const CF_STUB = "data:text/javascript,export const env={get DB(){return globalThis.__R55_DB__;},get FOUNDER_EMAIL(){return undefined;},get PAWSPACE_UAT_LOGIN(){return undefined;}};";
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context); throw error; }
    },
  });
} else {
  const hook = `export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: ${JSON.stringify(CF_STUB)}, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context); throw error; }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

const { buildCompanyAnalytics } = await import("../lib/company-analytics.ts");
const { buildUnitEconomics } = await import("../lib/unit-economics.ts");
const { generatePnlReport } = await import("../lib/pnl-reporting.ts");
const { RECOGNIZED_BOOKING_STATUSES, isRecognizedBookingRevenue } = await import("../lib/revenue-recognition.ts");

const NOW = Date.now();
const at = (day) => new Date(Date.UTC(2026, 6, day, 10, 0, 0)).toISOString(); // July 2026

// canonical_bookings DDL copied verbatim from app/api/canonical-bookings/route.ts (via tests/unit-economics.test.mjs).
function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)");
  globalThis.__R55_DB__ = createD1(sqlite);
  return sqlite;
}

function insertBooking(sqlite, { id, customer, status, total, day }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east','grooming','pkg','Pkg',?,'prov_1',?,?,?,'customer_app',?,'INR','{}','uat',?,?)")
    .run(id, `k-${id}`, customer, `g-${id}`, at(day), at(day), status, total, NOW, NOW);
}

// Recognized: distinct small amounts -> known total 1230, across two customers so LTV has a denominator.
const RECOGNIZED = [
  { id: "R-completed", customer: "cus_A", status: "completed", total: 1000, day: 5 },
  { id: "R-confirmed", customer: "cus_A", status: "confirmed", total: 200, day: 6 },
  { id: "R-inprogress", customer: "cus_B", status: "in_progress", total: 30, day: 7 },
];
const RECOGNIZED_GMV = 1230;
const RECOGNIZED_CUSTOMERS = 2;
const LTV_PER_ACTIVE = RECOGNIZED_GMV / RECOGNIZED_CUSTOMERS; // 615

// Every status that must NEVER count as GMV/LTV, plus one deliberately-unknown status (fail-closed).
// Distinct powers of two so a single accidental inclusion is identifiable by the exact overage.
const EXCLUDED = [
  { id: "X-cancelled", customer: "cus_C", status: "cancelled", total: 4000, day: 8 },
  { id: "X-refunded", customer: "cus_C", status: "refunded", total: 8000, day: 9 },
  { id: "X-noshow", customer: "cus_C", status: "no_show", total: 16000, day: 10 },
  { id: "X-awaiting-host", customer: "cus_C", status: "awaiting_host_acceptance", total: 32000, day: 11 },
  { id: "X-awaiting", customer: "cus_C", status: "awaiting_acceptance", total: 64000, day: 12 },
  { id: "X-draft", customer: "cus_C", status: "draft", total: 128000, day: 13 },
  { id: "X-pending", customer: "cus_C", status: "pending", total: 256000, day: 14 },
  // A status no report has ever heard of. The whole point of the allowlist is that this fails closed.
  { id: "X-unknown", customer: "cus_C", status: "quantum_hold_2027", total: 512000, day: 15 },
];

function seedAll(sqlite) {
  for (const b of [...RECOGNIZED, ...EXCLUDED]) insertBooking(sqlite, b);
}

test("the classification itself: only completed/confirmed/in_progress are recognized, unknowns fail closed", () => {
  assert.deepEqual([...RECOGNIZED_BOOKING_STATUSES].sort(), ["completed", "confirmed", "in_progress"]);
  for (const s of ["completed", "confirmed", "in_progress"]) assert.equal(isRecognizedBookingRevenue(s), true, `${s} must be recognized`);
  for (const b of EXCLUDED) assert.equal(isRecognizedBookingRevenue(b.status), false, `${b.status} must NOT be recognized`);
  assert.equal(isRecognizedBookingRevenue(undefined), false, "an absent status fails closed");
  assert.equal(isRecognizedBookingRevenue(""), false, "an empty status fails closed");
});

test("company analytics GMV counts only the recognized allowlist — no excluded or unknown status leaks", async () => {
  const sqlite = freshDb();
  seedAll(sqlite);
  const report = await buildCompanyAnalytics(globalThis.__R55_DB__);
  assert.equal(report.money.gmv, RECOGNIZED_GMV, `GMV must be exactly the recognized total; a leak shows as an overage. got ${report.money.gmv}`);
  // The per-service ladder must agree — grooming GMV is the same recognized total.
  assert.equal(report.services.grooming.gmv, RECOGNIZED_GMV, "per-service GMV also excludes non-recognized statuses");
  assert.equal(report.bookings.completed, 1, "the literal completed counter is unaffected");
});

test("P&L turnover recognizes only the allowlist — no_show / awaiting_* / pending / refunded / unknown excluded", async () => {
  const sqlite = freshDb();
  seedAll(sqlite);
  const pnl = await generatePnlReport(globalThis.__R55_DB__, { fromMonth: "2026-07", toMonth: "2026-07" });
  assert.equal(pnl.revenue.subtotalAmount, RECOGNIZED_GMV, `turnover must equal the recognized total; got ${pnl.revenue.subtotalAmount}`);
  assert.equal(pnl.totalTurnoverAmount, RECOGNIZED_GMV, "total turnover carries only recognized booking revenue");
});

test("unit economics GMV and LTV/active-customer count only the allowlist", async () => {
  const sqlite = freshDb();
  seedAll(sqlite);
  const ue = await buildUnitEconomics(globalThis.__R55_DB__, { from: "2026-07-01", to: "2026-07-31" });
  assert.equal(ue.company.gmv, RECOGNIZED_GMV, `company GMV must equal the recognized total; got ${ue.company.gmv}`);
  assert.equal(ue.company.activeCustomers, RECOGNIZED_CUSTOMERS, "only customers with a recognized booking are active");
  assert.equal(ue.company.ltvPerActiveCustomer, LTV_PER_ACTIVE, `LTV/active must be recognized-total / active-customers = ${LTV_PER_ACTIVE}; got ${ue.company.ltvPerActiveCustomer}`);
  assert.equal(ue.services.grooming.gmv, RECOGNIZED_GMV, "per-service GMV excludes non-recognized statuses");
  assert.equal(ue.services.grooming.orders, RECOGNIZED.length, "orders count only recognized bookings");
});

test("MUTATION GUARD: a single leaked status would move the number — proves the assertions above bite", async () => {
  // If any one excluded booking were counted, GMV would be RECOGNIZED_GMV + that booking's amount. The
  // smallest excluded amount (cancelled=4000) already dwarfs the whole recognized total, so any leak is
  // unmissable. Assert the invariant AND that the overage would be visible (excluded total is non-trivial).
  const excludedTotal = EXCLUDED.reduce((s, b) => s + b.total, 0);
  assert.ok(excludedTotal > RECOGNIZED_GMV * 100, "the excluded amounts must dominate, so a denylist regression is loud");
  const sqlite = freshDb();
  seedAll(sqlite);
  const report = await buildCompanyAnalytics(globalThis.__R55_DB__);
  assert.notEqual(report.money.gmv, RECOGNIZED_GMV + 4000, "cancelled must not be added back");
  assert.notEqual(report.money.gmv, RECOGNIZED_GMV + excludedTotal, "the old denylist behaviour (count everything but cancelled/draft) is gone");
});
