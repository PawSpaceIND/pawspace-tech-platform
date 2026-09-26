/*
 * Owner decision 7 (26 Sept 2026): full-time providers are contractors. Each month they are paid a fixed fee,
 * an incentive and petrol as separate statement lines, with TDS on the fee and incentive (not on petrol), no
 * PF/ESI/PT, and never commission. These tests execute lib/contractor-pay.ts and the payout paths it touches
 * against a real SQLite database through the in-memory D1 harness.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { world, attempt, seedActors, asActor, ORIGIN } from "./helpers/execution-harness.mjs";

installWorkersHooks("__CONTRACTOR_PAY_DB__", "__CONTRACTOR_PAY_ENV__");
const pay = await import("../lib/contractor-pay.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");
const grooming = await import("../lib/grooming-incentive-engine.ts");
const travel = await import("../lib/provider-daily-travel.ts");
const settlement = await import("../lib/partner-settlement-governance.ts");
const commission = await import("../lib/provider-commission-governance.ts");
const tds = await import("../lib/tds-governance.ts");

const NOW = Date.now(), DAY = 86_400_000;
const FIN = "finance.lead@pawspace.test", OPS = "ops.lead@pawspace.test";
const AFTER_AUGUST = Date.parse("2026-09-02T00:00:00+05:30");

async function contractorWorld() {
  const w = world("__CONTRACTOR_PAY_DB__", "__CONTRACTOR_PAY_ENV__", { PAWSPACE_PAYMENT_ENV: "sandbox", PAWSPACE_PAYMENT_LIVE_APPROVED: "false", FORBID_PRODUCTION: "true" });
  await capacity.ensureProviderCapacityTables(w.db);
  await grooming.ensureGroomingIncentiveTables(w.db);
  await travel.ensureProviderDailyTravelTables(w.db);
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT,city_id TEXT,service_code TEXT,package_code TEXT,package_name TEXT,provider_id TEXT,status TEXT,scheduled_start TEXT,scheduled_end TEXT,total_amount REAL,currency TEXT,created_at INTEGER,updated_at INTEGER)");
  return w;
}
function provider(sqlite, id, model, service = "grooming") {
  sqlite.prepare("INSERT INTO provider_capacity_profiles (id,city_id,name,provider_model,services_json,zones_json,live,rating,quality_score,capacity,travel_buffer_minutes,max_daily_jobs,acceptance_timeout_minutes,status,version,effective_from,effective_to,updated_by,updated_at) VALUES (?,'blr',?,?,?,'[\"blr-east\"]',1,4.8,95,1,30,6,3,'active',1,'2026-01-01',NULL,'test',?)")
    .run(id, `Provider ${id}`, model, JSON.stringify([service]), NOW);
}
function job(sqlite, { id, providerId, day, amount, status = "completed", service = "grooming" }) {
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,city_id,service_code,package_code,package_name,provider_id,status,scheduled_start,scheduled_end,total_amount,currency,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, `CUS-${id}`, "blr", service, "full-groom", "Full groom", providerId, status, `${day}T05:00:00.000Z`, `${day}T06:00:00.000Z`, amount, "INR", NOW, NOW);
}
/** One routed day of travel, as computeDailyTravel() would have persisted it. */
function travelDay(sqlite, providerId, day, km) {
  sqlite.prepare("INSERT INTO provider_daily_travel_legs (id,provider_id,travel_date,leg_sequence,leg_type,booking_id,origin_label,destination_label,distance_km,duration_minutes,route_status,computed_at) VALUES (?,?,?,1,'home_to_job',NULL,'Home','Jobs and back',?,90,'configured',?)")
    .run(`LEG-${providerId}-${day}`, providerId, day, km, NOW);
}
const august = (d) => `2026-08-${String(d).padStart(2, "0")}`;

