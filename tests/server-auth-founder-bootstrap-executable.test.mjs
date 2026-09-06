import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__FOUNDER_AUTH_DB__", "__FOUNDER_AUTH_ENV__");

class Statement {
  constructor(sqlite, sql, args = []) { this.sqlite = sqlite; this.sql = sql; this.args = args; }
  bind(...args) { return new Statement(this.sqlite, this.sql, args); }
  async run() { const r = this.sqlite.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes || 0) } }; }
  async first() { return this.sqlite.prepare(this.sql).get(...this.args) ?? null; }
  async all() { return { success: true, results: this.sqlite.prepare(this.sql).all(...this.args) }; }
}

class Db {
  constructor() { this.sqlite = new DatabaseSync(":memory:"); this.sqlite.exec("PRAGMA foreign_keys = ON"); }
  prepare(sql) { return new Statement(this.sqlite, sql); }
  async batch(items) {
    this.sqlite.exec("BEGIN IMMEDIATE");
    try { const out = []; for (const item of items) out.push(await item.run()); this.sqlite.exec("COMMIT"); return out; }
    catch (error) { this.sqlite.exec("ROLLBACK"); throw error; }
  }
  async exec(sql) { this.sqlite.exec(sql); return { count: 0, duration: 0 }; }
  close() { this.sqlite.close(); }
}

test("matching FOUNDER_EMAIL header cannot create or authenticate an unprovisioned founder", async () => {
  const db = new Db();
  globalThis.__FOUNDER_AUTH_DB__ = db;
  globalThis.__FOUNDER_AUTH_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test", PAWSPACE_DEPLOYMENT_ENV: "staging" };
  try {
    const auth = await import("../lib/server-auth.ts");
    await auth.ensureSecurityTables(db);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM app_users").get().n, 0);

    const request = new Request("https://uat.pawspace.in/api/launch-readiness", {
      headers: {
        "oai-authenticated-user-email": "founder@pawspace.test",
        "oai-authenticated-user-full-name": "Founder",
      },
    });

    await assert.rejects(
      () => auth.resolveActor(request),
      (error) => error instanceof Response && error.status === 403,
      "a matching configured founder email is identity only, never authorization to self-provision",
    );
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM app_users").get().n, 0, "auth refusal must have no app_users side effect");
  } finally {
    db.close();
  }
});

test("a pre-provisioned founder still authenticates normally", async () => {
  const db = new Db();
  globalThis.__FOUNDER_AUTH_DB__ = db;
  globalThis.__FOUNDER_AUTH_ENV__ = { FOUNDER_EMAIL: "founder@pawspace.test", PAWSPACE_DEPLOYMENT_ENV: "staging" };
  try {
    const auth = await import("../lib/server-auth.ts");
    await auth.ensureSecurityTables(db);
    const now = Date.now();
    await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?)")
      .bind("USR-FOUNDER-1", "founder@pawspace.test", "Founder", "founder", "active", now, now).run();

    const actor = await auth.resolveActor(new Request("https://uat.pawspace.in/api/launch-readiness", {
      headers: { "oai-authenticated-user-email": "founder@pawspace.test" },
    }));
    assert.equal(actor.email, "founder@pawspace.test");
    assert.equal(actor.roleCode, "founder");
    assert.ok(actor.permissions.length > 0);
    assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM app_users").get().n, 1);
  } finally {
    db.close();
  }
});
