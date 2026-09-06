import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// Route-level defense in depth for the scheduling policy already enforced by the worker gateway.
// Every denial below is checked against persistence, not only the HTTP status.
installWorkersHooks("__SR_DB__", "__SR_ENV__");

const ORIGIN = "https://ops.pawspace.example";
const ENDPOINT = `${ORIGIN}/api/scheduling-rules`;
const NOW = 1770000000000;
const EXISTING = "rule_existing";
const EXISTING_NAME = "Do not double-book groomers";
const VALID_RULE = Object.freeze({ code: "quality-floor", field: "qualityScore", operator: "gte", value: 80 });

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

const SCHEMA = "CREATE TABLE IF NOT EXISTS scheduling_rules (id TEXT PRIMARY KEY,name TEXT NOT NULL,service_code TEXT,city_id TEXT,zone_id TEXT,priority INTEGER NOT NULL DEFAULT 100,condition_json TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)";

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__SR_DB__ = db;
  globalThis.__SR_ENV__ = {};
  await serverAuth.ensureSecurityTables(db);
  sqlite.exec(SCHEMA);
  sqlite.prepare("INSERT INTO scheduling_rules (id,name,service_code,city_id,zone_id,priority,condition_json,active,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .run(EXISTING, EXISTING_NAME, "grooming", "blr", null, 10, "[]", 1, "ops@pawspace.in", NOW, NOW);
  return { sqlite, db };
}

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
const rules = (sqlite) => sqlite.prepare("SELECT id,name,active,priority,created_by,condition_json FROM scheduling_rules ORDER BY id").all();
const refused = (response) => [401, 403].includes(response.status);

function operator(sqlite, email = "ops.lead@pawspace.in") {
  const { manage } = rolesByPermission(sqlite);
  assert.ok(manage.length > 0, "no scheduling.manage role exists");
  return seedUser(sqlite, email, manage[0]);
}

async function assertDeniedWrites(sqlite, email) {
  const before = rules(sqlite);
  const request = (init) => email ? asStaff(email, init) : anonymous(init);
  const attempts = [
    ["POST", () => route.POST(request(jsonInit("POST", { name: "blocked", conditions: [VALID_RULE] })))],
    ["PATCH", () => route.PATCH(request(jsonInit("PATCH", { id: EXISTING, active: false, priority: 999 })))],
    ["DELETE", () => route.DELETE(request({ method: "DELETE", url: `${ENDPOINT}?id=${EXISTING}` }))],
  ];
  for (const [method, attempt] of attempts) {
    const response = await attempt();
    assert.ok(refused(response), `${method} should be refused, got ${response.status}`);
    assert.deepEqual(rules(sqlite), before, `${method} refusal changed persistence`);
  }
}

test("the role catalogue distinguishes scheduling.manage from scheduling.view", async () => {
  const { sqlite } = await world();
  const { manage, viewOnly, neither } = rolesByPermission(sqlite);
  assert.ok(manage.length > 0);
  assert.ok(viewOnly.length > 0);
  assert.ok(neither.length > 0);
});

test("an anonymous caller cannot read scheduling rules or their shape", async () => {
  await world();
  const response = await route.GET(anonymous());
  assert.ok(refused(response), `expected refusal, got ${response.status}`);
  const body = JSON.stringify(await response.json());
  assert.doesNotMatch(body, new RegExp(EXISTING_NAME, "i"));
  assert.doesNotMatch(body, /condition_json|service_code/i);
});

test("anonymous writes are refused and leave persistence unchanged", async () => {
  const { sqlite } = await world();
  await assertDeniedWrites(sqlite, null);
});

test("a scheduling.view-only role may read but cannot write", async () => {
  const { sqlite } = await world();
  const { viewOnly } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "viewer@pawspace.in", viewOnly[0]);
  assert.equal((await route.GET(asStaff(email))).status, 200);
  await assertDeniedWrites(sqlite, email);
});

test("a role holding neither permission is refused on every method", async () => {
  const { sqlite } = await world();
  const { neither } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "outsider@pawspace.in", neither[0]);
  const before = rules(sqlite);
  assert.equal((await route.GET(asStaff(email))).status, 403);
  await assertDeniedWrites(sqlite, email);
  assert.deepEqual(rules(sqlite), before);
});

test("an unprovisioned identity is refused", async () => {
  const { sqlite } = await world();
  const before = rules(sqlite);
  const response = await route.POST(asStaff("stranger@pawspace.in", jsonInit("POST", { name: "blocked", conditions: [VALID_RULE] })));
  assert.ok(refused(response));
  assert.deepEqual(rules(sqlite), before);
});