/** Sample month: fee Rs 25,000; 20 completed Rs 5,500 grooming jobs, 4 a day on 5 days; 10 days over 70 km. */
async function sampleGroomer(w, id = "FT-GROOM") {
  provider(w.sqlite, id, "full_time");
  await grooming.saveGroomerBracket(w.db, { headGroomerId: id, bracket: "single", effectiveFrom: "2026-08-01", reason: "Single groomer on contract", actorId: OPS });
  for (let d = 3; d <= 7; d++) for (let n = 1; n <= 4; n++) job(w.sqlite, { id: `${id}-${d}-${n}`, providerId: id, day: august(d), amount: 5500 });
  for (let d = 10; d <= 19; d++) travelDay(w.sqlite, id, august(d), 82);
  travelDay(w.sqlite, id, august(20), 55); // under the 70 km threshold: no petrol for this day
  await pay.saveContractorPayProfile(w.db, { providerId: id, serviceCode: "grooming", monthlyFee: 25000, effectiveFrom: "2026-01-01", reason: "Full-time groomer contract signed", actorId: FIN });
  return id;
}

test("sample month: fixed fee, incentive and petrol are separate lines, TDS is on fee + incentive only", async () => {
  const w = await contractorWorld();
  const id = await sampleGroomer(w);
  const engine = await grooming.computeGroomerMonthlyIncentive(w.db, { headGroomerId: id, monthStart: "2026-08-01", actorId: OPS });
  assert.equal(engine.monthTotal, 110000, "20 jobs x Rs 5,500");
  assert.equal(engine.headTotal, 4500, "the engine folds Rs 2,000 of petrol into its Rs 2,500 incentive");

  const s = await pay.computeContractorStatement(w.db, { providerId: id, periodCode: "2026-08" });
  assert.equal(s.daysInMonth, 31);
  assert.equal(s.activeDays, 31);
  assert.equal(s.fixedFee, 25000);
  assert.equal(s.incentive, 2500, "5 days with 4 jobs, each Rs 500 (30% of Rs 22,000 capped at Rs 500); petrol taken out");
  assert.equal(s.petrol, 2000, "10 days over 70 km at Rs 200; the 55 km day does not count");
  assert.equal(s.tdsSection, "194J");
  assert.equal(s.tdsRatePct, 10);
  assert.equal(s.tdsBase, 27500, "TDS base is the fee plus the incentive, never the petrol reimbursement");
  assert.equal(s.tdsAmount, 2750);
  assert.equal(s.netPayable, 26750, "25,000 + 2,500 + 2,000 - 2,750");
  assert.deepEqual(s.lines.map((l) => l.code), ["fixed_fee", "incentive", "petrol", "tds"]);
  assert.deepEqual(s.lines.map((l) => l.amount), [25000, 2500, 2000, -2750]);
  assert.equal(s.blockers.length, 0);
  assert.ok(s.notes.some((n) => /no PF, ESI or professional tax/.test(n)));
});

test("the default TDS comes from the existing tds-governance constants: 194J at 10%", () => {
  assert.equal(pay.CONTRACTOR_TDS_DEFAULT.section, "194J");
  assert.equal(pay.CONTRACTOR_TDS_DEFAULT.ratePct, tds.TDS_RATES.professional194J * 100);
});

test("part months are pro-rated by active days: a joiner, a mid-month change and a leaver", async () => {
  const w = await contractorWorld();
  provider(w.sqlite, "FT-JOIN", "full_time", "dog_walking");
  await pay.saveContractorPayProfile(w.db, { providerId: "FT-JOIN", monthlyFee: 30000, effectiveFrom: "2026-09-16", reason: "Walker joins on 16 September", actorId: FIN });
  const joiner = await pay.computeContractorStatement(w.db, { providerId: "FT-JOIN", periodCode: "2026-09" });
  assert.equal(joiner.serviceCode, "dog_walking", "the service defaults from the provider's capacity profile");
  assert.equal(joiner.activeDays, 15);
  assert.equal(joiner.fixedFee, 15000, "Rs 30,000 x 15/30 days");
  assert.equal(joiner.incentive, 0, "walking has no incentive engine yet");
  assert.equal(await pay.computeContractorStatement(w.db, { providerId: "FT-JOIN", periodCode: "2026-08" }), null, "no pay before the start date");

  provider(w.sqlite, "FT-RAISE", "full_time", "pet_sitting");
  await pay.saveContractorPayProfile(w.db, { providerId: "FT-RAISE", monthlyFee: 20000, effectiveFrom: "2026-07-01", reason: "Sitter contract from July", actorId: FIN });
  await pay.saveContractorPayProfile(w.db, { providerId: "FT-RAISE", monthlyFee: 31000, effectiveFrom: "2026-08-11", reason: "Raise agreed from 11 August", actorId: FIN });
  const raise = await pay.computeContractorStatement(w.db, { providerId: "FT-RAISE", periodCode: "2026-08" });
  assert.equal(raise.activeDays, 31);
  assert.equal(raise.fixedFee, 27451.61, "Rs 20,000 x 10/31 + Rs 31,000 x 21/31");
  const versions = w.sqlite.prepare("SELECT version,effective_from,effective_to FROM contractor_pay_profiles WHERE provider_id='FT-RAISE' ORDER BY version").all();
  assert.deepEqual(versions.map((v) => [v.version, v.effective_from, v.effective_to]), [[1, "2026-07-01", "2026-08-10"], [2, "2026-08-11", null]]);

  await pay.endContractorPayProfile(w.db, { providerId: "FT-RAISE", lastDay: "2026-10-10", reason: "Contract ends on 10 October", actorId: FIN });
  const leaver = await pay.computeContractorStatement(w.db, { providerId: "FT-RAISE", periodCode: "2026-10" });
  assert.equal(leaver.activeDays, 10);
  assert.equal(leaver.fixedFee, 10000, "Rs 31,000 x 10/31 days");
  assert.equal(await pay.computeContractorStatement(w.db, { providerId: "FT-RAISE", periodCode: "2026-11" }), null);
});

