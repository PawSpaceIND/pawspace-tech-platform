import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Full-access privilege escalation through /api/platform-governance.
//
// create_user rejected roleCode === "founder". update_user checked only whether the TARGET was already
// a founder — never what role was being ASSIGNED — and then wrote body.roleCode straight into
// app_users.role_code. Any holder of users.manage (an admin) could therefore promote a normal account,
// or their own, to founder and obtain ["*"].
//
// Guarding the literal "founder" was NOT sufficient: `superuser` is also defined as ["*"], so blocking
// one name left the other completely open, and the UI actively offered Superuser in both role
// dropdowns. The protected set is now derived from the permissions in role_definitions, so a role is
// protected because of what it can do rather than because someone remembered its name.
//
// The route already carried the correct guard for create_user, and the only test coverage was
// `assert.match(route, /Founder is protected/)` — a grep for the error string in the source. That
// passed the whole time the hole was open, which is why these tests execute the real POST handler
// against a real database and then read app_users back, rather than inspecting the file.
// ---------------------------------------------------------------------------
// The resolver comes from the shared helper, which carries BOTH branches: registerHooks on Node >=22.15
// and an out-of-thread module.register() loader on the version CI pins (22.13.0). This file previously
// installed only the registerHooks branch with no fallback, so on CI no resolver was registered, the
// route's extensionless `../../../lib/platform-security` import could not resolve, and the whole file
// died before a single test ran - the suite proved nothing on the only machine that gates the merge.
installWorkersHooks("__PAWSPACE_TEST_DB__", "__PAWSPACE_TEST_ENV__");

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
  globalThis.__PAWSPACE_TEST_DB__ = makeD1(sqlite);
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  // DDL copied from lib/api-gateway.ts, which owns it. Created up front so a test can define a role
  // before the first POST (the route's own ensureTables would otherwise create it lazily).
  sqlite.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  const insert = sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)");
  insert.run("U-FOUNDER", "real.founder@pawspace.in", "Real Founder", "founder", "active", 0, 0);
  insert.run("U-ADMIN", ADMIN_EMAIL, "Admin Actor", "admin", "active", 0, 0);
  insert.run("U-STAFF", "ordinary.staff@tkpetcare.in", "Ordinary Staff", "associate", "active", 0, 0);
  insert.run("U-SUPER", "real.superuser@pawspace.in", "Real Superuser", "superuser", "active", 0, 0);
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
  assert.equal(response.status, 403, "the request must be refused");
  assert.match((await response.json()).error, /cannot be assigned/i);
  assert.equal(roleOf(sqlite, "U-STAFF"), "associate", "the target's role must be unchanged in the database");
});

// ---------------------------------------------------------------------------
// 2. Admin promoting THEMSELVES to founder → rejected.
// ---------------------------------------------------------------------------
test("update_user: an admin cannot promote themselves to founder", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-ADMIN", roleCode: "founder", status: "active" });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /cannot be assigned/i);
  assert.equal(roleOf(sqlite, "U-ADMIN"), "admin", "self-promotion must leave the actor's own role untouched");
});

// ---------------------------------------------------------------------------
// 3. create_user founder assignment remains rejected.
// ---------------------------------------------------------------------------
test("create_user: assigning founder is still rejected", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "create_user", email: "brand.new@tkpetcare.in", name: "Brand New", roleCode: "founder" });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /cannot be assigned/i);
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
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /cannot be changed/i);
  assert.deepEqual(plain(sqlite.prepare("SELECT role_code,status FROM app_users WHERE id=?").get("U-FOUNDER")), { role_code: "founder", status: "active" }, "neither the role nor the status may change");
});

// Found while fixing the reported defect: create_user INSERTs with ON CONFLICT(email) DO UPDATE SET
// role_code=excluded.role_code, so passing an existing founder's email with any non-founder role edited
// that founder's record — the same protection update_user enforces, bypassed through the create path.
test("create_user: an existing founder cannot be demoted through the upsert path", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "create_user", email: "real.founder@pawspace.in", name: "Hijacked", roleCode: "associate" });
  assert.equal(response.status, 409, "create must conflict on an existing address rather than edit it");
  assert.deepEqual(plain(sqlite.prepare("SELECT name,role_code FROM app_users WHERE email=?").get("real.founder@pawspace.in")), { name: "Real Founder", role_code: "founder" }, "the founder's record must be untouched");
});

