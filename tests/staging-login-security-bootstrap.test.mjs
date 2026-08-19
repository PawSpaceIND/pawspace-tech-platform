import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__UAT_BOOTSTRAP_DB__", "__UAT_BOOTSTRAP_ENV__");

function makeD1(sqlite) {
  const statement = (sql, args = []) => ({
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
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => {
      const out = [];
      for (const item of list) out.push(await item.run());
      return out;
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

test("UAT sign-in bootstraps the audit table before a permission denial", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  const env = {
    PAWSPACE_UAT_LOGIN: "on",
    PAWSPACE_UAT_ACCESS_CODE: "x".repeat(32),
    PAWSPACE_UAT_SIGNING_KEY: "s".repeat(32),
  };
  globalThis.__UAT_BOOTSTRAP_DB__ = db;
  globalThis.__UAT_BOOTSTRAP_ENV__ = env;

  // This is the release-preview starting condition: staff identity + role exist, but no prior gated
  // request has created security_audit_events yet. The first denied request must still be a clean 403.
  sqlite.exec("CREATE TABLE app_users (id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role_code TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  sqlite.exec("CREATE TABLE role_definitions (code TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL, permissions_json TEXT NOT NULL, system_role INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)");
  sqlite.prepare("INSERT INTO role_definitions (code,name,description,permissions_json,system_role,updated_at) VALUES (?,?,?,?,?,?)")
    .run("preview_marketing", "preview_marketing", "preview gate", JSON.stringify(["marketing.view"]), 0, 1);
  sqlite.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
    .run("U-preview-marketing", "preview-marketing@pawspace.test", "preview_marketing", "preview_marketing", "active", 1, 1);

  assert.throws(() => sqlite.prepare("SELECT COUNT(*) FROM security_audit_events").get(), /no such table/);

  const { POST } = await import("../app/api/staging-login/route.ts");
  const login = await POST(new Request("https://preview.pawspace.test/api/staging-login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "login", code: env.PAWSPACE_UAT_ACCESS_CODE, email: "preview-marketing@pawspace.test" }),
  }));
  assert.equal(login.status, 200);

  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(cookie, "a real UAT session cookie must be issued");
  assert.equal(sqlite.prepare("SELECT COUNT(*) n FROM security_audit_events").get().n, 0,
    "sign-in creates the audit schema but does not invent an audit event");

  const { authorizeApiRequest } = await import("../lib/api-gateway.ts");
  const refusal = await authorizeApiRequest(
    new Request("https://preview.pawspace.test/api/canonical-bookings", { headers: { cookie } }),
    { DB: db, ...env },
  );

  assert.ok(refusal instanceof Response, "the permission denial must return a response instead of throwing");
  assert.equal(refusal.status, 403, "a known UAT identity without bookings.view is forbidden, not a 500");
  assert.equal((await refusal.clone().json()).error, "Permission denied");

  const audit = sqlite.prepare("SELECT outcome,detail_json FROM security_audit_events").get();
  assert.equal(audit.outcome, "denied");
  assert.match(String(audit.detail_json), /bookings\.view/);
});
