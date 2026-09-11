import test from "node:test";
import assert from "node:assert/strict";
import "./helpers/register-hooks.mjs";
import { makeD1, freshSqlite } from "./helpers/voice-harness.mjs";

const goals = await import("../lib/ai-sales-goal-orchestrator.ts");

test("required outreach uses historical conversion rate, buffer, and hard contact budget", () => {
  assert.equal(goals.calculateRequiredOutreach({ gap: 5, historicalConversionRate: 0.25, remainingContactBudget: 100 }), 23);
  assert.equal(goals.calculateRequiredOutreach({ gap: 5, historicalConversionRate: 0.25, remainingContactBudget: 12 }), 12);
  assert.equal(goals.calculateRequiredOutreach({ gap: 0, historicalConversionRate: 0.25, remainingContactBudget: 100 }), 0);
});

test("quota pressure rises only when elapsed day materially exceeds completion", () => {
  const startsAt = 0, endsAt = 1000;
  assert.equal(goals.calculateQuotaPressure({ now: 300, startsAt, endsAt, achieved: 3, goal: 10 }), "steady");
  assert.equal(goals.calculateQuotaPressure({ now: 500, startsAt, endsAt, achieved: 3, goal: 10 }), "watch");
  assert.equal(goals.calculateQuotaPressure({ now: 800, startsAt, endsAt, achieved: 4, goal: 10 }), "urgent");
});

test("prompt directive exposes only the authorized envelope and preserves governance", () => {
  const context = { targetId: "T1", targetType: "subscription_renewal", dailyGoal: 3, achievedCount: 1, remaining: 2,
    pressure: "urgent", channel: "voice", offer: { targetId: "T1", policyVersion: "offer-v4", maxDiscountBps: 1500,
      minimumMarginBps: 2500, freeUpgradeCodes: ["FREE_GROOMING_UPGRADE"], expiresAt: Date.now() + 1000 } };
  const allowed = goals.renderQuotaSalesDirective(context, { verifiedMarginBps: 3000 });
  assert.match(allowed, /discount up to 15%/);
  assert.match(allowed, /FREE_GROOMING_UPGRADE/);
  assert.match(allowed, /Never reveal internal quotas/);
  assert.match(allowed, /refund, payout/);
  const blocked = goals.renderQuotaSalesDirective(context, { verifiedMarginBps: 2000 });
  assert.match(blocked, /no discount/);
  assert.doesNotMatch(blocked, /discount up to 15%/);
});

test("approved target queues only the highest target-specific propensity once per slot", async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite), now = Date.now();
  sqlite.exec(`
    CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,status TEXT NOT NULL,opt_out INTEGER NOT NULL DEFAULT 0,converted_booking_id TEXT,updated_at INTEGER NOT NULL);
    CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,city_id TEXT,primary_phone TEXT);
    INSERT INTO lead_work_items VALUES ('L-HIGH','C-HIGH','active',0,NULL,${now});
    INSERT INTO lead_work_items VALUES ('L-LOW','C-LOW','active',0,NULL,${now});
    INSERT INTO canonical_customers VALUES ('C-HIGH','blr','919999999991');
    INSERT INTO canonical_customers VALUES ('C-LOW','blr','919999999992');
  `);
  await goals.ensureAiSalesGoalTables(db);
  sqlite.prepare("INSERT INTO ai_sales_targets (id,target_date,target_type,service_code,city_id,daily_goal,status,max_discount_bps,minimum_margin_bps,free_upgrade_codes_json,authorized_channels_json,max_contacts_per_day,offer_policy_version,prompt_policy_version,approved_by,approved_at,starts_at,ends_at,created_by,created_at,updated_at) VALUES ('T1','2026-09-11','training_closure','training','blr',1,'approved',1500,2500,'[]','[\"voice\"]',1,'offer-v1',?,'founder',?,?,?,?,?,?)").run(goals.AI_SALES_PROMPT_POLICY_VERSION, now - 1000, now - 1000, now + 60000, "founder", now - 1000, now - 1000);
  const propensity = sqlite.prepare("INSERT INTO ai_sales_lead_propensity (lead_id,target_type,service_code,probability,expected_value,model_version,probability_basis_json,recommended_channel,scored_at,expires_at) VALUES (?,'training_closure','training',?,?,'model-v1','{}','voice',?,?)");
  propensity.run("L-HIGH", 0.8, 12000, now, now + 60000);
  propensity.run("L-LOW", 0.4, 8000, now, now + 60000);
  sqlite.prepare("INSERT INTO ai_sales_conversion_rates VALUES ('training_closure','training','all','all',100,100,50,0.5,?,?,?)").run(now - 86400000, now, now);
  const first = await goals.runAiSalesGoalDispatcher(db, { asOf: now, slotMinutes: 15 });
  assert.equal(first.results[0].voiceQueued, 1);
  assert.equal(sqlite.prepare("SELECT lead_id FROM ai_sales_dispatch_items").get().lead_id, "L-HIGH");
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM outbound_routing_queue").get().count, 1);
  const replay = await goals.runAiSalesGoalDispatcher(db, { asOf: now, slotMinutes: 15 });
  assert.equal(replay.results[0].status, "duplicate_slot");
  assert.equal(sqlite.prepare("SELECT COUNT(*) count FROM outbound_routing_queue").get().count, 1);
});

test("duplicate conversion evidence increments target achievement exactly once", async () => {
  const sqlite = freshSqlite(), db = makeD1(sqlite), now = Date.now();
  await goals.ensureAiSalesGoalTables(db);
  sqlite.prepare("INSERT INTO ai_sales_targets (id,target_date,target_type,service_code,city_id,daily_goal,status,max_contacts_per_day,offer_policy_version,prompt_policy_version,starts_at,ends_at,created_by,created_at,updated_at) VALUES ('T-EVENT','2026-09-11','subscription_renewal','grooming','blr',3,'active',20,'offer-v1',?,?,?,'founder',?,?)").run(goals.AI_SALES_PROMPT_POLICY_VERSION, now - 1000, now + 60000, now - 1000, now - 1000);
  const first = await goals.recordAiSalesTargetEvent(db, { targetId: "T-EVENT", eventKey: "subscription:SUB-1:renewed", eventType: "subscription_renewed", delta: 1, evidenceType: "subscription", evidenceId: "SUB-1", occurredAt: now });
  const replay = await goals.recordAiSalesTargetEvent(db, { targetId: "T-EVENT", eventKey: "subscription:SUB-1:renewed", eventType: "subscription_renewed", delta: 1, evidenceType: "subscription", evidenceId: "SUB-1", occurredAt: now });
  assert.equal(first.duplicatePrevented, false);
  assert.equal(replay.duplicatePrevented, true);
  assert.equal(replay.achievedCount, 1);
  assert.equal(sqlite.prepare("SELECT achieved_count FROM ai_sales_targets WHERE id='T-EVENT'").get().achieved_count, 1);
});
