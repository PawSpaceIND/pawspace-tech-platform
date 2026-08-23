import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// /api/scheduling-rules authorization.
//
// Scheduling rules are operations configuration: a read exposes how work is allocated, a write
// changes it for every future booking. The authoritative policy for this path is already declared in
// lib/api-gateway.ts:
//
//   GET                  /api/scheduling-rules -> scheduling.view
//   POST/PATCH/DELETE    /api/scheduling-rules -> scheduling.manage
//
// The worker enforces that map before the route runs, so this endpoint was never anonymously
// writable in production. What it lacked was any check of its own, which made that one gateway entry
// a single point of failure - unlike its sibling /api/provider-capacity-control, which carries the
// route-level check as well. These tests pin both layers:
//
//   * the route handlers themselves now refuse an unauthorized caller, and every denial is asserted
//     against the DATABASE, not just the HTTP status - a 403 that still wrote the row would pass a
//     status-only assertion;
//   * the gateway map still declares those permissions and still does not treat this path as public.
//
// Requests deliberately use a NON-localhost host: resolveActor and authorizeApiRequest both
// short-circuit localhost/127.0.0.1/terminal.local to a development-preview superuser holding ["*"],
// which would make every assertion here vacuous. That short-circuit is asserted to be host-gated.
// ---------------------------------------------------------------------------

installWorkersHooks("__SR_DB__", "__SR_ENV__");

const ORIGIN = "https://ops.pawspace.example";
const ENDPOINT = `${ORIGIN}/api/scheduling-rules`;
const NOW = 1770000000000;
const EXISTING = "rule_existing";
const EXISTING_NAME = "Do not double-book groomers";

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const route = await import("../app/api/scheduling-rules/route.ts");
const serverAuth = await import("../lib/server-auth.ts");
const gateway = await import("../lib/api-gateway.ts");

// Schema copied from the only place that creates this table, app/api/uat-scheduling/route.ts.
const SCHEMA = "CREATE TABLE IF NOT EXISTS scheduling_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,priority INTEGER NOT NULL DEFAULT 100,condition_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__SR_DB__ = db;
  globalThis.__SR_ENV__ = {};
  await serverAuth.ensureSecurityTables(db);           // seeds app_users + the fixed role catalogue
  sqlite.exec(SCHEMA);
  sqlite.prepare("INSERT INTO scheduling_rules (id,name,service_code,city_id,zone_id,priority,condition_json,active,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(EXISTING, EXISTING_NAME, "grooming", "blr", null, 10, "[]", 1, "ops@pawspace.in", NOW, NOW);
  return { sqlite, db };
}

// Roles are derived from the seeded catalogue rather than hardcoded, so a permission moving between
// roles changes what these tests mean instead of silently making them wrong.
function rolesByPermission(sqlite) {
  const rows = sqlite.prepare("SELECT code,permissions_json FROM role_definitions").all();
  const holds = (permissions, wanted) => permissions.includes("*") || permissions.includes(wanted);
  const manage = [], viewOnly = [], neither = [];
  for (const row of rows) {
    let permissions = [];
    try { permissions = JSON.parse(String(row.permissions_json)); } catch { permissions = []; }
    const code = String(row.code);
    if (holds(permissions, "scheduling.manage")) manage.push(code);
    else if (holds(permissions, "scheduling.view")) viewOnly.push(code);
    else neither.push(code);
  }
  return { manage, viewOnly, neither };
}

function seedUser(sqlite, email, roleCode) {
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run(`USR-${email}`, email, email.split("@")[0], roleCode, NOW, NOW);
  return email;
}

const asStaff = (email, init = {}) => new Request(init.url ?? ENDPOINT, { ...init, headers: { ...(init.headers ?? {}), "oai-authenticated-user-email": email } });
const anonymous = (init = {}) => new Request(init.url ?? ENDPOINT, init);
const jsonInit = (method, body) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const rules = (sqlite) => sqlite.prepare("SELECT id,name,active,priority,created_by FROM scheduling_rules ORDER BY id").all();
const refused = (response) => [401, 403].includes(response.status);

// ---------------------------------------------------------------------------
// The tests only mean something if the role catalogue actually distinguishes these permissions.
// ---------------------------------------------------------------------------

