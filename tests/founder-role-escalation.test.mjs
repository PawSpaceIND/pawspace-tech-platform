import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

// ---------------------------------------------------------------------------
// Founder privilege escalation through /api/platform-governance, action update_user.
//
// create_user rejected roleCode === "founder". update_user checked only whether the TARGET was already
// a founder — never what role was being ASSIGNED — and then wrote body.roleCode straight into
// app_users.role_code. Any holder of users.manage (an admin) could therefore promote a normal account,
// or their own, to founder and obtain ["*"].
//
// The route already carried the correct guard for create_user, and the only test coverage was
// `assert.match(route, /Founder is protected/)` — a grep for the error string in the source. That
// passed the whole time the hole was open, which is why these tests execute the real POST handler
// against a real database and then read app_users back, rather than inspecting the file.
// ---------------------------------------------------------------------------
const WORKERS_SHIM = `export const env = new Proxy({}, { get: (_, key) => globalThis.__PAWSPACE_TEST_ENV?.[key] });`;
const workersUrl = `data:text/javascript,${encodeURIComponent(WORKERS_SHIM)}`;
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
      try { return nextResolve(specifier, context); }
      catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
}

const route = await import("../app/api/platform-governance/route.ts");

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

const ADMIN_EMAIL = "admin.actor@tkpetcare.in";

/**
 * A governance database with a real founder, the admin doing the acting, and an ordinary target.
 * ensureTables() in the route seeds role_definitions from defaultRoles, so founder's ["*"] is the real
 * definition rather than a fixture.
 */
function governanceDb() {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__PAWSPACE_TEST_ENV = { DB: makeD1(sqlite) };
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  const insert = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("U-FOUNDER", "real.founder@pawspace.in", "Real Founder", "founder", "active", 0, 0);
  insert.run("U-ADMIN", ADMIN_EMAIL, "Admin Actor", "admin", "active", 0, 0);
  insert.run("U-STAFF", "ordinary.staff@tkpetcare.in", "Ordinary Staff", "associate", "active", 0, 0);
  return sqlite;
}

const roleOf = (sqlite, id) => sqlite.prepare("SELECT role_code FROM app_users WHERE id=?").get(id)?.role_code;
// node:sqlite returns null-prototype rows, which strict deepEqual will not match against a literal.
const plain = (row) => (row ? { ...row } : row);

/**
 * POST as an admin. localhost makes resolveActor return the development-preview superuser, which is a
 * SUPERSET of an admin's authority — so anything refused here is refused for an admin too. The point of
 * these tests is that the founder guard does not depend on who is asking: it is not a permission check
 * that a sufficiently privileged caller can satisfy, it is a rule about the role being assigned.
 */
const post = (body) => route.POST(new Request("http://localhost/api/platform-governance", {
  method: "POST",
  headers: { "content-type": "application/json", "oai-authenticated-user-email": ADMIN_EMAIL },
  body: JSON.stringify(body),
}));

// ---------------------------------------------------------------------------
// 1. Admin promoting ANOTHER user to founder → rejected.
// ---------------------------------------------------------------------------
test("update_user: an admin cannot promote another user to founder", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-STAFF", roleCode: "founder", status: "active" });
  assert.equal(response.status, 400, "the request must be refused");
  assert.match((await response.json()).error, /Founder is protected/);
  assert.equal(roleOf(sqlite, "U-STAFF"), "associate", "the target's role must be unchanged in the database");
});

// ---------------------------------------------------------------------------
// 2. Admin promoting THEMSELVES to founder → rejected.
// ---------------------------------------------------------------------------
test("update_user: an admin cannot promote themselves to founder", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-ADMIN", roleCode: "founder", status: "active" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Founder is protected/);
  assert.equal(roleOf(sqlite, "U-ADMIN"), "admin", "self-promotion must leave the actor's own role untouched");
});

// ---------------------------------------------------------------------------
// 3. create_user founder assignment remains rejected.
// ---------------------------------------------------------------------------
test("create_user: assigning founder is still rejected", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "create_user", email: "brand.new@tkpetcare.in", name: "Brand New", roleCode: "founder" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Founder is protected/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM app_users WHERE email=?").get("brand.new@tkpetcare.in").total, 0, "no account may be created at all");
});

// ---------------------------------------------------------------------------
// 4. Legitimate non-founder role updates keep working.
// ---------------------------------------------------------------------------
test("update_user: an ordinary role change still succeeds", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-STAFF", roleCode: "manager", status: "active" });
  assert.equal(response.status, 200, `expected success, got ${await response.clone().text()}`);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(roleOf(sqlite, "U-STAFF"), "manager", "the role change must actually be applied");
});

test("create_user: creating an ordinary account still succeeds", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "create_user", email: "new.associate@tkpetcare.in", name: "New Associate", roleCode: "associate" });
  assert.equal(response.status, 200, `expected success, got ${await response.clone().text()}`);
  assert.equal(sqlite.prepare("SELECT role_code FROM app_users WHERE email=?").get("new.associate@tkpetcare.in").role_code, "associate");
});

// ---------------------------------------------------------------------------
// Existing founder accounts stay protected — including through the create path.
// ---------------------------------------------------------------------------
test("update_user: an existing founder still cannot be modified", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-FOUNDER", roleCode: "associate", status: "suspended" });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Founder access cannot be changed/);
  assert.deepEqual(plain(sqlite.prepare("SELECT role_code,status FROM app_users WHERE id=?").get("U-FOUNDER")), { role_code: "founder", status: "active" }, "neither the role nor the status may change");
});

// Found while fixing the reported defect: create_user INSERTs with ON CONFLICT(email) DO UPDATE SET
// role_code=excluded.role_code, so passing an existing founder's email with any non-founder role edited
// that founder's record — the same protection update_user enforces, bypassed through the create path.
test("create_user: an existing founder cannot be demoted through the upsert path", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "create_user", email: "real.founder@pawspace.in", name: "Hijacked", roleCode: "associate" });
  assert.equal(response.status, 400, "the create path must not become an edit path for a founder");
  assert.match((await response.json()).error, /Founder access cannot be changed/);
  assert.deepEqual(plain(sqlite.prepare("SELECT name,role_code FROM app_users WHERE email=?").get("real.founder@pawspace.in")), { name: "Real Founder", role_code: "founder" }, "the founder's record must be untouched");
});

// ---------------------------------------------------------------------------
// The guard is on the value, not on the spelling.
// ---------------------------------------------------------------------------
test("a padded or differently-cased founder value is refused too", async () => {
  const sqlite = governanceDb();
  for (const spelling of ["Founder", "FOUNDER", " founder", "founder "]) {
    const response = await post({ action: "update_user", id: "U-STAFF", roleCode: spelling, status: "active" });
    assert.equal(response.status, 400, `'${spelling}' must be refused`);
    assert.equal(roleOf(sqlite, "U-STAFF"), "associate", `'${spelling}' must not be written to the database`);
  }
});

test("a refused founder assignment is recorded as a denial in the audit trail", async () => {
  const sqlite = governanceDb();
  await post({ action: "update_user", id: "U-STAFF", roleCode: "founder", status: "active" });
  const denied = sqlite.prepare("SELECT action,outcome,detail_json FROM security_audit_events WHERE outcome='denied'").all();
  assert.equal(denied.length, 1, "an attempt to mint founder must leave a record");
  assert.equal(denied[0].action, "update_user");
  assert.match(String(denied[0].detail_json), /founder_role_assignment_blocked/);
});
