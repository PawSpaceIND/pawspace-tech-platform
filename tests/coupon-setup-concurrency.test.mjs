import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { freshCountingD1 } from "./helpers/d1-harness.mjs";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
installWorkersHooks("__COUPON_SETUP_DB__");
const { ensureCouponTables, customerFacts } = await import("../lib/coupon-governance.ts");

test("concurrent first coupon requests share one initialization including column migrations", async t => {
  const { db, sqlite } = freshCountingD1(); t.after(() => sqlite.close());
  let release, entered; const gate = new Promise(r => { release = r; });
  const started = new Promise(r => { entered = r; });
  let batches = 0, authorityBatches = 0;
  const wrapper = { ...db, batch: async statements => {
    batches++; if (statements.some(s => s.sql.includes("CREATE TABLE IF NOT EXISTS canonical_bookings"))) authorityBatches++;
    entered(); await gate; return db.batch(statements);
  }};
  const first = ensureCouponTables(wrapper); await started;
  const others = Array.from({ length: 9 }, () => ensureCouponTables(wrapper));
  try { await tick(); assert.equal(batches, 1); assert.equal(authorityBatches, 1); }
  finally { release(); await Promise.allSettled([first, ...others]); }
  await Promise.all([first, ...others]);
  assert.equal((await customerFacts(wrapper, "C1")).orderCount, 0);
  assert.ok(sqlite.prepare("PRAGMA table_info(coupon_campaigns)").all().some(r => r.name === "customer_ids_json"));
});

test("failed shared initialization rejects every waiter and permits a clean retry", async t => {
  const { db, sqlite } = freshCountingD1(); t.after(() => sqlite.close());
  let fail = true, attempts = 0;
  const wrapper = { ...db, batch: async statements => { attempts++; await tick(); if(fail)throw new Error("fixture cold database failure"); return db.batch(statements); }};
  const refused = await Promise.allSettled(Array.from({length:5}, () => ensureCouponTables(wrapper)));
  assert.equal(attempts, 1); assert.ok(refused.every(r => r.status === "rejected"));
  fail = false;
  await Promise.all(Array.from({length:5}, () => ensureCouponTables(wrapper)));
  assert.equal(attempts, 2); assert.equal((await customerFacts(wrapper, "C1")).orderCount, 0);
});
