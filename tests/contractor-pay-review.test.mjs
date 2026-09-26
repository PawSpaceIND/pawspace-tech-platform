/*
 * Review of work package E (owner decision 7, 26 Sept 2026: full-time providers are contractors paid a monthly
 * fixed fee + incentive + petrol, never commission). These tests execute the real modules on the in-memory D1
 * harness and cover three gaps the first cut left open:
 *   1. a per-job partner statement made for a full-time provider BEFORE the decision could still be approved
 *      and turned into a payout, on top of the new contractor statement (paid twice);
 *   2. a full-time trainer's per-session payout statement could still be approved (paid twice);
 *   3. choosing TDS section 194C with a blank rate deducted 194J's 10% instead of 1%, and the TDS
 *      reconciliation rejected every 194C row as an unknown section.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt } from "./helpers/execution-harness.mjs";

installWorkersHooks("__CONTRACTOR_REVIEW_DB__", "__CONTRACTOR_REVIEW_ENV__");
const pay = await import("../lib/contractor-pay.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");
const settlement = await import("../lib/partner-settlement-governance.ts");
const training = await import("../lib/training-finance.ts");
const tds = await import("../lib/tds-governance.ts");
const reconciliation = await import("../lib/tds-tcs-reconciliation.ts");

const NOW = Date.now();
const FIN = "finance.lead@pawspace.test", CHECKER = "finance.checker@pawspace.test";
const AFTER_AUGUST = Date.parse("2026-09-02T00:00:00+05:30");

async function reviewWorld() {
  const w = world("__CONTRACTOR_REVIEW_DB__", "__CONTRACTOR_REVIEW_ENV__", { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" });
  await capacity.ensureProviderCapacityTables(w.db);
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER)");
  return w;
}
function provider(sqlite, id, model, service) {
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,'blr',?,?,?,'[\"blr-east\"]',1,4.8,95,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)")
    .run(id, `Provider ${id}`, model, JSON.stringify([service]), NOW);
}
function partnerStatement(sqlite, { id, providerId, period, status }) {
  sqlite.prepare("INSERT INTO partner_settlement_statements (id,provider_id,period_code,currency,earned_amount,adjustment_amount,payable_amount,status,source_json,policy_status,approved_by,approved_at,created_at,updated_at) VALUES (?,?,?,'INR',700,0,700,?,'[]','approved',?,?,?,?)")
    .run(id, providerId, period, status, status === "approved" ? FIN : null, status === "approved" ? NOW : null, NOW, NOW);
}

test("a per-job partner statement made for a full-time groomer before decision 7 can be neither approved nor paid", async () => {
  const w = await reviewWorld();
  await settlement.ensurePartnerSettlementTables(w.db);
  provider(w.sqlite, "FT1", "full_time", "grooming");
  provider(w.sqlite, "P-OTHER", "commission", "grooming");
  // What refreshPartnerSettlementStatements wrote for a full-time groomer before this change: Rs 700 a job.
  partnerStatement(w.sqlite, { id: "SET-2026-08-FT1", providerId: "FT1", period: "2026-08", status: "draft" });
  partnerStatement(w.sqlite, { id: "SET-2026-07-FT1", providerId: "FT1", period: "2026-07", status: "approved" });
  partnerStatement(w.sqlite, { id: "SET-2026-08-P-OTHER", providerId: "P-OTHER", period: "2026-08", status: "draft" });

  // Refreshing leaves the old draft in place, so approval itself must refuse it.
  await settlement.refreshPartnerSettlementStatements(w.db, "2026-08");
  // A refusal Finance can read (409 with the reason), not a generic server error.
  const fullTimeRefusal = (error) => error?.status === 409 && /full-time, so they are paid by the monthly contractor statement/.test(error.message);
  await assert.rejects(() => settlement.approveSettlement(w.db, { statementId: "SET-2026-08-FT1", actor: FIN }), fullTimeRefusal,
    "a full-time groomer's per-job statement must not be approved on top of the contractor statement");
  assert.equal(w.sqlite.prepare("SELECT status FROM partner_settlement_statements WHERE id='SET-2026-08-FT1'").get().status, "draft");

  await assert.rejects(() => settlement.createSandboxPayoutInstruction(w.db, { statementId: "SET-2026-07-FT1", idempotencyKey: "FT1-JULY", actor: CHECKER }), fullTimeRefusal,
    "an already approved per-job statement must not become a payout instruction");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM partner_payout_instructions WHERE provider_id='FT1'").get().n, 0);

  // Non-vacuity: the same steps still work for a provider who is not full-time.
  const other = await settlement.approveSettlement(w.db, { statementId: "SET-2026-08-P-OTHER", actor: FIN });
  assert.equal(other.status, "approved");
  const otherPayout = await settlement.createSandboxPayoutInstruction(w.db, { statementId: "SET-2026-08-P-OTHER", idempotencyKey: "OTHER-AUG", actor: CHECKER });
  assert.equal(otherPayout.environment, "sandbox");
  assert.equal(otherPayout.liveMoney, false);
});

test("a full-time trainer's per-session payout statement cannot be approved; a trainer who is not full-time still can", async () => {
  const w = await reviewWorld();
  await training.ensureTrainingFinanceTables(w.db);
  provider(w.sqlite, "FT-TRAINER", "full_time", "dog_training");
  provider(w.sqlite, "SESSION-TRAINER", "commission", "dog_training");
  const completedAt = Date.parse("2026-08-12T10:00:00Z");
  for (const [session, providerId] of [["S-FT", "FT-TRAINER"], ["S-OTHER", "SESSION-TRAINER"]]) {
    w.sqlite.prepare("INSERT INTO training_session_earnings (session_id,programme_id,booking_id,provider_id,city_id,package_code,rate_type,rate_value,gross_earning,currency,status,completed_at,calculated_at,updated_at) VALUES (?,?,?,?,'blr','basic','per_completed_session',700,700,'INR','earned',?,?,?)")
      .run(session, `PRG-${session}`, `BK-${session}`, providerId, completedAt, NOW, NOW);
  }
  await training.refreshTrainingFinanceReadModel(w.db);
  const ready = w.sqlite.prepare("SELECT provider_id,status FROM training_payout_statements WHERE period_code='2026-08' ORDER BY provider_id").all().map((r) => [r.provider_id, r.status]);
  assert.deepEqual(ready, [["FT-TRAINER", "ready_for_finance_approval"], ["SESSION-TRAINER", "ready_for_finance_approval"]]);

  const approve = (providerId) => attempt(() => training.approveTrainingPayout(w.db, { providerId, periodCode: "2026-08", idempotencyKey: `TRN-${providerId}`, reason: "Monthly trainer payout approval", actorId: FIN }));
  const refused = await approve("FT-TRAINER");
  assert.equal(refused.ok, false, "a full-time trainer is paid by the contractor statement, never per session");
  assert.equal(refused.status, 409);
  assert.match(refused.body, /Full-time trainers are contractors/);
  assert.equal(w.sqlite.prepare("SELECT status FROM training_payout_statements WHERE provider_id='FT-TRAINER'").get().status, "ready_for_finance_approval");

  const allowed = await approve("SESSION-TRAINER");
  assert.equal(allowed.ok, true, allowed.body);
  assert.equal(allowed.value.status, "instruction_ready_sandbox");
});

test("choosing section 194C with a blank rate deducts 1%, and the TDS reconciliation accepts the contractor rows", async () => {
  const w = await reviewWorld();
  provider(w.sqlite, "FT-194C", "full_time", "dog_walking");
  provider(w.sqlite, "FT-194J", "full_time", "pet_sitting");
  const c = await pay.saveContractorPayProfile(w.db, { providerId: "FT-194C", monthlyFee: 20000, effectiveFrom: "2026-08-01", tdsSection: "194C", reason: "CA advised 194C for walkers", actorId: FIN });
  assert.equal(c.tdsSection, "194C");
  assert.equal(c.tdsRatePct, 1, "194C for an individual is 1%, not 194J's 10%");
  assert.equal(pay.CONTRACTOR_TDS_DEFAULT_RATE_PCT["194C"], tds.TDS_RATES.contract194C * 100);
  const j = await pay.saveContractorPayProfile(w.db, { providerId: "FT-194J", monthlyFee: 24000, effectiveFrom: "2026-08-01", reason: "Full-time sitter contract signed", actorId: FIN });
  assert.equal(j.tdsRatePct, 10, "the 194J default is unchanged");
  const explicit = await pay.saveContractorPayProfile(w.db, { providerId: "FT-194C", monthlyFee: 20000, effectiveFrom: "2026-09-01", tdsSection: "194C", tdsRatePct: 2, reason: "CA asked for 2% from September", actorId: FIN });
  assert.equal(explicit.tdsRatePct, 2, "an explicit rate is kept as Finance typed it");

  await pay.refreshContractorStatements(w.db, "2026-08");
  for (const id of ["FT-194C", "FT-194J"]) await pay.approveContractorStatement(w.db, { statementId: pay.contractorStatementId(id, "2026-08"), actorId: FIN, asOf: AFTER_AUGUST });
  const statement = w.sqlite.prepare("SELECT tds_section,tds_rate_pct,tds_base,tds_amount,net_payable FROM contractor_monthly_statements WHERE provider_id='FT-194C'").get();
  assert.deepEqual({ ...statement }, { tds_section: "194C", tds_rate_pct: 1, tds_base: 20000, tds_amount: 200, net_payable: 19800 });

  const month = await tds.computeMonthlyTds(w.db, { period: "2026-08", actorId: FIN });
  assert.equal(month.sections["194C"].tds, 200);
  assert.equal(month.sections["194J"].tds, 2400);
  const { findings } = await reconciliation.reconcileTds(w.db, { period: "2026-08" });
  const wrong = findings.filter((f) => ["unknown_section", "rate_mismatch", "amount_mismatch"].includes(f.code));
  assert.deepEqual(wrong, [], "statutory contractor TDS rows reconcile: no unknown section, rate or amount mismatch");

  // Non-vacuity: a 194C row at a rate that is not statutory is still flagged for review.
  w.sqlite.prepare("UPDATE tds_deductions SET rate_pct=5,tds_amount=1000 WHERE section='194C'").run();
  const flagged = (await reconciliation.reconcileTds(w.db, { period: "2026-08" })).findings.filter((f) => f.code === "rate_mismatch");
  assert.equal(flagged.length, 1);
  assert.match(flagged[0].detail, /194C FT-194C: recorded rate 5%/);
});