// ---------------------------------------------------------------------------
// The guard is on the value, not on the spelling.
// ---------------------------------------------------------------------------
test("a padded or differently-cased founder value is refused too", async () => {
  const sqlite = governanceDb();
  for (const spelling of ["Founder", "FOUNDER", " founder", "founder "]) {
    const response = await post({ action: "update_user", id: "U-STAFF", roleCode: spelling, status: "active" });
    assert.equal(response.status, 403, `'${spelling}' must be refused`);
    assert.equal(roleOf(sqlite, "U-STAFF"), "associate", `'${spelling}' must not be written to the database`);
  }
});

test("a refused founder assignment is recorded as a denial in the audit trail", async () => {
  const sqlite = governanceDb();
  await post({ action: "update_user", id: "U-STAFF", roleCode: "founder", status: "active" });
  const denied = sqlite.prepare("SELECT action,outcome,detail_json FROM security_audit_events WHERE outcome='denied'").all();
  assert.equal(denied.length, 1, "an attempt to mint founder must leave a record");
  assert.equal(denied[0].action, "update_user");
  assert.match(String(denied[0].detail_json), /full_access_role_assignment_blocked/);
});


// ---------------------------------------------------------------------------
// Superuser is the other ["*"] role. Blocking "founder" by name left this wide open.
// ---------------------------------------------------------------------------
test("update_user: an admin cannot promote another user to superuser", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-STAFF", roleCode: "superuser", status: "active" });
  assert.equal(response.status, 403, "superuser carries [\"*\"] and must be refused exactly like founder");
  assert.match((await response.json()).error, /full access/i);
  assert.equal(roleOf(sqlite, "U-STAFF"), "associate", "the target's role must be unchanged");
});

test("update_user: an admin cannot promote themselves to superuser", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-ADMIN", roleCode: "superuser", status: "active" });
  assert.equal(response.status, 403);
  assert.equal(roleOf(sqlite, "U-ADMIN"), "admin", "self-promotion to superuser must change nothing");
});

test("create_user: assigning superuser is rejected", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "create_user", email: "sneaky@tkpetcare.in", name: "Sneaky", roleCode: "superuser" });
  assert.equal(response.status, 403);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS total FROM app_users WHERE email=?").get("sneaky@tkpetcare.in").total, 0);
});

test("an existing superuser cannot be edited from user management either", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-SUPER", roleCode: "associate", status: "suspended" });
  assert.equal(response.status, 403);
  assert.deepEqual(plain(sqlite.prepare("SELECT role_code,status FROM app_users WHERE id=?").get("U-SUPER")), { role_code: "superuser", status: "active" });
});

test("the protected set is derived from permissions, not from a list of names", async () => {
  const sqlite = governanceDb();
  // A role nobody hardcoded anywhere, defined as full access. It must be protected on definition.
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)")
    .run("owner_delegate", "Owner Delegate", "invented for this test", JSON.stringify(["*"]), 0, 0);
  const response = await post({ action: "update_user", id: "U-STAFF", roleCode: "owner_delegate", status: "active" });
  assert.equal(response.status, 403, "a new ['*'] role must be protected without anyone adding its name to a guard");
  assert.equal(roleOf(sqlite, "U-STAFF"), "associate");
});

// ---------------------------------------------------------------------------
// create must create. It used to upsert, which made it an edit path.
// ---------------------------------------------------------------------------
test("create_user: a duplicate email is a conflict, and cannot silently change the role", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "create_user", email: "ordinary.staff@tkpetcare.in", name: "Renamed", roleCode: "manager" });
  assert.equal(response.status, 409, "an existing email must conflict rather than behave as update");
  assert.deepEqual(plain(sqlite.prepare("SELECT name,role_code FROM app_users WHERE email=?").get("ordinary.staff@tkpetcare.in")), { name: "Ordinary Staff", role_code: "associate" }, "neither the name nor the role may change");
});

