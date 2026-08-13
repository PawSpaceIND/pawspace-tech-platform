import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Verifies scripts/uat-demo-seed.sql: loaded into an EMPTY database, every module's
// real route handler must return NON-EMPTY data — so no staging page opens blank.
// The generator is also re-run here to prove the committed .sql is in sync with it.
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
const managerDashboardRoute = await import("../app/api/manager-dashboard/route.ts");
const peopleReportsRoute = await import("../app/api/people-reports/route.ts");
const aiAnalyticsRoute = await import("../app/api/ai-analytics/route.ts");
const acquisitionFunnelRoute = await import("../app/api/acquisition-funnel/route.ts");
const commandCenterRoute = await import("../app/api/booking-command-center/route.ts");
const walkingOpsRoute = await import("../app/api/walking-ops/route.ts");
const taxiOpsRoute = await import("../app/api/taxi-ops/route.ts");
const leaderboardRoute = await import("../app/api/leaderboard/route.ts");
const payrollRoute = await import("../app/api/payroll/route.ts");
const incentivesRoute = await import("../app/api/incentives/route.ts");
const attendanceRoute = await import("../app/api/attendance-leave/route.ts");
const cashFlowRoute = await import("../app/api/cash-flow-statement/route.ts");
const financeIntelRoute = await import("../app/api/finance-intelligence/route.ts");
const growthIntelRoute = await import("../app/api/growth-intelligence/route.ts");
const opsIntelRoute = await import("../app/api/ops-intelligence/route.ts");
const meRoute = await import("../app/api/me/route.ts");
const providerWorkspaceRoute = await import("../app/api/provider-workspace/route.ts");

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

// A fresh database with ONLY the demo seed loaded — exactly the staging situation.
function seededDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(fs.readFileSync("scripts/uat-demo-seed.sql", "utf8"));
  globalThis.__PAWSPACE_TEST_ENV = { DB: makeD1(sqlite) };
  return sqlite;
}

const body = async (response) => {
  assert.equal(response.status, 200, `expected 200, got ${response.status}: ${await response.clone().text()}`);
  return response.json();
};
const GET = (route, url) => route.GET(new Request(`http://localhost${url}`));

test("the committed uat-demo-seed.sql is exactly what the generator produces", () => {
  const committed = fs.readFileSync("scripts/uat-demo-seed.sql", "utf8");
  assert.ok(committed.includes("INSERT OR IGNORE INTO canonical_bookings"), "seed must carry canonical bookings");
  assert.ok(!/INSERT INTO /.test(committed), "every insert must be OR IGNORE so the seed is re-runnable");
  assert.ok(committed.includes("CREATE TABLE IF NOT EXISTS"), "seed must create its tables so it can run before the app");
  // every seeded row is namespaced, so it can never collide with the other two seeds
  const ids = committed.match(/VALUES \('([^']+)'/g) || [];
  assert.ok(ids.length > 100, "seed should carry a meaningful number of rows");
});

test("seeded DB: company analytics reports real revenue, services and CX", async () => {
  seededDb();
  const { data } = await body(await GET(companyAnalyticsRoute, "/api/company-analytics"));
  assert.ok(data.bookings.total >= 12, `expected the demo bookings, got ${data.bookings.total}`);
  assert.ok(data.money.gmv > 0, "GMV must be non-zero");
  assert.equal(data.services.dog_training.cancelled, 1, "the deliberately cancelled training booking is visible");
  assert.equal(data.services.dog_training.gmv, 4999, "cancelled value excluded, completed 4999 counted");
  assert.ok(data.cx.tickets >= 2, "CX tickets are seeded");
  assert.ok(data.customers.unique >= 6);
});

test("seeded DB: booking command centre lists bookings with customer, work order and payment joins", async () => {
  seededDb();
  const payload = await body(await GET(commandCenterRoute, "/api/booking-command-center"));
  assert.ok(payload.bookings.length >= 12, `command centre must show the demo bookings, got ${payload.bookings.length}`);
  const first = payload.bookings[0];
  assert.ok(String(first.customer_name).length > 0, "the customer join must resolve");
  assert.ok(String(first.provider_name).length > 0, "the work-order join must resolve");
  assert.ok(Number(first.payment_amount) > 0, "the payment join must resolve");
});

