/*
 * GET /api/leaderboard — the whole staff sales board was served to external commission partners.
 *
 * The route gated on `authorize(request,"self_service.view")` and did no subject scoping at all. The
 * `service_provider` role holds `self_service.view` (lib/platform-security.ts), so a partner signed in
 * with a partner session — an identity whose /api/me answers "No employee record linked yet" — got
 * HTTP 200 and every employee's NAME, WORK EMAIL and NET COLLECTED REVENUE, which /leaderboard then
 * rendered in full. That role's own description bounds it to "own earnings/rank self-service WHEN
 * LINKED TO AN EMPLOYEE RECORD"; nothing enforced the link.
 *
 * Everything here EXECUTES the shipped route handler against a real SQLite-backed D1 (the shared
 * counting harness), with real identities: a verified identity binding plus an issued platform session
 * for the partner, and the workspace identity header for staff. No source text is matched, and no
 * localhost URL is used — resolveActor short-circuits localhost to a development-preview superuser and
 * every assertion below would then pass for the wrong reason.
 *
 * The board is seeded with distinctive, identifiable staff rows. An empty board would prove nothing:
 * zero rows look identical whether the boundary holds or there was simply no data.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { installWorkersHooks, enterWorkersDbScope } from "./helpers/module-hooks.mjs";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { importLibModule } from "./helpers/ts-module-loader.mjs";

process.env.NODE_ENV = "test";
delete process.env.PAWSPACE_DEPLOYMENT_ENV;
installWorkersHooks("__LEADERBOARD_SCOPE_DB__", "__LEADERBOARD_SCOPE_ENV__");
// PAWSPACE_UAT_LOGIN deliberately unset: the staging sign-in path must not be what authenticates anyone here.
globalThis.__LEADERBOARD_SCOPE_ENV__ = {};

const { ensureSalesProductivityTables } = await importLibModule("sales-productivity-governance");
const { ensureWorkforcePersonLinkTables } = await importLibModule("workforce-person-linkage");
const { upsertEmployee } = await importLibModule("people-foundation");
const { upsertIdentityBinding } = await importLibModule("identity-binding");
const { issuePlatformSession, PLATFORM_SESSION_COOKIE } = await importLibModule("platform-session");
const { defaultRoles, parsePermissions } = await importLibModule("platform-security");
const leaderboardRoute = await import("../app/api/leaderboard/route.ts");

const NOW = Date.UTC(2026, 8, 15);
const DAY = 86_400_000;

/* Staff rows. Every one of these strings is PII that an unlinked external identity must never receive. */
const STAFF = [
  { email: "uat.demo.sales1@tkpetcare.in", name: "Demo · Neha (Sales)", team: "sales", revenue: 921_337, conversions: 14, leads: 22 },
  { email: "uat.demo.sales2@tkpetcare.in", name: "Demo · Rahul (Sales)", team: "sales", revenue: 613_571, conversions: 9, leads: 17 },
  { email: "uat.demo.cx3@tkpetcare.in", name: "Demo · Fatima (CX)", team: "cx", revenue: 484_729, conversions: 6, leads: 11 },
];
/* The contract partner's OWN row — their entitlement, not a leak. Ranked last, so "own rank" is a real rank. */
const PARTNER = { email: "contract.partner@tkpetcare.in", name: "Contract · Imran (Grooming)", team: "grooming", revenue: 300_021, conversions: 3, leads: 5 };
const BOARD = [...STAFF, PARTNER];

const LINKED_PROVIDER = "PRV-CONTRACT-LINKED";
const EXTERNAL_PROVIDER = "PRV-EXTERNAL-COMMISSION";
const MANAGER_EMAIL = "ops.manager@pawspace.in";
const EXTERNAL_STAFF_ROLE_EMAIL = "commission.partner@external.example";

/** Names and work emails of OTHER people. None may appear anywhere in a scoped response. */
const STAFF_PII = STAFF.flatMap((row) => [row.name, row.email]);
/** Their revenue figures, checked against the employees array so a 13-digit `asOf` cannot alias a match. */
const STAFF_REVENUE = STAFF.map((row) => String(row.revenue));

