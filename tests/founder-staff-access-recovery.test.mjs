/**
 * Execute real staff HMAC, directory lookup, platform-session resolution and API gateway decisions.
 * SQLite supplies D1's statement/batch interface. Only database failures are injected; no auth
 * functions or role decisions are mocked. Remote browser/deployment acceptance is a separate gate.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__FOUNDER_ACCESS_DB__", "__FOUNDER_ACCESS_ENV__", { strictMfa: true });
const uat = await import("../lib/uat-staging-auth.ts");
const { authorizeApiRequest, requiredPermission } = await import("../lib/api-gateway.ts");
const { defaultRoles } = await import("../lib/platform-security.ts");
const { upsertIdentityBinding } = await import("../lib/identity-binding.ts");
const sessions = await import("../lib/platform-session.ts");
const { isTransientD1Refusal, serviceBusyResponse } = await import("../lib/d1-transient.ts");

const ORIGIN = "https://staff-recovery.pawspace.example"; // Never an authentication-free preview host.
const FOUNDER = "founder-fixture@pawspace.test";
const FINANCE = "finance-fixture@pawspace.test";
const ENV = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: "fixture-signing-key-not-a-secret-32-bytes" };
const ACTOR_SQL = "SELECT u.id,u.name,u.role_code,u.status,r.permissions_json";
const USER_SQL = "SELECT status,role_code FROM app_users";
const ROLE_SQL = "SELECT code FROM role_definitions";
const SESSION_SQL = "SELECT s.*,b.status binding_status";
const STAFF_READS = ["/api/team-overview", "/api/crm", "/api/customer-360"];
const REFUSALS = ["D1_ERROR: Currently processing a long-running import.", "D1 DB is overloaded", "Too many requests queued"];

function world(t) {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const calls = [], faults = [];
  async function before(sql, method) {
    calls.push({ sql, method });
    const fault = faults.find(item => item.remaining > 0 && sql.includes(item.match));
    if (fault) {
      fault.remaining -= 1;
      if (fault.before) await fault.before();
      throw fault.error;
    }
  }
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async () => { await before(sql, "first"); return sqlite.prepare(sql).get(...args) ?? null; },
    all: async () => { await before(sql, "all"); return { results: sqlite.prepare(sql).all(...args) }; },
    run: async () => { await before(sql, "run"); const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
  });
  const db = {
    prepare: sql => statement(sql),
    batch: async statements => {
      sqlite.exec("BEGIN IMMEDIATE");
      try { const results = []; for (const stmt of statements) results.push(await stmt.run()); sqlite.exec("COMMIT"); return results; }
      catch (error) { sqlite.exec("ROLLBACK"); throw error; }
    },
    exec: async sql => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  // The same directory/role/audit schema the gateway owns. Session/binding schemas are created
  // below by the real production modules, not by fixture copies.
  sqlite.exec(`
    CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL);
    CREATE TABLE security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT NOT NULL, actor_role TEXT NOT NULL, action TEXT NOT NULL, resource_type TEXT NOT NULL, resource_id TEXT, outcome TEXT NOT NULL, detail_json TEXT NOT NULL, created_at INTEGER NOT NULL);
  `);
  for (const role of defaultRoles) sqlite.prepare("INSERT INTO role_definitions VALUES (?,?,?,?,1,?)").run(role.code, role.name, role.description, JSON.stringify(role.permissions), Date.now());
  const addStaff = (email, role, status = "active") => sqlite.prepare("INSERT INTO app_users VALUES (?,?,?,?,?,?,?)").run(email, email, "Access fixture", role, status, Date.now(), Date.now());
  addStaff(FOUNDER, "founder"); addStaff(FINANCE, "finance");
  return {
    db, sqlite, calls, addStaff, env: { DB: db, ...ENV },
    fail: (match, remaining = 1, error = new Error(REFUSALS[0]), before) => { faults.push({ match, remaining, error, before }); return error; },
    count: match => calls.filter(call => call.sql.includes(match)).length,
    audit: () => sqlite.prepare("SELECT * FROM security_audit_events ORDER BY created_at,rowid").all(),
  };
}

const staffCookie = async (email = FOUNDER, env = ENV) => `pawspace_uat=${await uat.issueUatToken(env, email, 3600)}`;
function request(path, cookies = [], method = "GET", headers = {}) {
  return new Request(`${ORIGIN}${path}`, { method, headers: { cookie: cookies.filter(Boolean).join("; "), ...headers } });
}
async function platformCookie(w, subjectType = "customer") {
  const identity = {
    identitySource: subjectType === "customer" ? "customer_otp" : "partner_otp",
    principalType: "identity_subject", principalKey: `fixture:${subjectType}`,
    subjectType, subjectId: `FIXTURE-${subjectType}`,
  };
  const binding = await upsertIdentityBinding(w.db, { ...identity, actorId: "test", reason: "Access recovery fixture" });
  const issued = await sessions.issuePlatformSession(w.db, { ...identity, bindingId: binding.id });
  return sessions.platformSessionCookie(issued.token, issued.ttlSeconds).split(";")[0];
}
function founderAllowed(result) {
  assert.ok(!(result instanceof Response), `Founder was refused with HTTP ${result.status}`);
  assert.equal(result.actor.roleCode, "founder");
  assert.equal(result.actor.email, FOUNDER);
  assert.deepEqual(result.actor.permissions, ["*"]);
  assert.equal(result.actor.preview, false);
}

for (const path of STAFF_READS) test(`valid Founder outranks customer cookie on ${path}`, async t => {
  const w = world(t), customer = await platformCookie(w), founder = await staffCookie();
  founderAllowed(await authorizeApiRequest(request(path, [customer, founder]), w.env));
  assert.equal(w.count(SESSION_SQL), 0, "a recognised staff cookie must not fall through to a customer");
});

for (const message of REFUSALS) test(`transient directory refusal preserves Founder: ${message}`, async t => {
  const w = world(t), customer = await platformCookie(w), founder = await staffCookie();
  w.fail(ACTOR_SQL, 1, new Error(message));
  founderAllowed(await authorizeApiRequest(request("/api/crm", [founder, customer]), w.env));
  assert.equal(w.count(ACTOR_SQL), 2, "one retry of the failed SELECT, not the request");
  assert.equal(w.count(SESSION_SQL), 0, "no identity downgrade");
  assert.equal(w.audit().length, 0, "no false customer permission-denied audit");
});

test("one transient failure also recovers a Founder-only browser", async t => {
  const w = world(t); w.fail(ACTOR_SQL);
  founderAllowed(await authorizeApiRequest(request("/api/team-overview", [await staffCookie()]), w.env));
  assert.equal(w.count(ACTOR_SQL), 2);
});

test("persistent directory failure never becomes a different identity, then a new read recovers", async t => {
  const w = world(t), cookies = [await staffCookie(), await platformCookie(w)];
  const error = w.fail(ACTOR_SQL, 2);
  await assert.rejects(authorizeApiRequest(request("/api/crm", cookies), w.env), e => e === error);
  assert.equal(w.count(ACTOR_SQL), 2); assert.equal(w.count(SESSION_SQL), 0); assert.equal(w.audit().length, 0);
  assert.equal(isTransientD1Refusal(error), true, "the existing Worker boundary can classify this refusal");
  assert.equal(serviceBusyResponse().status, 503);
  founderAllowed(await authorizeApiRequest(request("/api/crm", cookies), w.env));
  assert.equal(w.count(ACTOR_SQL), 3, "rejected in-flight lookup was removed");
});

test("unexpected directory errors propagate without retry or customer fallback", async t => {
  const w = world(t), cookies = [await staffCookie(), await platformCookie(w)];
  const error = w.fail(ACTOR_SQL, 1, new Error("Unexpected database failure"));
  await assert.rejects(authorizeApiRequest(request("/api/crm", cookies), w.env), e => e === error);
  assert.equal(w.count(ACTOR_SQL), 1); assert.equal(w.count(SESSION_SQL), 0); assert.equal(w.audit().length, 0);
});

test("concurrent Founder reads share only the in-flight retry and resolve to Founder", async t => {
  const w = world(t), cookie = await staffCookie(); w.fail(ACTOR_SQL);
  const results = await Promise.all(STAFF_READS.map(path => authorizeApiRequest(request(path, [cookie]), w.env)));
  for (const result of results) founderAllowed(result);
  assert.equal(w.count(ACTOR_SQL), 2);
  founderAllowed(await authorizeApiRequest(request("/api/crm", [cookie]), w.env));
  assert.equal(w.count(ACTOR_SQL), 3, "successful roles are not cached across later requests");
});

for (const role of ["finance", "disabled"]) test(`retry respects directory change to ${role}`, async t => {
  const w = world(t), cookie = await staffCookie();
  w.fail(ACTOR_SQL, 1, new Error(REFUSALS[1]), () => {
    if (role === "disabled") w.sqlite.prepare("UPDATE app_users SET status='disabled' WHERE email=?").run(FOUNDER);
    else w.sqlite.prepare("UPDATE app_users SET role_code='finance' WHERE email=?").run(FOUNDER);
  });
  const response = await authorizeApiRequest(request("/api/crm", [cookie]), w.env);
  assert.ok(response instanceof Response); assert.equal(response.status, role === "disabled" ? 401 : 403);
  assert.equal(w.count(ACTOR_SQL), 2, "retry must re-read, not invent the former Founder role");
});

test("a later role downgrade is seen immediately with the same signed cookie", async t => {
  const w = world(t), cookie = await staffCookie();
  founderAllowed(await authorizeApiRequest(request("/api/crm", [cookie]), w.env));
  w.sqlite.prepare("UPDATE app_users SET role_code='finance' WHERE email=?").run(FOUNDER);
  const response = await authorizeApiRequest(request("/api/crm", [cookie]), w.env);
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "Permission denied" });
  assert.equal(w.audit().at(-1).actor_role, "finance");
});

for (const sql of [USER_SQL, ROLE_SQL]) test(`sign-in eligibility retries a transient read: ${sql}`, async t => {
  const w = world(t); w.fail(sql);
  assert.equal(await uat.uatStaffIdentityAllowed(w.db, FOUNDER), true);
  assert.equal(w.count(sql), 2);
});

for (const sql of [USER_SQL, ROLE_SQL]) test(`persistent eligibility error is not reported as an unknown staff account: ${sql}`, async t => {
  const w = world(t), error = w.fail(sql, 2);
  await assert.rejects(uat.uatStaffIdentityAllowed(w.db, FOUNDER), e => e === error);
  assert.equal(w.count(sql), 2);
});

test("unprovisioned, disabled and undefined-role identities never acquire staff authority", async t => {
  const w = world(t);
  w.addStaff("disabled@pawspace.test", "founder", "disabled"); w.addStaff("missing-role@pawspace.test", "not-defined");
  for (const email of ["unknown@pawspace.test", "disabled@pawspace.test", "missing-role@pawspace.test"]) {
    assert.equal(await uat.resolveUatStaffActor(w.db, request("/api/crm", [await staffCookie(email)]), w.env), null);
    assert.equal(await uat.uatStaffIdentityAllowed(w.db, email), false);
  }
});

test("a forged cookie and disabled UAT environment cannot become Founder", async t => {
  const w = world(t), forged = await staffCookie(FOUNDER, { ...ENV, PAWSPACE_UAT_SIGNING_KEY: "another-fixture-signing-key-that-is-long" });
  assert.equal((await authorizeApiRequest(request("/api/crm", [forged]), w.env)).status, 401);
  assert.equal((await authorizeApiRequest(request("/api/crm", [await staffCookie()]), { DB: w.db })).status, 401);
  assert.equal(w.count(ACTOR_SQL), 0, "invalid credentials never read or repair a role");
});

for (const subjectType of ["customer", "provider"]) for (const path of STAFF_READS) {
  test(`${subjectType} alone is denied with staff recovery on ${path}`, async t => {
    const w = world(t), cookie = await platformCookie(w, subjectType);
    const response = await authorizeApiRequest(request(path, [cookie]), w.env);
    assert.equal(response.status, 403, "messaging must never grant staff access");
    const body = await response.json();
    assert.equal(body.code, "staff_sign_in_required"); assert.equal(body.signInUrl, "/staging-login");
    assert.match(body.error, subjectType === "customer" ? /a customer/ : /a PawSpace partner/);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(w.audit().length, 1); assert.equal(w.audit()[0].outcome, "denied");
    assert.equal(w.audit()[0].actor_role, subjectType === "customer" ? "customer" : "service_provider");
  });
}

test("production refusal never advertises a staging sign-in endpoint", async t => {
  const w = world(t), cookie = await platformCookie(w);
  const response = await authorizeApiRequest(request("/api/team-overview", [cookie]), { DB: w.db });
  assert.equal(response.status, 403);
  const body = await response.json(); assert.equal(body.code, "staff_sign_in_required"); assert.equal(body.signInUrl, undefined);
});

test("Finance's genuine CRM restriction is not disguised as a missing staff sign-in", async t => {
  const w = world(t), cookie = await staffCookie(FINANCE);
  const response = await authorizeApiRequest(request("/api/crm", [cookie]), w.env);
  assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "Permission denied" });
  assert.equal(w.audit()[0].actor_role, "finance");
});

test("anonymous staff reads still receive authentication-required, not role grants", async t => {
  const w = world(t), response = await authorizeApiRequest(request("/api/team-overview"), w.env);
  assert.equal(response.status, 401); assert.equal((await response.json()).code, "sign_in_required");
});

test("customer CRM writes and unrelated read denials preserve their existing permission refusal", async t => {
  const w = world(t), cookie = await platformCookie(w);
  for (const [path, method] of [["/api/crm", "POST"], ["/api/finance-control", "GET"], ["/api/crm-extra", "GET"]]) {
    const response = await authorizeApiRequest(request(path, [cookie], method), w.env);
    assert.equal(response.status, 403); assert.deepEqual(await response.json(), { error: "Permission denied" });
  }
});

test("customer and partner permitted surfaces keep their original restricted actors", async t => {
  const w = world(t), customer = await platformCookie(w), provider = await platformCookie(w, "provider");
  const booking = await authorizeApiRequest(request("/api/payment-order", [customer], "POST"), w.env);
  assert.equal(booking.actor.roleCode, "customer"); assert.equal(booking.actor.permissions.includes("*"), false);
  const jobs = await authorizeApiRequest(request("/api/partner-job-feed", [provider]), w.env);
  assert.equal(jobs.actor.roleCode, "service_provider"); assert.equal(jobs.actor.permissions.includes("*"), false);
});

test("fresh staff sign-in restores access without broadening the previous customer identity", async t => {
  const w = world(t), customer = await platformCookie(w);
  assert.equal((await authorizeApiRequest(request("/api/crm", [customer]), w.env)).status, 403);
  founderAllowed(await authorizeApiRequest(request("/api/crm", [customer, await staffCookie()]), w.env));
  assert.equal((await sessions.resolvePlatformSession(w.db, request("/api/crm", [customer]))).roleCode, "customer");
});

test("permission mappings, cross-origin write protection and secure staff-cookie flags are intact", async t => {
  assert.equal(await requiredPermission(request("/api/crm")), "customers.view");
  assert.equal(await requiredPermission(request("/api/crm", [], "POST")), "customers.manage");
  assert.equal(await requiredPermission(request("/api/team-overview")), "dashboard.view");
  const w = world(t), cookie = await staffCookie();
  const response = await authorizeApiRequest(request("/api/crm", [cookie], "POST", { origin: "https://untrusted.example" }), w.env);
  assert.equal(response.status, 403); assert.equal((await response.json()).error, "Cross-origin write blocked");
  for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"]) assert.ok(uat.uatCookie("fixture", 3600).includes(flag));
});
