/**
 * Staging report: "none of the links are working" on /team/performance.
 *
 * Navigation itself was exonerated by driving the built worker under workerd with a real browser: all
 * three header links (/team, /crm, /team/alerts) navigate and render. What actually made every screen
 * look dead was the end of the 8-hour UAT session (app/api/staging-login/route.ts): each gated API then
 * answered a bare "Authentication required" - as text/plain from the route layer, which every page reads
 * with response.json(), turning the message into `Unexpected token 'A', "Authentica"... is not valid
 * JSON` - and nothing anywhere pointed back at /staging-login. The performance page went further and
 * reported the failure as "No active productivity policy is configured yet", a claim about the system
 * that the response never supported.
 *
 * These tests execute the real gateway, the real resolveActor and the real route files.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, readdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { createD1 } from "./helpers/d1.mjs";

const CF_STUB = "data:text/javascript,export const env=new Proxy({},{get:(t,k)=>k===\"DB\"?globalThis.__NAV_DB__:(globalThis.__NAV_ENV__??{})[k]});";
// registerHooks() requires Node >= 22.15; CI pins 22.13.0, where it does not exist. Without this
// fallback the hook is never registered, "cloudflare:workers" fails to resolve, and every test in
// this file dies on CI while passing locally on a newer Node. Same shape as the other suites.
if (typeof nodeModule.registerHooks === "function") {
  nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "cloudflare:workers") return { url: CF_STUB, shortCircuit: true };
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(`${specifier}.ts`, context);
        throw error;
      }
    },
  });
} else {
  const hook = `const stub=${JSON.stringify('CF_STUB_PLACEHOLDER')};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: stub, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`.replace('"CF_STUB_PLACEHOLDER"', JSON.stringify(CF_STUB));
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

// batch() is one transaction in D1: see tests/helpers/d1.mjs. The loop this replaced committed
// each statement as it went, so any atomicity claim below was measured against the wrong machine.
const makeD1 = (sqlite, options) => createD1(sqlite, options);

const repoFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__NAV_DB__ = db;
  return { sqlite, db };
}

// Test-only values. These deliberately do NOT reuse the credentials that were once committed to the
// repository: scripts/stage-config.mjs now refuses those, and a test should not keep them in play.
const UAT_STAGING_ENV = {
  PAWSPACE_UAT_LOGIN: "on",
  PAWSPACE_UAT_SIGNING_KEY: "navigation-recovery-test-signing-key-32",
  PAWSPACE_UAT_ACCESS_CODE: "navigation-recovery-code",
};

/** UAT sign-in resolves an identity from the staff directory, so a test needs a real staff row. */
function seedStaff(sqlite, email, roleCode = "manager", permissions = ["*"]) {
  // DDL copied from lib/api-gateway.ts, which owns both tables and may have created them already; the
  // INSERTs name their columns so they work against either the owner's schema or this one.
  sqlite.exec("CREATE TABLE IF NOT EXISTS app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE IF NOT EXISTS role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)").run(`U-${email}`, email, email, roleCode, "active", 0, 0);
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)").run(roleCode, roleCode, "seeded for this test", JSON.stringify(permissions), 1, 0);
}

test("real execution: an expired staging session is answered with JSON that names the way back in", async () => {
  const { db } = freshDb();
  globalThis.__NAV_ENV__ = UAT_STAGING_ENV;
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");

  const denied = await authorizeApiRequest(
    new Request("https://pawspace-staging.example/api/employee-performance?metric=net_collected_revenue&days=30"),
    { DB: db, ...UAT_STAGING_ENV },
  );
  assert.ok(denied instanceof Response);
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get("content-type") ?? "", /application\/json/);

  const payload = await denied.json();
  assert.equal(payload.code, "sign_in_required");
  assert.equal(payload.signInUrl, "/staging-login");
  assert.match(payload.error, /\/staging-login/);
});

test("real execution: production keeps the original 401 contract - no staging sign-in leaks into it", async () => {
  const { db } = freshDb();
  globalThis.__NAV_ENV__ = {};
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");

  const denied = await authorizeApiRequest(
    new Request("https://pawspace.example/api/employee-performance"),
    { DB: db },
  );
  assert.ok(denied instanceof Response);
  assert.equal(denied.status, 401);
  assert.deepEqual(await denied.json(), { error: "Authentication required" });
});