test("the role catalogue distinguishes scheduling.manage from scheduling.view", async () => {
  const { sqlite } = await world();
  const { manage, viewOnly, neither } = rolesByPermission(sqlite);
  assert.ok(manage.length > 0, "no role grants scheduling.manage, so the authorized path is not expressible");
  assert.ok(viewOnly.length > 0, "no role holds scheduling.view without scheduling.manage, so escalation cannot be tested");
  assert.ok(neither.length > 0, "no role lacks both, so the denial case is not expressible");
});

// ---------------------------------------------------------------------------
// Anonymous callers: refused, and the database is untouched.
// ---------------------------------------------------------------------------

test("an anonymous caller cannot read the scheduling rules", async () => {
  await world();
  const response = await route.GET(anonymous());
  assert.ok(refused(response), `expected a sign-in or forbidden status, got ${response.status}`);
  const body = JSON.stringify(await response.json());
  assert.doesNotMatch(body, new RegExp(EXISTING_NAME, "i"), "a refused read must not leak rule content");
  assert.doesNotMatch(body, /condition_json|service_code/i, "a refused read must not leak the configuration shape");
});

test("an anonymous POST cannot create a rule, and inserts nothing", async () => {
  const { sqlite } = await world();
  const before = rules(sqlite);
  const response = await route.POST(anonymous(jsonInit("POST", { name: "ANONYMOUS INJECTED RULE", conditions: [{ any: true }], priority: 1 })));
  assert.ok(refused(response), `expected a refusal, got ${response.status}`);
  assert.deepEqual(rules(sqlite), before, "the refusal must leave the table byte-for-byte unchanged");
  assert.equal(rules(sqlite).length, 1, "no row may be inserted by an unauthorized caller");
});

test("an anonymous PATCH cannot modify an existing rule, and changes no field", async () => {
  const { sqlite } = await world();
  const before = rules(sqlite);
  const response = await route.PATCH(anonymous(jsonInit("PATCH", { id: EXISTING, active: false, name: "disabled by stranger", priority: 999 })));
  assert.ok(refused(response), `expected a refusal, got ${response.status}`);
  assert.deepEqual(rules(sqlite), before, "the refusal must leave every field unchanged");
  const row = sqlite.prepare("SELECT active,name,priority FROM scheduling_rules WHERE id=?").get(EXISTING);
  assert.equal(row.active, 1, "the rule must still be active");
  assert.equal(row.name, EXISTING_NAME, "the rule name must be untouched");
  assert.equal(row.priority, 10, "the rule priority must be untouched");
});

test("an anonymous DELETE cannot remove a rule, and the row survives", async () => {
  const { sqlite } = await world();
  const before = rules(sqlite);
  const response = await route.DELETE(anonymous({ method: "DELETE", url: `${ENDPOINT}?id=${EXISTING}` }));
  assert.ok(refused(response), `expected a refusal, got ${response.status}`);
  assert.deepEqual(rules(sqlite), before, "the refusal must leave the table unchanged");
  assert.ok(sqlite.prepare("SELECT id FROM scheduling_rules WHERE id=?").get(EXISTING), "the rule must still exist");
});

// ---------------------------------------------------------------------------
// A broad view/booking permission must not become a write permission.
// ---------------------------------------------------------------------------

test("a role holding scheduling.view but not scheduling.manage may read but never write", async () => {
  const { sqlite } = await world();
  const { viewOnly } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "viewer@pawspace.in", viewOnly[0]);

  const read = await route.GET(asStaff(email));
  assert.equal(read.status, 200, `role ${viewOnly[0]} holds scheduling.view and must be allowed to read`);

  const before = rules(sqlite);
  for (const [method, request] of [
    ["POST", asStaff(email, jsonInit("POST", { name: "escalated", conditions: [{ any: true }] }))],
    ["PATCH", asStaff(email, jsonInit("PATCH", { id: EXISTING, active: false }))],
    ["DELETE", asStaff(email, { method: "DELETE", url: `${ENDPOINT}?id=${EXISTING}` })],
  ]) {
    const response = await route[method](request);
    assert.equal(response.status, 403, `${method} must be refused for role ${viewOnly[0]}, got ${response.status}`);
    assert.deepEqual(rules(sqlite), before, `${method} must not have changed persistence`);
  }
});

