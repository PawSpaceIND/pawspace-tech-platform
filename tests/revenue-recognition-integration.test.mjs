import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const integration = await readFile(new URL("../lib/revenue-recognition-integration.ts", import.meta.url), "utf8");
const scheduler = await readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8");

test("Revenue recognition is wired into the live booking lifecycle via a cold-DB-safe sweep", () => {
  assert.match(integration, /export async function runRevenueRecognitionSweep/);
  // subscriptions: collection uses payment time; consumption uses each actual usage completion time.
  assert.match(integration, /p\.updated_at paid_at/);
  assert.match(integration, /booking_subscription_usage WHERE plan_code=\? AND status='consumed'/);
  assert.match(integration, /usageAt=new Date\(Number\(usage\.updated_at/);
  assert.match(integration, /recognizeSubscriptionUsage\(db,\{sourceId:String\(s\.id\),sessionsConsumed:cumulative,at:usageAt/);
  // advance bookings: prepaid+captured, excluding subscription purchase + subscription-credit redemptions
  assert.match(integration, /p\.mode='prepaid' AND p\.status='captured'/);
  assert.match(integration, /b\.id NOT IN \(SELECT source_booking_id FROM customer_grooming_subscriptions\)/);
  assert.match(integration, /b\.id NOT IN \(SELECT booking_id FROM booking_subscription_usage\)/);
  // advance cash is dated to capture, revenue only to actual canonical completion/update time.
  assert.match(integration, /collectedAt=new Date\(Number\(b\.paid_at/);
  assert.match(integration, /if \(String\(b\.status\) === "completed"\)/);
  assert.match(integration, /completedAt=new Date\(Number\(b\.updated_at/);
  assert.match(integration, /recognizeAdvanceBooking/);
  // cold-DB safe: every read tolerates missing tables
  assert.match(integration, /\.catch\(empty\)/);
  // wired into the background scheduler
  assert.match(scheduler, /runRevenueRecognitionSweep\(db,\{asOf\}\)/);
  assert.match(scheduler, /"revenueRecognition"/);
});
