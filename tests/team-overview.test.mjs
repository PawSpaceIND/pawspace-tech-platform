import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// /team was a static shell: "Revenue actions 100", "Open escalations 3", "7 PM command pack
// Ready", "18 bookings today", "3 need attention", "Day close pending", "8 active partners"
// and even the signed-in identity were literals typed into the page. Every one of those
// figures already existed in a canonical table. These tests hold them to real data.
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

const teamOverviewRoute = await import("../app/api/team-overview/route.ts");
const { buildTeamOverview } = await import("../lib/team-overview.ts");

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

const NOW = Date.UTC(2026, 7, 13, 6, 0, 0);
const TODAY = new Date(NOW + 19_800_000).toISOString().slice(0, 10);
const ACTOR = { actorEmail: "founder@pawspace.in", actorName: "Karthik P", roleCode: "founder", asOf: NOW };

function db() {
  const sqlite = new DatabaseSync(":memory:");
  const shim = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: shim };
  return { sqlite, shim };
}

test("cold database: every counter is null (rendered '—'), never an invented number", async () => {
  const { shim } = db();
  const overview = await buildTeamOverview(shim, ACTOR);
  assert.equal(overview.commandStrip.revenueActions, null);
  assert.equal(overview.commandStrip.openEscalations, null);
  assert.equal(overview.commandStrip.firstResponseMinutes, null);
  assert.equal(overview.commandStrip.commandPackReports, null);
  assert.equal(overview.workspaces.bookingsToday, null);
  assert.equal(overview.workspaces.dayCloseStatus, null);
  assert.equal(overview.workspaces.activeEmployees, null);
  assert.equal(overview.truth.fabricatedCounters, false);
});

test("every counter derives exactly from seeded canonical rows", async () => {
  const { sqlite, shim } = db();
  sqlite.exec("CREATE TABLE revenue_opportunities (id TEXT PRIMARY KEY,opportunity_date TEXT NOT NULL,status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO revenue_opportunities VALUES ('O1',?,'open'),('O2',?,'open'),('O3',?,'completed'),('O4','2026-01-01','open')").run(TODAY, TODAY, TODAY);
  sqlite.exec("CREATE TABLE customer_experience_tickets (id TEXT PRIMARY KEY,status TEXT NOT NULL,escalation_level INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO customer_experience_tickets VALUES ('T1','open',1),('T2','open',0),('T3','resolved',2)").run();
  sqlite.exec("CREATE TABLE command_report_runs (id TEXT PRIMARY KEY,report_date TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO command_report_runs VALUES ('R1',?),('R2',?)").run(TODAY, TODAY);
  sqlite.exec("CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,scheduled_start TEXT NOT NULL,status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO canonical_bookings VALUES ('B1',?,'confirmed'),('B2',?,'completed'),('B3',?,'cancelled'),('B4','2026-01-05T10:00:00.000Z','confirmed')")
    .run(`${TODAY}T09:00:00.000Z`, `${TODAY}T14:00:00.000Z`, `${TODAY}T16:00:00.000Z`);
  sqlite.exec("CREATE TABLE finance_day_closures (closure_date TEXT PRIMARY KEY,status TEXT NOT NULL,escalation_level INTEGER NOT NULL DEFAULT 0)");
  sqlite.prepare("INSERT INTO finance_day_closures VALUES (?,'open',0)").run(TODAY);
  sqlite.exec("CREATE TABLE employees (id TEXT PRIMARY KEY,employment_status TEXT NOT NULL)");
  sqlite.prepare("INSERT INTO employees VALUES ('E1','active'),('E2','active'),('E3','exited')").run();
  sqlite.exec("CREATE TABLE lead_work_items (id TEXT PRIMARY KEY,assigned_at INTEGER,first_action_due_at INTEGER,manager_alert_at INTEGER)");
  sqlite.prepare("INSERT INTO lead_work_items VALUES ('L1',?,?,?)").run(NOW, NOW + 10 * 60_000, NOW + 30 * 60_000);

  const overview = await buildTeamOverview(shim, ACTOR);
  assert.equal(overview.commandStrip.revenueActions, 2, "today's open opportunities only — completed and other days excluded");
  assert.equal(overview.commandStrip.openEscalations, 1, "unresolved tickets with an escalation level");
  assert.equal(overview.commandStrip.openTickets, 2);
  assert.equal(overview.commandStrip.firstResponseMinutes, 10, "read off a real lead, not restated as a constant");
  assert.equal(overview.commandStrip.managerAlertMinutes, 30);
  assert.equal(overview.commandStrip.commandPackReports, 2);
  assert.equal(overview.workspaces.bookingsToday, 2, "today's bookings excluding cancelled and other days");
  assert.equal(overview.workspaces.ticketsNeedAttention, 2);
  assert.equal(overview.workspaces.dayCloseStatus, "open");
  assert.equal(overview.workspaces.activeEmployees, 2);
  assert.equal(overview.actor.name, "Karthik P", "the identity is the real signed-in actor");
  assert.equal(overview.actor.roleCode, "founder");
});

test("the route serves it under the gateway's dashboard.view default without touching the gateway", async () => {
  db();
  const response = await teamOverviewRoute.GET(new Request("http://localhost/api/team-overview"));
  assert.equal(response.status, 200);
  const { data } = await response.json();
  assert.ok(data.actor.email, "the signed-in actor is resolved server-side");
  const route = fs.readFileSync("app/api/team-overview/route.ts", "utf8");
  assert.match(route, /requirePermission\(actor,"dashboard\.view"\)/);
  assert.match(route, /await import\("cloudflare:workers"\)|database\(\)/, "DB access goes through the shared helper");
  assert.doesNotMatch(route, /globalThis/);
  assert.doesNotMatch(route, /export async function POST/, "the front door is read-only");
  // the gateway already defaults unmapped routes to dashboard.view — no gateway edit was needed
  assert.match(fs.readFileSync("lib/api-gateway.ts", "utf8"), /return "dashboard\.view";/);
});

test("the team page renders API values and no longer hardcodes any counter", () => {
  const page = fs.readFileSync("app/team/page.tsx", "utf8");
  assert.match(page, /fetch\("\/api\/team-overview"/, "the page loads real data");
  for (const fabricated of ["18 bookings today", "3 need attention", "8 active partners", "Day close pending"]) {
    assert.ok(!page.includes(fabricated), `the fabricated card metric '${fabricated}' must be gone`);
  }
  // the command strip reads from the payload rather than literals
  assert.match(page, /show\(strip\?\.revenueActions\)/);
  assert.match(page, /show\(strip\?\.openEscalations\)/);
  assert.ok(!/<b>100<\/b>/.test(page), "the hardcoded 100 revenue actions is gone");
  assert.ok(!/<b>3<\/b>/.test(page), "the hardcoded 3 escalations is gone");
  assert.ok(!/<b>10 min<\/b>/.test(page), "the hardcoded SLA is gone");
  assert.ok(!/<b>Ready<\/b>/.test(page), "the hardcoded command-pack status is gone");
  // identity comes from the actor, not a typed-in name
  assert.ok(!page.includes("Good morning, Karthik"), "the greeting is derived from the real actor");
  assert.ok(!page.includes("Super admin"), "the role label comes from the real actor");
  assert.match(page, /data\.actor\.roleCode/);
  assert.match(page, /const DASH = "—"/, "unknown values render as a dash, never a guess");
});