test("petrol is paid in a month under Rs 1,00,000, where the incentive engine drops it", async () => {
  const w = await contractorWorld();
  provider(w.sqlite, "FT-QUIET", "full_time");
  await grooming.saveGroomerBracket(w.db, { headGroomerId: "FT-QUIET", bracket: "single", effectiveFrom: "2026-08-01", reason: "Single groomer on contract", actorId: OPS });
  for (let n = 1; n <= 5; n++) job(w.sqlite, { id: `Q-${n}`, providerId: "FT-QUIET", day: august(12), amount: 1000 });
  for (const d of [12, 13, 14]) travelDay(w.sqlite, "FT-QUIET", august(d), 80);
  await pay.saveContractorPayProfile(w.db, { providerId: "FT-QUIET", monthlyFee: 25000, effectiveFrom: "2026-08-01", reason: "Full-time groomer contract signed", actorId: FIN });

  const engine = await grooming.computeGroomerMonthlyIncentive(w.db, { headGroomerId: "FT-QUIET", monthStart: "2026-08-01", actorId: OPS });
  assert.equal(engine.eligible, false);
  assert.equal(engine.headTotal, 0, "below the Rs 1,00,000 floor the engine returns before adding petrol");

  const s = await pay.computeContractorStatement(w.db, { providerId: "FT-QUIET", periodCode: "2026-08" });
  assert.equal(s.incentive, 0);
  assert.equal(s.petrol, 600, "3 days over 70 km at Rs 200, worked out on its own");
  assert.equal(s.tdsAmount, 2500, "10% of the Rs 25,000 fee; none on petrol");
  assert.equal(s.netPayable, 23100);
});