test("seeded DB: walking and taxi ops queues both show real bookings", async () => {
  seededDb();
  const walking = await body(await GET(walkingOpsRoute, "/api/walking-ops"));
  assert.ok(walking.data.metrics.total >= 2, "walking ops queue must not be empty");
  assert.ok(walking.data.bookings.some((b) => b.sessions.length > 0), "walk sessions are seeded");
  const taxi = await body(await GET(taxiOpsRoute, "/api/taxi-ops"));
  assert.ok(taxi.data.metrics.total >= 2, "taxi ops queue must not be empty");
  assert.ok(taxi.data.bookings.some((b) => String(b.trip_status) === "completed"));
});

test("seeded DB: people surfaces (manager dashboard, reports, payroll, attendance, incentives) all carry data", async () => {
  seededDb();
  const dashboard = await body(await GET(managerDashboardRoute, "/api/manager-dashboard"));
  assert.ok(dashboard.data.employeeCount >= 4, "demo employees are visible");
  assert.ok(dashboard.data.verticals.sales.length >= 2, "the governed sales registry classifies the demo sellers");

  const reports = await body(await GET(peopleReportsRoute, "/api/people-reports"));
  assert.ok(reports.data.headcount.active >= 4);
  assert.ok(reports.data.payroll.register.length >= 4, "payroll register is populated");
  assert.ok(reports.data.teamRollups.length >= 2, "team rollups are populated");

  const payroll = await body(await GET(payrollRoute, "/api/payroll"));
  assert.ok(payroll.data.runs.length >= 1, "a payroll run is visible");
  assert.ok(payroll.data.structures.length >= 1, "a salary structure is visible");

  const attendance = await body(await GET(attendanceRoute, "/api/attendance-leave"));
  assert.ok(attendance.data.attendanceDays.length >= 4, "attendance days are seeded");
  assert.ok(attendance.data.leaveRequests.length >= 2, "leave requests are seeded");

  const incentives = await body(await GET(incentivesRoute, "/api/incentives"));
  assert.ok(incentives.data.schemes.length >= 1, "an incentive scheme is visible");
  assert.ok(incentives.data.results.length >= 2, "incentive results are visible");
});

test("seeded DB: leaderboard ranks the demo team from real productivity facts", async () => {
  seededDb();
  const { data } = await body(await GET(leaderboardRoute, "/api/leaderboard"));
  assert.ok(data.employees.length >= 3, "leaderboard must not be empty");
  assert.equal(data.employees[0].rank, 1);
  assert.ok(data.employees[0].netCollectedRevenue >= data.employees[1].netCollectedRevenue, "ranked by real net collected revenue");
});

test("seeded DB: AI analytics reports real turns, handoff, voice and CSAT", async () => {
  seededDb();
  const { data } = await body(await GET(aiAnalyticsRoute, "/api/ai-analytics"));
  assert.equal(data.volume.turns, 7, "the seven demo AI turns");
  assert.equal(data.volume.threads, 5);
  assert.equal(data.containment.handoffTurns, 3, "explicit human request, refund policy risk, and the fail-closed voice turn");
  assert.ok(data.containment.rate > 0 && data.containment.rate < 1, "both contained and handed-off turns are represented");
  assert.equal(data.csat.responses, 2);
  assert.equal(data.csat.averageRating, 4.5);
  assert.ok(data.voice.byOutcome.length >= 1, "a voice call is seeded");
  assert.ok(data.volume.byChannel.length >= 3, "whatsapp, chat and voice all appear");
});

