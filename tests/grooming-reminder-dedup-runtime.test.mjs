import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import * as nodeModule from "node:module";

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
  const hook = `const workersUrl=${JSON.stringify(workersUrl)}; export async function resolve(specifier, context, nextResolve) { if (specifier === "cloudflare:workers") return { url: workersUrl, shortCircuit: true }; try { return await nextResolve(specifier, context); } catch (error) { if (specifier.startsWith(".") && !specifier.endsWith(".ts")) return nextResolve(specifier + ".ts", context); throw error; } }`;
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
    exec: async (sql) => sqlite.exec(sql),
  };
}

test("grooming 15-day reminder: two scheduler runs create one notification and one history row", async () => {
  const sqlite = new DatabaseSync(":memory:");
  const db = makeD1(sqlite);
  globalThis.__PAWSPACE_TEST_ENV = { DB: db };
  sqlite.exec("CREATE TABLE canonical_customers (id TEXT PRIMARY KEY,consent_json TEXT); CREATE TABLE canonical_bookings (id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,status TEXT NOT NULL,scheduled_start TEXT,scheduled_end TEXT);");

  const asOf = Date.now();
  const completedAt = new Date(asOf - 16 * 86_400_000).toISOString();
  sqlite.prepare("INSERT INTO canonical_customers (id,consent_json) VALUES (?,?)").run("CUS-REMINDER-1", JSON.stringify({ serviceUpdates: true }));
  sqlite.prepare("INSERT INTO canonical_bookings (id,customer_id,service_code,status,scheduled_start,scheduled_end) VALUES (?,?,?,?,?,?)")
    .run("BK-REMINDER-1", "CUS-REMINDER-1", "grooming", "completed", completedAt, completedAt);

  const reminders = await import("../lib/customer-reminder-governance.ts");
  const first = await reminders.runCustomerReminderSweep(db, { actorId: "system:test", asOf });
  const second = await reminders.runCustomerReminderSweep(db, { actorId: "system:test", asOf });

  assert.equal(first.grooming.queued, 1, "first due run queues the reminder");
  assert.equal(second.grooming.queued, 0, "second run does not queue another reminder");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_messages WHERE idempotency_key LIKE 'grooming_rebooking:%'").get().c, 1, "one customer notification message");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM communication_outbox").get().c, 1, "one communications outbox record");
  assert.equal(sqlite.prepare("SELECT COUNT(*) c FROM reminder_governance_events WHERE customer_id='CUS-REMINDER-1' AND reminder_type='grooming_rebooking'").get().c, 1, "CRM/reminder history is updated once");
});