test("update_user: an unknown role is refused rather than stored", async () => {
  const sqlite = governanceDb();
  // An unvalidated role_code produced an account that authenticates and authorises nothing.
  const response = await post({ action: "update_user", id: "U-STAFF", roleCode: "not_a_real_role", status: "active" });
  assert.equal(response.status, 400);
  assert.equal(roleOf(sqlite, "U-STAFF"), "associate");
});

// ---------------------------------------------------------------------------
// save_role: immutability enforced instead of implied, and durability across isolates.
// ---------------------------------------------------------------------------
test("save_role: a built-in role is refused, because ensureSecurityTables would revert it anyway", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "save_role", code: "admin", permissions: ["dashboard.view"] });
  assert.equal(response.status, 403, "accepting an edit that a fresh isolate silently undoes is worse than refusing it");
  assert.match((await response.json()).error, /immutable|restored/i);
  const stored = JSON.parse(sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get("admin").permissions_json);
  assert.ok(stored.length > 1, "admin's permissions must not have been narrowed");
});

test("save_role: a full-access role is refused", async () => {
  const sqlite = governanceDb();
  for (const code of ["founder", "superuser"]) {
    const response = await post({ action: "save_role", code, permissions: ["dashboard.view"] });
    assert.equal(response.status, 403, `${code} permissions must be protected`);
    assert.deepEqual(JSON.parse(sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get(code).permissions_json), ["*"]);
  }
});

test("a revoked permission on a CUSTOM role survives a fresh security bootstrap", async () => {
  const sqlite = governanceDb();
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)")
    .run("city_lead", "City Lead", "custom role", JSON.stringify(["dashboard.view", "bookings.view", "customers.manage"]), 0, 0);

  const saved = await post({ action: "save_role", code: "city_lead", permissions: ["dashboard.view"] });
  assert.equal(saved.status, 200, `a custom role must be editable, got ${await saved.clone().text()}`);
  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get("city_lead").permissions_json), ["dashboard.view"], "the revocation applied");

  // Simulate a fresh Worker isolate: ensureSecurityTables memoises on a WeakSet<Db>, so the same
  // binding object would skip the seed entirely and the test would pass without proving anything.
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(makeD1(sqlite));

  assert.deepEqual(JSON.parse(sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get("city_lead").permissions_json), ["dashboard.view"], "the bootstrap must not restore a revoked permission");
});

// ---------------------------------------------------------------------------
// The UI must offer only what the API will accept, and must not claim it can edit what it cannot.
// ---------------------------------------------------------------------------
test("no full-access role is offered in either user-management dropdown", () => {
  const panel = fs.readFileSync(new URL("../app/control/access-control-panel.tsx", import.meta.url), "utf8");
  assert.match(panel, /assignableRoles/, "both selects must draw from the assignable set");
  assert.ok(panel.includes("filter(role=>!isFullAccessRole(role.permissions))"), "assignability is derived from permissions");
  // The old filters named founder and left superuser on offer.
  assert.ok(!panel.includes('filter(r=>r.code!=="founder")'), "filtering by the name 'founder' left superuser assignable");
  assert.ok(!panel.includes('r.code!=="founder"||u.role_code==="founder"'), "the user select must not filter by name either");
});

test("the permission list no longer claims editing is available", () => {
  const panel = fs.readFileSync(new URL("../app/control/access-control-panel.tsx", import.meta.url), "utf8");
  // The claim lived in a warning string while every checkbox was readOnly and nothing could save one.
  // The claim lived in a rendered warning string. Only the explanatory comment may mention it now.
  const rendered = panel.replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
  assert.ok(!rendered.includes("Permission editing is available"), "the UI must not claim an editor it does not have");
  assert.ok(rendered.includes("reference view, not an editor"), "and it should say what the list actually is");
  // Every checkbox is disabled now, not only the founder's.
  assert.ok(panel.includes("readOnly disabled/>"), "no checkbox may look interactive");
  assert.ok(!panel.includes('disabled={role?.code==="founder"}'), "the disabled state must not depend on a role name");
});

