import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// A staging-login staff cookie is resolved before the platform session, so on a provider-scoped
// route it used to shadow an explicit provider binding: the partner presented the credential the
// UAT switch had just minted for them and still got a redacted 403, with no way to make the
// binding count. Nothing in the response said which of the two cookies had won.
//
// Two things are checked here, and they fail for different reasons on purpose:
//   - the precedence itself, driven through the real resolvePrimaryActor with both cookies set;
//   - that PROVIDER_SCOPED_API_PATHS still covers every route that calls requireProviderOwnership,
//     so a provider route added later cannot silently reintroduce the shadowing.
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
} else {
  const hook = `const workersUrl=${JSON.stringify(workersUrl)};
  export async function resolve(specifier, context, nextResolve) {
    if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true };
    try { return await nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context);
      throw error;
    }
  }`;
  nodeModule.register(new URL(`data:text/javascript,${encodeURIComponent(hook)}`));
}

function makeD1(sqlite) {
  function statement(sql, args) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
      run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
    exec: async (sql) => { sqlite.exec(sql); },
  };
}

const ORIGIN = "https://uat.pawspace.test";
const GOOD_KEY = "k".repeat(32);
const GOOD_CODE = "c".repeat(32);
const OPEN = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: GOOD_KEY, PAWSPACE_UAT_ACCESS_CODE: GOOD_CODE };

/** A provider route, and a route that has nothing to do with provider ownership. */
const PROVIDER_ROUTE = `${ORIGIN}/api/grooming-route`;
const NEUTRAL_ROUTE = `${ORIGIN}/api/admin/sales-targets`;

async function world({ staffRole } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db, ...OPEN };

  const auth = await import("../lib/server-auth.ts");
  await auth.ensureSecurityTables(db);
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const binding = await import("../lib/identity-binding.ts");
  await binding.ensureIdentityBindingTables(db);
  const platform = await import("../lib/platform-session.ts");
  await platform.ensurePlatformSessionTables(db);

  // The staff identity. `ops` carries bookings.manage, so actorManagesProviders() is true for it;
  // `viewer` carries none of the manage permissions and is the role that gets stuck on a 403.
  const permissions = staffRole === "ops"
    ? JSON.stringify(["bookings.view", "bookings.manage"])
    : JSON.stringify(["bookings.view"]);
  const role = staffRole ?? "viewer";
  const now = Date.now();
  sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,0,?)")
    .run(role, role, `${role} fixture`, permissions, now);
  sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',?,?)")
    .run("U1", "tester@pawspace.in", "Tester", role, now, now);

  const live = sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE live=1 AND status='active' ORDER BY id").all();
  return { sqlite, db, providerId: String(live[0].id) };
}

/** The staff staging-login cookie, minted exactly as /api/staging-login mints it. */
async function staffCookie() {
  const uat = await import("../lib/uat-staging-auth.ts");
  const token = await uat.issueUatToken(globalThis.__PAWSPACE_TEST_ENV, "tester@pawspace.in", 3600);
  return `pawspace_uat=${encodeURIComponent(token)}`;
}

/** Drive the real switch and return the platform session cookie pair it sets. */
async function switchToProvider(providerId) {
  const { POST } = await import("../app/api/uat-provider-switch/route.ts");
  const response = await POST(new Request(`${ORIGIN}/api/uat-provider-switch`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ providerId, code: GOOD_CODE }),
  }));
  assert.equal(response.status, 200, "the switch must succeed before precedence means anything");
  return response.headers.getSetCookie();
}

const sessionValue = (cookies) => {
  const raw = cookies.find(item => item.startsWith("pawspace_identity_session="));
  return raw.split(";")[0];
};

const actorOn = async (url, cookie) => {
  const auth = await import("../lib/server-auth.ts");
  return auth.resolvePrimaryActor(new Request(url, { headers: { cookie } }));
};

// --- the shadowing itself -------------------------------------------------------------------------

test("a provider binding outranks a staff cookie that cannot manage providers, on a provider route", async () => {
  const { providerId } = await world();
  const cookies = await switchToProvider(providerId);
  const cookie = `${await staffCookie()}; ${sessionValue(cookies)}`;

  const actor = await actorOn(PROVIDER_ROUTE, cookie);
  assert.equal(actor.subjectType, "provider", "the explicit provider binding must win here");
  assert.equal(actor.principalKey, `uat-provider:${providerId}`);
  assert.equal(actor.identitySource, "partner_otp");
});