async function seed() {
  const { sqlite, db } = freshCountingD1();
  enterWorkersDbScope(db);
  globalThis.__LEADERBOARD_SCOPE_DB__ = db;

  // Real DDL from the modules that own these tables, not a hand-written fixture schema.
  await ensureSalesProductivityTables(db);
  await ensureWorkforcePersonLinkTables(db);
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");

  const addUser = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)");
  // employeeBoard() joins app_users for the display name, so these carry the names that must not leak.
  BOARD.forEach((row, index) => addUser.run(`APPU-${index}`, row.email, row.name, "associate", NOW, NOW));
  addUser.run("APPU-MGR", MANAGER_EMAIL, "Ops manager", "manager", NOW, NOW);
  // A service_provider role held by a WORKSPACE identity: the same entitlement, without a partner session.
  addUser.run("APPU-EXT", EXTERNAL_STAFF_ROLE_EMAIL, "External commission partner", "service_provider", NOW, NOW);

  sqlite.prepare("INSERT INTO sales_productivity_fact_runs (id,idempotency_key,policy_id,policy_version,period_start,period_end,status,source_contract_version,generated_by,generated_at,detail_json) VALUES (?,?,?,?,?,?,'completed',?,?,?,'{}')")
    .run("RUN-LB-SCOPE", "runkey-lb-scope", "POL-1", 1, NOW - 30 * DAY, NOW, "v1", "test", NOW);
  const addFact = sqlite.prepare("INSERT INTO sales_productivity_facts (id,run_id,employee_email,team_code,period_start,period_end,booking_conversions,net_collected_revenue,qualified_leads,first_response_clocks,first_response_met,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
  BOARD.forEach((row, index) => addFact.run(`FACT-${index}`, "RUN-LB-SCOPE", row.email, row.team, NOW - 30 * DAY, NOW, row.conversions, row.revenue, row.leads, 10, 9, NOW));

  return { sqlite, db };
}

/** The People linkage a full-time contract partner gets — the row lib/workforce-person-linkage.ts writes. */
async function linkPartnerToEmployeeRecord(sqlite, db) {
  const employee = await upsertEmployee(db, {
    employeeCode: `CTR-${LINKED_PROVIDER}`, displayName: PARTNER.name,
    workEmail: PARTNER.email, userEmail: PARTNER.email, joinedAt: NOW - 200 * DAY, actorId: "test",
  });
  sqlite.prepare("UPDATE employees SET employment_status='contract_active' WHERE id=?").run(String(employee.id));
  sqlite.prepare("INSERT INTO provider_people_links (provider_id,employee_id,engagement_kind,status,source,created_by,created_at,updated_at) VALUES (?,?,'contract','active','provider_onboarding','test',?,?)")
    .run(LINKED_PROVIDER, String(employee.id), NOW, NOW);
  return String(employee.id);
}

/** A real partner session: verified identity binding, then an issued session cookie. One principal per provider. */
const PRINCIPALS = { [LINKED_PROVIDER]: "+919900000011", [EXTERNAL_PROVIDER]: "+919900000012" };
async function providerCookie(db, providerId) {
  const principalKey = PRINCIPALS[providerId];
  if (!principalKey) throw new Error(`No test principal for ${providerId} — add one rather than sharing a key`);
  const binding = await upsertIdentityBinding(db, {
    identitySource: "partner_otp", principalType: "identity_subject", principalKey,
    subjectType: "provider", subjectId: providerId, verificationState: "verified",
    actorId: "test", reason: "leaderboard self-service scope test",
  });
  const issued = await issuePlatformSession(db, {
    bindingId: String(binding.id), identitySource: "partner_otp", principalType: "identity_subject",
    principalKey: String(binding.principal_key), subjectType: "provider", subjectId: providerId,
  });
  return `${PLATFORM_SESSION_COOKIE}=${encodeURIComponent(issued.token)}`;
}

const ENDPOINT = "https://uat.pawspace.in/api/leaderboard";
const asPartnerSession = (cookie) => new Request(ENDPOINT, { headers: { cookie } });
const asWorkspace = (email) => new Request(ENDPOINT, { headers: { "oai-authenticated-user-email": email } });

async function get(request) {
  const response = await leaderboardRoute.GET(request);
  let body = null;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}
const payload = (body) => JSON.stringify(body ?? {});
const employees = (body) => (Array.isArray(body?.data?.employees) ? body.data.employees : []);
const leakedPii = (body) => STAFF_PII.filter((secret) => payload(body).includes(secret));

// ---------------------------------------------------------------------------
// The exploit.
// ---------------------------------------------------------------------------
test("an external partner with no employee record receives no colleague's name, work email or revenue", async () => {
  const { sqlite, db } = await seed();
  await linkPartnerToEmployeeRecord(sqlite, db);           // a DIFFERENT partner is linked; this one is not
  const { status, body } = await get(asPartnerSession(await providerCookie(db, EXTERNAL_PROVIDER)));

  const leaked = leakedPii(body);
  assert.deepEqual(leaked, [], `unlinked partner -> HTTP ${status} -> leaked ${leaked.length} staff field(s): ${leaked.join(" | ")}`);
  const rows = JSON.stringify(employees(body));
  const revenue = STAFF_REVENUE.filter((amount) => rows.includes(amount));
  assert.deepEqual(revenue, [], `unlinked partner -> HTTP ${status} -> leaked revenue: ${revenue.join(" | ")}`);
  assert.equal(employees(body).length, 0, `unlinked partner received ${employees(body).length} employee rows`);
  assert.equal(body?.data?.counts?.employees, 0, "the counts must describe what was actually returned");
});