// ---------------------------------------------------------------------------
// 22-23. GAP 9 — create_user never validated the role, while update_user did.
//
// An unknown roleCode was written straight into app_users, producing an account that authenticates and
// then authorises nothing — the exact failure update_user's own guard exists to prevent. The role code
// is also normalised ONCE now and used for the protection check, the existence check AND the stored
// value; it was previously normalised only for the comparison and persisted verbatim.
// ---------------------------------------------------------------------------
const auditRows = (sqlite, outcome = "denied") =>
  sqlite.prepare("SELECT action,resource_type,resource_id,outcome,detail_json FROM security_audit_events WHERE outcome=?").all(outcome).map(plain);
const userByEmail = (sqlite, email) => plain(sqlite.prepare("SELECT id,role_code FROM app_users WHERE email=?").get(email));

test("create_user: an unknown role is refused and NO app_users row is written", async () => {
  const sqlite = governanceDb();
  const before = sqlite.prepare("SELECT COUNT(*) c FROM app_users").get().c;
  const response = await post({ action: "create_user", email: "new.hire@tkpetcare.in", name: "New Hire", roleCode: "role_that_does_not_exist" });
  assert.equal(response.status, 400, "an unknown role must be refused");
  assert.match((await response.json()).error, /unknown role/i);
  assert.equal(userByEmail(sqlite, "new.hire@tkpetcare.in"), undefined, "no account may exist for a rejected role");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM app_users").get().c, before, "the user table must be unchanged");
  const denied = auditRows(sqlite);
  assert.equal(denied.length, 1, "the refusal must be audited");
  assert.equal(denied[0].action, "create_user");
  assert.match(String(denied[0].detail_json), /unknown_role/);
});

test("create_user: the role code is normalised for protection, existence AND storage", async () => {
  const sqlite = governanceDb();
  // Padded + differently-cased PROTECTED role is still refused (protection reads the normalised code).
  const escalation = await post({ action: "create_user", email: "sneaky@tkpetcare.in", name: "Sneaky", roleCode: "  FoUnDeR  " });
  assert.equal(escalation.status, 403);
  assert.equal(userByEmail(sqlite, "sneaky@tkpetcare.in"), undefined, "no row may be written for a refused protected role");
  // Padded + differently-cased ORDINARY role resolves and is STORED normalised, not verbatim.
  const ok = await post({ action: "create_user", email: "cased@tkpetcare.in", name: "Cased", roleCode: "  ASSOCIATE  " });
  assert.equal(ok.status, 200, "a real role in odd casing must still resolve");
  assert.equal(userByEmail(sqlite, "cased@tkpetcare.in").role_code, "associate",
    "the stored role_code must be the normalised value — storing it verbatim yields a role matching no definition");
});

// ---------------------------------------------------------------------------
// 24-28. GAP 13 — five refusal paths returned silently.
//
// An attempt to hand out full access through update_user, to assign an unknown role, or to edit a
// protected/built-in role left NO trace, while three neighbouring refusals did write one. A partial
// audit trail is worse than none: it reads as complete. Business state is untouched on every path.
// ---------------------------------------------------------------------------
test("audit: refusing to edit a protected HOLDER is recorded", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-FOUNDER", roleCode: "associate", status: "active" });
  assert.equal(response.status, 403);
  assert.equal(roleOf(sqlite, "U-FOUNDER"), "founder", "the founder's role must be untouched");
  const denied = auditRows(sqlite);
  assert.equal(denied.length, 1, "editing a protected holder must be audited");
  assert.equal(denied[0].action, "update_user");
  assert.equal(denied[0].resource_id, "U-FOUNDER");
  assert.match(String(denied[0].detail_json), /protected_holder_edit_blocked/);
});

test("audit: refusing an unknown role on update_user is recorded", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "update_user", id: "U-STAFF", roleCode: "no_such_role", status: "active" });
  assert.equal(response.status, 400);
  assert.equal(roleOf(sqlite, "U-STAFF"), "associate", "the target's role must be unchanged");
  const denied = auditRows(sqlite);
  assert.equal(denied.length, 1);
  assert.match(String(denied[0].detail_json), /unknown_role/);
});