test("a role holding neither permission is refused on every method", async () => {
  const { sqlite } = await world();
  const { neither } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "outsider@pawspace.in", neither[0]);
  const before = rules(sqlite);

  assert.equal((await route.GET(asStaff(email))).status, 403, `role ${neither[0]} must not read scheduling rules`);
  for (const [method, request] of [
    ["POST", asStaff(email, jsonInit("POST", { name: "nope", conditions: [{ any: true }] }))],
    ["PATCH", asStaff(email, jsonInit("PATCH", { id: EXISTING, active: false }))],
    ["DELETE", asStaff(email, { method: "DELETE", url: `${ENDPOINT}?id=${EXISTING}` })],
  ]) {
    assert.equal((await route[method](request)).status, 403, `${method} must be refused for role ${neither[0]}`);
  }
  assert.deepEqual(rules(sqlite), before, "nothing this role attempted may have persisted");
});

test("an identity that was never provisioned is refused", async () => {
  const { sqlite } = await world();
  const before = rules(sqlite);
  const response = await route.POST(asStaff("stranger@pawspace.in", jsonInit("POST", { name: "x", conditions: [{ any: true }] })));
  assert.ok(refused(response), `expected a refusal, got ${response.status}`);
  assert.deepEqual(rules(sqlite), before);
});

test("a suspended identity is refused even with a scheduling.manage role", async () => {
  const { sqlite } = await world();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "former.ops@pawspace.in", manage[0]);
  sqlite.prepare("UPDATE app_users SET status='suspended' WHERE email=?").run(email);
  const before = rules(sqlite);
  const response = await route.POST(asStaff(email, jsonInit("POST", { name: "x", conditions: [{ any: true }] })));
  assert.ok(refused(response), `expected a refusal, got ${response.status}`);
  assert.deepEqual(rules(sqlite), before, "a suspended identity must not be able to write");
});

// ---------------------------------------------------------------------------
// The authorized path still works, for every method that was gated.
// ---------------------------------------------------------------------------

test("an authorized operator can read the rules", async () => {
  const { sqlite } = await world();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const response = await route.GET(asStaff(email));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1, "the seeded rule must still be returned to an authorized reader");
  assert.equal(body.data[0].name, EXISTING_NAME);
});

test("an authorized operator can create a rule", async () => {
  const { sqlite } = await world();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const response = await route.POST(asStaff(email, jsonInit("POST", { name: "Avoid Sunday grooming", conditions: [{ code: "weekday", operator: "neq", value: 0 }], priority: 20 })));
  assert.equal(response.status, 201, `authorized creation must still succeed, got ${response.status}`);
  const created = sqlite.prepare("SELECT name,priority,created_by FROM scheduling_rules WHERE name=?").get("Avoid Sunday grooming");
  assert.ok(created, "the rule must actually be persisted");
  assert.equal(created.priority, 20);
  assert.equal(created.created_by, email, "created_by must be the verified actor, not a caller-supplied field");
});

test("created_by cannot be spoofed through the request body", async () => {
  const { sqlite } = await world();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const response = await route.POST(asStaff(email, jsonInit("POST", { name: "Attributed rule", conditions: [{ any: true }], createdBy: "someone.else@pawspace.in" })));
  assert.equal(response.status, 201);
  const created = sqlite.prepare("SELECT created_by FROM scheduling_rules WHERE name=?").get("Attributed rule");
  assert.equal(created.created_by, email, "the body must not be able to dictate who a change is attributed to");
});

test("an authorized operator can update a rule", async () => {
  const { sqlite } = await world();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const response = await route.PATCH(asStaff(email, jsonInit("PATCH", { id: EXISTING, active: false, priority: 5 })));
  assert.equal(response.status, 200, `authorized update must still succeed, got ${response.status}`);
  const row = sqlite.prepare("SELECT active,priority FROM scheduling_rules WHERE id=?").get(EXISTING);
  assert.equal(row.active, 0, "the update must actually persist");
  assert.equal(row.priority, 5);
});

test("an authorized operator can delete a rule", async () => {
  const { sqlite } = await world();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const response = await route.DELETE(asStaff(email, { method: "DELETE", url: `${ENDPOINT}?id=${EXISTING}` }));
  assert.equal(response.status, 200, `authorized deletion must still succeed, got ${response.status}`);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_rules").get().c, 0, "the deletion must actually persist");
});