test("real execution: route-level auth failures are JSON, not the text body that pages could not parse", async () => {
  freshDb();
  globalThis.__NAV_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.in" };
  const security = await import("../lib/server-auth.ts");

  // No forwarded identity, no session, no UAT cookie: exactly the state a tester lands in when the
  // staging cookie lapses while the tab is open.
  const rejected = await security.resolveActor(new Request("https://pawspace-staging.example/api/staff-alerts")).then(
    () => null,
    (error) => error,
  );
  assert.ok(rejected instanceof Response, "resolveActor must reject with a Response");
  assert.equal(rejected.status, 401);
  assert.match(rejected.headers.get("content-type") ?? "", /application\/json/);
  // The regression: JSON.parse of the old body threw `Unexpected token 'A'` inside every page.
  const body = await rejected.text();
  assert.deepEqual(JSON.parse(body), { error: "Authentication required" });

  const forbidden = (() => {
    try {
      security.requirePermission(
        { email: "a@b.c", name: "A", roleCode: "associate", permissions: ["dashboard.view"], developmentPreview: false, identitySource: "workspace", principalType: "email", principalKey: "a@b.c" },
        "finance.manage",
      );
      return null;
    } catch (error) {
      return error;
    }
  })();
  assert.ok(forbidden instanceof Response);
  assert.equal(forbidden.status, 403);
  assert.match(forbidden.headers.get("content-type") ?? "", /application\/json/);
  assert.deepEqual(await forbidden.json(), { error: "Permission denied" });
});

// This test used to sign in as "tester@pawspace.in" — an address in no staff directory — and assert it
// resolved to permissions ["*"]. That was the privilege-escalation defect written down as the expected
// behaviour: the access code alone conferred full authority over the staging workspace. The test's real
// purpose is that a VALID staging session resolves to a working actor and an invalid one is routed back
// to sign-in, and both halves are kept — but the identity now has to exist.
test("real execution: a signed staging session resolves to a working actor from the staff directory", async () => {
  const { sqlite } = freshDb();
  globalThis.__NAV_ENV__ = UAT_STAGING_ENV;
  const security = await import("../lib/server-auth.ts");
  const uat = await import("../lib/uat-staging-auth.ts");
  seedStaff(sqlite, "seeded.tester@pawspace.in", "founder", ["*"]);

  const token = await uat.issueUatToken(UAT_STAGING_ENV, "seeded.tester@pawspace.in", 3600);
  const actor = await security.resolveActor(
    new Request("https://pawspace-staging.example/api/staff-alerts", { headers: { cookie: `pawspace_uat=${encodeURIComponent(token)}` } }),
  );
  assert.equal(actor.email, "seeded.tester@pawspace.in");
  assert.deepEqual(actor.permissions, ["*"], "a seeded founder gets the founder role's own permissions");

  // The other half of the same property: an address that is NOT in the directory gets nothing, however
  // valid its cookie. A valid cookie proves someone knew the access code, not who they are.
  const strangerToken = await uat.issueUatToken(UAT_STAGING_ENV, "stranger@example.com", 3600);
  const stranger = await uat.resolveUatStaffActor(globalThis.__NAV_DB__, new Request("https://pawspace-staging.example/api/staff-alerts", { headers: { cookie: `pawspace_uat=${encodeURIComponent(strangerToken)}` } }), UAT_STAGING_ENV);
  assert.equal(stranger, null, "an unrecognised email must not become founder");

  const seeded = sqlite.prepare("SELECT COUNT(*) AS total FROM role_definitions").get();
  assert.ok(Number(seeded.total) > 0, "resolveActor seeds the role catalogue it reads");

  // A cookie that no longer verifies is refused and routed back to sign-in, so the prompt is truthful
  // rather than a second dead screen.
  const [payloadPart] = token.split(".");
  const rejected = await security
    .resolveActor(new Request("https://pawspace-staging.example/api/staff-alerts", { headers: { cookie: `pawspace_uat=${encodeURIComponent(`${payloadPart}.tampered-signature`)}` } }))
    .then(() => null, (error) => error);
  assert.ok(rejected instanceof Response);
  assert.equal(rejected.status, 401);
  assert.equal((await rejected.json()).signInUrl, "/staging-login");
});