test("audit: save_role refusing an unknown role is recorded", async () => {
  const sqlite = governanceDb();
  const response = await post({ action: "save_role", code: "not_a_role", permissions: ["bookings.view"] });
  assert.equal(response.status, 400);
  const denied = auditRows(sqlite);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].action, "save_role");
  assert.equal(denied[0].resource_type, "role");
  assert.match(String(denied[0].detail_json), /unknown_role/);
});

// role_definitions is seeded by the route's own ensureTables(), not by the fixture, so a "before" value
// read prior to the first POST is undefined. This fires a benign unknown action first: it runs
// ensureTables and returns 400 WITHOUT writing an audit row, so the denial counts below stay exact.
const seedRoles = async (sqlite) => { await post({ action: "__no_such_action__" }); return sqlite; };
const permsOf = (sqlite, code) => sqlite.prepare("SELECT permissions_json FROM role_definitions WHERE code=?").get(code)?.permissions_json;

test("audit: save_role refusing a FULL-ACCESS role is recorded and changes nothing", async () => {
  const sqlite = await seedRoles(governanceDb());
  assert.equal(auditRows(sqlite).length, 0, "the seeding call must not itself write a denial");
  for (const code of ["founder", "superuser"]) {
    const before = permsOf(sqlite, code);
    assert.equal(before, '["*"]', `control: ${code} must really be full-access before the attempt`);
    const response = await post({ action: "save_role", code, permissions: ["bookings.view"] });
    assert.equal(response.status, 403, `${code} must be refused`);
    assert.equal(permsOf(sqlite, code), before, `${code}'s stored permissions must be byte-identical after the refusal`);
    assert.notEqual(permsOf(sqlite, code), '["bookings.view"]', `${code} must not have taken the attempted downgrade`);
  }
  const denied = auditRows(sqlite);
  assert.equal(denied.length, 2, "both refusals must be audited");
  for (const row of denied) assert.match(String(row.detail_json), /full_access_role_edit_blocked/);
});

test("audit: save_role refusing a BUILT-IN role is recorded and changes nothing", async () => {
  const sqlite = await seedRoles(governanceDb());
  const before = permsOf(sqlite, "admin");
  assert.ok(before && before !== '["*"]', "control: admin must be a seeded built-in that is NOT full-access");
  const response = await post({ action: "save_role", code: "admin", permissions: ["bookings.view"] });
  assert.equal(response.status, 403);
  assert.match((await response.json()).error, /immutable|built-in/i);
  assert.equal(permsOf(sqlite, "admin"), before, "a refused built-in edit must leave the definition byte-identical");
  const denied = auditRows(sqlite);
  assert.equal(denied.length, 1);
  assert.match(String(denied[0].detail_json), /built_in_role_edit_blocked/);
});

test("audit: EVERY security-relevant refusal path writes exactly one denied record", async () => {
  // Structural sweep: no refusal path may return silently. Each case is driven independently so a
  // single shared counter cannot mask a path that writes nothing.
  const cases = [
    ["create_user protected role", { action: "create_user", email: "a@tkpetcare.in", name: "A", roleCode: "founder" }],
    ["create_user unknown role", { action: "create_user", email: "b@tkpetcare.in", name: "B", roleCode: "nope" }],
    ["create_user duplicate email", { action: "create_user", email: "ordinary.staff@tkpetcare.in", name: "C", roleCode: "associate" }],
    ["update_user protected holder", { action: "update_user", id: "U-SUPER", roleCode: "associate", status: "active" }],
    ["update_user protected assignment", { action: "update_user", id: "U-STAFF", roleCode: "superuser", status: "active" }],
    ["update_user unknown role", { action: "update_user", id: "U-STAFF", roleCode: "nope", status: "active" }],
    ["save_role unknown role", { action: "save_role", code: "nope", permissions: [] }],
    ["save_role full-access role", { action: "save_role", code: "founder", permissions: [] }],
    ["save_role built-in role", { action: "save_role", code: "manager", permissions: [] }],
  ];
  for (const [label, body] of cases) {
    const sqlite = governanceDb();
    const response = await post(body);
    assert.ok(response.status >= 400, `${label}: must be refused`);
    assert.equal(auditRows(sqlite).length, 1, `${label}: must write exactly one denied audit record`);
  }
});
