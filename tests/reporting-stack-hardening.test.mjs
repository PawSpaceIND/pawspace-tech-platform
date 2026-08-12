import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Module hooks: extensionless relative .ts imports + a live "cloudflare:workers"
// shim so the REAL reporting route handlers execute in-process over node:sqlite.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;

if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const workersUrl = ${JSON.stringify(workersUrl)};
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

const companyAnalyticsRoute = await import("../app/api/company-analytics/route.ts");
const acquisitionFunnelRoute = await import("../app/api/acquisition-funnel/route.ts");
const commandCenterRoute = await import("../app/api/booking-command-center/route.ts");
const companyAnalytics = await import("../lib/company-analytics.ts");
const peopleReportsLib = await import("../lib/people-reports.ts");
const aiAnalyticsLib = await import("../lib/ai-analytics.ts");
const growthLib = await import("../lib/growth-intelligence-governance.ts");
const opsLib = await import("../lib/ops-intelligence-governance.ts");
const financeIntelLib = await import("../lib/finance-intelligence-governance.ts");
const cashFlowLib = await import("../lib/cash-flow-statement.ts");
const managerDashboardLib = await import("../lib/manager-dashboard.ts");
const financeAccounts = await import("../lib/finance-accounts.ts");
const peopleFoundation = await import("../lib/people-foundation.ts");
const payroll = await import("../lib/payroll-engine.ts");
const attendanceLeave = await import("../lib/attendance-leave.ts");
const salesIncentive = await import("../lib/sales-incentive-engine.ts");
const groomingIncentive = await import("../lib/grooming-incentive-engine.ts");
const ratingLib = await import("../lib/booking-rating.ts");
const vaccinationLib = await import("../lib/pet-vaccination-governance.ts");
const birthdayLib = await import("../lib/pet-birthday-governance.ts");
const serverAuth = await import("../lib/server-auth.ts");
const capacity = await import("../lib/provider-capacity-governance.ts");

// ---------------------------------------------------------------------------
// D1-over-node:sqlite shim + verbatim canonical DDL from its owning routes.
// ---------------------------------------------------------------------------
function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...boundArgs) => statement(sql, boundArgs),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const results = [];
      for (const stmt of statements) results.push(await stmt.run());
      return results;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

