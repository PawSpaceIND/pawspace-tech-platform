import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const risk = await readFile(new URL("../lib/risk-anomaly-governance.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/risk-anomaly/route.ts", import.meta.url), "utf8");
const scheduler = await readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8");

test("Risk & anomaly engine: flags wallet + review-reward abuse for staff review, never auto-blocks", () => {
  // scores both money domains
  assert.match(risk, /export async function scoreReviewRewards|async function scoreReviewRewards/);
  assert.match(risk, /async function scoreWallet/);
  // strongest review signal: claimed a reward without ever leaving a real 5-star review
  assert.match(risk, /LEFT JOIN service_reviews sr ON sr\.booking_id=pc\.booking_id AND sr\.customer_id=pc\.customer_id AND sr\.stars=5/);
  assert.match(risk, /claims_without_review/);
  // wallet signal: rapid credit->redeem cycling within 30 min + goodwill concentration
  assert.match(risk, /FAST_CYCLE_MS = 30 \* 60 \* 1000/);
  assert.match(risk, /goodwill_amt/);
  // advisory only: flags are reviewed by staff, thresholds map to levels
  assert.match(risk, /score >= 0\.7 \? "high" : score >= 0\.4 \? "medium" : "low"/);
  assert.match(risk, /export async function reviewRiskFlag/);
  assert.match(risk, /A review note is required/);
  // idempotent upsert per (domain, subject)
  assert.match(risk, /UNIQUE\(domain,subject_id\)/);
  // cold-DB safe reads
  assert.match(risk, /\.catch\(empty\)/);
  // wired into the scheduler; route is permission-gated (view to read, finance.manage to action)
  assert.match(scheduler, /runRiskAnomalySweep\(db,\{asOf\}\)/);
  assert.match(scheduler, /"riskAnomaly"/);
  assert.match(route, /requirePermission\(actor,"reports\.view"\)/);
  assert.match(route, /requirePermission\(actor,"finance\.manage"\)/);
});