test("a suspended manager is refused", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite, "former.ops@pawspace.in");
  sqlite.prepare("UPDATE app_users SET status='suspended' WHERE email=?").run(email);
  const before = rules(sqlite);
  const response = await route.POST(asStaff(email, jsonInit("POST", { name: "blocked", conditions: [VALID_RULE] })));
  assert.ok(refused(response));
  assert.deepEqual(rules(sqlite), before);
});

test("an authorized operator can read the rules", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const response = await route.GET(asStaff(email));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.length, 1);
  assert.equal(body.data[0].name, EXISTING_NAME);
});

test("an authorized operator can create a valid rule", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const response = await route.POST(asStaff(email, jsonInit("POST", { name: "Quality floor", conditions: [VALID_RULE], priority: 20 })));
  assert.equal(response.status, 201);
  const created = sqlite.prepare("SELECT priority,created_by,condition_json FROM scheduling_rules WHERE name=?").get("Quality floor");
  assert.ok(created);
  assert.equal(created.priority, 20);
  assert.equal(created.created_by, email);
  assert.deepEqual(JSON.parse(created.condition_json), [VALID_RULE]);
});

test("created_by cannot be spoofed through the request body", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const response = await route.POST(asStaff(email, jsonInit("POST", { name: "Attributed rule", conditions: [VALID_RULE], createdBy: "someone.else@pawspace.in" })));
  assert.equal(response.status, 201);
  const created = sqlite.prepare("SELECT created_by FROM scheduling_rules WHERE name=?").get("Attributed rule");
  assert.equal(created.created_by, email);
});

test("an authorized operator can update a rule", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const response = await route.PATCH(asStaff(email, jsonInit("PATCH", { id: EXISTING, active: false, priority: 5 })));
  assert.equal(response.status, 200);
  const row = sqlite.prepare("SELECT active,priority FROM scheduling_rules WHERE id=?").get(EXISTING);
  assert.equal(row.active, 0);
  assert.equal(row.priority, 5);
});

test("an authorized operator can delete a rule", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const response = await route.DELETE(asStaff(email, { method: "DELETE", url: `${ENDPOINT}?id=${EXISTING}` }));
  assert.equal(response.status, 200);
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM scheduling_rules").get().c, 0);
});

test("authorization precedes request validation", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const invalid = { name: "bad", conditions: "not-an-array" };
  assert.equal((await route.POST(asStaff(email, jsonInit("POST", invalid)))).status, 400);
  const stranger = await route.POST(anonymous(jsonInit("POST", invalid)));
  assert.ok(refused(stranger), `anonymous malformed request was validated instead of refused: ${stranger.status}`);
});

test("authorized creation rejects malformed condition shapes without persisting", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const before = rules(sqlite);
  const invalidConditions = [
    "not-an-array",
    { 0: VALID_RULE, length: 1 },
    [null],
    [{ ...VALID_RULE, code: "" }],
    [{ ...VALID_RULE, field: "unknown" }],
    [{ ...VALID_RULE, operator: "contains" }],
    [{ ...VALID_RULE, value: { minimum: 80 } }],
    [{ ...VALID_RULE, value: [80] }],
  ];
  for (const conditions of invalidConditions) {
    const response = await route.POST(asStaff(email, jsonInit("POST", { name: "Malformed rule", conditions })));
    assert.equal(response.status, 400, `accepted malformed conditions: ${JSON.stringify(conditions)}`);
    assert.match(String((await response.json()).error), /valid conditions/i);
    assert.deepEqual(rules(sqlite), before);
  }
});

test("PATCH rejects non-boolean active values without changing the rule", async () => {
  const { sqlite } = await world();
  const email = operator(sqlite);
  const before = rules(sqlite);
  for (const active of ["false", 1, null, []]) {
    const response = await route.PATCH(asStaff(email, jsonInit("PATCH", { id: EXISTING, active })));
    assert.equal(response.status, 400, `accepted non-boolean active=${JSON.stringify(active)}`);
    assert.match(String((await response.json()).error), /boolean/i);
    assert.deepEqual(rules(sqlite), before);
  }
});

test("the development-preview superuser bypass is host-gated", async () => {
  await world();
  assert.ok(refused(await route.GET(anonymous())));
  assert.equal((await route.GET(new Request("http://localhost/api/scheduling-rules"))).status, 200);
});

test("the gateway declares scheduling.view for reads and scheduling.manage for writes", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  assert.match(source, /"\/api\/scheduling-rules"\)return method==="GET"\?"scheduling\.view":"scheduling\.manage"/);
});

