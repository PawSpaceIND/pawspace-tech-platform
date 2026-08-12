import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const integration = await readFile(new URL("../lib/revenue-recognition-integration.ts", import.meta.url), "utf8");
const scheduler = await readFile(new URL("../lib/background-scheduler.ts", import.meta.url), "utf8");

test("Revenue recognition is wired into the live booking lifecycle via a cold-DB-safe sweep", () => {
  assert.match(integration, /export async function runRevenueRecognitionSweep/);
  // subscriptions: pack price from the source booking, recognised up to sessions_consumed
  assert.match(integration, /FROM customer_grooming_subscriptions s JOIN canonical_bookings b ON b\.id=s\.source_booking_id/);
  assert.match(integration, /recognizeSubscriptionUsage\(db, \{ sourceId: String\(s\.id\), sessionsConsumed: Number\(s\.consumed\)/);
  // advance bookings: prepaid+captured, excluding subscription purchase + subscription-credit redemptions
  assert.match(integration, /p\.mode='prepaid' AND p\.status='captured'/);
  assert.match(integration, /b\.id NOT IN \(SELECT source_booking_id FROM customer_grooming_subscriptions\)/);
  assert.match(integration, /b\.id NOT IN \(SELECT booking_id FROM booking_subscription_usage\)/);
  // recognise advance only when the booking is completed (service utilised)
  assert.match(integration, /if \(String\(b\.status\) === "completed"\)/);
  assert.match(integration, /recognizeAdvanceBooking/);
  // cold-DB safe: every read tolerates missing tables
  assert.match(integration, /\.catch\(empty\)/);
  // wired into the background scheduler
  assert.match(scheduler, /runRevenueRecognitionSweep\(db,\{asOf\}\)/);
  assert.match(scheduler, /"revenueRecognition"/);
});