test("approval is one click, idempotent per provider and month, and posts one balanced journal", async () => {
  const w = await contractorWorld();
  const id = await sampleGroomer(w);
  await pay.refreshContractorStatements(w.db, "2026-08");
  const statementId = pay.contractorStatementId(id, "2026-08");

  const early = await attempt(() => pay.approveContractorStatement(w.db, { statementId, actorId: FIN, asOf: Date.parse("2026-08-31T12:00:00+05:30") }));
  assert.equal(early.ok, false);
  assert.match(early.body, /once the month is over/);

  const stale = await attempt(() => pay.approveContractorStatement(w.db, { statementId, actorId: FIN, expectedNetPayable: 25000, asOf: AFTER_AUGUST }));
  assert.equal(stale.ok, false, "a figure Finance was not shown is never approved");
  assert.match(stale.body, /changed since you opened it/);

  const [a, b] = await Promise.all([
    pay.approveContractorStatement(w.db, { statementId, actorId: FIN, expectedNetPayable: 26750, asOf: AFTER_AUGUST }),
    pay.approveContractorStatement(w.db, { statementId, actorId: FIN, expectedNetPayable: 26750, asOf: AFTER_AUGUST }),
  ]);
  assert.equal([a, b].filter((r) => !r.duplicatePrevented).length, 1, "two clicks at once approve once");
  const again = await pay.approveContractorStatement(w.db, { statementId, actorId: "someone.else@pawspace.test", asOf: AFTER_AUGUST });
  assert.equal(again.duplicatePrevented, true);
  assert.equal(again.status, "approved");
  assert.equal(again.approvedBy, FIN);
  assert.equal(again.netPayable, 26750);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM contractor_pay_events WHERE event_type='statement_approved'").get().n, 1);
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM contractor_monthly_statements WHERE provider_id=? AND period_code='2026-08'").get(id).n, 1);

  const lines = w.sqlite.prepare("SELECT account_code,debit,credit,entry_date,period_code,source_type FROM finance_journal_entries WHERE source_id=? ORDER BY id").all(statementId);
  assert.equal(lines.length, 5, "fee, incentive, petrol, provider payable, TDS payable - posted once");
  const debit = lines.reduce((sum, l) => sum + l.debit, 0), credit = lines.reduce((sum, l) => sum + l.credit, 0);
  assert.equal(debit, 29500);
  assert.equal(credit, 29500, "expense = provider payable + TDS payable");
  const by = (code) => lines.filter((l) => l.account_code === code);
  assert.deepEqual(by("6020-Contract Partners (2)").map((l) => l.debit), [25000, 2500], "grooming contract partner expense: fee and incentive");
  assert.equal(by("6090-Office and Administration (4)")[0].debit, 2000, "petrol reimbursement as conveyance");
  assert.equal(by("2110-Provider Payable")[0].credit, 26750);
  assert.equal(by("2150-TDS Payable")[0].credit, 2750);
  assert.ok(lines.every((l) => l.entry_date === "2026-08-31" && l.period_code === "2026-08" && l.source_type === "contractor_statement"));

  // New work after approval does not rewrite what was approved.
  job(w.sqlite, { id: "LATE-1", providerId: id, day: august(28), amount: 90000 });
  await pay.refreshContractorStatements(w.db, "2026-08");
  const frozen = w.sqlite.prepare("SELECT status,net_payable,incentive FROM contractor_monthly_statements WHERE id=?").get(statementId);
  assert.deepEqual({ ...frozen }, { status: "approved", net_payable: 26750, incentive: 2500 });
  await assert.rejects(
    () => pay.saveContractorPayProfile(w.db, { providerId: id, monthlyFee: 40000, effectiveFrom: "2026-08-15", reason: "Backdated raise into an approved month", actorId: FIN }),
    /already approved, so pay changes can only start from 2026-09-01/,
  );
});

test("the TDS return records the contractor TDS actually deducted, and recomputing it is idempotent", async () => {
  const w = await contractorWorld();
  const id = await sampleGroomer(w);
  await pay.refreshContractorStatements(w.db, "2026-08");
  await pay.approveContractorStatement(w.db, { statementId: pay.contractorStatementId(id, "2026-08"), actorId: FIN, asOf: AFTER_AUGUST });
  // A per-job share the completion engine computed for this contractor under a commission term is not a
  // payment to them (they are never paid per job), so it must not be taxed as if it were.
  w.sqlite.exec("CREATE TABLE provider_commercial_terms (id TEXT PRIMARY KEY,engagement_model TEXT); CREATE TABLE provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT,provider_net_payout REAL,computed_at INTEGER,term_id TEXT); INSERT INTO provider_commercial_terms VALUES ('T-GROOM','commission_groomer')");
  w.sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('FT-GROOM-JOBS',?,60000,?,'T-GROOM')").run(id, Date.parse("2026-08-15T10:00:00+05:30"));
  const first = await tds.computeMonthlyTds(w.db, { period: "2026-08", actorId: FIN });
  const again = await tds.computeMonthlyTds(w.db, { period: "2026-08", actorId: FIN });
  assert.equal(first.sections["194J"].tds, 2750);
  assert.equal(again.totalTds, 2750, "recompute does not double-count");
  const row = w.sqlite.prepare("SELECT section,deductee_id,base_amount,rate_pct,tds_amount,source_type FROM tds_deductions WHERE period='2026-08'").get();
  assert.deepEqual({ ...row }, { section: "194J", deductee_id: id, base_amount: 27500, rate_pct: 10, tds_amount: 2750, source_type: "contractor_statement" });
});

