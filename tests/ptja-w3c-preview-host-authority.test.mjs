/**
 * WAVE 3C - development-preview authority proof. [PTJA-W3C]
 *
 * Preview authority must never be derivable from request host alone. The canonical helper requires
 * explicit development/test runtime state plus PAWSPACE_LOCAL_PREVIEW=on and one local hostname.
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

async function world() {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__W3C_DB__ = db;
  globalThis.__W3C_ENV__ = {};
  const { ensureSecurityTables } = await import("../lib/server-auth.ts");
  await ensureSecurityTables(db);
  return db;
}

async function withEnv(values, fn) {
  const prior = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value;
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(prior)) value === undefined ? delete process.env[key] : process.env[key] = value;
  }
}

const withProductionEnv = (fn) => withEnv({ NODE_ENV: "production", PAWSPACE_LOCAL_PREVIEW: undefined }, fn);

test("W3C-01: production refuses every local preview hostname", async () => {
  await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  await withProductionEnv(async () => {
    for (const host of PREVIEW_HOSTS) {
      const outcome = await resolveActor(new Request(`http://${host}/api/crm`)).then((actor) => ({ ok: true, actor }), () => ({ ok: false }));
      assert.equal(outcome.ok, false, `${host} must not resolve a preview superuser in production`);
    }
  });
});

test("W3C-02: absent runtime declarations fail closed", async () => {
  const db = await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  await withEnv({ NODE_ENV: undefined, PAWSPACE_LOCAL_PREVIEW: undefined }, async () => {
    for (const host of PREVIEW_HOSTS) {
      const outcome = await resolveActor(new Request(`http://${host}/api/crm`)).then((actor) => ({ ok: true, actor }), () => ({ ok: false }));
      assert.equal(outcome.ok, false, `unset runtime must not admit ${host}`);
      const decision = await authorizeApiRequest(new Request(`http://${host}/api/crm`), { DB: db });
      assert.notEqual(decision instanceof Response ? null : decision.actor?.roleCode, "superuser");
    }
  });
});

test("W3C-02a sabotage: forged local Host is insufficient even in development without runtime opt-in", async () => {
  await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  await withEnv({ NODE_ENV: "development", PAWSPACE_LOCAL_PREVIEW: undefined }, async () => {
    for (const host of PREVIEW_HOSTS) {
      await assert.rejects(() => resolveActor(new Request(`http://${host}/api/crm`)), `${host} must not create authority without PAWSPACE_LOCAL_PREVIEW=on`);
    }
  });
});

test("W3C-02b non-vacuity: explicit local preview runtime still works", async () => {
  await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  await withEnv({ NODE_ENV: "development", PAWSPACE_LOCAL_PREVIEW: "on" }, async () => {
    const actor = await resolveActor(new Request("http://localhost/api/crm"));
    assert.equal(actor.roleCode, "superuser");
    assert.equal(actor.developmentPreview, true);
  });
});

test("W3C-02d: a DEPLOYED environment refuses preview even with every other gate satisfied", async () => {
  // Models the real staging deployment, not a hypothetical. scripts/stage-config.mjs spreads the
  // built worker's vars into the staging config, and vite.config.ts puts PAWSPACE_LOCAL_PREVIEW:"on"
  // among them - so a deployed staging Worker genuinely ships with that gate already satisfied, and a
  // forged `Host: localhost` satisfies the hostname gate. Before PAWSPACE_DEPLOYMENT_ENV was consulted,
  // the ONLY thing refusing an authentication-free actor there was NODE_ENV happening to be unset.
  await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  await withEnv({ PAWSPACE_DEPLOYMENT_ENV: "staging", NODE_ENV: "development", PAWSPACE_LOCAL_PREVIEW: "on" }, async () => {
    for (const host of ["localhost", "127.0.0.1", "terminal.local"]) {
      await assert.rejects(() => resolveActor(new Request(`http://${host}/api/crm`)),
        `a forged ${host} Host must not grant preview authority in a declared deployment`);
    }
  });
});

test("W3C-02e non-vacuity: the deployment guard is what refuses, not a broken world", async () => {
  // Same three hosts, same NODE_ENV and PAWSPACE_LOCAL_PREVIEW - only the deployment declaration is
  // removed. If these did not succeed, W3C-02d would be passing for the wrong reason.
  await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  await withEnv({ PAWSPACE_DEPLOYMENT_ENV: undefined, NODE_ENV: "development", PAWSPACE_LOCAL_PREVIEW: "on" }, async () => {
    for (const host of ["localhost", "127.0.0.1", "terminal.local"]) {
      const actor = await resolveActor(new Request(`http://${host}/api/crm`));
      assert.equal(actor.developmentPreview, true, `${host} is still a working local preview`);
    }
  });
});

test("W3C-02c: runtime opt-in cannot turn a real remote host into preview authority", async () => {
  await world();
  const { resolveActor } = await import("../lib/server-auth.ts");
  await withEnv({ NODE_ENV: "development", PAWSPACE_LOCAL_PREVIEW: "on" }, async () => {
    await assert.rejects(() => resolveActor(new Request(`https://${REAL_HOST}/api/crm`)));
  });
});

test("W3C-03: API gateway does not grant superuser on hostname alone in production", async () => {
  const db = await world();
  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  await withProductionEnv(async () => {
    for (const host of PREVIEW_HOSTS) {
      const decision = await authorizeApiRequest(new Request(`http://${host}/api/crm`), { DB: db });
      const actor = decision instanceof Response ? null : decision.actor;
      assert.notEqual(actor?.roleCode, "superuser");
      assert.notDeepEqual(actor?.permissions, ["*"]);
    }
  });
});

test("W3C-04: launch-readiness POST refuses unauthenticated local-host write in production", async () => {
  await world();
  const route = await import("../app/api/launch-readiness/route.ts");
  await withProductionEnv(async () => {
    const response = await route.POST(new Request("http://localhost/api/launch-readiness", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record_signoff", gateCode: "REL-01", note: "w3c probe" }),
    }));
    assert.ok(response.status === 401 || response.status === 403, `expected refusal, got ${response.status}`);
  });
});

test("W3C-05: same unauthenticated POST from real host is refused", async () => {
  await world();
  const route = await import("../app/api/launch-readiness/route.ts");
  await withProductionEnv(async () => {
    const response = await route.POST(new Request(`https://${REAL_HOST}/api/launch-readiness`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "record_signoff", gateCode: "REL-01", note: "w3c probe" }),
    }));
    assert.equal(response.status, 401);
  });
});

test("W3C-06: preview-host rule has exactly one definition", async () => {
  const offenders = [];
  const walk = async (dir) => {
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(new URL(`../${dir}`, import.meta.url), { withFileTypes: true })) {
      if (entry.isDirectory()) { await walk(`${dir}/${entry.name}`); continue; }
      if (!/\.tsx?$/.test(entry.name)) continue;
      const path = `${dir}/${entry.name}`;
      if (path === "lib/development-preview.ts") continue;
      const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
      for (const line of source.split("\n")) if (line.includes("terminal.local") && !line.trimStart().startsWith("*") && !line.trimStart().startsWith("//")) offenders.push(`${path}: ${line.trim().slice(0, 90)}`);
    }
  };
  for (const root of ["lib", "app"]) await walk(root);
  assert.deepEqual(offenders, [
    'lib/otp-sandbox-runtime.ts: const LOCAL_OTP_HOSTS=new Set(["terminal.local","localhost","127.0.0.1"]);',
  ]);
  const canonical = await readFile(new URL("../lib/development-preview.ts", import.meta.url), "utf8");
  assert.match(canonical, /terminal\.local/);
  assert.match(canonical, /PAWSPACE_LOCAL_PREVIEW/);
});
