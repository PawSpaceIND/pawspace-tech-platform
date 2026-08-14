import test from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// Does the handler actually refuse someone who lacks the permission?
//
// Dozens of tests answered that by reading the file and matching
// /requirePermission\(actor,"pricing\.manage"\)/. That assertion passes on a route that computes the
// answer first and checks second, on a route that catches its own 403, and on a route whose check
// sits in a branch that never runs. It is a spell-check for a security control. The launch-readiness
// route proved the cost this week: a test asserted /Authentication required/ and passed *because*
// the route threw a plain-text 401 that broke every caller's response.json().
//
// This drives the real exported handlers instead. Every route that claims a permission check is
// called twice against a non-localhost URL - once as an identity holding nothing, once as the
// founder - and must refuse the first. The second call is what stops this suite passing for the
// wrong reason: a route that refuses everyone would satisfy a deny-only test.
// ---------------------------------------------------------------------------
installWorkersHooks("__RPE_DB__", "__RPE_ENV__");

const HOST = "https://pawspace-staging.example.dev";
const METHODS = ["GET", "POST", "PATCH", "DELETE"];

// This shim is deliberately permissive: the routes under test write to tables this harness does not
// create, and the shape being measured is whether an outsider is refused - not whether the write
// lands. So it delegates to createD1 (one transaction per batch, rolled back on failure) and then
// swallows the error, rather than hand-rolling a shim that never had a transaction to begin with.
function makeD1(sqlite) {
  const inner = createD1(sqlite);
  const tolerant = (statement) => ({
    ...statement,
    bind: (...bound) => tolerant(statement.bind(...bound)),
    first: async () => { try { return await statement.first(); } catch { return null; } },
    all: async () => { try { return await statement.all(); } catch { return { results: [] }; } },
    run: async () => { try { return await statement.run(); } catch { return { success: true, meta: { changes: 0 } }; } },
  });
  return {
    prepare: (sql) => tolerant(inner.prepare(sql)),
    batch: async (list) => {
      try { return await inner.batch(list); }
      catch { return list.map(() => ({ success: true, meta: { changes: 0 } })); }
    },
    exec: async (sql) => { try { return await inner.exec(sql); } catch { return { count: 0, duration: 0 }; } },
  };
}

