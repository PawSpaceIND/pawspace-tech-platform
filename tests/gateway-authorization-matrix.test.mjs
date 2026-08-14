import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// Every gated API route × every real role, through the real gateway.
//
// Only eight tests in the suite went through authorizeApiRequest, and 35 used a localhost URL. The
// gateway short-circuits localhost to a development-preview superuser holding ["*"]:
//
//     if(["terminal.local","localhost","127.0.0.1"].includes(url.hostname))
//       return {actor:{...,permissions:["*"],preview:true},permission};
//
// So those tests could never observe a denial - they asserted that a superuser is allowed, which is
// true of every route and proves nothing. That is how an over-permissive route reaches UAT green.
//
// This suite authenticates for real against a non-localhost host, once per route per role, and
// asserts the decision the role's own permissions imply.
//
// The expectation is DERIVED, never written down. The route's required permission is learned by
// asking the gateway itself (as founder, who holds "*"), and each other role's expected verdict is
// hasPermission(role.permissions, thatPermission). A hand-written table would be another place for
// the bug to hide - if someone widens a route, this suite fails rather than agreeing with the change.
// ---------------------------------------------------------------------------
installWorkersHooks("__GWMATRIX_DB__", "__GWMATRIX_ENV__");

/** A host that is not localhost, so the development-preview bypass cannot fire. */
const HOST = "https://pawspace-staging.example.dev";

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

