/** Staging D1 timing: calls inside a timed request are recorded and reported; others pass straight through. */
import test from "node:test";
import assert from "node:assert/strict";
const timing = await import("../lib/d1-request-timing.ts");

class Statement {
  constructor(sql) { this.statement = sql; }
  bind() { return this; }
  async first() { await new Promise((resolve) => setTimeout(resolve, 15)); return { ok: 1 }; }
  async run() { return { success: true }; }
  async all() { return { results: [] }; }
  async raw() { return []; }
}
class Database {
  prepare(sql) { return new Statement(sql); }
  async batch(statements) { return statements.map(() => ({ success: true })); }
}

test("D1 calls in a timed request are recorded, and the slowest lead the Server-Timing header", async () => {
  const db = new Database();
  timing.installD1RequestTiming(db);
  timing.installD1RequestTiming(db);
  assert.deepEqual(await db.prepare("SELECT outside").first(), { ok: 1 }, "an untimed call still works");
  const { result, timings } = await timing.withD1RequestTiming(async () => {
    await db.prepare("SELECT \"slow\", one FROM t WHERE a=?").bind(1).first();
    await db.prepare("UPDATE t SET a=1").run();
    await db.batch([db.prepare("INSERT INTO t VALUES (1)"), db.prepare("INSERT INTO t VALUES (2)")]);
    return "done";
  });
  assert.equal(result, "done");
  assert.deepEqual(timings.map((entry) => entry.sql), ["SELECT \"slow\", one FROM t WHERE a=?", "UPDATE t SET a=1", "BATCH(2) INSERT INTO t VALUES (1)"]);
  const header = timing.d1ServerTiming(timings, 40);
  assert.match(header, /^app;dur=40, d1;dur=\d+;desc="3 calls", q1;dur=\d+;desc="SELECT slow one FROM t WHERE a=\?"/);
  assert.ok(!/[^\x20-\x7e]/.test(header));
});