test("the same partner through a workspace identity holding the service_provider role is scoped identically", async () => {
  // Proves the boundary is the employee link, not the shape of the session: same role, different identity source.
  const { sqlite, db } = await seed();
  await linkPartnerToEmployeeRecord(sqlite, db);
  const { status, body } = await get(asWorkspace(EXTERNAL_STAFF_ROLE_EMAIL));
  const leaked = leakedPii(body);
  assert.deepEqual(leaked, [], `service_provider workspace identity -> HTTP ${status} -> leaked: ${leaked.join(" | ")}`);
  assert.equal(employees(body).length, 0);
});

test("the refusal is governed: 200 with an empty own-board, scope.linked=false and a reason - never someone else's data", async () => {
  const { sqlite, db } = await seed();
  await linkPartnerToEmployeeRecord(sqlite, db);
  const { status, body } = await get(asPartnerSession(await providerCookie(db, EXTERNAL_PROVIDER)));
  assert.equal(status, 200, `the partner holds self_service.view legitimately: ${payload(body).slice(0, 200)}`);
  assert.equal(body.data.scope.level, "self");
  assert.equal(body.data.scope.linked, false);
  assert.ok(String(body.data.scope.reason || "").length > 20, "an unlinked identity must be told why its board is empty");
  assert.equal(body.data.scope.reason, leaderboardRoute.NOT_LINKED_REASON);
});

// ---------------------------------------------------------------------------
// Control cases. Refusing everyone is not a fix.
// ---------------------------------------------------------------------------
test("a partner WHO IS linked to an employee record keeps its own row and its own real rank", async () => {
  const { sqlite, db } = await seed();
  await linkPartnerToEmployeeRecord(sqlite, db);
  const { status, body } = await get(asPartnerSession(await providerCookie(db, LINKED_PROVIDER)));

  assert.equal(status, 200, payload(body).slice(0, 200));
  assert.equal(employees(body).length, 1, `a linked partner must see exactly its own row, got ${employees(body).length}`);
  const own = employees(body)[0];
  assert.equal(own.email, PARTNER.email);
  assert.equal(own.netCollectedRevenue, PARTNER.revenue);
  // Rank is computed across the WHOLE board before the filter, so "my rank" is the real rank, not 1 of 1.
  assert.equal(own.rank, BOARD.length, "own rank must stay the rank among everyone, not a rank within the filtered board");
  assert.equal(body.data.scope.linked, true);
  assert.equal(body.data.scope.ofEmployees, BOARD.length, "how many peers are ranked is a number, not other people's PII");
  const leaked = leakedPii(body);
  assert.deepEqual(leaked, [], `a linked partner still must not see colleagues: ${leaked.join(" | ")}`);
});

test("staff who review performance keep the full board", async () => {
  const { sqlite, db } = await seed();
  await linkPartnerToEmployeeRecord(sqlite, db);
  const { status, body } = await get(asWorkspace(MANAGER_EMAIL));

  assert.equal(status, 200, payload(body).slice(0, 200));
  assert.equal(employees(body).length, BOARD.length, "a manager must still see everyone");
  assert.equal(body.data.scope.level, "full");
  assert.deepEqual(employees(body).map((row) => row.rank), [1, 2, 3, 4]);
  assert.equal(employees(body)[0].name, STAFF[0].name, "ranked by real net collected revenue");
  for (const secret of STAFF_PII) assert.ok(payload(body).includes(secret), `the full board must still carry ${secret}`);
});

// ---------------------------------------------------------------------------
// Why performance.view is the permission that expresses "may see the whole board".
// Derived from the shipped role catalogue, so granting it to an external role fails here.
// ---------------------------------------------------------------------------
test("performance.view separates internal reviewers from the non-staff session roles", async () => {
  const holds = (code, permission) => {
    const role = defaultRoles.find((item) => item.code === code);
    assert.ok(role, `role ${code} must exist`);
    const permissions = parsePermissions(role.permissions);
    return permissions.includes("*") || permissions.includes(permission);
  };
  for (const code of ["founder", "superuser", "admin", "manager", "associate", "auditor"]) {
    assert.equal(holds(code, "performance.view"), true, `${code} reviews performance and must keep the full board`);
  }
  for (const code of ["service_provider", "customer"]) {
    assert.equal(holds(code, "performance.view"), false, `${code} is a non-staff role and must never hold full-board visibility`);
  }
  // And the reason the old gate leaked: the permission it checked is one the external role holds.
  assert.equal(holds("service_provider", "self_service.view"), true);
});