test("the gateway refuses an anonymous scheduling-rules read", async () => {
  const { db } = await world();
  const decision = await gateway.authorizeApiRequest(new Request(ENDPOINT), { DB: db });
  assert.ok(decision instanceof Response);
  assert.ok(refused(decision), `expected gateway refusal, got ${decision.status}`);
});

test("the gateway refuses an anonymous scheduling-rules write", async () => {
  const { db } = await world();
  const decision = await gateway.authorizeApiRequest(new Request(ENDPOINT, jsonInit("POST", { name: "blocked", conditions: [VALID_RULE] })), { DB: db });
  assert.ok(decision instanceof Response);
  assert.ok(refused(decision), `expected gateway refusal, got ${decision.status}`);
});

test("no customer- or provider-facing role can write scheduling configuration", async () => {
  const { sqlite } = await world();
  for (const code of ["customer", "service_provider", "associate"]) {
    const row = sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get(code);
    if (!row) continue;
    let permissions = [];
    try { permissions = JSON.parse(String(row.permissions_json)); } catch { permissions = []; }
    assert.ok(!permissions.includes("*") && !permissions.includes("scheduling.manage"), `${code} unexpectedly holds scheduling.manage`);
  }
});

test("the view-only escalation case is exercised by service_provider", async () => {
  const { sqlite } = await world();
  const { viewOnly } = rolesByPermission(sqlite);
  assert.ok(viewOnly.includes("service_provider"), `expected service_provider among view-only roles, got ${JSON.stringify(viewOnly)}`);
});

// ---------------------------------------------------------------------------
// Schema lifecycle. Nothing owned the scheduling_rules table: the only CREATE TABLE for it lives in
// app/api/uat-scheduling/route.ts, so on a fresh database an authorized operator got a 500 from a
// route that was otherwise working correctly - the read simply had no table to read. There is no
// migrations/ directory; routes bootstrap their own schema, which is the convention followed here.
//
// The split matters: writes ensure the table, reads do not. d7-read-side-effects.test.mjs holds reads
// to creating nothing at all on a cold database, so GET reports an empty rule set rather than
// bootstrapping - keeping both contracts intact.
// ---------------------------------------------------------------------------

async function coldWorld() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__SR_DB__ = db;
  globalThis.__SR_ENV__ = {};
  await serverAuth.ensureSecurityTables(db);          // identity only; no scheduling_rules table
  return { sqlite, db };
}
const schedulingTables = (sqlite) => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'scheduling%'").all().map((row) => row.name);

test("an authorized read on a fresh database reports an empty rule set instead of failing", async () => {
  const { sqlite } = await coldWorld();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const response = await route.GET(asStaff(email));
  assert.equal(response.status, 200, `a fresh database must not produce a 500, got ${response.status}`);
  assert.deepEqual((await response.json()).data, [], "a database with no rules yet reports no rules");
});

test("that read creates no table, so the D7 read-side contract still holds", async () => {
  const { sqlite } = await coldWorld();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const before = schedulingTables(sqlite);
  await route.GET(asStaff(email));
  assert.deepEqual(schedulingTables(sqlite), before, "a read must not bootstrap the schema");
  assert.equal(schedulingTables(sqlite).length, 0, "no scheduling table may exist after a cold read");
});

test("an authorized write on a fresh database bootstraps the table and persists the rule", async () => {
  const { sqlite } = await coldWorld();
  const { manage } = rolesByPermission(sqlite);
  const email = seedUser(sqlite, "ops.lead@pawspace.in", manage[0]);
  const response = await route.POST(asStaff(email, jsonInit("POST", {
    name: "First rule on a fresh database",
    conditions: [{ code: "min_rating", field: "rating", operator: "gte", value: 4 }],
  })));
  assert.equal(response.status, 201, `a write must bootstrap its own schema, got ${response.status}`);
  assert.ok(schedulingTables(sqlite).includes("scheduling_rules"), "the write must have created the table");
  const row = sqlite.prepare("SELECT name,created_by FROM scheduling_rules WHERE name=?").get("First rule on a fresh database");
  assert.ok(row, "the rule must persist");
  assert.equal(row.created_by, email, "attribution still comes from the verified actor");
});

test("an unauthorized write on a fresh database creates nothing", async () => {
  const { sqlite } = await coldWorld();
  const response = await route.POST(anonymous(jsonInit("POST", { name: "x", conditions: [{ code: "c", field: "rating", operator: "gte", value: 1 }] })));
  assert.ok(refused(response), `an anonymous write must be refused, got ${response.status}`);
  assert.equal(schedulingTables(sqlite).length, 0, "a refused write must not bootstrap the schema either");
});