test("validation still runs for an authorized caller, and only after authorization", async () => {
  const { sqlite } = await world();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const bad = await route.POST(asStaff(email, jsonInit("POST", { name: "", conditions: [] })));
  assert.equal(bad.status, 400, "an authorized but invalid request is still a 400");
  // The same malformed input from an anonymous caller must be refused, not validated: a 400 here
  // would confirm the endpoint's shape to someone who is not allowed to use it at all.
  const stranger = await route.POST(anonymous(jsonInit("POST", { name: "", conditions: [] })));
  assert.ok(refused(stranger), `authorization must precede validation, got ${stranger.status}`);
});

// ---------------------------------------------------------------------------
// The development-preview superuser must stay host-gated, or every test above is vacuous.
// ---------------------------------------------------------------------------

test("the development-preview superuser bypass is host-gated", async () => {
  await world();
  const remote = await route.GET(anonymous());
  assert.ok(refused(remote), "a real host must never receive the preview superuser");
  const local = await route.GET(new Request("http://localhost/api/scheduling-rules"));
  assert.equal(local.status, 200, "localhost keeps its documented preview bypass");
});

// ---------------------------------------------------------------------------
// The gateway layer this route now doubles up on: its policy must not silently change.
// ---------------------------------------------------------------------------

test("the gateway still declares scheduling.view for reads and scheduling.manage for writes", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(source, /"\/api\/scheduling-rules"\)return method==="GET"\?"scheduling\.view":"scheduling\.manage"/,
    "the authoritative permission map for this path has changed; the route-level check must be kept in step with it");
});

test("the gateway does not treat scheduling-rules as a public path", async () => {
  // requiredPermission() returns null for allowlisted public paths. If this route were ever added to
  // that list, the route-level check added here would become the only thing protecting it - which is
  // exactly why it exists, but it should not happen silently.
  const anonymousRead = await gateway.authorizeApiRequest(new Request(ENDPOINT), { DB: globalThis.__SR_DB__ });
  assert.ok(anonymousRead instanceof Response, "the gateway must refuse an anonymous read outright");
  assert.ok([401, 403].includes(anonymousRead.status), `expected the gateway to refuse, got ${anonymousRead.status}`);
});

test("the gateway refuses an anonymous write before the route is reached", async () => {
  await world();
  const decision = await gateway.authorizeApiRequest(new Request(ENDPOINT, jsonInit("POST", { name: "x", conditions: [{ any: true }] })), { DB: globalThis.__SR_DB__ });
  assert.ok(decision instanceof Response, "an anonymous write must be refused by the gateway, not passed through");
  assert.ok([401, 403].includes(decision.status), `expected 401/403 from the gateway, got ${decision.status}`);
});

test("no customer- or provider-facing role can write scheduling configuration", async () => {
  // authorize() resolves platform sessions as well as staff headers (server-auth resolveActor), so a
  // customer or provider session reaches this route with its own role permissions. That is deliberate
  // and matches the gateway - but it must not become a write path. Asserted against the catalogue so
  // granting one of these roles scheduling.manage tomorrow fails here rather than in production.
  const { sqlite } = await world();
  const selfService = ["customer", "service_provider", "associate"];
  for (const code of selfService) {
    const row = sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get(code);
    if (!row) continue;
    let permissions = [];
    try { permissions = JSON.parse(String(row.permissions_json)); } catch { permissions = []; }
    assert.ok(!permissions.includes("*") && !permissions.includes("scheduling.manage"),
      `${code} must not hold scheduling.manage; it would gain write access to scheduling configuration`);
  }
});

test("the view-only role used above is a real self-service role, not another admin", async () => {
  const { sqlite } = await world();
  const { viewOnly } = rolesByPermission(sqlite);
  // Pins what test 6 actually proves: the escalation case must be exercised by a role a provider can
  // hold, otherwise "view but not manage" could quietly be some other privileged staff role.
  assert.ok(viewOnly.includes("service_provider"),
    `expected service_provider among scheduling.view-only roles, got ${JSON.stringify(viewOnly)}`);
});
