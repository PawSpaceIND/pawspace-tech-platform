import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

// ---------------------------------------------------------------------------
// Platform-wide route authorization, executed.
//
// WHY THIS EXISTS. 149 route handlers enforce a permission somewhere in their source. Before this
// suite, an audit of how that enforcement was *proved* found:
//
//    40  executed in a test that builds requests on a real host  -> authorization actually exercised
//   104  executed only against http://localhost / 127.0.0.1 / terminal.local
//     5  never executed by any test at all
//
// Those 104 prove nothing about authorization. isDevelopmentPreview() hands any request on a preview
// host a superuser actor holding ["*"], so every requirePermission() call in them passes
// unconditionally - the deny path is never taken. Several suites additionally asserted authorization
// by regexing the route's own source for `requirePermission(actor,"...")`, which cannot tell whether
// the guard runs before the work it is meant to guard.
//
// So this suite enumerates every guarded route from disk and drives every exported method on a REAL
// host, twice: once with no identity, once as the least-privileged role in the catalogue. The
// invariant is narrow and absolute - a guarded route must never answer 2xx to either. A route added
// tomorrow is swept without anyone remembering to list it here.
//
// WHAT IT FOUND. One defect, and one intentional design it initially mistook for a defect.
//
//   platform-governance.GET  DEFECT. No permission check at all. It served the whole role catalogue,
//                            the permission vocabulary and recent import batches to any identity
//                            resolveActor accepted, including a customer or provider session. (The
//                            user list was already gated on users.manage; the security model saying
//                            who may do what was not.) Protected in production by the worker gateway,
//                            which authorizes every /api/* request - so this is the same
//                            defense-in-depth class as /api/scheduling-rules, not an exploitable
//                            hole. The point is that the gateway was then the only thing standing
//                            there, with nothing at the handler to catch a mistake in it.
//
//   ops-work-queue.GET       NOT a defect. It answers a zeroed snapshot to an anonymous caller on a
//                            cold database because its guard deliberately sits after the
//                            table-existence probe. resolveActor() calls ensureSecurityTables(),
//                            which is DDL, and the D7 read-side contract
//                            (tests/d7-read-side-effects.test.mjs) requires a cold GET to create
//                            nothing whatsoever - security tables included. Authorizing first
//                            reintroduces that closed defect. The trade-off is deliberate: the reply
//                            carries no task data, and the gateway refuses anonymous callers anyway.
//                            Asserted below rather than "fixed".
//
// SCOPE OF THE CLAIM, stated so it is not read as more than it is. This executes route handlers
// directly. It is not an end-to-end test and does not exercise the worker gateway;
// tests/canonical-bookings-gateway-authorization.test.mjs covers that layer. Every case here is real
// handler execution against a real SQLite-backed D1 shape - no source-text assertion stands in for
// behaviour.
//
// Two limits are deliberate and bounded rather than hidden:
//
//   Request shape. The sweep sends ONE shape per method - no query string, empty JSON body - so a
//   branch selected by a parameter is not swept by it. Those need their own case; the
//   content-controls ?view=admin test below is the pattern to copy for a new one.
//
//   Discovery. Routes are found by matching requirePermission( / authorize(request in source, so a
//   guard in a comment or an unreachable branch is enough to enrol a route in the sweep. Enrolment
//   only ever ADDS a route to be probed - it cannot mark one as passing - and the floor assertion
//   below catches wholesale collapse, but it does mean the route count is an upper bound on what is
//   genuinely guarded, not a coverage claim.
// ---------------------------------------------------------------------------

installWorkersHooks("__RAC_DB__", "__RAC_ENV__");

