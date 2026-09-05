import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";

installWorkersHooks("__SECURITY_AUDIT_DB__", "__SECURITY_AUDIT_ENV__");

function makeD1(sqlite) {
  function statement(sql, args = []) {
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    };
  }
  return {
    prepare: (sql) => statement(sql),
    batch: async (items) => {
      const out = [];
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        for (const item of items) out.push(await item.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
}

const auth = await import("../lib/server-auth.ts");

function freshDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const db = makeD1(sqlite);
  globalThis.__SECURITY_AUDIT_DB__ = db;
  globalThis.__SECURITY_AUDIT_ENV__ = {};
  return { sqlite, db };
}

const actor = {
  email: "founder.audit@pawspace.test",
  name: "Founder Audit",
  roleCode: "founder",
  permissions: ["*"],
  developmentPreview: false,
  identitySource: "workspace",
  principalType: "email",
  principalKey: "founder.audit@pawspace.test",
};

test("privileged audit reservation is durable before completion and closes with a central audit event", async () => {
  const { sqlite, db } = freshDb();
  try {
    await auth.ensureSecurityTables(db);
    const operationId = await auth.reserveSecurityAudit(
      db,
      actor,
      "provider.approve",
      "provider",
      "PRV-AUDIT-1",
      { reason: "runtime audit boundary" },
    );

    const reserved = sqlite.prepare("SELECT * FROM security_audit_outbox WHERE id=?").get(operationId);
    assert.ok(reserved, "reservation must exist before the privileged operation is completed");
    assert.equal(reserved.status, "reserved");
    assert.equal(reserved.actor_email, actor.email);
    assert.equal(reserved.action, "provider.approve");
    assert.equal(reserved.completed_at, null);

    const reservationEvents = sqlite.prepare("SELECT * FROM security_audit_events WHERE action='provider.approve.reserved'").all();
    assert.equal(reservationEvents.length, 1, "reservation must create exactly one central audit event");
    assert.equal(reservationEvents[0].outcome, "allowed");
    assert.match(String(reservationEvents[0].detail_json), new RegExp(operationId));

    await auth.completeReservedSecurityAudit(
      db,
      actor,
      operationId,
      "provider.approve",
      "provider",
      "PRV-AUDIT-1",
      "completed",
      { decision: "approved" },
    );

    const completed = sqlite.prepare("SELECT * FROM security_audit_outbox WHERE id=?").get(operationId);
    assert.equal(completed.status, "completed");
    assert.ok(Number(completed.completed_at) > 0);
    assert.match(String(completed.detail_json), /approved/);

    const finalEvents = sqlite.prepare("SELECT * FROM security_audit_events WHERE action='provider.approve'").all();
    assert.equal(finalEvents.length, 1, "completion must create exactly one final central audit event");
    assert.equal(finalEvents[0].outcome, "completed");
    assert.match(String(finalEvents[0].detail_json), new RegExp(operationId));
  } finally {
    sqlite.close();
    delete globalThis.__SECURITY_AUDIT_DB__;
    delete globalThis.__SECURITY_AUDIT_ENV__;
  }
});
