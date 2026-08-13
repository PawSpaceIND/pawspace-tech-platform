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

const CF_STUB = "data:text/javascript,export const env=new Proxy({},{get:(t,k)=>k===\"DB\"?globalThis.__NAV_DB__:(globalThis.__NAV_ENV__??{})[k]});";
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

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => {
        const row = sqlite.prepare(sql).get(...args);
        return row === undefined ? null : row;
      },
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (statements) => {
      const out = [];
      for (const item of statements) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

const repoFile = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__NAV_DB__ = db;
  return { sqlite, db };
}

const UAT_STAGING_ENV = {
  PAWSPACE_UAT_LOGIN: "on",
  PAWSPACE_UAT_SIGNING_KEY: "pawspace-staging-uat-signing-key-do-not-reuse-in-prod",
  PAWSPACE_UAT_ACCESS_CODE: "pawspace-uat-2026",
};

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

test("real execution: a signed staging session still resolves to a working actor", async () => {
  const { sqlite } = freshDb();
  globalThis.__NAV_ENV__ = UAT_STAGING_ENV;
  const security = await import("../lib/server-auth.ts");
  const uat = await import("../lib/uat-staging-auth.ts");

  const token = await uat.issueUatToken(UAT_STAGING_ENV, "tester@pawspace.in", 3600);
  const actor = await security.resolveActor(
    new Request("https://pawspace-staging.example/api/staff-alerts", { headers: { cookie: `pawspace_uat=${encodeURIComponent(token)}` } }),
  );
  assert.equal(actor.email, "tester@pawspace.in");
  assert.deepEqual(actor.permissions, ["*"]);

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

  // The three links from the reported screen, pinned explicitly.
  const performance = await repoFile("app/team/performance/page.tsx");
  for (const href of ["/team", "/crm", "/team/alerts"]) {
    assert.match(performance, new RegExp(`href="${href}"`));
    assert.ok(routes.has(href), `${href} must be a real route`);
  }
});
