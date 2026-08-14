import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Operations / command consoles — horizontal authorization.
//
// These GET endpoints return UNSCOPED, platform-wide operational data: every provider's jobs,
// settlement/payout ledgers, and (in booking-command-center) every customer's raw phone/email plus
// payment details. They were mapped to `bookings.view` at the gateway, which the `service_provider`
// role holds ("sees assigned jobs only") — so any signed-in provider could read the whole platform.
// Their POST siblings already require `bookings.manage`; the GET was the asymmetric leak.
//
// The enforcement point that actually runs in production is the worker gateway
// (worker/index.ts -> authorizeApiRequest). This suite drives that exact function with a REAL
// forwarded-identity actor resolved from app_users/role_definitions, on a non-localhost URL (localhost
// short-circuits to a preview superuser and would pass for the wrong reason).
// ---------------------------------------------------------------------------
installWorkersHooks("__OPSAUTH_DB__", "__OPSAUTH_ENV__");

const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
const { defaultRoles } = await import("../lib/platform-security.ts");

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
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

function seed() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT, actor_role TEXT, action TEXT, resource_type TEXT, resource_id TEXT, outcome TEXT, detail_json TEXT, created_at INTEGER)");
  const insRole = sqlite.prepare("INSERT OR IGNORE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,0)");
  for (const r of defaultRoles) insRole.run(r.code, r.name, r.description, JSON.stringify(r.permissions));
  const insUser = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',0,0)");
  insUser.run("U-PRV", "provider@pawspace.test", "Provider", "service_provider");
  insUser.run("U-MGR", "manager@pawspace.test", "Manager", "manager");
  return makeD1(sqlite);
}

// Every ops/command console whose GET must be staff-only (bookings.manage), not provider-reachable.
const ROUTES = [
  "/api/booking-command-center",
  "/api/canonical-bookings",
  "/api/training-ops",
  "/api/walking-ops",
  "/api/taxi-ops",
  "/api/sitting-ops",
  "/api/boarding-ops",
  "/api/ops-work-queue",
  "/api/food-ops",
  "/api/food-supply-chain",
  "/api/food-fulfilment",
];

const req = (path, email) => new Request(`https://uat.pawspace.in${path}`, { method: "GET", headers: { "oai-authenticated-user-email": email } });

test("a service_provider is denied at the gateway on every ops/command console GET", async () => {
  for (const path of ROUTES) {
    const db = seed();
    const result = await authorizeApiRequest(req(path, "provider@pawspace.test"), { DB: db });
    assert.ok(result instanceof Response, `${path}: a provider must be refused a Response, not granted an actor`);
    assert.equal(result.status, 403, `${path}: a service_provider must get 403 (holds bookings.view but not bookings.manage)`);
  }
});

test("a manager (bookings.manage) still passes the gateway on every ops/command console GET", async () => {
  for (const path of ROUTES) {
    const db = seed();
    const result = await authorizeApiRequest(req(path, "manager@pawspace.test"), { DB: db });
    assert.ok(!(result instanceof Response), `${path}: a manager must be granted access, got ${result instanceof Response ? result.status : "actor"}`);
    assert.equal(result.permission, "bookings.manage", `${path}: the required permission must be bookings.manage`);
    assert.equal(result.actor.roleCode, "manager");
  }
});

test("guard: the fixture actually distinguishes the two roles (manager has bookings.manage, provider does not)", () => {
  const provider = defaultRoles.find(r => r.code === "service_provider");
  const manager = defaultRoles.find(r => r.code === "manager");
  assert.ok(provider.permissions.includes("bookings.view"), "provider must hold bookings.view (else the test proves nothing)");
  assert.ok(!provider.permissions.includes("bookings.manage"), "provider must NOT hold bookings.manage");
  assert.ok(manager.permissions.includes("bookings.manage"), "manager must hold bookings.manage");
});