test("a full-time trainer's incentive comes from the trainer engine, with its petrol paid as its own line", async () => {
  const w = await contractorWorld();
  provider(w.sqlite, "FT-TRAIN", "full_time", "dog_training");
  job(w.sqlite, { id: "TR-1", providerId: "FT-TRAIN", day: august(9), amount: 160000, service: "dog_training" });
  for (const d of [9, 10]) travelDay(w.sqlite, "FT-TRAIN", august(d), 75);
  await pay.saveContractorPayProfile(w.db, { providerId: "FT-TRAIN", monthlyFee: 30000, effectiveFrom: "2026-08-01", reason: "Full-time trainer contract signed", actorId: FIN });
  const s = await pay.computeContractorStatement(w.db, { providerId: "FT-TRAIN", periodCode: "2026-08" });
  assert.equal(s.incentive, 4000, "20% of the Rs 20,000 above Rs 1,40,000; the engine's Rs 400 petrol is not counted twice");
  assert.equal(s.petrol, 400);
  assert.equal(s.tdsAmount, 3400, "10% of Rs 34,000");
  assert.equal(s.netPayable, 31000);
});

test("a groomer with no incentive bracket is held, never approved on a guessed incentive", async () => {
  const w = await contractorWorld();
  provider(w.sqlite, "FT-NOBRACKET", "full_time");
  job(w.sqlite, { id: "NB-1", providerId: "FT-NOBRACKET", day: august(5), amount: 2000 });
  await pay.saveContractorPayProfile(w.db, { providerId: "FT-NOBRACKET", monthlyFee: 22000, effectiveFrom: "2026-08-01", reason: "Full-time groomer contract signed", actorId: FIN });
  await pay.refreshContractorStatements(w.db, "2026-08");
  const result = await attempt(() => pay.approveContractorStatement(w.db, { statementId: pay.contractorStatementId("FT-NOBRACKET", "2026-08"), actorId: FIN, asOf: AFTER_AUGUST }));
  assert.equal(result.ok, false);
  assert.match(result.body, /incentive bracket/);
  assert.equal(w.sqlite.prepare("SELECT status FROM contractor_monthly_statements WHERE provider_id='FT-NOBRACKET'").get().status, "draft");
});

test("a full-time groomer gets no commission line: not in the commission sync, not in the monthly partner statement", async () => {
  const w = await contractorWorld();
  provider(w.sqlite, "FT1", "full_time");
  provider(w.sqlite, "COMM1", "commission");
  await commission.ensureProviderCommissionTables(w.db);
  await settlement.ensurePartnerSettlementTables(w.db);
  w.sqlite.exec(`CREATE TABLE IF NOT EXISTS provider_work_orders (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,provider_model TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS booking_lifecycle_events (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,entity_type TEXT NOT NULL,entity_id TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',occurred_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS provider_payout_computations (booking_id TEXT PRIMARY KEY,provider_id TEXT,service_code TEXT,provider_net_payout REAL,computed_at INTEGER);`);
  // Both jobs completed; the full-time groomer's work order was mis-recorded as commission.
  for (const [booking, providerId] of [["B-FT", "FT1"], ["B-COMM", "COMM1"]]) {
    job(w.sqlite, { id: booking, providerId, day: new Date(NOW).toISOString().slice(0, 10), amount: 1000 });
    w.sqlite.prepare("INSERT INTO provider_work_orders VALUES (?,?,?,'commission')").run(`WO-${booking}`, booking, providerId);
  }
  // Owner decision 8 / G14 (26 Sept 2026): the commission is set per service in provider_commercial_terms (a maker and a
  // different approver); the older profile no longer takes a commission percentage.
  w.sqlite.exec("CREATE TABLE IF NOT EXISTS provider_commercial_terms (id TEXT PRIMARY KEY,service_code TEXT NOT NULL,provider_id TEXT,version INTEGER NOT NULL,status TEXT NOT NULL,engagement_model TEXT NOT NULL,provider_share_pct REAL NOT NULL,effective_from TEXT NOT NULL,created_by TEXT,approved_by TEXT,approval_reference TEXT)");
  w.sqlite.prepare("INSERT INTO provider_commercial_terms (id,service_code,provider_id,version,status,engagement_model,provider_share_pct,effective_from,created_by,approved_by,approval_reference) VALUES ('PCT-COMM1','grooming','COMM1',1,'active','commission_groomer',0.70,'2026-01-01',?,?,'TEST-COMM1')").run(FIN, OPS);
  await commission.syncCompletedCommissionOrders(w.db);
  const commissions = w.sqlite.prepare("SELECT provider_id,commission_amount FROM provider_order_commissions ORDER BY provider_id").all();
  assert.deepEqual(commissions.map((c) => [c.provider_id, c.commission_amount]), [["COMM1", 700]], "the commission provider is paid per job; the full-time groomer is not");

  // The verifier's case: the full-time groomer's completed job carries a Rs 700 per-job share.
  w.sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('B-FT','FT1','grooming',700,?)").run(NOW);
  w.sqlite.prepare("INSERT INTO provider_payout_computations VALUES ('B-OTHER','P-UNPROFILED','grooming',600,?)").run(NOW);
  await settlement.refreshPartnerSettlementStatements(w.db, new Date(NOW).toISOString().slice(0, 7));
  const statements = w.sqlite.prepare("SELECT provider_id,earned_amount FROM partner_settlement_statements ORDER BY provider_id").all();
  assert.equal(statements.some((s) => s.provider_id === "FT1"), false, "no Rs 700 per-job statement for a full-time groomer");
  assert.deepEqual(statements.map((s) => [s.provider_id, s.earned_amount]), [["P-UNPROFILED", 600]], "the exclusion is only for full-time providers");

  // Their pay is the contractor statement, and it has no commission line at all.
  await pay.saveContractorPayProfile(w.db, { providerId: "FT1", monthlyFee: 25000, effectiveFrom: "2026-01-01", reason: "Full-time groomer contract signed", actorId: FIN });
  await assert.rejects(
    () => pay.saveContractorPayProfile(w.db, { providerId: "COMM1", monthlyFee: 25000, effectiveFrom: "2026-01-01", reason: "Wrongly put a commission groomer on a fee", actorId: FIN }),
    /not recorded as full-time/,
  );
});