function statementsOf(source) {
  const out = [];
  const pattern = /\.prepare\(\s*(["'`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let match;
  while ((match = pattern.exec(source))) out.push(match[2].replace(/\\(["'`\\])/g, "$1"));
  return out;
}
const ddlOnly = (source) => statementsOf(source).filter((sql) => /^CREATE (TABLE|INDEX|UNIQUE INDEX)/i.test(sql.trim()));
const canonicalDDL = ddlOnly(fs.readFileSync("app/api/walking-bookings/route.ts", "utf8"));
const commandCenterDDL = ddlOnly(fs.readFileSync("app/api/booking-command-center/route.ts", "utf8"));
const financeJournalDDL = ddlOnly(fs.readFileSync("app/api/finance-control/route.ts", "utf8")).filter((sql) => /finance_journal_entries|finance_bills/.test(sql));

const DAY = 86_400_000;
const NOW = Date.now();
const MONTH = new Date(NOW).toISOString().slice(0, 7);
const iso = (offsetMs) => new Date(NOW + offsetMs).toISOString();

async function reportingStack() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  for (const sql of [...canonicalDDL, ...commandCenterDDL, ...financeJournalDDL]) sqlite.exec(sql);
  await serverAuth.ensureSecurityTables(db);
  await capacity.seedProviderCapacityDefaults(db);

  const seedBooking = (id, { customerId, serviceCode, amount, status, providerId = "prov_1", start = `${MONTH}-15T10:00:00.000Z`, createdAt = NOW - 3 * DAY }) =>
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','blr-east',?,'pkg','Pkg',?,?,?,?,?,'customer_app',?,'INR','{}','uat',?,?)")
      .run(id, `k-${id}`, customerId, serviceCode, `g-${id}`, providerId, start, new Date(new Date(start).getTime() + 2 * 3_600_000).toISOString(), status, amount, createdAt, createdAt);

  const seedPayment = (id, bookingId, customerId, amount, status = "captured") =>
    sqlite.prepare("INSERT INTO booking_payments (id,booking_id,customer_id,amount,amount_due_now,currency,method,mode,status,gateway,idempotency_key,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,'INR','upi','prepaid',?,'uat_sandbox',?,'{}',?,?)")
      .run(id, bookingId, customerId, amount, amount, status, `pk-${id}`, NOW - 3 * DAY, NOW - 3 * DAY);

  return { sqlite, db, seedBooking, seedPayment };
}

// The exact 4-booking canonical seed the mission/P&L reconciliation tests use:
// B1 grooming 1000 confirmed, B2 boarding 2500 completed, B3 training 1500 CANCELLED,
// B4 walking 800 DRAFT. Canonical revenue truth = 3500.
function seedReconciliationBookings(stack) {
  stack.seedBooking("B1", { customerId: "cus_1", serviceCode: "grooming", amount: 1000, status: "confirmed" });
  stack.seedBooking("B2", { customerId: "cus_2", serviceCode: "boarding", amount: 2500, status: "completed" });
  stack.seedBooking("B3", { customerId: "cus_3", serviceCode: "dog_training", amount: 1500, status: "cancelled" });
  stack.seedBooking("B4", { customerId: "cus_4", serviceCode: "dog_walking", amount: 800, status: "draft" });
  stack.seedPayment("PAY1", "B1", "cus_1", 1000);
  stack.seedPayment("PAY2", "B2", "cus_2", 2500);
}

// ---------------------------------------------------------------------------
// 1. company-analytics: every number exactly derivable; regression: cancelled and
//    draft bookings are never revenue.
// ---------------------------------------------------------------------------
test("company-analytics: every reported number derives exactly from the seeds; cancelled/draft never count as revenue", async () => {
  const stack = await reportingStack();
  const { sqlite } = stack;
  seedReconciliationBookings(stack);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,status,escalation_level,reopened_count,created_by,created_at,updated_at,resolved_at) VALUES ('T1','cus_1','B1','Grooming','high','s','d','Neha','M',?,?,0,1,'uat',?,?,?)")
    .run(NOW, "resolved", NOW - 2 * DAY, NOW - DAY, NOW - 2 * DAY + 3_600_000);
  sqlite.prepare("INSERT INTO customer_experience_tickets (id,customer_id,booking_id,category,priority,subject,detail,owner,manager,sla_due_at,status,escalation_level,reopened_count,created_by,created_at,updated_at) VALUES ('T2','cus_2','B2','Boarding','high','s','d','Neha','M',?,?,1,0,'uat',?,?)")
    .run(NOW, "open", NOW - DAY, NOW - DAY);

  const response = await companyAnalyticsRoute.GET(new Request("http://localhost/api/company-analytics"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.equal(data.bookings.total, 4);
  assert.equal(data.bookings.completed, 1);
  assert.equal(data.bookings.cancelled, 1);
  assert.equal(data.money.gmv, 3500, "GMV excludes the cancelled 1500 and draft 800 (was 5800 before the fix)");
  assert.equal(data.money.collected, 3500, "captured payments only");
  assert.equal(data.money.revenueBasis, "excludes_cancelled_and_draft_bookings");
  assert.equal(data.customers.unique, 4);
  assert.equal(data.customers.repeat, 0);
  assert.equal(data.cx.tickets, 2);
  assert.equal(data.cx.open, 1);
  assert.equal(data.cx.reopened, 1);
  assert.equal(data.cx.averageResolutionMs, 3_600_000, "exactly the one resolved ticket's duration");
  // Per-service revenue follows the same basis: the cancelled training booking is counted, but worth 0.
  assert.equal(data.services.dog_training.bookings, 1);
  assert.equal(data.services.dog_training.cancelled, 1);
  assert.equal(data.services.dog_training.gmv, 0, "a cancelled booking's value is never service revenue");
  assert.equal(data.services.grooming.gmv, 1000);
  assert.equal(data.services.boarding.gmv, 2500);
  assert.equal(data.dataQuality.paymentsMissing, 2, "B3 and B4 have no payment rows");
  // Service/zone filters stay exactly derivable.
  const filtered = await companyAnalytics.buildCompanyAnalytics(stack.db, { serviceCode: "boarding" });
  assert.equal(filtered.money.gmv, 2500);
  assert.equal(filtered.bookings.total, 1);
});

// ---------------------------------------------------------------------------
// 2. people-reports: numbers derive from real payroll/attendance rows; manager
//    scope and permission gating enforced.
// ---------------------------------------------------------------------------
test("people-reports: payroll register/rollups derive from real runs; manager scope and permission gates hold", async () => {
  const stack = await reportingStack();
  const { sqlite, db } = stack;
  await peopleFoundation.ensurePeopleTables(db);
  await attendanceLeave.ensureAttendanceLeaveTables(db);
  const seedEmployee = (id, workEmail, { managerId = null, team = "sales" } = {}) => {
    sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,ended_at,created_at,updated_at) VALUES (?,NULL,?,?,?,NULL,'active',?,NULL,?,?)")
      .run(id, `CODE-${id}`, `Employee ${id}`, workEmail, NOW - 90 * DAY, NOW, NOW);
    sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'full_time',NULL,?,?,?,?,NULL,'seed','hr@test',?)")
      .run(`V-${id}`, id, NOW - 90 * DAY, "Executive", team, managerId, `CC-${team}`, NOW);
  };
  seedEmployee("EMP-M", "manager@pawspace.test");
  seedEmployee("EMP-A", "a@pawspace.test", { managerId: "EMP-M" });
  seedEmployee("EMP-B", "b@pawspace.test", { team: "ops" });
  const structure = await payroll.saveSalaryStructure(db, { structureCode: "STD", effectiveFrom: NOW - 60 * DAY, components: [{ code: "BASIC", label: "Basic", kind: "earning", amount: 40_000 }], actorId: "hr@test" });
  for (const id of ["EMP-M", "EMP-A", "EMP-B"]) await payroll.assignCompensation(db, { employeeId: id, structureId: String(structure.id), effectiveFrom: NOW - 30 * DAY, reason: "Initial UAT compensation", actorId: "hr@test" });
  await payroll.calculatePayroll(db, { periodStart: NOW - 14 * DAY, periodEnd: NOW - 1 * DAY, idempotencyKey: "PR-REP-1", actorId: "maker@test" });
  const attendanceRow = sqlite.prepare("INSERT INTO attendance_days (id,employee_id,work_date,status,first_check_in,last_check_out,worked_minutes,exception_code,updated_at) VALUES (?,?,?,'present',?,NULL,NULL,'missing_checkout',?)");
  attendanceRow.run("ATD-1", "EMP-A", new Date(NOW).toISOString().slice(0, 10), NOW, NOW);
  attendanceRow.run("ATD-2", "EMP-B", new Date(NOW).toISOString().slice(0, 10), NOW, NOW);

  const full = await peopleReportsLib.peopleReports(db, { actorEmail: "founder@pawspace.test", roleCode: "founder", permissions: ["*"], periodStart: NOW - 30 * DAY, periodEnd: NOW });
  assert.equal(full.scope.mode, "all");
  assert.equal(full.headcount.active, 3);
  assert.equal(full.payroll.available, true);
  assert.equal(full.payroll.register.length, 3);
  assert.equal(full.payroll.runTotals[0].netPay, 120_000, "3 x 40,000 from the real payroll run");
  assert.equal(full.attendance.exceptions, 2);
  const salesTeam = full.teamRollups.find((row) => row.teamCode === "sales");
  assert.equal(salesTeam.headcount, 2);
  assert.equal(salesTeam.payrollCost, 80_000, "gross+employer cost for the 2 sales employees");

  // Manager scope: the manager sees only their direct report. (payroll.view deliberately absent -
  // by design that permission grants org-wide scope, so a plain manager reads attendance only.)
  const managerView = await peopleReportsLib.peopleReports(db, { actorEmail: "manager@pawspace.test", roleCode: "manager", permissions: ["reports.view", "attendance.view"], periodStart: NOW - 30 * DAY, periodEnd: NOW });
  assert.equal(managerView.scope.mode, "manager");
  assert.equal(managerView.scope.employeeCount, 1);
  assert.equal(managerView.attendance.rows.length, 1, "only the direct report's attendance");
  assert.equal(String(managerView.attendance.rows[0].employee_id), "EMP-A");
  assert.equal(managerView.payroll.available, false, "no payroll.view - compensation stays hidden");
  assert.ok(!JSON.stringify(managerView.sourceDrilldown).includes("EMP-B"), "out-of-scope employees never leak");

  // Permission gating: without payroll.view the compensation section stays hidden.
  const gated = await peopleReportsLib.peopleReports(db, { actorEmail: "founder@pawspace.test", roleCode: "founder", permissions: ["people.manage", "reports.view"], periodStart: NOW - 30 * DAY, periodEnd: NOW });
  assert.equal(gated.payroll.available, false);
  assert.equal(gated.payroll.register.length, 0);
  assert.equal(gated.incentives.available, false);
});

// ---------------------------------------------------------------------------
// 3. ai-analytics: volume/containment/CSAT derive from real turns; unattributable
//    KPIs stay null instead of being invented.
// ---------------------------------------------------------------------------
test("ai-analytics: turns, containment, CSAT and filters derive exactly; unattributable KPIs stay null", async () => {
  const stack = await reportingStack();
  const { sqlite, db } = stack;
  await aiAnalyticsLib.ensureAiAnalytics(db);
  const turn = sqlite.prepare("INSERT INTO ai_conversation_turns (id,session_id,thread_id,customer_id,input_message_id,idempotency_key,channel,intent_code,intent_confidence,context_id,provider,model_ref,output_text,latency_ms,input_tokens,output_tokens,cost_minor,policy_decision,outcome,handoff_reason,created_at,completed_at) VALUES (?,?,?,?,?,?,?,?,0.9,'ctx','uat',NULL,'ok',?,?,?,?,?,?,NULL,?,?)");
  turn.run("TURN-1", "S1", "TH-1", "cus_1", "M1", "ik1", "chat", "booking_help", 400, 100, 50, 3, "allowed", "answered", NOW - 2 * DAY, NOW - 2 * DAY);
  turn.run("TURN-2", "S1", "TH-1", "cus_1", "M2", "ik2", "chat", "booking_help", 600, 120, 60, 4, "allowed", "handoff", NOW - DAY, NOW - DAY);
  turn.run("TURN-3", "S2", "TH-2", "cus_2", "M3", "ik3", "whatsapp", "pricing", 200, 80, 40, 2, "allowed", "answered", NOW - DAY, NOW - DAY);
  sqlite.prepare("INSERT INTO ai_explicit_csat (id,thread_id,customer_id,rating,source,created_at) VALUES ('C1','TH-1','cus_1',4,'survey',?)").run(NOW);
  sqlite.prepare("INSERT INTO ai_explicit_csat (id,thread_id,customer_id,rating,source,created_at) VALUES ('C2','TH-2','cus_2',5,'survey',?)").run(NOW);

  const data = await aiAnalyticsLib.buildAiAnalytics(db, {});
  assert.equal(data.volume.turns, 3);
  assert.equal(data.volume.threads, 2);
  assert.equal(data.containment.handoffTurns, 1);
  assert.equal(data.containment.rate, Number((2 / 3).toFixed(4)));
  assert.equal(data.performance.avgLatencyMs, 400, "(400+600+200)/3");
  assert.equal(data.performance.costMinor, 9);
  assert.equal(data.csat.responses, 2);
  assert.equal(data.csat.averageRating, 4.5);
  assert.equal(data.csat.inferredSentiment, false);
  // Unattributable KPIs are explicit nulls, never invented percentages.
  assert.equal(data.conversion.attributedConversionRate, null);
  assert.equal(data.firstResponseMs, null);
  assert.equal(data.resolutionMs, null);
  const chatOnly = await aiAnalyticsLib.buildAiAnalytics(db, { channel: "chat" });
  assert.equal(chatOnly.volume.turns, 2, "channel filter is exact");
});

// ---------------------------------------------------------------------------
// 4. acquisition-funnel: the real route, end to end - installs, identify, sweep,
//    payment-truthful stages.
// ---------------------------------------------------------------------------
test("acquisition-funnel route: downloads/identified/converted derive from payment truth via the real sweep", async () => {
  const stack = await reportingStack();
  const post = (body) => acquisitionFunnelRoute.POST(new Request("http://localhost/api/acquisition-funnel", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await post({ action: "record_install", installId: "INST-1", source: "play_store" })).status, 201);
  assert.equal((await post({ action: "record_install", installId: "INST-2" })).status, 201);
  assert.equal((await post({ action: "identify", installId: "INST-1", customerId: "cus_app_1" })).status, 201);
  assert.equal((await post({ action: "identify", installId: "INST-2", customerId: "cus_app_2" })).status, 201);
  // cus_app_2 books and pays; cus_app_1 never books.
  stack.seedBooking("B-APP", { customerId: "cus_app_2", serviceCode: "grooming", amount: 1200, status: "confirmed" });
  stack.seedPayment("PAY-APP", "B-APP", "cus_app_2", 1200, "captured");
  const refresh = await post({ action: "refresh" });
  assert.equal(refresh.status, 201);
  const refreshBody = await refresh.json();
  assert.equal(refreshBody.data.appInboundLeads, 1, "the no-booking app user becomes exactly one App-Inbound lead");

  const report = await acquisitionFunnelRoute.GET(new Request("http://localhost/api/acquisition-funnel"));
  assert.equal(report.status, 200);
  const funnel = (await report.json()).data.appAcquisitionFunnel;
  assert.equal(funnel.downloads, 2);
  assert.equal(funnel.identified, 2);
  assert.equal(funnel.anonymous, 0);
  assert.equal(funnel.converted, 1, "payment captured = converted");
  assert.equal(funnel.noBooking, 1);
  assert.equal(funnel.paymentPending, 0);
  assert.equal(funnel.conversionRateFromIdentified, 50, "1 of 2 identified — a real division, not a hardcoded trend");
  const badAction = await post({ action: "nonsense" });
  assert.equal(badAction.status, 400);
});

// ---------------------------------------------------------------------------
// 5. growth-intelligence: churn risk and next-best-action from real history.
// ---------------------------------------------------------------------------
test("growth-intelligence: churn risk and recommendations derive from real bookings, vaccinations and birthdays", async () => {
  const stack = await reportingStack();
  const { sqlite, db } = stack;
  await vaccinationLib.ensurePetVaccinationTables(db);
  await birthdayLib.ensurePetBirthdayTables(db);
  stack.seedBooking("B-OLD", { customerId: "cus_lapsed", serviceCode: "grooming", amount: 2000, status: "completed", start: iso(-100 * DAY) });
  stack.seedBooking("B-NEW", { customerId: "cus_active", serviceCode: "grooming", amount: 900, status: "completed", start: iso(-10 * DAY) });

  const churn = await growthLib.listChurnRisk(db, { at: NOW });
  assert.equal(churn.atRisk.length, 1, "only the lapsed customer is at risk");
  const risk = churn.atRisk[0];
  assert.equal(risk.customerId, "cus_lapsed");
  assert.equal(risk.daysSinceLastService, 100);
  assert.equal(risk.score, Math.round((100 / 120) * 100) / 100, "risk = daysSince/120, a real ratio");
  assert.equal(risk.riskLevel, "high");
  assert.equal(risk.recommendationOnly, true, "advisory only - never auto-contacts");

  sqlite.prepare("INSERT INTO canonical_pets (id,customer_id,name,species,breed,vaccination_status,source_pet_id,created_at,updated_at) VALUES ('PET-1','cus_lapsed','Bruno','dog',NULL,'not_provided',NULL,?,?)").run(NOW, NOW);
  sqlite.prepare("INSERT INTO pet_vaccinations (id,pet_id,customer_id,vaccine_type,administered_on,next_due_on,administered_by,notes,status,created_at,updated_at) VALUES ('VAX-1','PET-1','cus_lapsed','rabies','2025-08-01',?,NULL,NULL,'active',?,?)")
    .run(new Date(NOW - 2 * DAY).toISOString().slice(0, 10), NOW, NOW);
  const recs = await growthLib.recommendNextService(db, { customerId: "cus_lapsed", at: NOW });
  assert.equal(recs.recommendationOnly, true);
  assert.equal(recs.recommendations[0].type, "vaccination_due", "overdue vaccination outranks everything");
  assert.equal(recs.recommendations[0].priority, 1);
  const gaps = recs.recommendations.filter((r) => r.type === "service_gap").map((r) => r.service);
  assert.ok(!gaps.includes("grooming"), "already-used services are not cross-sell gaps");
  assert.ok(gaps.includes("dog_training") && gaps.includes("boarding"));
});

// ---------------------------------------------------------------------------
// 6. ops-intelligence: provider rank and demand forecast are exactly derivable.
// ---------------------------------------------------------------------------
test("ops-intelligence: provider rank orders by real history and the demand forecast is a transparent weekday average", async () => {
  const stack = await reportingStack();
  const { sqlite, db } = stack;
  await ratingLib.ensureBookingRatingTables(db);
  const wo = sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES (?,?,?,?,?,'full_time','grooming',?,?,1,?,'{}',?,?)");
  for (let i = 0; i < 5; i++) wo.run(`WO-G-${i}`, `B-G-${i}`, `G-G-${i}`, "prov_good", "Good Groomer", iso(-(i + 2) * DAY), iso(-(i + 2) * DAY + 3_600_000), "completed", NOW, NOW);
  wo.run("WO-B-1", "B-B-1", "G-B-1", "prov_bad", "Bad Groomer", iso(-3 * DAY), iso(-3 * DAY + 3_600_000), "completed", NOW, NOW);
  wo.run("WO-B-2", "B-B-2", "G-B-2", "prov_bad", "Bad Groomer", iso(-2 * DAY), iso(-2 * DAY + 3_600_000), "cancelled", NOW, NOW);

  const ranked = await opsLib.rankProvidersForBooking(db, { serviceCode: "grooming", at: NOW });
  assert.equal(ranked.recommendationOnly, true, "recommends an order - never assigns");
  assert.equal(ranked.ranked[0].providerId, "prov_good");
  assert.equal(ranked.ranked[0].factors.completionRate, 1);
  assert.equal(ranked.ranked[1].providerId, "prov_bad");
  assert.equal(ranked.ranked[1].factors.completionRate, 0.5, "1 completed of 2 terminal outcomes");

  // basisDays=7 means each weekday occurs exactly once: the forecast for a weekday IS that day's real count.
  const targetDay = new Date(NOW - 2 * DAY);
  for (let i = 0; i < 3; i++) stack.seedBooking(`B-D-${i}`, { customerId: `cus_d${i}`, serviceCode: "grooming", amount: 500, status: "confirmed", createdAt: targetDay.getTime() });
  const forecast = await opsLib.forecastDemand(db, { serviceCode: "grooming", basisDays: 7, horizonDays: 7, at: NOW });
  const sameWeekday = forecast.forecast.find((f) => new Date(f.date + "T00:00:00Z").getUTCDay() === targetDay.getUTCDay());
  assert.equal(sameWeekday.expectedBookings, 3, "the weekday forecast equals the real seeded count");
  assert.equal(forecast.method, "day_of_week_seasonal_v1");
});

// ---------------------------------------------------------------------------
// 7. finance-intelligence + cash-flow statement: anomalies, forecast and the
//    direct-method statement all reconcile to the journal.
// ---------------------------------------------------------------------------
test("finance-intelligence: anomalies and the cash forecast derive from the real journal and bills", async () => {
  const stack = await reportingStack();
  const { sqlite, db } = stack;
  const journal = sqlite.prepare("INSERT INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?,1,?)");
  // Unbalanced group JRN-BAD: Dr 100 vs Cr 90.
  journal.run("JRN-BAD-1", "2026-07-05", "manual", "S1", "6000-Expense", 100, 0, "bad journal", "2026-07", NOW);
  journal.run("JRN-BAD-2", "2026-07-05", "manual", "S1", financeAccounts.ACCT.BANK, 0, 90, "bad journal", "2026-07", NOW);
  // Balanced cash movements: +1000 in 2026-06, +2000 in 2026-07.
  journal.run("JRN-OK1-1", "2026-06-10", "collection", "S2", financeAccounts.ACCT.BANK, 1000, 0, "june cash", "2026-06", NOW);
  journal.run("JRN-OK1-2", "2026-06-10", "collection", "S2", financeAccounts.ACCT.REVENUE, 0, 1000, "june cash", "2026-06", NOW);
  journal.run("JRN-OK2-1", "2026-07-10", "collection", "S3", financeAccounts.ACCT.BANK, 2000, 0, "july cash", "2026-07", NOW);
  journal.run("JRN-OK2-2", "2026-07-10", "collection", "S3", financeAccounts.ACCT.REVENUE, 0, 2000, "july cash", "2026-07", NOW);
  const bill = sqlite.prepare("INSERT INTO finance_bills (id,vendor_id,bill_number,bill_date,due_date,cost_centre,vertical,taxable_amount,gst_amount,tds_amount,total_amount,status,purchase_order_id,attachment_reference,created_at,updated_at) VALUES (?,?,?,?,?,'CC','ops',?,0,0,?,'approved',NULL,NULL,?,?)");
  bill.run("BILL-1", "V1", "INV-1", "2026-07-01", "2026-07-15", 5000, 5000, NOW, NOW);
  bill.run("BILL-2", "V1", "INV-2", "2026-07-04", "2026-07-18", 5000, 5000, NOW, NOW); // duplicate: same amount, 3 days apart
  bill.run("BILL-3", "V2", "INV-3", "2026-07-01", "2026-07-15", 100, 100, NOW, NOW);
  bill.run("BILL-4", "V2", "INV-4", "2026-07-05", "2026-07-19", 100, 100, NOW, NOW);
  bill.run("BILL-5", "V2", "INV-5", "2026-07-09", "2026-07-23", 100, 100, NOW, NOW);
  bill.run("BILL-6", "V2", "INV-6", "2026-07-12", "2026-07-26", 1000, 1000, NOW, NOW); // outlier: 10x the vendor's usual

  const anomalies = await financeIntelLib.detectFinanceAnomalies(db, {});
  const types = anomalies.anomalies.map((a) => String(a.type));
  assert.ok(types.includes("unbalanced_journal"), "Dr 100 vs Cr 90 must be flagged");
  const unbalanced = anomalies.anomalies.find((a) => a.type === "unbalanced_journal");
  assert.equal(unbalanced.subjectId, "JRN-BAD");
  assert.ok(types.includes("duplicate_bill"), "same vendor+amount within 7 days must be flagged");
  assert.ok(types.includes("outlier_bill"), "10x the vendor's usual bill must be flagged");
  assert.equal(anomalies.anomalies.find((a) => a.type === "outlier_bill").subjectId, "BILL-6");

  const forecast = await financeIntelLib.forecastCashFlow(db, { months: 2 });
  // Cash lines: -90 (2026-07 bad journal credit), +1000 (06), +2000 (07) => closing 2910; monthly nets 1000 and 1910.
  assert.equal(forecast.latestClosingCash, 2910);
  assert.equal(forecast.trailingMonthlyNet, 1455, "(1000 + 1910) / 2 - a real trailing average");
  assert.equal(forecast.forecast[0].projectedClosingCash, 4365);
  assert.equal(forecast.forecast[1].projectedClosingCash, 5820);
  assert.equal(forecast.method, "trailing_net_projection_v1");
});

test("cash-flow statement: direct method from journal groups - opening, sections and closing reconcile", async () => {
  const stack = await reportingStack();
  const { sqlite, db } = stack;
  await financeAccounts.ensureFinanceJournalTable(db);
  const journal = sqlite.prepare("INSERT INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at) VALUES (?,?,?,?,?,NULL,NULL,?,?,?,?,1,?)");
  // Prior-period cash (opening balance): +1000.
  journal.run("G0-1", "2026-05-10", "collection", "S0", financeAccounts.ACCT.CASH, 1000, 0, "prior cash", "2026-05", NOW);
  journal.run("G0-2", "2026-05-10", "collection", "S0", financeAccounts.ACCT.REVENUE, 0, 1000, "prior cash", "2026-05", NOW);
  // In-window operating collection: +5000.
  journal.run("G1-1", "2026-07-10", "collection", "S1", financeAccounts.ACCT.BANK, 5000, 0, "collection", "2026-07", NOW);
  journal.run("G1-2", "2026-07-10", "collection", "S1", financeAccounts.ACCT.REVENUE, 0, 5000, "collection", "2026-07", NOW);
  // Non-cash recognition journal: must NOT appear in a cash-flow statement.
  journal.run("G2-1", "2026-07-15", "recognition", "S2", financeAccounts.ACCT.DEFERRED_REVENUE, 3000, 0, "recognise", "2026-07", NOW);
  journal.run("G2-2", "2026-07-15", "recognition", "S2", financeAccounts.ACCT.REVENUE, 0, 3000, "recognise", "2026-07", NOW);
  // Financing inflow: borrowing +2000 (account prefix 25 => financing).
  journal.run("G3-1", "2026-07-20", "loan", "S3", financeAccounts.ACCT.BANK, 2000, 0, "borrowing", "2026-07", NOW);
  journal.run("G3-2", "2026-07-20", "loan", "S3", "2500-Borrowings", 0, 2000, "borrowing", "2026-07", NOW);

  const statement = await cashFlowLib.generateCashFlowStatement(db, { periodCode: "2026-07" });
  assert.equal(statement.openingCash, 1000);
  assert.equal(statement.operating.total, 5000, "only the cash collection - the 3000 recognition journal is excluded");
  assert.equal(statement.financing.total, 2000);
  assert.equal(statement.investing.total, 0);
  assert.equal(statement.netChangeInCash, 7000);
  assert.equal(statement.closingCash, 8000);
  assert.equal(statement.reconciled, true, "sections reconcile to movement and closing balance");
  await assert.rejects(cashFlowLib.generateCashFlowStatement(db, { periodCode: "bad" }), /period \(YYYY-MM\) is required/);
});

// ---------------------------------------------------------------------------
// 8. manager-dashboard: registry-based classification and manager-only scope.
// ---------------------------------------------------------------------------
test("manager-dashboard: verticals come from governed registries and managers see only real direct reports", async () => {
  const stack = await reportingStack();
  const { sqlite, db } = stack;
  await peopleFoundation.ensurePeopleTables(db);
  await salesIncentive.ensureSalesIncentiveTables(db);
  await groomingIncentive.ensureGroomingIncentiveTables(db);
  const seedEmployee = (id, workEmail, { managerId = null, title = "Executive", team = "sales" } = {}) => {
    sqlite.prepare("INSERT INTO employees (id,user_email,employee_code,display_name,work_email,phone,employment_status,joined_at,ended_at,created_at,updated_at) VALUES (?,NULL,?,?,?,NULL,'active',?,NULL,?,?)")
      .run(id, `CODE-${id}`, `Employee ${id}`, workEmail, NOW - 90 * DAY, NOW, NOW);
    sqlite.prepare("INSERT INTO employee_employment_versions (id,employee_id,version,effective_from,effective_until,employment_type,probation_status,title,team_code,manager_employee_id,cost_centre_code,location_code,reason,actor_id,created_at) VALUES (?,?,1,?,NULL,'full_time',NULL,?,?,?,NULL,NULL,'seed','hr@test',?)")
      .run(`V-${id}`, id, NOW - 90 * DAY, title, team, managerId, NOW);
  };
  seedEmployee("EMP-M", "manager@pawspace.test");
  seedEmployee("EMP-S", "seller@pawspace.test", { managerId: "EMP-M" });
  seedEmployee("EMP-T", "trainer@pawspace.test", { title: "Dog Trainer", team: "training" });
  await salesIncentive.saveSalesEmployeeBase(db, { employeeId: "seller@pawspace.test", baseVertical: "training", effectiveFrom: new Date(NOW - 30 * DAY).toISOString().slice(0, 10), reason: "UAT sales base", actorId: "hr@test" });

  const all = await managerDashboardLib.buildManagerDashboard(db, { actorEmail: "founder@pawspace.test", permissions: ["people.manage"], asOf: NOW });
  assert.equal(all.scope, "all");
  assert.equal(all.employeeCount, 3);
  assert.equal(all.verticals.sales.length, 1, "the governed sales registry classifies the seller");
  assert.equal(all.verticals.sales[0].employeeEmail, "seller@pawspace.test");
  assert.equal(all.classificationBasis["seller@pawspace.test"], "governed_registry");
  assert.equal(all.verticals.trainers.length, 1);
  assert.equal(all.classificationBasis["trainer@pawspace.test"], "title_heuristic", "the trainer fallback is honestly flagged, not presented as registry truth");
  assert.equal(all.verticals.other.length, 1, "the manager stays unclassified");

  const managerView = await managerDashboardLib.buildManagerDashboard(db, { actorEmail: "manager@pawspace.test", permissions: ["people.view"], asOf: NOW });
  assert.equal(managerView.scope, "manager");
  assert.equal(managerView.employeeCount, 1, "only the real direct report");
  assert.equal(managerView.verticals.sales[0].employeeEmail, "seller@pawspace.test");
  assert.ok(!JSON.stringify(managerView.verticals).includes("trainer@pawspace.test"), "non-reports never leak into a manager's dashboard");
});

// ---------------------------------------------------------------------------
// 9. booking-command-center route: real GET assembly + governed POST actions.
// ---------------------------------------------------------------------------
test("booking-command-center route: assembles only real canonical joins; admin actions are reasoned and audited", async () => {
  const stack = await reportingStack();
  const { sqlite } = stack;
  // First GET bootstraps the route's own tables.
  assert.equal((await commandCenterRoute.GET(new Request("http://localhost/api/booking-command-center"))).status, 200);
  sqlite.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES ('cus_1','blr','Ananya','9999900001',NULL,NULL,'uat_customer_app','{}',?,?)").run(NOW, NOW);
  stack.seedBooking("B-CC", { customerId: "cus_1", serviceCode: "grooming", amount: 1500, status: "confirmed" });
  sqlite.prepare("INSERT INTO provider_work_orders (id,booking_id,schedule_group_id,provider_id,provider_name,provider_model,service_code,scheduled_start,scheduled_end,occurrence_count,status,assignment_json,created_at,updated_at) VALUES ('WO-CC','B-CC','g-B-CC','prov_1','Groomer One','full_time','grooming',?,?,1,'assigned','{}',?,?)").run(iso(0), iso(3_600_000), NOW, NOW);
  stack.seedPayment("PAY-CC", "B-CC", "cus_1", 1500, "created");

  const listed = await commandCenterRoute.GET(new Request("http://localhost/api/booking-command-center"));
  const payload = await listed.json();
  assert.equal(payload.bookings.length, 1);
  assert.equal(payload.bookings[0].id, "B-CC");
  assert.equal(payload.bookings[0].customer_name, "Ananya");
  assert.equal(Number(payload.bookings[0].payment_amount), 1500);
  assert.equal(payload.source, "canonical UAT database");

  const post = (body) => commandCenterRoute.POST(new Request("http://localhost/api/booking-command-center", { method: "POST", body: JSON.stringify(body) }));
  assert.equal((await post({ bookingId: "B-CC", action: "call_customer", reason: "" })).status, 400, "a reason is mandatory");
  assert.equal((await post({ bookingId: "B-CC", action: "delete_everything", reason: "valid reason" })).status, 400, "unknown actions are refused");
  assert.equal((await post({ bookingId: "MISSING", action: "call_customer", reason: "valid reason" })).status, 404);
  const acted = await post({ bookingId: "B-CC", action: "whatsapp_customer", reason: "Customer asked for an update" });
  assert.equal(acted.status, 201);
  assert.equal((await acted.json()).deliveryStatus, "uat_queued");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM booking_admin_actions WHERE booking_id='B-CC'").get().c, 1);
  assert.equal(sqlite.prepare("SELECT status FROM booking_customer_notifications WHERE booking_id='B-CC'").get().status, "uat_queued");
  assert.ok(Number(sqlite.prepare("SELECT COUNT(*) c FROM security_audit_events WHERE action='whatsapp_customer'").get().c) >= 1, "admin actions are security-audited");
});

// ---------------------------------------------------------------------------
// 10. Permission mapping per the gateway + route-level checks (gateway untouched).
// ---------------------------------------------------------------------------
test("permission mapping: gateway lines and per-route authorize() match, and no reporting surface fabricates numbers", () => {
  const read = (path) => fs.readFileSync(path, "utf8");
  const gateway = read("lib/api-gateway.ts");
  assert.match(gateway, /if\(url\.pathname==="\/api\/company-analytics"\)return "reports\.view";/);
  assert.match(gateway, /if\(url\.pathname==="\/api\/booking-command-center"\)return method==="GET"\?"bookings\.view":"bookings\.manage";/);
  const routeChecks = [
    ["app/api/company-analytics/route.ts", /authorize\(request,"reports\.view"\)/],
    ["app/api/people-reports/route.ts", /authorize\(request,"reports\.view"\)/],
    ["app/api/ai-analytics/route.ts", /authorize\(request,"reports\.view"\)/],
    ["app/api/manager-dashboard/route.ts", /authorize\(request, "people\.view"\)/],
    ["app/api/acquisition-funnel/route.ts", /requirePermission\(actor,"marketing\.view"\)/],
    ["app/api/acquisition-funnel/route.ts", /requirePermission\(actor,"marketing\.manage"\)/],
    ["app/api/growth-intelligence/route.ts", /requirePermission\(actor,"marketing\.view"\)/],
    ["app/api/ops-intelligence/route.ts", /requirePermission\(actor,"scheduling\.view"\)/],
    ["app/api/finance-intelligence/route.ts", /requirePermission\(actor,"finance\.view"\)/],
    ["app/api/cash-flow-statement/route.ts", /requirePermission\(actor,"finance\.view"\)/],
    ["app/api/booking-command-center/route.ts", /authorize\(request, "bookings\.view"\)/],
    ["app/api/booking-command-center/route.ts", /authorize\(request, "bookings\.manage"\)/],
  ];
  for (const [path, pattern] of routeChecks) assert.match(read(path), pattern, `${path} must keep ${pattern}`);
  // No fabrication anywhere in the reporting stack: no Math.random, no globalThis in routes.
  const surfaces = [
    "lib/company-analytics.ts", "lib/people-reports.ts", "lib/ai-analytics.ts", "lib/app-to-revenue-funnel.ts",
    "lib/growth-intelligence-governance.ts", "lib/ops-intelligence-governance.ts", "lib/finance-intelligence-governance.ts",
    "lib/cash-flow-statement.ts", "lib/manager-dashboard.ts",
    "app/api/company-analytics/route.ts", "app/api/people-reports/route.ts", "app/api/ai-analytics/route.ts",
    "app/api/acquisition-funnel/route.ts", "app/api/growth-intelligence/route.ts", "app/api/ops-intelligence/route.ts",
    "app/api/finance-intelligence/route.ts", "app/api/cash-flow-statement/route.ts", "app/api/manager-dashboard/route.ts",
    "app/api/booking-command-center/route.ts",
    "app/team/analytics/page.tsx", "app/team/acquisition-funnel/page.tsx", "app/team/people/reports/page.tsx",
    "app/team/ai/analytics/page.tsx", "app/team/people/manager-dashboard/page.tsx",
  ];
  for (const path of surfaces) {
    const source = read(path);
    assert.doesNotMatch(source, /Math\.random/, `${path} must not fabricate numbers`);
    if (path.startsWith("app/api/")) assert.doesNotMatch(source, /globalThis/, `${path} must not use globalThis`);
  }
  // The funnel page's only write is the route-supported refresh action.
  assert.match(read("app/team/acquisition-funnel/page.tsx"), /action: "refresh"/);
  assert.match(read("app/api/acquisition-funnel/route.ts"), /action==="refresh"/);
});