async function bootstrap() {
  const { defaultRoles } = await import("../lib/platform-security.ts");
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role_code TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE role_definitions (code TEXT PRIMARY KEY, name TEXT, description TEXT, permissions_json TEXT, system_role INTEGER, updated_at INTEGER);
    CREATE TABLE security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT, actor_role TEXT, action TEXT, resource_type TEXT, resource_id TEXT, outcome TEXT, detail_json TEXT, created_at INTEGER);`);
  // A real, provisioned identity that simply holds no permissions - the case a source regex cannot see.
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES ('nobody','Nobody','Holds nothing','[]',1,0)").run();
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES ('u-nobody','nobody@pawspace.test','Nobody','nobody','active',0,0)").run();
  for (const role of defaultRoles) {
    sqlite.prepare("INSERT OR REPLACE INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,0)")
      .run(role.code, role.name, role.description, JSON.stringify(role.permissions));
    sqlite.prepare("INSERT OR REPLACE INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',0,0)")
      .run(`u-${role.code}`, `${role.code}@pawspace.test`, role.code, role.code);
  }
  const DB = makeD1(sqlite);
  const env = { DB, FOUNDER_EMAIL: "founder@pawspace.test" };
  globalThis.__RPE_DB__ = DB;
  globalThis.__RPE_ENV__ = env;
  return env;
}

function request(route, method, email) {
  const init = { method, headers: { "oai-authenticated-user-email": email } };
  if (method !== "GET") { init.body = "{}"; init.headers["content-type"] = "application/json"; }
  return new Request(`${HOST}/api/${route}`, init);
}

/** A handler may legitimately throw; what matters is whether an outsider ever gets a 2xx. */
async function statusOf(handler, route, method, email) {
  try {
    const response = await handler(request(route, method, email));
    return response && typeof response.status === "number" ? response.status : 0;
  } catch (error) {
    if (error instanceof Response) return error.status;
    return -1; // threw something that is not a Response: not a refusal, but not a disclosure either
  }
}

test("a gated handler refuses an identity that holds nothing, without relying on the gateway", async () => {
  const env = await bootstrap();
  assert.ok(env.DB, "the D1 shim must be installed before any route module is imported");

  // worker/index.ts runs authorizeApiRequest in front of every /api/* request, so the gateway is the
  // primary control and a handler is never reached unguarded in production. What this measures is the
  // second layer: whether the handler still refuses when called directly. A route that only passes
  // because of the gateway is one refactor away from being exposed, and /api/identity-session already
  // bypasses the gateway by design - so the layer has to actually exist, not be assumed.
  //
  // The gated set comes from the frozen policy, not from grepping for the word requirePermission. A
  // route the gateway leaves public (GET /api/i18n, the non-admin view of /api/content-controls) is
  // correctly served to anyone, and counting it as a leak would be a false alarm.
  const approved = JSON.parse(await readFile(new URL("./fixtures/route-permissions.json", import.meta.url), "utf8"));
  const gated = new Map();
  for (const key of Object.keys(approved)) {
    const [method, path] = key.split(" ");
    const name = path.replace("/api/", "");
    if (!gated.has(name)) gated.set(name, new Set());
    gated.get(name).add(method);
  }
  assert.ok(gated.size > 40, `expected many gated routes in the frozen policy, found ${gated.size}`);

  const served = [];
  const gatewayOnly = [];
  let exercised = 0;

  for (const [route, methods] of gated) {
    let handlers;
    try { handlers = await import(`../app/api/${route}/route.ts`); }
    catch { continue; } // cannot load in this harness; the gateway matrix still covers it
    for (const method of METHODS) {
      if (!methods.has(method)) continue;
      const handler = handlers[method];
      if (typeof handler !== "function") continue;
      const outsider = await statusOf(handler, route, method, "nobody@pawspace.test");
      if (outsider === 0) continue;
      exercised += 1;
      // A refusal is 401 or 403 and nothing else. This used to accept any non-2xx, which quietly
      // counted the wrong thing: POST /api/scheduling-rules validates its body before it looks at
      // who is asking, so an outsider got 400 "Rule name is required" and the route was scored as
      // defended. With a valid body the same caller would have got 201. A handler that happens to
      // fail is not a handler that refuses.
      if (outsider === 401 || outsider === 403) continue;
      if (outsider === -1) served.push(`${method} /api/${route} threw a non-Response instead of refusing`);
      else gatewayOnly.push(`${method} /api/${route} → ${outsider} (gateway requires ${approved[`${method} /api/${route}`]})`);
    }
  }

  assert.ok(exercised > 150, `expected to exercise the gated handlers, only reached ${exercised}`);
  assert.deepEqual(served, [], `a gated handler failed in a way that is not a refusal:\n  ${served.join("\n  ")}`);
  // Asserted, not reported. This was a printed backlog of 8 while a refusal meant "any non-2xx"; once
  // that was tightened to 401/403 the real number was 71, and once PATCH and DELETE entered the frozen
  // policy it was 75. All of them now hold their own line via refuseUnlessPermitted, so an empty list
  // is the enforceable state and a new unguarded handler fails here by name.
  assert.deepEqual(
    gatewayOnly, [],
    `these gated handlers rely on the worker gateway alone - called directly they do not refuse an identity holding nothing. Add refuseUnlessGatewayPermits(request) from lib/api-gateway as the first statement:\n  ${gatewayOnly.join("\n  ")}`,
  );
  console.log(`  ${exercised} gated handler+method pairs each refuse an outsider on their own.`);
});

test("the spelled-permission assertions never grow, and burn down deliberately", async () => {
  // 87 assertions still verify a permission control by matching source text. Converting them means
  // driving each route with an under-privileged actor, which needs that route's rows - real work per
  // route, not a sweep. Deleting them instead would make this file pass by removing coverage, which
  // is the opposite of the point, so they stay until they are replaced.
  //
  // What this does enforce is direction: the count may fall, never rise. A new spelled check fails
  // here, and every conversion lowers the number, so the burn-down is visible in the diff. Same
  // shape as the lint baseline this repo already holds at 23/81.
  const BASELINE = 87;

  const pure = /assert\.match\(\s*[A-Za-z_$][\w$]*\s*,\s*\/requirePermission\\\(actor,\\?"[a-z_.\\]+\\?"\\\)\/[a-z]*\s*(?:,\s*(?:"[^"]*"|'[^']*'|`[^`]*`))?\s*\)/g;
  const files = (await readdir("tests")).filter((f) => f.endsWith(".test.mjs"));
  let found = 0;
  const worst = [];
  for (const file of files) {
    const source = await readFile(`tests/${file}`, "utf8");
    const hits = source.match(pure) || [];
    found += hits.length;
    if (hits.length) worst.push(`${String(hits.length).padStart(3)}  ${file}`);
  }

  assert.ok(
    found <= BASELINE,
    `spelled-permission assertions rose from ${BASELINE} to ${found}. Drive the handler instead - see the two suites in this directory for the pattern.`,
  );
  if (found < BASELINE) {
    console.log(`  ${BASELINE - found} converted since the baseline was set; lower BASELINE to ${found} in this file.`);
  }
  console.log(`  ${found} remaining, heaviest first:\n${worst.sort((a, b) => b.trim().localeCompare(a.trim())).slice(0, 5).join("\n")}`);
});
