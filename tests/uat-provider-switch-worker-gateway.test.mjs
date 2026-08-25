import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__UAT_SWITCH_DB__", "__UAT_SWITCH_ENV__");

const ORIGIN = "https://uat.pawspace.test";
const ENDPOINT = `${ORIGIN}/api/uat-provider-switch`;
const SIGNING_KEY = "k".repeat(32);
const ACCESS_CODE = "c".repeat(32);
const OPEN = { PAWSPACE_UAT_LOGIN: "on", PAWSPACE_UAT_SIGNING_KEY: SIGNING_KEY, PAWSPACE_UAT_ACCESS_CODE: ACCESS_CODE };

function makeD1(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (items) => { const results = []; for (const item of items) results.push(await item.run()); return results; },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

async function world(env) {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__UAT_SWITCH_DB__ = db;
  globalThis.__UAT_SWITCH_ENV__ = env;
  const capacity = await import("../lib/provider-capacity-governance.ts");
  await capacity.ensureProviderCapacityTables(db);
  await capacity.seedProviderCapacityDefaults(db);
  const { ensurePlatformSessionTables } = await import("../lib/platform-session.ts");
  await ensurePlatformSessionTables(db);
  const provider = sqlite.prepare("SELECT id FROM provider_capacity_profiles WHERE live=1 AND status='active' ORDER BY id LIMIT 1").get();
  assert.ok(provider?.id);
  return { sqlite, db, providerId: String(provider.id) };
}

async function throughGateway(request) {
  const env = { DB: globalThis.__UAT_SWITCH_DB__, ...globalThis.__UAT_SWITCH_ENV__ };
  const { authorizePlatformSessionRequest } = await import("../lib/session-api-gateway.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const sessionAccess = await authorizePlatformSessionRequest(request, env.DB);
  if (sessionAccess instanceof Response) return { refused: sessionAccess };
  const access = sessionAccess ?? await authorizeApiRequest(request, env);
  if (access instanceof Response) return { refused: access };
  return { access };
}

async function callEndpoint(request) {
  const gate = await throughGateway(request);
  if (gate.refused) return { reachedRoute: false, response: gate.refused };
  const route = await import("../app/api/uat-provider-switch/route.ts");
  const handler = request.method === "GET" ? route.GET : route.POST;
  return { reachedRoute: true, response: await handler(request) };
}

const post = (providerId, code) => new Request(ENDPOINT, {
  method: "POST",
  headers: { origin: ORIGIN, "content-type": "application/json" },
  body: JSON.stringify({ providerId, code }),
});

function written(sqlite) {
  return {
    bindings: Number(sqlite.prepare("SELECT COUNT(*) AS n FROM identity_bindings WHERE principal_key LIKE 'uat-provider:%'").get().n),
    sessions: Number(sqlite.prepare("SELECT COUNT(*) AS n FROM platform_identity_sessions").get().n),
  };
}

test("the UAT access code can mint the first provider session through the real Worker gateway", async () => {
  const { sqlite, providerId } = await world(OPEN);
  const result = await callEndpoint(post(providerId, ACCESS_CODE));
  assert.equal(result.reachedRoute, true, `gateway blocked the pre-session switch with ${result.response.status}`);
  assert.equal(result.response.status, 200);
  assert.match(String(result.response.headers.get("set-cookie")), /^pawspace_identity_session=/);
  assert.deepEqual(written(sqlite), { bindings: 1, sessions: 1 });
});

test("a wrong UAT code is rejected by the route, not hidden behind a contradictory prior-session requirement", async () => {
  const { sqlite, providerId } = await world(OPEN);
  const result = await callEndpoint(post(providerId, "wrong-code"));
  assert.equal(result.reachedRoute, true, "the access-code gate must be the pre-session authentication boundary");
  assert.equal(result.response.status, 401);
  assert.deepEqual(written(sqlite), { bindings: 0, sessions: 0 });
});

test("outside UAT the route remains production-dead through the complete gateway composition", async () => {
  const { sqlite, providerId } = await world({});
  const result = await callEndpoint(post(providerId, ACCESS_CODE));
  assert.equal(result.reachedRoute, true);
  assert.equal(result.response.status, 404);
  assert.deepEqual(written(sqlite), { bindings: 0, sessions: 0 });
});

test("the provider roster is available before the first session only when the UAT gate is enabled", async () => {
  await world(OPEN);
  const open = await callEndpoint(new Request(ENDPOINT));
  assert.equal(open.reachedRoute, true);
  assert.equal(open.response.status, 200);
  const body = await open.response.json();
  assert.ok(Array.isArray(body.data?.providers) && body.data.providers.length > 0);

  await world({});
  const closed = await callEndpoint(new Request(ENDPOINT));
  assert.equal(closed.reachedRoute, true);
  assert.equal(closed.response.status, 404);
});