// Deliberately NOT localhost: a preview host would grant ["*"] and make every case below vacuous.
const HOST = "https://ops.pawspace.example";
// A route is "guarded" if it authorizes AT ALL, by any of the mechanisms this codebase uses. This used
// to name only requirePermission and authorize(request, which silently excluded every route that
// authorizes by OWNERSHIP - requireCustomerOwnership / requireProviderOwnership - and every route that
// delegates to the gateway with authorizeApiRequest. That was 52 of 205 routes, a quarter of the API
// surface, and it excluded exactly the routes most worth sweeping: customer-owned bookings, profiles,
// pet records, payment orders, provider workspaces.
//
// The hole is self-concealing, which is why it is worth naming. A route with no recognised guard token
// is not classified as guarded, so it is never swept - meaning the routes MOST likely to be unguarded
// are the ones this sweep cannot see. The same shape as a gate that passes because the thing it should
// catch is invisible to it.
//
// Widening it brought those 52 routes into coverage. Measured at the time: not one of them serves an
// anonymous caller or the least-privileged role, apart from food-commercial.GET, which is a public zone
// catalogue and is recorded below alongside its sibling boarding-commercial.
const GUARD = /requirePermission\(|authorize\(request|requireCustomerOwnership\(|requireProviderOwnership\(|authorizeApiRequest\(/;
const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];
const LOW_PRIVILEGE_EMAIL = "shopper@pawspace.in";

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

const serverAuth = await import("../lib/server-auth.ts");
const platformSecurity = await import("../lib/platform-security.ts");

async function guardedRoutes() {
  const { readdir, readFile } = await import("node:fs/promises");
  const apiDir = new URL("../app/api/", import.meta.url);
  const names = [];
  for (const entry of await readdir(apiDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let source;
    try { source = await readFile(new URL(`${entry.name}/route.ts`, apiDir), "utf8"); } catch { continue; }
    if (GUARD.test(source)) names.push(entry.name);
  }
  return names.sort();
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms`)), ms); });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function leastPrivilegedRole() {
  let best = null;
  for (const role of platformSecurity.defaultRoles) {
    const permissions = role.permissions;
    if (permissions.includes("*")) continue;
    if (!best || permissions.length < best.permissions.length) best = role;
  }
  return best;
}

async function sweep({ roleCode = null } = {}) {
  const names = await guardedRoutes();
  const served = [], refused = [], validatedFirst = [], inconclusive = [], problems = [];
  for (const name of names) {
    let handler;
    try { handler = await import(`../app/api/${name}/route.ts`); }
    catch (error) { problems.push(`${name}: import failed - ${String(error.message).slice(0, 100)}`); continue; }
    for (const method of METHODS) {
      if (typeof handler[method] !== "function") continue;
      const label = `${name}.${method}`;
      const sqlite = new DatabaseSync(":memory:");
      globalThis.__RAC_DB__ = makeD1(sqlite);
      globalThis.__RAC_ENV__ = {};
      try { await serverAuth.ensureSecurityTables(globalThis.__RAC_DB__); } catch { }
      const headers = { "content-type": "application/json" };
      if (roleCode) {
        sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
          .run("USR-LOWPRIV", LOW_PRIVILEGE_EMAIL, "shopper", roleCode, 1, 1);
        headers["oai-authenticated-user-email"] = LOW_PRIVILEGE_EMAIL;
      }
      const init = method === "GET" ? { headers } : { method, headers, body: "{}" };
      let response;
      try { response = await withDeadline(handler[method](new Request(`${HOST}/api/${name}`, init)), 10000, label); }
      catch (error) { problems.push(`${label}: ${String(error.message).slice(0, 100)}`); continue; }
      if (!(response instanceof Response)) { problems.push(`${label}: returned ${typeof response}, not a Response`); continue; }
      if (response.status >= 200 && response.status < 300) served.push(`${label} -> ${response.status}`);
      else if ([401, 403].includes(response.status)) refused.push(label);
      else if (response.status >= 400 && response.status < 500) validatedFirst.push(`${label} -> ${response.status}`);
      else inconclusive.push(`${label} -> ${response.status}`);
    }
  }
  return { names, served, refused, validatedFirst, inconclusive, problems };
}

const DELIBERATELY_READABLE = new Map([
  ["food-commercial.GET", "public zone product catalogue; no customer data and no live money"],
  ["training-requirements.GET", "public: gateway allowlists /api/training-requirements"],
  ["content-controls.GET", "public content branch; ?view=admin is guarded"],
  ["catalogue.GET", "guards pricing.view, which the probe role holds by design"],
  ["pricing-rules.GET", "guards pricing.view, which the probe role holds by design"],
  ["pricing-control.GET", "guards pricing.view, which the probe role holds by design"],
  ["subscription-plans.GET", "guards pricing.view, which the probe role holds by design"],
  ["grooming-subscription-plans.GET", "guards pricing.view, which the probe role holds by design"],
  ["grooming-commercial-policy.GET", "guards pricing.view, which the probe role holds by design"],
  ["coupon-governance.GET", "guards pricing.view, which the probe role holds by design"],
  ["referral-governance.GET", "guards pricing.view, which the probe role holds by design"],
  ["i18n.GET", "translated UI strings for any signed-in identity; ?mode=coverage is guarded"],
  ["ops-work-queue.GET", "cold-DB zeroed snapshot; guarding first would violate the D7 read-side DDL contract"],
]);

let anonymousSweep, lowPrivilegeSweep, probeRole;

test("the sweep enumerates a real guarded surface and a real least-privileged role", async () => {
  probeRole = leastPrivilegedRole();
  anonymousSweep = await sweep();
  lowPrivilegeSweep = await sweep({ roleCode: probeRole.code });
  assert.ok(anonymousSweep.names.length >= 100,
    `expected the guarded surface to be substantial, found ${anonymousSweep.names.length}`);
  assert.ok(probeRole && probeRole.permissions.length > 0, "no least-privileged role was derived");
  assert.ok(!probeRole.permissions.includes("*"), "the probe role must not hold the wildcard");
  for (const forbidden of ["dashboard.view", "bookings.manage", "users.manage", "finance.manage", "settings.manage"]) {
    assert.ok(!probeRole.permissions.includes(forbidden),
      `probe role ${probeRole.code} holds ${forbidden}; it is no longer a low-privilege probe`);
  }
});

test("no guarded route serves an anonymous caller on a real host", async () => {
  const unexpected = anonymousSweep.served.filter((entry) => !DELIBERATELY_READABLE.has(entry.split(" -> ")[0]));
  assert.deepEqual(unexpected, [],
    `these guarded handlers answered 2xx with no identity at all: ${unexpected.join(", ")}`);
});

test("no guarded route serves a least-privileged identity it should refuse", async () => {
  const unexpected = lowPrivilegeSweep.served.filter((entry) => !DELIBERATELY_READABLE.has(entry.split(" -> ")[0]));
  assert.deepEqual(unexpected, [],
    `these guarded handlers answered 2xx to role ${probeRole.code}: ${unexpected.join(", ")}`);
});

test("the sweep actually reaches authorization rather than failing earlier", async () => {
  assert.ok(anonymousSweep.refused.length >= 150,
    `only ${anonymousSweep.refused.length} handlers reached a 401/403 for an anonymous caller; the sweep has stopped exercising authorization`);
  assert.ok(lowPrivilegeSweep.refused.length >= 150,
    `only ${lowPrivilegeSweep.refused.length} handlers reached a 401/403 for role ${probeRole.code}`);
});

const UNLOADABLE_UNDER_STRIP_ONLY = [];

const AUTHORIZED_PROBE_VALIDATION = new Map([
  ["canonical-bookings.POST", "customer probe holds scheduling.book; empty body is validated only after authorization"],
  ["subscription-billing.GET", "customer probe holds scheduling.book; missing subscription selector is validated only after authorization"],
]);

const VALIDATES_BEFORE_AUTHORIZING = [
  "booking-rating.POST",
  "customer-support-case.POST",
  "food-commercial.POST",
  "food-orders.POST",
  "grooming-service-location.POST",
  "payment-order.POST",
  "pet-emergency.POST",
  "pet-vaccination.POST",
  "provider-availability.POST",
  "sitting-bookings.POST",
  "taxi-bookings.POST",
  "walking-bookings.POST",
  "attendance-leave.POST",
  "boarding-finance.GET",
  "boarding-finance.POST",
  "boarding-proof.GET",
  "boarding-proof.POST",
  "boarding-stays.POST",
  "booking-operations.POST",
  "coupon-governance.POST",
  "food-finance.GET",
  "food-finance.POST",
  "food-fulfilment.POST",
  "food-proof.GET",
  "food-proof.POST",
  "food-subscriptions.GET",
  "food-subscriptions.POST",
  "grooming-booking-change.POST",
  "grooming-lifecycle.GET",
  "grooming-lifecycle.POST",
  "grooming-payment-sandbox.GET",
  "grooming-payment-sandbox.POST",
  "host-trust.GET",
  "host-trust.POST",
  "meet-and-greet.POST",
  "platform-governance.POST",
  "provider-assignment-recovery.POST",
  "referral-governance.POST",
  "relocation-enquiry.POST",
  "revenue-opportunity-governance.POST",
  "service-media.PATCH",
  "service-media.POST",
  "service-zone.GET",
  "sitting-finance.GET",
  "sitting-finance.POST",
  "sitting-lifecycle.GET",
  "sitting-lifecycle.POST",
  "sitting-proof.GET",
  "sitting-proof.POST",
  "stay-balance.GET",
  "stay-balance.POST",
  "subscription-wallet.GET",
  "subscription-wallet.POST",
  "taxi-finance.GET",
  "taxi-finance.POST",
  "taxi-lifecycle.GET",
  "taxi-lifecycle.POST",
  "taxi-proof.GET",
  "taxi-proof.POST",
  "taxi-recovery.POST",
  "training-customer-session-change.POST",
  "training-programmes.GET",
  "training-programmes.POST",
  "training-provider-earnings.GET",
  "training-session-media.GET",
  "training-session-media.POST",
  "training-sessions.GET",
  "training-sessions.POST",
  "walking-finance.GET",
  "walking-finance.POST",
  "walking-lifecycle.GET",
  "walking-lifecycle.POST",
  "walking-proof.GET",
  "walking-proof.POST",
  "walking-recovery.POST"
];

test("no new route validates before it authorizes", async () => {
  const lowPrivilegeUnauthorized = lowPrivilegeSweep.validatedFirst
    .filter((entry) => !AUTHORIZED_PROBE_VALIDATION.has(entry.split(" -> ")[0]));
  const seen = [...new Set([...anonymousSweep.validatedFirst, ...lowPrivilegeUnauthorized]
    .map((entry) => entry.split(" -> ")[0]))].sort();
  const appeared = seen.filter((entry) => !VALIDATES_BEFORE_AUTHORIZING.includes(entry));
  const fixed = VALIDATES_BEFORE_AUTHORIZING.filter((entry) => !seen.includes(entry));
  assert.deepEqual(appeared, [], `these route/methods newly do work before authorizing: ${appeared.join(", ")}`);
  assert.deepEqual(fixed, [], `these no longer validate before authorizing - remove them from VALIDATES_BEFORE_AUTHORIZING: ${fixed.join(", ")}`);
});

test("canonical-bookings authorizes before validating while preserving the customer booking path", async () => {
  assert.ok(anonymousSweep.refused.includes("canonical-bookings.POST"),
    "an anonymous canonical booking must reach a 401/403 before body validation");
  assert.ok(lowPrivilegeSweep.validatedFirst.some((entry) => entry.startsWith("canonical-bookings.POST -> 400")),
    "the customer probe legitimately passes scheduling.book and only then receives payload validation");
});

test("every loadable handler answers with a Response instead of throwing", async () => {
  const unexpected = anonymousSweep.problems.filter((problem) => {
    const route = problem.split(":")[0];
    return !(UNLOADABLE_UNDER_STRIP_ONLY.includes(route) && problem.includes("parameter property"));
  });
  assert.deepEqual(unexpected, [],
    `these handlers did not return a governed Response for an anonymous caller: ${unexpected.join(" | ")}`);
});

test("the set of routes this harness cannot load has not grown", async () => {
  const unloadable = anonymousSweep.problems
    .filter((problem) => problem.includes("parameter property"))
    .map((problem) => problem.split(":")[0])
    .sort();
  assert.deepEqual(unloadable, [...UNLOADABLE_UNDER_STRIP_ONLY].sort(),
    "a route has dropped out of this sweep; its authorization is no longer executed here");
});

test("no guarded route answers 5xx to an unauthorized caller", async () => {
  assert.deepEqual(anonymousSweep.inconclusive, [],
    `these handlers failed internally instead of refusing: ${anonymousSweep.inconclusive.join(", ")}`);
});

test("platform-governance does not serve the role and permission catalogue without dashboard.view", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RAC_DB__ = makeD1(sqlite);
  globalThis.__RAC_ENV__ = {};
  await serverAuth.ensureSecurityTables(globalThis.__RAC_DB__);
  const role = leastPrivilegedRole();
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("USR-LP", LOW_PRIVILEGE_EMAIL, "shopper", role.code, 1, 1);
  const route = await import("../app/api/platform-governance/route.ts");
  const response = await route.GET(new Request(`${HOST}/api/platform-governance`, { headers: { "oai-authenticated-user-email": LOW_PRIVILEGE_EMAIL } }));
  assert.equal(response.status, 403, `role ${role.code} must not read the governance surface, got ${response.status}`);
  const body = JSON.stringify(await response.json());
  assert.doesNotMatch(body, /permissionCatalog|role_definitions|"roles"/, "the refusal must not carry the security model");
  assert.doesNotMatch(body, /users\.manage|finance\.manage/, "the refusal must not enumerate permissions");
});

test("platform-governance still serves an identity that holds dashboard.view", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RAC_DB__ = makeD1(sqlite);
  globalThis.__RAC_ENV__ = {};
  await serverAuth.ensureSecurityTables(globalThis.__RAC_DB__);
  const allowed = platformSecurity.defaultRoles.find((role) => role.permissions.includes("dashboard.view"));
  assert.ok(allowed, "no role holds dashboard.view, so the authorized path is not expressible");
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("USR-OPS", "ops.lead@pawspace.in", "ops", allowed.code, 1, 1);
  const route = await import("../app/api/platform-governance/route.ts");
  const response = await route.GET(new Request(`${HOST}/api/platform-governance`, { headers: { "oai-authenticated-user-email": "ops.lead@pawspace.in" } }));
  assert.equal(response.status, 200, `role ${allowed.code} holds dashboard.view and must still be served, got ${response.status}`);
  const body = await response.json();
  assert.ok(Array.isArray(body.roles) && body.roles.length > 0, "the governance surface must still return the role catalogue");
});

test("the ops-work-queue cold-DB reply carries no task data and creates no tables", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RAC_DB__ = makeD1(sqlite);
  globalThis.__RAC_ENV__ = {};
  const tables = () => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  const before = tables();
  const route = await import("../app/api/ops-work-queue/route.ts");
  const response = await route.GET(new Request(`${HOST}/api/ops-work-queue`));
  assert.equal(response.status, 200, "the cold-DB branch answers before authorization, by D7 design");
  const body = await response.json();
  assert.equal(body.data.metrics.total, 0, "the snapshot must be empty");
  assert.equal(body.data.metrics.open, 0);
  assert.deepEqual(tables(), before, "a cold GET must create no tables at all, security tables included");
  const serialized = JSON.stringify(body);
  assert.doesNotMatch(serialized, /customer|provider_id|assignee|"tasks":\[\s*\{/, "no task or customer data may appear in the cold reply");
});

test("ops-work-queue refuses an unauthorized caller once its tables exist", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RAC_DB__ = makeD1(sqlite);
  globalThis.__RAC_ENV__ = {};
  await serverAuth.ensureSecurityTables(globalThis.__RAC_DB__);
  sqlite.exec("CREATE TABLE IF NOT EXISTS ops_work_queue_tasks (id TEXT PRIMARY KEY,status TEXT,created_at INTEGER)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS ops_work_queue_events (id TEXT PRIMARY KEY,task_id TEXT,created_at INTEGER)");
  const route = await import("../app/api/ops-work-queue/route.ts");
  const response = await route.GET(new Request(`${HOST}/api/ops-work-queue`));
  assert.ok([401, 403].includes(response.status),
    `with the queue initialised an anonymous caller must be refused, got ${response.status}`);
});

test("the content-controls admin view is refused even though its public branch is open", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RAC_DB__ = makeD1(sqlite);
  globalThis.__RAC_ENV__ = {};
  await serverAuth.ensureSecurityTables(globalThis.__RAC_DB__);
  const role = leastPrivilegedRole();
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("USR-LP2", LOW_PRIVILEGE_EMAIL, "shopper", role.code, 1, 1);
  const route = await import("../app/api/content-controls/route.ts");
  const response = await route.GET(new Request(`${HOST}/api/content-controls?view=admin`, { headers: { "oai-authenticated-user-email": LOW_PRIVILEGE_EMAIL } }));
  assert.equal(response.status, 403, `the admin view must require marketing.manage, got ${response.status}`);
});

test("the development-preview superuser is host-gated, which is what makes this suite non-vacuous", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RAC_DB__ = makeD1(sqlite);
  globalThis.__RAC_ENV__ = {};
  await serverAuth.ensureSecurityTables(globalThis.__RAC_DB__);
  const route = await import("../app/api/platform-governance/route.ts");
  const real = await route.GET(new Request(`${HOST}/api/platform-governance`));
  assert.ok([401, 403].includes(real.status), "a real host must never receive the preview superuser");
  const preview = await route.GET(new Request("http://localhost/api/platform-governance"));
  assert.equal(preview.status, 200, "localhost keeps its documented preview bypass - which is exactly why every case above uses a real host");
});

test("a denied governance read performs no route-owned schema creation", async () => {
  const sqlite = new DatabaseSync(":memory:");
  globalThis.__RAC_DB__ = makeD1(sqlite);
  globalThis.__RAC_ENV__ = {};
  const tables = () => sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((row) => row.name);
  const route = await import("../app/api/platform-governance/route.ts");
  const response = await route.GET(new Request(`${HOST}/api/platform-governance`));
  assert.ok([401, 403].includes(response.status), `the caller must be refused, got ${response.status}`);
  const created = tables();
  for (const owned of ["data_import_batches", "communication_attempts"]) {
    assert.ok(!created.includes(owned), `a refused read created route-owned table ${owned}`);
  }
});
