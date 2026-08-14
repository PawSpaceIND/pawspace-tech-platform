/**
 * Regenerate tests/fixtures/route-permissions.json from the live gateway.
 *
 * The fixture is the approved answer to "what does each route and method demand?", and
 * tests/gateway-authorization-matrix.test.mjs fails when the code disagrees with it. That guard only
 * means something if the fixture is changed deliberately, so regeneration lives here rather than
 * behind a flag inside the test - a test that can rewrite its own expectation proves nothing.
 *
 * Run it when a permission change is intended, then read the diff before committing: every line that
 * moves is a route whose access just changed, and the commit message should say why.
 *
 *   node scripts/freeze-route-policy.mjs
 */
import { DatabaseSync } from "node:sqlite";
import { writeFile } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { installWorkersHooks } from "../tests/helpers/module-hooks.mjs";
import { enumerateProbes, probeKey, probeRequest } from "../tests/helpers/gateway-policy-probe.mjs";
import { createD1 } from "../tests/helpers/d1.mjs";

installWorkersHooks("__FREEZE_DB__", "__FREEZE_ENV__");

const HOST = "https://pawspace-staging.example.dev";

const { defaultRoles } = await import("../lib/platform-security.ts");
const sqlite = new DatabaseSync(":memory:");
sqlite.exec(`CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, role_code TEXT, status TEXT, created_at INTEGER, updated_at INTEGER);
  CREATE TABLE role_definitions (code TEXT PRIMARY KEY, name TEXT, description TEXT, permissions_json TEXT, system_role INTEGER, updated_at INTEGER);
  CREATE TABLE security_audit_events (id TEXT PRIMARY KEY, actor_email TEXT, actor_role TEXT, action TEXT, resource_type TEXT, resource_id TEXT, outcome TEXT, detail_json TEXT, created_at INTEGER);
  CREATE TABLE api_audit_events (id TEXT PRIMARY KEY, actor_email TEXT, actor_role TEXT, method TEXT, path TEXT, outcome TEXT, detail_json TEXT, created_at INTEGER);`);
for (const role of defaultRoles) {
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,1,0)")
    .run(role.code, role.name, role.description, JSON.stringify(role.permissions));
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,'active',0,0)")
    .run(`u-${role.code}`, `${role.code}@pawspace.test`, role.code, role.code);
}
const env = { DB: createD1(sqlite), FOUNDER_EMAIL: "founder@pawspace.test" };
globalThis.__FREEZE_DB__ = env.DB;
globalThis.__FREEZE_ENV__ = env;

const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
const source = await readFile(new URL("../lib/api-gateway.ts", import.meta.url), "utf8");

const probes = enumerateProbes(source);
const live = {};
for (const probe of probes) {
  const result = await authorizeApiRequest(probeRequest(HOST, probe, "founder@pawspace.test"), env);
  if (!(result instanceof Response) && result.permission) live[probeKey(probe)] = result.permission;
}

const out = new URL("../tests/fixtures/route-permissions.json", import.meta.url);
await writeFile(out, `${JSON.stringify(Object.fromEntries(Object.entries(live).sort()), null, 2)}\n`);
console.log(`${Object.keys(live).length} gated route+method pairs written to tests/fixtures/route-permissions.json`);
console.log("Read the diff before committing: each moved line is a change in who can reach that route.");