test("the same two cookies still resolve to the staff actor away from provider routes", async () => {
  const { providerId } = await world();
  const cookies = await switchToProvider(providerId);
  const cookie = `${await staffCookie()}; ${sessionValue(cookies)}`;

  const actor = await actorOn(NEUTRAL_ROUTE, cookie);
  assert.equal(actor.email, "tester@pawspace.in", "no permissions may move on a route that is not provider-scoped");
  assert.equal(actor.principalType, "email");
});

test("staff who can manage providers keep precedence even on a provider route", async () => {
  // The de-escalation must not cost an ops user their own session; they never hit this 403 anyway,
  // because actorManagesProviders() short-circuits requireProviderOwnership before any binding read.
  const { providerId } = await world({ staffRole: "ops" });
  const cookies = await switchToProvider(providerId);
  const cookie = `${await staffCookie()}; ${sessionValue(cookies)}`;

  const actor = await actorOn(PROVIDER_ROUTE, cookie);
  assert.equal(actor.email, "tester@pawspace.in", "an ops actor must not be downgraded to the provider session");
});

test("a provider route with only the staff cookie is unchanged", async () => {
  await world();
  const actor = await actorOn(PROVIDER_ROUTE, await staffCookie());
  assert.equal(actor.email, "tester@pawspace.in", "with no platform session there is nothing to defer to");
});

test("requireProviderOwnership accepts the binding the switch issued", async () => {
  const { db, providerId } = await world();
  const cookies = await switchToProvider(providerId);
  const cookie = `${await staffCookie()}; ${sessionValue(cookies)}`;

  const auth = await import("../lib/server-auth.ts");
  const actor = await actorOn(PROVIDER_ROUTE, cookie);
  await auth.requireProviderOwnership(db, actor, providerId);

  // And it is still a real gate: the binding is for one provider, not for the roster.
  await assert.rejects(
    () => auth.requireProviderOwnership(db, actor, "SOME-OTHER-PROVIDER"),
    "ownership of a different provider must still be refused",
  );
});

// --- the switch leaves one credential behind ------------------------------------------------------

test("the switch clears the staff cookie it would otherwise be shadowed by", async () => {
  const { providerId } = await world();
  const cookies = await switchToProvider(providerId);

  const cleared = cookies.find(item => item.startsWith("pawspace_uat="));
  assert.ok(cleared, "the staff cookie must be cleared in the same response");
  assert.match(cleared, /Max-Age=0/, "cleared, not re-issued");
  assert.ok(cookies.some(item => item.startsWith("pawspace_identity_session=")), "the provider session must still be set");
});

// --- the drift guard ------------------------------------------------------------------------------

function routeFiles(dir, found = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) routeFiles(full, found);
    else if (entry === "route.ts") found.push(full);
  }
  return found;
}

test("every route that gates on requireProviderOwnership is covered by providerScopedRequest", async () => {
  // Without this, adding a provider route is enough to bring the shadowing back for that route
  // alone — the failure would look exactly like the original bug and point nowhere near this change.
  const { providerScopedRequest } = await import("../lib/server-auth.ts");
  const missed = [];
  for (const file of routeFiles("app/api")) {
    if (!readFileSync(file, "utf8").includes("requireProviderOwnership")) continue;
    const path = `/${file.replace(/^app\//, "").replace(/\/route\.ts$/, "")}`;
    if (!providerScopedRequest(new Request(`${ORIGIN}${path}`))) missed.push(path);
  }
  assert.deepEqual(missed, [], "these provider routes are not in PROVIDER_SCOPED_API_PATHS");
});

test("providerScopedRequest does not claim routes that are not provider-scoped", async () => {
  const { providerScopedRequest } = await import("../lib/server-auth.ts");
  for (const path of ["/api/admin/sales-targets", "/api/me", "/api/razorpay-webhook", "/api/customer-checkout"]) {
    assert.equal(providerScopedRequest(new Request(`${ORIGIN}${path}`)), false, `${path} must keep staff precedence`);
  }
  // A trailing slash is the same route, and a malformed URL is not a provider route.
  assert.equal(providerScopedRequest(new Request(`${ORIGIN}/api/grooming-route/`)), true);
});
