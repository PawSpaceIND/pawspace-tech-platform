import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { installWorkersHooks } from "./helpers/module-hooks.mjs";
import { makePlatformScaleD1 } from "./helpers/platform-scale-d1.mjs";
installWorkersHooks("__R04_JOURNAL_DB__", "__R04_JOURNAL_ENV__");

/** Isolated journal fixtures. No bank, gateway, customer or hosted database is accessed. */
async function world(t) {
  const sqlite = new DatabaseSync(":memory:"); t.after(() => sqlite.close());
  const db = makePlatformScaleD1(sqlite);
  const accounts = await import("../lib/finance-accounts.ts");
  await accounts.ensureFinanceJournalTable(db);
  const input = { groupKey: "R04-COMPLETE", entryDate: "2026-09-29", periodCode: "2026-09",
    sourceType: "service_completion", sourceId: "R04-BOOKING", narration: "Synthetic R04 journal",
    lines: [{ accountCode: accounts.ACCT.CUSTOMER_COLLECTIONS, debit: 100 },
      { accountCode: accounts.ACCT.REVENUE, credit: 100 }] };
  const rows = () => sqlite.prepare("SELECT * FROM finance_journal_entries ORDER BY id").all();
  return { sqlite, db, accounts, input, rows, post: () => accounts.postJournal(db, input) };
}

test("R04: a normal journal posts once and its exact replay is read-only", async t => {
  const w = await world(t);
  assert.equal((await w.post()).posted, true);
  const before = w.rows(); assert.equal(before.length, 2);
  assert.equal((await w.post()).duplicatePrevented, true);
  assert.deepEqual(w.rows(), before);
});

test("R04: balance validation uses the actual rounded lines that would be persisted", async t => {
  const w = await world(t);
  w.input.lines = [...Array.from({ length: 4 }, () => ({ accountCode: "1000-Cash in Hand", debit: 0.005 })),
    { accountCode: "4000-Service Revenue", credit: 0.02 }];
  await assert.rejects(w.post, /balanced|round|precision/i);
  assert.equal(w.rows().length, 0, "an unbalanced rounded journal must never be written");
});

test("R04: an ignored journal line aborts the whole posting and retry remains safe", async t => {
  const w = await world(t);
  w.sqlite.exec("CREATE TEMP TRIGGER r04_ignore_credit BEFORE INSERT ON finance_journal_entries WHEN NEW.credit>0 BEGIN SELECT RAISE(IGNORE); END");
  await assert.rejects(w.post, /constraint|integrity|journal/i);
  assert.equal(w.rows().length, 0, "no debit may survive a suppressed balancing credit");
  w.sqlite.exec("DROP TRIGGER r04_ignore_credit");
  assert.equal((await w.post()).posted, true);
  assert.equal(w.rows().length, 2);
});

test("R04: a historical partial group is not reported as a successful duplicate", async t => {
  const w = await world(t); await w.post();
  w.sqlite.prepare("DELETE FROM finance_journal_entries WHERE credit>0").run();
  const before = w.rows(); assert.equal(before.length, 1);
  await assert.rejects(w.post, /integrity|incomplete|mismatch/i);
  assert.deepEqual(w.rows(), before, "historical ledger repair needs a separate approved reconciliation");
});

test("R04: the same idempotency key cannot acknowledge different financial lines", async t => {
  const w = await world(t); await w.post(); const before = w.rows();
  w.input.lines = [{ accountCode: "1000-Cash in Hand", debit: 500 }, { accountCode: "4000-Service Revenue", credit: 500 }];
  await assert.rejects(w.post, /integrity|mismatch|conflict/i);
  assert.deepEqual(w.rows(), before);
});

for (const amount of [NaN, Infinity, -Infinity]) {
  test(`R04: non-finite money ${String(amount)} is refused`, async t => {
    const w = await world(t);
    w.input.lines.push({ accountCode: "1000-Cash in Hand", debit: amount });
    await assert.rejects(w.post, /finite|amount|money|number/i);
    assert.equal(w.rows().length, 0);
  });
}
