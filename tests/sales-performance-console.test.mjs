/**
 * Staging report on /team/performance: "no UI, no test data, nothing".
 *
 * The screen could only ever be empty: it read a leaderboard that requires a productivity policy, and
 * the only way to create one was to POST to the governance API by hand. These tests drive the whole
 * path the console now exposes - save policy, activate it, generate the fact run, read the board -
 * through the real route handlers over node:sqlite, against seeded canonical source data, and assert
 * real numbers come out the other end.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

const CF_STUB = "data:text/javascript,export const env=new Proxy({},{get:(t,k)=>k===\"DB\"?globalThis.__PERF_DB__:(globalThis.__PERF_ENV__??{})[k]});";
nodeModule.registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
      throw error;
    }
  },
});

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
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
      const out = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

const PREVIEW = "http://localhost";
const NOW = Date.now();
const DAY = 86_400_000;

// DDL copied verbatim from the modules that own each table: drizzle/0011_serious_shaman.sql for
// canonical_bookings and app/api/revenue-crm/route.ts for customer_experience_tickets. Every other
// table is created by calling its own module's ensure* function below.
const CANONICAL_BOOKINGS = "CREATE TABLE IF NOT EXISTS canonical_bookings (id text PRIMARY KEY NOT NULL, idempotency_key text NOT NULL, customer_id text NOT NULL, pet_ids_json text NOT NULL, source_pet_ids_json text NOT NULL, city_id text NOT NULL, zone_id text NOT NULL, service_code text NOT NULL, package_code text NOT NULL, package_name text NOT NULL, schedule_group_id text NOT NULL, provider_id text NOT NULL, scheduled_start text NOT NULL, scheduled_end text NOT NULL, status text DEFAULT 'confirmed' NOT NULL, channel text DEFAULT 'customer_app' NOT NULL, total_amount real NOT NULL, currency text DEFAULT 'INR' NOT NULL, pricing_json text DEFAULT '{}' NOT NULL, created_by text NOT NULL, created_at integer NOT NULL, updated_at integer NOT NULL)";
const CX_TICKETS = "CREATE TABLE IF NOT EXISTS customer_experience_tickets (id TEXT PRIMARY KEY, customer_id TEXT, booking_id TEXT, lead_id TEXT, category TEXT NOT NULL, priority TEXT NOT NULL, subject TEXT NOT NULL, detail TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, sla_due_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'open', escalation_level INTEGER NOT NULL DEFAULT 0, customer_status TEXT NOT NULL DEFAULT 'We received your request', resolution TEXT, root_cause TEXT, resolution_evidence TEXT, reopened_count INTEGER NOT NULL DEFAULT 0, created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, resolved_at INTEGER)";

async function seedWorkspace() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PERF_DB__ = db;
  globalThis.__PERF_ENV__ = {};

  const assignments = await import("../lib/lead-assignment-governance.ts");
  const sla = await import("../lib/lead-sla-governance.ts");
  const mission = await import("../lib/revenue-mission-control.ts");
  const opportunities = await import("../lib/revenue-opportunity-governance.ts");
  const security = await import("../lib/server-auth.ts");
  await security.ensureSecurityTables(db);
  await assignments.ensureLeadAssignmentTables(db);
  await sla.ensureLeadSlaTables(db);
  await mission.ensureRevenueMissionTables(db);
  await opportunities.ensureRevenueOpportunityTables(db);
  sqlite.exec(CANONICAL_BOOKINGS);
  sqlite.exec(CX_TICKETS);

  const reps = [
    { email: "rep.one@pawspace.in", name: "Rep One", leads: 3, revenue: 42000, refund: 2000 },
    { email: "rep.two@pawspace.in", name: "Rep Two", leads: 2, revenue: 18000, refund: 0 },
  ];
  for (const rep of reps) {
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .run(`USR-${rep.email}`, rep.email, rep.name, "associate", "active", NOW, NOW);
    sqlite.prepare("INSERT INTO lead_assignment_memberships (id,employee_email,team_code,service_codes_json,city_ids_json,language_codes_json,active,workload_cap_override,created_by,created_at,updated_by,updated_at) VALUES (?,?,?,?,?,?,1,NULL,?,?,?,?)")
      .run(`MEM-${rep.email}`, rep.email, "sales", "[]", "[]", "[]", "seed", NOW, "seed", NOW);

    for (let index = 0; index < rep.leads; index += 1) {
      const leadId = `LEAD-${rep.email}-${index}`;
      const assignmentId = `ASG-${rep.email}-${index}`;
      const at = NOW - 5 * DAY;
      sqlite.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,recycle_cycle,opt_out,converted_booking_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,0,0,?,?,?)")
        .run(leadId, `CUS-${rep.email}-${index}`, "web", "grooming", rep.email, "manager@pawspace.in", at, at + 600000, at + 1_800_000, index === 0 ? `BKG-${rep.email}` : null, at, at);
      sqlite.prepare("INSERT INTO lead_assignments (id,idempotency_key,lead_id,employee_email,team_code,policy_id,policy_version,assignment_reason,status,assigned_at,accepted_at,detail_json,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,'current',?,?,'{}',?,?)")
        .run(assignmentId, `${assignmentId}-idem`, leadId, rep.email, "sales", "LAP-SEED", 1, "round_robin", at, at + 60_000, "seed", at);
      sqlite.prepare("INSERT INTO lead_sla_clocks (id,idempotency_key,lead_id,assignment_id,policy_id,policy_version,clock_type,cycle,status,started_at,due_at,manager_escalation_due_at,reassignment_due_at,met_at,detail_json,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,'first_response',1,?,?,?,?,?,?,'{}',?,?,?)")
        .run(`CLK-${assignmentId}`, `CLK-${assignmentId}-idem`, leadId, assignmentId, "LSP-SEED", 1, index === 0 ? "met" : "running", at, at + 600_000, at + 1_800_000, at + 3_600_000, index === 0 ? at + 300_000 : null, "seed", at, at);
      sqlite.prepare("INSERT INTO lead_sla_events (id,idempotency_key,clock_id,lead_id,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,'action_recorded',?,?,?)")
        .run(`EVT-${assignmentId}`, `EVT-${assignmentId}-idem`, `CLK-${assignmentId}`, leadId, rep.email, JSON.stringify({ actionType: "call", outcome: index === 0 ? "qualified" : "call_back_later" }), at + 300_000);
    }

    const bookingId = `BKG-${rep.email}`;
    const at = NOW - 4 * DAY;
    sqlite.prepare("INSERT INTO canonical_bookings (id,idempotency_key,customer_id,pet_ids_json,source_pet_ids_json,city_id,zone_id,service_code,package_code,package_name,schedule_group_id,provider_id,scheduled_start,scheduled_end,status,channel,total_amount,currency,pricing_json,created_by,created_at,updated_at) VALUES (?,?,?,'[]','[]','blr','zone-1','grooming','pkg','Full groom',?,'PRV-1',?,?,'confirmed','customer_app',?,'INR','{}',?,?,?)")
      .run(bookingId, `${bookingId}-idem`, `CUS-${rep.email}-0`, `SG-${bookingId}`, new Date(at).toISOString(), new Date(at + 3_600_000).toISOString(), rep.revenue, "seed", at, at);
    sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES (?,?,?,'collected',?,?,'grooming','blr',?,0,?,'INR',?,'v1','{}',?)")
      .run(`RME-${rep.email}-c`, "MIS-1", `${bookingId}-collected`, `CUS-${rep.email}-0`, bookingId, rep.revenue, rep.revenue, at, at);
    if (rep.refund) {
      sqlite.prepare("INSERT INTO revenue_mission_events (id,mission_id,source_event_key,event_type,customer_id,booking_id,service_code,city_id,gross_amount,refund_amount,eligible_amount,currency,source_at,source_version,attribution_json,created_at) VALUES (?,?,?,'refunded',?,?,'grooming','blr',0,?,0,'INR',?,'v1','{}',?)")
        .run(`RME-${rep.email}-r`, "MIS-1", `${bookingId}-refunded`, `CUS-${rep.email}-0`, bookingId, rep.refund, at + 3600_000, at);
    }
  }
  return { sqlite, db };
}

const post = async (route, body) => route.POST(new Request(`${PREVIEW}/api/sales-productivity-governance`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const readJson = async (response) => ({ status: response.status, payload: await response.json() });

test("real execution: the console path configures a policy and produces a ranked leaderboard", async () => {
  await seedWorkspace();
  const governanceRoute = await import("../app/api/sales-productivity-governance/route.ts");
  const performanceRoute = await import("../app/api/employee-performance/route.ts");

  // The state the staging screen was stuck in: no policy, so the board is empty by construction.
  const before = await readJson(await performanceRoute.GET(new Request(`${PREVIEW}/api/employee-performance?metric=net_collected_revenue&days=30`)));
  assert.equal(before.status, 200);
  assert.deepEqual(before.payload.data.rows, []);

  // Step 1 on the console: define what counts, then activate.
  const saved = await readJson(await post(governanceRoute, {
    action: "save_policy", name: "Sales productivity (UAT baseline)", teamCode: "sales", timezone: "Asia/Kolkata",
    meaningfulActionTypes: ["call"], qualifiedOutcomes: ["qualified"], revenueBasis: "net_collected",
    requireCanonicalLeadBookingLink: true, effectiveFrom: NOW - 365 * DAY,
    reason: "UAT baseline productivity policy configured from the performance console",
  }));
  assert.equal(saved.status, 201);
  assert.equal(saved.payload.data.status, "draft");

  const activated = await readJson(await post(governanceRoute, {
    action: "activate_policy", policyId: saved.payload.data.id, approvalReference: "UAT-CONSOLE",
    reason: "UAT baseline productivity policy activated from the performance console",
  }));
  assert.equal(activated.status, 200);
  assert.equal(activated.payload.data.status, "active_uat");

  // Step 2: generate the run for the window on screen.
  const generated = await readJson(await post(governanceRoute, {
    action: "generate_facts", periodStart: NOW - 30 * DAY, periodEnd: NOW, idempotencyKey: "console-30d-test",
  }));
  assert.equal(generated.status, 200);
  assert.equal(generated.payload.data.facts.length, 2);

  // The board now carries real, source-derived numbers - not zeros.
  const after = await readJson(await performanceRoute.GET(new Request(`${PREVIEW}/api/employee-performance?metric=net_collected_revenue&days=30`)));
  const rows = after.payload.data.rows;
  assert.equal(rows.length, 2);
  assert.equal(rows[0].employeeEmail, "rep.one@pawspace.in");
  assert.equal(rows[0].employeeName, "Rep One");
  assert.equal(rows[0].rank, 1);
  assert.equal(rows[0].leadsAssigned, 3);
  assert.equal(rows[0].meaningfulActions, 3, "three 'call' actions counted by the policy vocabulary");
  assert.equal(rows[0].qualifiedLeads, 1, "one lead reached a 'qualified' outcome");
  assert.equal(rows[0].bookingConversions, 1);
  assert.equal(rows[0].netCollectedRevenue, 40000, "42000 collected less the 2000 refund");
  assert.equal(rows[1].employeeEmail, "rep.two@pawspace.in");
  assert.equal(rows[1].netCollectedRevenue, 18000);
  assert.equal(after.payload.data.totals.net, 58000);
  assert.equal(after.payload.data.totals.conversions, 2);
  assert.ok(after.payload.data.period.sourceRun, "the board names the run it is showing");

  // Re-running the same window is idempotent, so a second click cannot double-count.
  const replay = await readJson(await post(governanceRoute, {
    action: "generate_facts", periodStart: NOW - 30 * DAY, periodEnd: NOW, idempotencyKey: "console-30d-test",
  }));
  assert.equal(replay.payload.data.duplicatePrevented, true);
  assert.equal(replay.payload.data.facts.length, 2);
});

test("real execution: ranking by a different metric re-orders the same run", async () => {
  await seedWorkspace();
  const governanceRoute = await import("../app/api/sales-productivity-governance/route.ts");
  const performanceRoute = await import("../app/api/employee-performance/route.ts");

  const saved = await readJson(await post(governanceRoute, {
    action: "save_policy", name: "Sales productivity (UAT baseline)", teamCode: "sales", timezone: "Asia/Kolkata",
    meaningfulActionTypes: ["call"], qualifiedOutcomes: ["qualified"], revenueBasis: "net_collected",
    requireCanonicalLeadBookingLink: true, effectiveFrom: NOW - 365 * DAY,
    reason: "UAT baseline productivity policy configured from the performance console",
  }));
  await post(governanceRoute, { action: "activate_policy", policyId: saved.payload.data.id, approvalReference: "UAT-CONSOLE", reason: "UAT baseline productivity policy activated from the console" });
  await post(governanceRoute, { action: "generate_facts", periodStart: NOW - 30 * DAY, periodEnd: NOW, idempotencyKey: "console-metric-test" });

  const byActions = await readJson(await performanceRoute.GET(new Request(`${PREVIEW}/api/employee-performance?metric=meaningful_actions&days=30`)));
  assert.equal(byActions.payload.data.metric, "meaningful_actions");
  assert.deepEqual(byActions.payload.data.rows.map((row) => row.meaningfulActions), [3, 2]);
});

test("real execution: the setup panel reads its vocabulary and roster from live source data", async () => {
  await seedWorkspace();
  const governanceRoute = await import("../app/api/sales-productivity-governance/route.ts");

  const directory = await readJson(await governanceRoute.GET(new Request(`${PREVIEW}/api/sales-productivity-governance`)));
  assert.equal(directory.status, 200);
  const setup = directory.payload.data.setup;
  assert.deepEqual(setup.teamRoster, [{ teamCode: "sales", members: 2 }]);
  assert.deepEqual(setup.observedActionTypes, ["call"]);
  assert.deepEqual(setup.observedOutcomes.sort(), ["call_back_later", "qualified"]);
});

test("real execution: setup diagnostics degrade to empty on a database without the lead engine", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__PERF_DB__ = makeD1(sqlite);
  globalThis.__PERF_ENV__ = {};
  const governanceRoute = await import("../app/api/sales-productivity-governance/route.ts");

  const directory = await readJson(await governanceRoute.GET(new Request(`${PREVIEW}/api/sales-productivity-governance`)));
  assert.equal(directory.status, 200);
  assert.deepEqual(directory.payload.data.setup, { teamRoster: [], teamMembers: [], observedActionTypes: [], observedOutcomes: [], observedServiceCodes: [], observedCityIds: [] });
});

test("real execution: generating a report on a database without the lead engine completes instead of 500ing", async () => {
  // Clicking Generate on a fresh deployment used to answer `D1_ERROR: no such table:
  // lead_assignment_memberships`, which the console showed as a red failure with nothing to act on.
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__PERF_DB__ = makeD1(sqlite);
  globalThis.__PERF_ENV__ = {};
  const governanceRoute = await import("../app/api/sales-productivity-governance/route.ts");

  const saved = await readJson(await post(governanceRoute, {
    action: "save_policy", name: "Sales productivity (UAT baseline)", teamCode: "sales", timezone: "Asia/Kolkata",
    meaningfulActionTypes: ["call"], qualifiedOutcomes: ["qualified"], revenueBasis: "net_collected",
    requireCanonicalLeadBookingLink: true, effectiveFrom: NOW - 365 * DAY,
    reason: "UAT baseline productivity policy configured from the performance console",
  }));
  await post(governanceRoute, { action: "activate_policy", policyId: saved.payload.data.id, approvalReference: "UAT-CONSOLE", reason: "UAT baseline productivity policy activated from the console" });

  const generated = await readJson(await post(governanceRoute, {
    action: "generate_facts", periodStart: NOW - 30 * DAY, periodEnd: NOW, idempotencyKey: "console-bare-db",
  }));
  assert.equal(generated.status, 200);
  assert.ok(generated.payload.data.run.id, "the run is recorded even with nothing to measure");
  assert.deepEqual(generated.payload.data.facts, [], "no roster means no employee rows, not a failed run");

  // A genuine SQL error is still surfaced rather than swallowed with the missing-table case.
  const productivity = await import("../lib/sales-productivity-governance.ts");
  sqlite.exec("CREATE TABLE lead_assignment_memberships (employee_email TEXT)");
  await assert.rejects(
    productivity.generateSalesProductivityFacts(globalThis.__PERF_DB__, { periodStart: NOW - 30 * DAY, periodEnd: NOW, idempotencyKey: "console-broken-db", actorId: "tester@pawspace.in" }),
    /no such column|no such table: app_users|SQLITE/i,
  );
});

test("real execution: mapping a rep from the console puts them on the next report", async () => {
  // Nothing in the app could map a rep to a team - the action existed only on the lead assignment
  // API - so a staging leaderboard had no roster to measure and stayed empty whatever else was set up.
  const { sqlite } = await seedWorkspace();
  sqlite.exec("DELETE FROM lead_assignment_memberships");
  const assignmentRoute = await import("../app/api/lead-assignment-governance/route.ts");
  const governanceRoute = await import("../app/api/sales-productivity-governance/route.ts");

  const empty = await readJson(await governanceRoute.GET(new Request(`${PREVIEW}/api/sales-productivity-governance`)));
  assert.deepEqual(empty.payload.data.setup.teamMembers, [], "an unmapped team starts with no roster");

  const added = await assignmentRoute.POST(new Request(`${PREVIEW}/api/lead-assignment-governance`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save_member", employeeEmail: "rep.one@pawspace.in", teamCode: "sales", serviceCodes: ["grooming"], cityIds: ["blr"], active: true }),
  }));
  assert.equal(added.status, 200);

  const withRoster = await readJson(await governanceRoute.GET(new Request(`${PREVIEW}/api/sales-productivity-governance`)));
  assert.deepEqual(withRoster.payload.data.setup.teamMembers, [{ teamCode: "sales", employeeEmail: "rep.one@pawspace.in", name: "Rep One" }]);
  assert.deepEqual(withRoster.payload.data.setup.teamRoster, [{ teamCode: "sales", members: 1 }]);
  // The scope inputs are prefilled from what the bookings actually use, not from invented codes.
  assert.deepEqual(withRoster.payload.data.setup.observedServiceCodes, ["grooming"]);
  assert.deepEqual(withRoster.payload.data.setup.observedCityIds, ["blr"]);

  const saved = await readJson(await post(governanceRoute, {
    action: "save_policy", name: "Sales productivity (UAT baseline)", teamCode: "sales", timezone: "Asia/Kolkata",
    meaningfulActionTypes: ["call"], qualifiedOutcomes: ["qualified"], revenueBasis: "net_collected",
    requireCanonicalLeadBookingLink: true, effectiveFrom: NOW - 365 * DAY,
    reason: "UAT baseline productivity policy configured from the performance console",
  }));
  await post(governanceRoute, { action: "activate_policy", policyId: saved.payload.data.id, approvalReference: "UAT-CONSOLE", reason: "UAT baseline productivity policy activated from the console" });
  const generated = await readJson(await post(governanceRoute, { action: "generate_facts", periodStart: NOW - 30 * DAY, periodEnd: NOW, idempotencyKey: "console-roster" }));
  assert.equal(generated.payload.data.facts.length, 1, "only the mapped rep is measured");
  assert.equal(generated.payload.data.facts[0].employeeEmail, "rep.one@pawspace.in");

  // Removing the rep takes them off the roster without touching the run that already measured them.
  await assignmentRoute.POST(new Request(`${PREVIEW}/api/lead-assignment-governance`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "save_member", employeeEmail: "rep.one@pawspace.in", teamCode: "sales", serviceCodes: ["grooming"], cityIds: ["blr"], active: false }),
  }));
  const afterRemoval = await readJson(await governanceRoute.GET(new Request(`${PREVIEW}/api/sales-productivity-governance`)));
  assert.deepEqual(afterRemoval.payload.data.setup.teamMembers, []);
});

test("the performance console renders a real surface, not a bare instruction banner", async () => {
  const [page, css] = await Promise.all([
    readFile(new URL("../app/team/performance/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/team/performance/performance.module.css", import.meta.url), "utf8"),
  ]);

  // Built from the shared design system rather than inline system-ui styles.
  for (const component of ["PageHeader", "StatCard", "Badge", "Button", "EmptyState"]) assert.match(page, new RegExp(component));
  assert.doesNotMatch(page, /fontFamily:"system-ui,sans-serif"/);

  // The links that were indistinguishable from body text are styled, focusable navigation.
  assert.match(css, /\.nav a \{/);
  assert.match(css, /focus-visible/);

  // Setup is performed here: both governance actions the leaderboard needs are wired to buttons.
  assert.match(page, /action:"save_policy"/);
  assert.match(page, /action:"activate_policy"/);
  assert.match(page, /action:"generate_facts"/);
  // A repeated click on the same window cannot create a second run for it.
  assert.match(page, /idempotencyKey:`console-\$\{days\}d-/);
  // An empty board explains which prerequisite is missing instead of showing bare zeros.
  assert.match(page, /No reps are mapped to team/);
  // The roster itself is manageable here - the mapping action had no surface anywhere in the app.
  assert.match(page, /action:"save_member"/);
  assert.match(page, /Add to \{teamCode\} team/);
});