test("contractors stay off employee payroll and staff payroll is unchanged", async () => {
  const w = await contractorWorld();
  const people = await import("../lib/people-foundation.ts");
  const payroll = await import("../lib/payroll-engine.ts");
  const linkage = await import("../lib/workforce-person-linkage.ts");
  const employeeJourney = await import("../lib/employee-journey-onboarding.ts");
  await people.ensurePeopleTables(w.db);
  await payroll.ensurePayrollTables(w.db);
  const id = await sampleGroomer(w);
  const linked = await linkage.linkFullTimePartnerToPeople(w.db, { providerId: id, workEmail: "ft.groom@pawspace.test", displayName: "Full-time Groomer", joinedAt: NOW - 90 * DAY, cityId: "blr", actorId: OPS });
  const structure = await payroll.saveSalaryStructure(w.db, { structureCode: "STAFF", effectiveFrom: NOW - 120 * DAY, components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 42000 }, { code: "PF", label: "Provident fund", kind: "deduction", amount: 1800 }], actorId: "hr@pawspace.test" });
  const staff = await employeeJourney.onboardEmployeeJourney(w.db, { employeeCode: "EMP-STAFF", displayName: "Office Staff", workEmail: "staff@pawspace.test", joinedAt: NOW - 90 * DAY, structureId: String(structure.id), roleCode: "associate", reason: "Office staff onboarding", actorId: "hr@pawspace.test" });
  await pay.refreshContractorStatements(w.db, "2026-08");
  await pay.approveContractorStatement(w.db, { statementId: pay.contractorStatementId(id, "2026-08"), actorId: FIN, asOf: AFTER_AUGUST });

  const run = await payroll.calculatePayroll(w.db, { periodStart: NOW - 30 * DAY, periodEnd: NOW - 1, idempotencyKey: "contractor-payroll-check", actorId: "payroll@pawspace.test" });
  assert.deepEqual(run.results.map((r) => String(r.employee_id)), [staff.employeeId], "only the staff employee is on payroll");
  assert.equal(Number(run.results[0].net_pay), 40200, "staff pay is unchanged: Rs 42,000 less Rs 1,800 PF");
  assert.equal(w.sqlite.prepare("SELECT COUNT(*) n FROM employee_payroll_results WHERE employee_id=?").get(linked.employeeId).n, 0);
  const contractorLines = JSON.parse(w.sqlite.prepare("SELECT lines_json FROM contractor_monthly_statements WHERE provider_id=?").get(id).lines_json);
  assert.deepEqual(contractorLines.map((l) => l.code), ["fixed_fee", "incentive", "petrol", "tds"], "no PF, ESI or professional tax line for a contractor");
});