function seed(roles) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role_code TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE role_definitions (code TEXT PRIMARY KEY, name TEXT, description TEXT, permissions_json TEXT, system_role INTEGER, updated_at INTEGER);
    CREATE TABLE security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT, actor_role TEXT, action TEXT, resource_type TEXT, resource_id TEXT, outcome TEXT, detail_json TEXT, created_at INTEGER);
    CREATE TABLE api_audit_events (id TEXT PRIMARY KEY, actor_email TEXT, actor_role TEXT, method TEXT, path TEXT, outcome TEXT, detail_json TEXT, created_at INTEGER);`);
  for (const role of roles) {
    sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,0)")
      .run(role.code, role.name, role.description, JSON.stringify(role.permissions));
    sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',0,0)")
      .run(`u-${role.code}`, `${role.code}@pawspace.test`, role.code, role.code);
  }
  return sqlite;
}

/** Ask the gateway to decide, as this role, for this route and method. */
async function decide(authorizeApiRequest, env, route, method, roleCode) {
  const init = { method, headers: { "oai-authenticated-user-email": `${roleCode}@pawspace.test` } };
  if (method !== "GET") { init.body = "{}"; init.headers["content-type"] = "application/json"; }
  const result = await authorizeApiRequest(new Request(`${HOST}${route}`, init), env);
  if (result instanceof Response) return { allowed: false, status: result.status, permission: null };
  return { allowed: true, status: 200, permission: result.permission };
}

// ---------------------------------------------------------------------------
// The behavioural matrix below proves the gateway CONSULTS permissions - that a denial is a 403,
// that an unprovisioned identity is refused, that no route skips the check. It cannot prove the
// route asks for the RIGHT permission, because it learns the requirement from the gateway itself:
// widen a route and both the expectation and the decision move together, and the test stays green.
//
// So the policy is frozen in tests/fixtures/route-permissions.json. Changing what a route demands
// now fails here and has to be re-approved deliberately, which is the guard that matters: 54 of the
// 219 gated pairs sit behind bookings.view, a permission the service_provider role holds, and
// quietly moving a route into that set is exactly how the ops-console disclosure happened.
// ---------------------------------------------------------------------------
test("no route silently changes what it demands", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sqlite = seed(defaultRoles);
  const env = { DB: makeD1(sqlite), FOUNDER_EMAIL: "founder@pawspace.test" };
  globalThis.__GWMATRIX_DB__ = env.DB;
  globalThis.__GWMATRIX_ENV__ = env;

  const approved = JSON.parse(await readFile(new URL("./fixtures/route-permissions.json", import.meta.url), "utf8"));
  const source = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  const routes = [...new Set([...source.matchAll(/url\.pathname==="(\/api\/[a-z0-9-]+)"/g)].map((m) => m[1]))].sort();

  const live = {};
  for (const route of routes) {
    for (const method of ["GET", "POST"]) {
      const decision = await decide(authorizeApiRequest, env, route, method, "founder");
      if (decision.allowed && decision.permission) live[`${method} ${route}`] = decision.permission;
    }
  }

  const changed = [];
  for (const key of new Set([...Object.keys(approved), ...Object.keys(live)])) {
    if (approved[key] !== live[key]) changed.push(`${key}: approved ${approved[key] || "(ungated)"} → now ${live[key] || "(ungated)"}`);
  }
  assert.deepEqual(changed, [], `a route changed the permission it demands. If that is intended, update tests/fixtures/route-permissions.json in the same commit and say why:\n  ${changed.join("\n  ")}`);
});

test("every gated route allows exactly the roles whose permissions say so", async () => {
  const { defaultRoles, hasPermission } = await import("../lib/platform-security.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");

  const sqlite = seed(defaultRoles);
  const env = { DB: makeD1(sqlite), FOUNDER_EMAIL: "founder@pawspace.test" };
  globalThis.__GWMATRIX_DB__ = env.DB;
  globalThis.__GWMATRIX_ENV__ = env;

  // The routes the gateway itself knows about. Enumeration only - every assertion below is a real
  // authorization decision, not a claim about this file's text.
  const source = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");
  const routes = [...new Set([...source.matchAll(/url\.pathname==="(\/api\/[a-z0-9-]+)"/g)].map((m) => m[1]))];
  assert.ok(routes.length > 40, `expected the gateway to map many routes, found ${routes.length}`);

  const founder = defaultRoles.find((r) => r.permissions.includes("*")) || defaultRoles.find((r) => r.code === "founder");
  assert.ok(founder, "a role holding * is required to derive each route's permission");

  const failures = [];
  let checked = 0;

  for (const route of routes) {
    for (const method of ["GET", "POST"]) {
      // Learn what this route requires by asking the gateway as the role that can open everything.
      const asFounder = await decide(authorizeApiRequest, env, route, method, founder.code);
      if (!asFounder.allowed) {
        failures.push(`${method} ${route}: ${founder.code} holding * was denied (${asFounder.status})`);
        continue;
      }
      const permission = asFounder.permission;
      if (!permission) continue; // ungated by design

      for (const role of defaultRoles) {
        if (role.code === founder.code) continue;
        const expected = hasPermission(role.permissions, permission);
        const actual = await decide(authorizeApiRequest, env, route, method, role.code);
        checked += 1;
        if (actual.allowed !== expected) {
          failures.push(
            `${method} ${route} requires ${permission}: ${role.code} ${actual.allowed ? "was ALLOWED" : "was DENIED"}` +
            ` but its permissions say ${expected ? "allow" : "deny"}`,
          );
        }
        if (!expected && actual.allowed === false) assert.equal(actual.status, 403, `${method} ${route} must deny with 403`);
      }
    }
  }

  assert.ok(checked > 200, `expected a wide matrix, only ${checked} decisions were made`);
  assert.deepEqual(failures, [], `authorization decisions disagreed with the roles that grant them:\n  ${failures.join("\n  ")}`);
});

test("an unauthenticated request is refused, and localhost is not used to fake a superuser", async () => {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sqlite = seed(defaultRoles);
  const env = { DB: makeD1(sqlite), FOUNDER_EMAIL: "founder@pawspace.test" };
  globalThis.__GWMATRIX_DB__ = env.DB;
  globalThis.__GWMATRIX_ENV__ = env;

  const anonymous = await authorizeApiRequest(new Request(`${HOST}/api/company-analytics`), env);
  assert.ok(anonymous instanceof Response, "an anonymous request to a gated route must be refused");
  assert.ok([401, 403].includes(anonymous.status), `expected 401/403, got ${anonymous.status}`);

  // An identity with no app_users row must be refused rather than defaulted to some role.
  const unknown = await authorizeApiRequest(
    new Request(`${HOST}/api/company-analytics`, { headers: { "oai-authenticated-user-email": "nobody@pawspace.test" } }),
    env,
  );
  assert.ok(unknown instanceof Response, "an unprovisioned identity must be refused");
  assert.equal(unknown.status, 403);
});

test("no authorization test reaches for localhost, where the gateway hands out a superuser", async () => {
  // localhost short-circuits to permissions:["*"], so an auth test written against it asserts
  // nothing. This guard keeps the matrix honest, and stops the pattern coming back.
  const source = await readFile(new URL("./gateway-authorization-matrix.test.mjs", import.meta.url), "utf8");
  const urls = [...source.matchAll(/new Request\(`([^`]+)`/g)].map((m) => m[1]);
  for (const url of urls) {
    assert.doesNotMatch(url, /localhost|127\.0\.0\.1|terminal\.local/, `authorization must not be tested against ${url}`);
  }
});