test("the performance page never reports an unreadable response as 'no policy configured'", async () => {
  const page = await repoFile("app/team/performance/page.tsx");

  // Policy state is read from the governance response itself, never inferred from a failed request.
  assert.match(page, /policy\.status==="active_uat"/);
  assert.doesNotMatch(page, /No active productivity policy is configured yet/);
  // Every response body is parsed defensively, so a non-JSON body cannot become the error message.
  assert.match(page, /response\.json\(\)\.catch\(/);
  // A 401 that names a way back in is offered to the tester.
  assert.match(page, /signInUrl/);
  assert.match(page, /Sign in again/);
});

test("every in-app link target resolves to a real route", async () => {
  const appRoot = new URL("../app/", import.meta.url);

  async function walk(dir, out = []) {
    for (const entry of await readdir(dir)) {
      const full = new URL(entry, dir);
      if ((await stat(full)).isDirectory()) await walk(new URL(`${entry}/`, dir), out);
      else out.push(full);
    }
    return out;
  }

  const files = await walk(appRoot);
  const routes = new Set();
  for (const file of files) {
    if (!file.pathname.endsWith("/page.tsx")) continue;
    let route = `/${file.pathname.slice(appRoot.pathname.length).replace(/\/?page\.tsx$/, "")}`;
    route = route.replace(/\/\([^/]+\)/g, "");
    routes.add(route === "" || route === "/" ? "/" : route.replace(/\/$/, ""));
  }
  assert.ok(routes.size > 100, "route table should cover the app router tree");
  const dynamicRoutes = [...routes].filter((route) => route.includes("["));

  const resolves = (href) => {
    const clean = href.split("#")[0].split("?")[0].replace(/\/$/, "") || "/";
    if (routes.has(clean)) return true;
    const parts = clean.split("/").filter(Boolean);
    for (const route of dynamicRoutes) {
      const routeParts = route.split("/").filter(Boolean);
      if (routeParts.length !== parts.length) continue;
      if (routeParts.every((part, index) => part.startsWith("[") || part === parts[index])) return true;
    }
    return existsSync(new URL(`../public${clean}`, import.meta.url));
  };

  const broken = [];
  for (const file of files) {
    if (!/\.tsx?$/.test(file.pathname)) continue;
    const source = await readFile(file, "utf8");
    source.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(/href=(?:"|')(\/[^"']*)(?:"|')/g)) {
        const href = match[1];
        if (href.startsWith("/api/") || href.startsWith("//")) continue;
        if (!resolves(href)) broken.push(`${file.pathname.slice(appRoot.pathname.length)}:${index + 1} -> ${href}`);
      }
      for (const match of line.matchAll(/router\.(?:push|replace)\(\s*(?:"|')(\/[^"']*)(?:"|')/g)) {
        const href = match[1];
        if (href.startsWith("/api/")) continue;
        if (!resolves(href)) broken.push(`${file.pathname.slice(appRoot.pathname.length)}:${index + 1} -> ${href} (router)`);
      }
    });
  }
  assert.deepEqual(broken, [], `link targets without a route:\n${broken.join("\n")}`);

  // The navigation from the reported screen now lives in the Operations rail every console renders
  // inside, so it is pinned there - and the rail's targets must resolve like any other link.
  const rail = await repoFile("app/components/ops-shell/OpsShell.tsx");
  for (const href of ["/team", "/team/operations", "/team/performance", "/team/marketing"]) {
    assert.match(rail, new RegExp(`href: "${href}"`), `${href} must be reachable from the Operations rail`);
    assert.ok(routes.has(href), `${href} must be a real route`);
  }
  // The console itself no longer carries a second navigation row.
  const performance = await repoFile("app/team/performance/page.tsx");
  assert.doesNotMatch(performance, /className=\{styles\.nav\}/);
});