test("pay profiles are validated, reasoned and audited", async () => {
  const w = await contractorWorld();
  provider(w.sqlite, "FT-V", "full_time", "dog_training");
  const base = { providerId: "FT-V", monthlyFee: 28000, effectiveFrom: "2026-08-01", reason: "Trainer on a monthly contract", actorId: FIN };
  await assert.rejects(() => pay.saveContractorPayProfile(w.db, { ...base, reason: "short" }), /reason of at least 8 characters/);
  await assert.rejects(() => pay.saveContractorPayProfile(w.db, { ...base, monthlyFee: 0 }), /more than Rs 0/);
  await assert.rejects(() => pay.saveContractorPayProfile(w.db, { ...base, tdsSection: "192" }), /194J or 194C/);
  await assert.rejects(() => pay.saveContractorPayProfile(w.db, { ...base, tdsRatePct: 25 }), /between 0% and 20%/);
  await assert.rejects(() => pay.saveContractorPayProfile(w.db, { ...base, effectiveFrom: "2026-02-30" }), /real date/);
  const saved = await pay.saveContractorPayProfile(w.db, { ...base, tdsSection: "194C", tdsRatePct: 2, petrolRule: "none" });
  assert.deepEqual([saved.serviceCode, saved.tdsSection, saved.tdsRatePct, saved.petrolRule], ["dog_training", "194C", 2, "none"], "Finance can change the section and rate");
  const event = w.sqlite.prepare("SELECT event_type,actor_email,reason,detail_json FROM contractor_pay_events WHERE provider_id='FT-V'").get();
  assert.equal(event.event_type, "pay_profile_saved");
  assert.equal(event.actor_email, FIN);
  assert.equal(event.reason, "Trainer on a monthly contract");
  assert.equal(JSON.parse(event.detail_json).monthlyFee, 28000);
});

test("permissions: reading needs finance.view, changing pay or approving needs finance.manage", async () => {
  const w = await contractorWorld();
  const route = await import("../app/api/contractor-pay/route.ts");
  const gateway = await import("../lib/api-gateway.ts");
  const ADMIN = "admin.view@pawspace.test", ASSOC = "associate@pawspace.test";
  await seedActors(w.sqlite, w.db, [{ id: "U-FIN", email: FIN, role: "finance" }, { id: "U-ADM", email: ADMIN, role: "admin" }, { id: "U-ASC", email: ASSOC, role: "associate" }]);
  const id = await sampleGroomer(w);
  const body = { action: "save_profile", providerId: id, monthlyFee: 26000, effectiveFrom: "2026-09-01", reason: "Annual review raise from September" };
  const post = (email, payload) => attempt(() => route.POST(asActor(email, "/api/contractor-pay", { method: "POST", headers: { origin: ORIGIN }, body: JSON.stringify(payload) })));

  assert.equal((await attempt(() => route.GET(asActor(ASSOC, "/api/contractor-pay?period=2026-08")))).status, 403, "no finance access, no pay data");
  const view = await attempt(() => route.GET(asActor(ADMIN, "/api/contractor-pay?period=2026-08")));
  assert.equal(view.status, 200, view.body);
  const statement = JSON.parse(view.body).data.statements[0];
  assert.equal(statement.netPayable, 26750);
  assert.equal((await post(ADMIN, body)).status, 403, "finance.view alone cannot change pay");
  assert.equal((await post(ADMIN, { action: "approve_statement", statementId: statement.id })).status, 403, "or approve it");

  const saved = await post(FIN, body);
  assert.equal(saved.status, 201, saved.body);
  const audit = w.sqlite.prepare("SELECT actor_email,action,resource_id FROM security_audit_events WHERE action='contractor.pay_profile.save'").get();
  assert.deepEqual({ ...audit }, { actor_email: FIN, action: "contractor.pay_profile.save", resource_id: id });

  assert.equal(await gateway.requiredPermission(new Request(`${ORIGIN}/api/contractor-pay`, { method: "GET" })), "finance.view");
  assert.equal(await gateway.requiredPermission(new Request(`${ORIGIN}/api/contractor-pay`, { method: "POST" })), "finance.manage");
});
