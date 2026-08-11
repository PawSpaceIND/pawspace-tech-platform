import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const read = (p) => readFile(new URL(p, import.meta.url), "utf8");
const ops = await read("../lib/ops-intelligence-governance.ts");
const growth = await read("../lib/growth-intelligence-governance.ts");
const fin = await read("../lib/finance-intelligence-governance.ts");
const targeting = await read("../lib/customer-targeting-governance.ts");
const scheduler = await read("../lib/background-scheduler.ts");
const opsRoute = await read("../app/api/ops-intelligence/route.ts");
const growthRoute = await read("../app/api/growth-intelligence/route.ts");
const finRoute = await read("../app/api/finance-intelligence/route.ts");
const targetingRoute = await read("../app/api/customer-targeting/route.ts");

test("Ops intelligence: provider rank + demand forecast, advisory only", () => {
  assert.match(ops, /export async function rankProvidersForBooking/);
  assert.match(ops, /export async function forecastDemand/);
  assert.match(ops, /recommendationOnly: true/);
  assert.match(ops, /completionRate = terminal > 0 \? completed \/ terminal : 0\.5/);
  assert.match(ops, /day_of_week_seasonal_v1/);
  assert.match(opsRoute, /requirePermission\(actor,"scheduling\.view"\)/);
});

test("Growth intelligence: churn risk + next-best-action, advisory only", () => {
  assert.match(growth, /export async function listChurnRisk/);
  assert.match(growth, /export async function recommendNextService/);
  assert.match(growth, /suggestedAction: "winback_offer"/);
  assert.match(growth, /vaccination_due/);
  assert.match(growth, /birthday_offer/);
  assert.match(growth, /recommendationOnly: true/);
  assert.match(growthRoute, /requirePermission\(actor,"marketing\.view"\)/);
});

test("Finance intelligence: ledger anomalies + cash-flow forecast", () => {
  assert.match(fin, /export async function detectFinanceAnomalies/);
  assert.match(fin, /unbalanced_journal/);
  assert.match(fin, /duplicate_bill/);
  // leave-one-out so an outlier can't inflate its own baseline
  assert.match(fin, /const othersAvg = \(total - Number\(b\.total_amount\)\) \/ \(list\.length - 1\)/);
  assert.match(fin, /export async function forecastCashFlow/);
  assert.match(fin, /trailing_net_projection_v1/);
  assert.match(finRoute, /requirePermission\(actor,"finance\.view"\)/);
});

test("Customer targeting: refreshable top-N outbound audience with the requested signals", () => {
  assert.match(targeting, /export async function runCustomerTargetingSweep/);
  assert.match(targeting, /DEFAULT_TOP_N = 5000/);
  // the requested signals: frequency, order value, pets, service variety, tenure, young pet, recency
  assert.match(targeting, /frequency: 0\.25, orderValue: 0\.25, serviceVariety: 0\.15, petCount: 0\.10, tenure: 0\.10, youngPet: 0\.10, recency: 0\.05/);
  assert.match(targeting, /YOUNG_PET_MAX_DAYS = 365/);
  assert.match(targeting, /new_family_young_pet/);
  // throttled refresh + top-N retention
  assert.match(targeting, /REFRESH_THROTTLE_MS/);
  assert.match(targeting, /const kept = scored\.slice\(0, topN\)/);
  assert.match(targeting, /export async function listTargetCustomers/);
  assert.match(targetingRoute, /requirePermission\(actor,"marketing\.view"\)/);
  assert.match(targetingRoute, /requirePermission\(actor,"marketing\.manage"\)/);
  // targeting refresh is wired into the scheduler
  assert.match(scheduler, /runCustomerTargetingSweep\(db,\{asOf\}\)/);
  assert.match(scheduler, /"customerTargeting"/);
});
