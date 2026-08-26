/**
 * WAVE 3C - a coverage gap the Wave 2 hunt recorded and did not probe. [PTJA-W3C]
 *
 * THE GAP, in the hunt's own words (ptja/PTJA-FINDINGS.json, domain 01-leadgen):
 *
 *   "lib/server-auth.ts isDevelopmentPreview() grants permissions ["*"] whenever
 *    process.env.NODE_ENV !== "production" and the request hostname is localhost/127.0.0.1/
 *    terminal.local. In Workers process.env.NODE_ENV is commonly undefined, so this is
 *    permissive-on-absence. It is out of my domain (identity/auth) and I did not probe the
 *    Host-header reachability; flagging it here for whoever owns 00-identity rather than filing it."
 *
 * Nobody owned it, so nobody probed it. This file does.
 *
 * WHAT THE PROBE FOUND. The repository has THREE preview branches keyed on the same three hostnames,
 * and they do NOT agree with each other:
 *
 *   lib/server-auth.ts:22        GUARDED by process.env.NODE_ENV !== "production".
 *   lib/api-gateway.ts:198       NO environment guard. Hostname alone -> superuser, permissions ["*"].
 *   app/api/launch-readiness     NO environment guard. Hostname alone -> roleCode "superuser", and its
 *                                POST does not call authorize() at all - only this local actor().
 *
 * The guarded one is the one that folds away in a production build; the two unguarded ones survive it.
 * That is the audit's own defect class - a control whose safety depends on something being SET, which
 * disappears when it is absent instead of failing closed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__W3C_DB__", "__W3C_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
    bind: (...bound) => statement(sql, bound),
    first: async () => sqlite.prepare(sql).get(...args) ?? null,
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes || 0) } }; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  let depth = 0;
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const outer = depth === 0;
      if (outer) sqlite.exec("BEGIN IMMEDIATE");
      depth += 1;
      try { const out = []; for (const item of items) out.push(await item.run()); if (outer) sqlite.exec("COMMIT"); return out; }
      catch (error) { if (outer) sqlite.exec("ROLLBACK"); throw error; }
      finally { depth -= 1; }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const PREVIEW_HOSTS = ["terminal.local", "localhost", "127.0.0.1"];
const REAL_HOST = "uat.pawspace.in";

let sqlite;
async function world() {
  sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3C_DB__ = db;
  globalThis.__W3C_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  return db;
}

// A production deployment. Every case below runs with this set, because that is the state that matters.
const withProductionEnv = async (fn) => {
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  try { return await fn(); } finally {
    if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
  }
};

test("W3C-01: server-auth's preview branch IS environment-guarded and refuses in production", async () => {
  // The one the hunt flagged. It behaves correctly - which is why the other two matter.
  const db = await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  await withProductionEnv(async () => {
    for (const host of PREVIEW_HOSTS) {
      const outcome = await resolveActor(new Request(`http://${host}/api/crm`))
        .then((actor) => ({ ok: true, actor }), (error) => ({ ok: false, error }));
      assert.equal(outcome.ok, false,
        `with NODE_ENV=production, ${host} must not resolve a preview superuser: ${JSON.stringify(outcome.actor ?? {})}`);
    }
  });
});

test("W3C-02: an ABSENT environment is treated as production, not as development", async () => {
  // This is the core of the finding. The old rule was `process.env.NODE_ENV !== "production"`, which
  // reads an UNSET value as "not production" - permissive on absence, the defect class this audit
  // hunts - and throws a ReferenceError outright where `process` does not exist, as in a Workers
  // isolate without nodejs_compat. Preview access is now granted only on an EXPLICIT declaration.
  const db = await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const before = process.env.NODE_ENV;
  delete process.env.NODE_ENV;
  try {
    for (const host of PREVIEW_HOSTS) {
      const outcome = await resolveActor(new Request(`http://${host}/api/crm`))
        .then((actor) => ({ ok: true, actor }), () => ({ ok: false }));
      assert.equal(outcome.ok, false,
        `an unset NODE_ENV must not admit a preview superuser at ${host}: ${JSON.stringify(outcome.actor ?? {})}`);

      const decision = await authorizeApiRequest(new Request(`http://${host}/api/crm`), { DB: db });
      const actor = decision instanceof Response ? null : decision.actor;
      assert.notEqual(actor?.roleCode, "superuser",
        `nor may the gateway, at ${host}: ${JSON.stringify(actor)}`);
    }
  } finally {
    if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
  }
});

test("W3C-02b (non-vacuity): an EXPLICIT development declaration still works", async () => {
  // Without this the fix would read as "preview access removed", which is not what was intended and
  // would break local development silently.
  await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  const before = process.env.NODE_ENV;
  process.env.NODE_ENV = "development";
  try {
    const actor = await resolveActor(new Request("http://localhost/api/crm"));
    assert.equal(actor.roleCode, "superuser", "an explicit development environment still previews");
    assert.equal(actor.developmentPreview, true, "and is marked as a preview actor");
  } finally {
    if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before;
  }
});

test("W3C-03: the API GATEWAY does not grant superuser on the hostname alone in production", async () => {
  // MEASURED BEFORE THE FIX: lib/api-gateway.ts:198 had no environment guard at all, so any request
  // whose Host was one of the three preview names received roleCode "superuser" and permissions ["*"]
  // from the OUTER authorization layer, in a production build.
  const db = await world();
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  await withProductionEnv(async () => {
    for (const host of PREVIEW_HOSTS) {
      const decision = await authorizeApiRequest(new Request(`http://${host}/api/crm`), { DB: db });
      const actor = decision instanceof Response ? null : decision.actor;
      assert.notEqual(actor?.roleCode, "superuser",
        `${host} must not receive a preview superuser in production: ${JSON.stringify(actor)}`);
      assert.notDeepEqual(actor?.permissions, ["*"],
        `nor every permission: ${JSON.stringify(actor)}`);
    }
  });
});

test("W3C-04: launch-readiness POST refuses an unauthenticated write on the hostname alone", async () => {
  // The sharpest of the three. GET calls authorize(request,"launch.view") first - correct, and closed
  // by W2-B2-R06. POST does NOT: it calls only the route's own actor(), which sets
  // email="preview@pawspace.test" on hostname and then hard-codes roleCode "superuser" for that email.
  // canWrite() admits superuser. No credential of any kind is presented here.
  const db = await world();
  const route = await import("../app/api/launch-readiness/route.ts");
  await withProductionEnv(async () => {
    const response = await route.POST(new Request("http://localhost/api/launch-readiness", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record_signoff", gateCode: "REL-01", note: "w3c probe" }),
    }));
    assert.ok(response.status === 401 || response.status === 403,
      `an unauthenticated POST on a preview hostname must be refused in production, got ${response.status} ${(await response.clone().text()).slice(0, 250)}`);
  });
});

test("W3C-05 (non-vacuity): the same unauthenticated POST from a REAL host is refused 401", async () => {
  // Without this, W3C-04 would prove nothing about the hostname - the route might simply accept
  // anything from anyone.
  await world();
  const route = await import("../app/api/launch-readiness/route.ts");
  await withProductionEnv(async () => {
    const response = await route.POST(new Request(`https://${REAL_HOST}/api/launch-readiness`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record_signoff", gateCode: "REL-01", note: "w3c probe" }),
    }));
    assert.equal(response.status, 401,
      `a real host with no credential must be refused: ${response.status} ${(await response.clone().text()).slice(0, 200)}`);
  });
});

test("W3C-06: the preview-host rule has exactly ONE definition", async () => {
  // A guard against the inventory drifting: if a fourth appears, or one of these is fixed, this fails
  // and the ledger has to be updated deliberately.
  // After the fix there is ONE definition. Any file that names a preview hostname other than that
  // definition is a fourth copy of an authorization rule, which is how two of the three came to be
  // wrong in the first place.
  const offenders = [];
  const walk = async (dir) => {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      if (path === "lib/development-preview.ts") continue;
      const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      for (const line of source.split("\n")) {
        if (line.includes("terminal.local") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) {
          offenders.push(`${path}: ${line.trim().slice(0, 90)}`);
        }
      }
    }
  };
  for (const root of ["lib", "app"]) await walk(root);
  assert.deepEqual(offenders, [],
    "the preview-host rule has exactly one definition, lib/development-preview.ts - a second copy is how two of the original three lost their environment guard");

  // Non-vacuity: the one definition really does name those hosts.
  const canonical = await readFile(new URL("../lib/development-preview.ts", import.meta.url), "utf8");
  assert.match(canonical, /terminal\.local/, "the single definition still names the preview hosts");
});
