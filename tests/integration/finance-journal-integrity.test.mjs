import test from "node:test";
import assert from "node:assert/strict";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { installWorkersHooks } from "../helpers/module-hooks.mjs";
installWorkersHooks("__R04_NATIVE_DB__", "__R04_NATIVE_ENV__");
const accounts = await import("../../lib/finance-accounts.ts");

/** Native local D1 only: ephemeral storage, no credentials or remote bindings. */
async function fixture(t) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: "export default {fetch(){return new Response('isolated R04 test')}}",
    compatibilityDate: "2026-09-01", d1Databases: { DB: "r04-journal-integrity-test" },
    d1Persist: false, cf: false,
    outboundService: async () => { throw new Error("R04 forbids external requests"); },
  }));
  t.after(() => mf.dispose());
  const db = await mf.getD1Database("DB");
  await accounts.ensureFinanceJournalTable(db);
  const input = { groupKey: "R04-NATIVE", entryDate: "2026-09-29", periodCode: "2026-09",
    sourceType: "service_completion", sourceId: "R04-SYNTHETIC-BOOKING", narration: "Local D1 only",
    lines: [{ accountCode: accounts.ACCT.CUSTOMER_COLLECTIONS, debit: 100 },
      { accountCode: accounts.ACCT.REVENUE, credit: 100 }] };
  const rows = async () => (await db.prepare("SELECT * FROM finance_journal_entries ORDER BY id").all()).results;
  return { db, input, rows, post: () => accounts.postJournal(db, input) };
}

test("native D1: normal posting and identical replay preserve one balanced journal", { timeout: 60000 }, async t => {
  const w = await fixture(t);
  assert.equal((await w.post()).posted, true);
  const before = await w.rows(); assert.equal(before.length, 2);
  assert.equal((await w.post()).duplicatePrevented, true);
  assert.deepEqual(await w.rows(), before);
});

test("native D1: rounded stored lines must balance before a journal is posted", { timeout: 60000 }, async t => {
  const w = await fixture(t);
  w.input.lines = [...Array.from({ length: 4 }, () => ({ accountCode: accounts.ACCT.CASH, debit: 0.005 })),
    { accountCode: accounts.ACCT.REVENUE, credit: 0.02 }];
  await assert.rejects(w.post, /balanced|round|precision/i);
  assert.equal((await w.rows()).length, 0);
});

test("native D1: an ignored balancing line must roll back the complete journal", { timeout: 60000 }, async t => {
  const w = await fixture(t);
  await w.db.prepare("CREATE TRIGGER r04_ignore_credit BEFORE INSERT ON finance_journal_entries WHEN NEW.credit>0 BEGIN SELECT RAISE(IGNORE); END").run();
  await assert.rejects(w.post, /constraint|integrity|journal/i);
  assert.equal((await w.rows()).length, 0);
  await w.db.prepare("DROP TRIGGER r04_ignore_credit").run();
  assert.equal((await w.post()).posted, true);
  assert.equal((await w.rows()).length, 2);
});