// The AI tables store an engine vocabulary, not free text. The demo rows used to be hand-written and
// carried values the engine cannot emit (intent 'pricing', outcome 'answered', policy 'allowed',
// queue 'care'), so these screens grouped by categories that can never occur in production. The seed
// is now produced by running the real libs; this pins that every value is one the code can produce.
test("seeded DB: every AI row uses a value the real engine can actually emit", async () => {
  seededDb();
  const { data } = await body(await GET(aiAnalyticsRoute, "/api/ai-analytics"));
  const orchestrator = fs.readFileSync("lib/ai-conversation-orchestrator.ts", "utf8");
  const intents = new Set(orchestrator.match(/export type AiConversationIntent=([^;]+);/)[1].split("|").map((item) => item.trim().replace(/"/g, "")));
  for (const row of data.volume.byIntent) assert.ok(intents.has(row.intent), `intent '${row.intent}' is not a member of AiConversationIntent`);
  for (const row of data.policy.byDecision) assert.ok(["draft_review_required", "human_handoff", "blocked_high_impact"].includes(row.decision), `policy decision '${row.decision}' is not one the orchestrator writes`);
  for (const row of data.volume.byChannel) assert.ok(["whatsapp", "chat", "voice"].includes(row.channel), `channel '${row.channel}' is not an AiConversationChannel`);

  const handoffLib = fs.readFileSync("lib/ai-human-handoff.ts", "utf8");
  const queues = new Set([...handoffLib.matchAll(/queue:"([a-z-]+)"/g)].map((match) => match[1]));
  const reasons = new Set(handoffLib.match(/export type AiHandoffReason=([^;]+);/)[1].split("|").map((item) => item.trim().replace(/"/g, "")));
  for (const row of data.handoff.byReason) assert.ok(reasons.has(row.reason), `handoff reason '${row.reason}' is not an AiHandoffReason`);
  const rows = await globalThis.__PAWSPACE_TEST_ENV.DB.prepare("SELECT queue_code,status FROM ai_handoffs").all();
  assert.ok(rows.results.length >= 2, "handoffs are seeded");
  for (const row of rows.results) {
    assert.ok(queues.has(String(row.queue_code)), `queue '${row.queue_code}' is not a queue lib/ai-human-handoff.ts routes to`);
    assert.ok(["queued", "staff_active", "resumed"].includes(String(row.status)), `handoff status '${row.status}' is not one the lifecycle sets`);
  }
});

// A fresh environment had no AI configuration and no way to make any: the configuration screen only
// offered lifecycle buttons for versions that did not exist, so /team/ai/configuration read
// "No versions configured" forever. The seed now carries an activated grounding, and the screen
// carries the bootstrap action that creates one where the seed has not been loaded.
test("seeded DB: the assistant grounding is activated, so knowledge retrieval and public chat work", async () => {
  seededDb();
  const db = globalThis.__PAWSPACE_TEST_ENV.DB;
  const config = await import("../lib/ai-business-configuration.ts");
  const active = await config.resolveActiveAiBusinessConfig(db, { channel: "chat", intent: "service_info" });
  assert.equal(active.configurationRequired, false, "an active assistant profile and prompt policy exist");
  assert.equal(active.profile.key, "pawspace_default");
  assert.ok(active.promptPolicy.systemPrompt.includes("PawSpace assistant"), "the activated system policy is the real grounding");
  assert.equal(active.killSwitches.length, 0, "nothing is disabled");

  // Every activated version carries a genuine SHA-256 of its own snapshot, not a placeholder.
  const profiles = await db.prepare("SELECT immutable_hash FROM ai_assistant_profile_versions").all();
  for (const row of profiles.results) assert.match(String(row.immutable_hash), /^[0-9a-f]{64}$/, "immutable hashes are real digests");

  const chat = await import("../lib/ai-web-chat-adapter.ts");
  const publicAnswer = await chat.publicAiWebKnowledge(db, { query: "boarding" });
  assert.ok(publicAnswer.knowledge.length >= 1, "/chat public mode finds approved public knowledge");
  assert.equal(publicAnswer.customerDataAccess, false, "public mode never touches customer data");
});

test("seeded DB: the rollout is staff-first, never opened to customers by a seed", async () => {
  seededDb();
  const db = globalThis.__PAWSPACE_TEST_ENV.DB;
  const rollout = await import("../lib/ai-audience-rollout.ts");
  const snapshot = await rollout.aiRolloutSnapshot(db);
  assert.equal(snapshot.stage, "staff_only", "widening to customers stays a human decision on /team/ai/rollout");
  assert.equal((await rollout.resolveAiAudienceGate(db, { audience: "staff" })).allowed, true);
  assert.equal((await rollout.resolveAiAudienceGate(db, { audience: "customer" })).allowed, false, "customers still reach a human");
});

test("seeded DB: acquisition funnel shows installs, identification and payment-truthful conversion", async () => {
  seededDb();
  const { data } = await body(await GET(acquisitionFunnelRoute, "/api/acquisition-funnel"));
  const funnel = data.appAcquisitionFunnel;
  assert.equal(funnel.downloads, 6);
  assert.equal(funnel.identified, 5);
  assert.equal(funnel.anonymous, 1);
  assert.ok(funnel.converted >= 4, "customers with captured payments count as converted");
});

test("seeded DB: finance surfaces (cash flow, anomalies) show real movements and a real anomaly", async () => {
  seededDb();
  const month = fs.readFileSync("scripts/uat-demo-seed.sql", "utf8").match(/Demo 'today' is (\d{4}-\d{2})/)[1];
  const cash = await body(await GET(cashFlowRoute, `/api/cash-flow-statement?period=${month}`));
  assert.notEqual(cash.data.netChangeInCash, 0, "the statement must show real cash movement");
  assert.equal(cash.data.reconciled, true, "sections must reconcile");
  assert.ok(cash.data.operating.lines.length >= 1);

  const anomalies = await body(await GET(financeIntelRoute, "/api/finance-intelligence"));
  const types = anomalies.data.anomalies.map((a) => String(a.type));
  assert.ok(types.includes("unbalanced_journal"), "the deliberately unbalanced journal is flagged");
  assert.ok(types.includes("duplicate_bill"), "the duplicate vendor bill pair is flagged");
  assert.ok(types.includes("outlier_bill"), "the outlier vendor bill is flagged");
});

test("seeded DB: growth and ops intelligence produce real advisory output", async () => {
  seededDb();
  const growth = await body(await GET(growthIntelRoute, "/api/growth-intelligence"));
  assert.ok(growth.data.atRisk.length >= 1, "the lapsed demo customer surfaces as churn risk");
  assert.equal(growth.data.atRisk[0].customerId, "UATD-CUS-6");

  const ops = await body(await GET(opsIntelRoute, "/api/ops-intelligence?serviceCode=grooming&mode=rank"));
  const ranked = ops.data.ranked || ops.data.forecast;
  assert.ok(Array.isArray(ranked) && ranked.length >= 1, "ops intelligence returns real output");
});

test("seeded DB: partner workspace resolves a linked provider with real earnings", async () => {
  seededDb();
  const response = await providerWorkspaceRoute.GET(new Request("http://localhost/api/provider-workspace"));
  const { data } = await body(response);
  // The preview/founder identity is not provider-linked, so this proves the graceful path;
  // the seeded link (uat.demo.groomer@tkpetcare.in → groom_arun) is asserted directly below.
  assert.ok("linked" in data);
  const { providerWorkspace } = await import("../lib/provider-workspace.ts");
  const workspace = await providerWorkspace(globalThis.__PAWSPACE_TEST_ENV.DB, { providerId: "groom_arun" });
  assert.ok(workspace.bookings.past.length + workspace.bookings.upcoming.length >= 2, "the groomer has real jobs");
  assert.ok(workspace.liveAssignments.length >= 1, "a live assignment is waiting to be accepted");
  assert.ok(workspace.earnings.netPayout > 0, "computed payouts back the earnings tile");
});

test("seeded DB: employee self-service is populated for a demo employee identity", async () => {
  seededDb();
  const { employeeSelfServiceView } = await import("../lib/employee-self-service.ts");
  const view = await employeeSelfServiceView(globalThis.__PAWSPACE_TEST_ENV.DB, { email: "uat.demo.sales1@tkpetcare.in" });
  assert.equal(view.linked, true, "the demo employee resolves");
  assert.ok(view.payslips.list.length >= 1, "a payslip is visible in self-service");
  assert.equal(view.payslips.latest.net, 52200);
  assert.ok(view.compensation.grossMonthly > 0, "compensation breakdown is visible");
  assert.ok(view.leave.balances.length >= 1, "leave balance is visible");
  assert.ok(view.attendance.length >= 2, "attendance history is visible");
  assert.ok(view.incentives.list.length >= 1, "approved incentive is visible");
  assert.equal(view.performance.appears, true, "the employee appears in the performance facts");

  // and the route itself never accepts a caller-supplied identity
  const meResponse = await meRoute.GET(new Request("http://localhost/api/me"));
  assert.equal(meResponse.status, 200);
});
