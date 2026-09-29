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

test("R04: first-row absence does not permit repairing another surviving row", async t => {
  const w = await world(t); await w.post();
  w.sqlite.prepare("DELETE FROM finance_journal_entries WHERE debit>0").run();
  const before = w.rows();
  await assert.rejects(w.post, /integrity|incomplete|mismatch/i);
  assert.deepEqual(w.rows(), before);
});

test("R04: different line counts and nested group keys remain distinct", async t => {
  const w = await world(t); await w.post();
  const parent = w.rows();
  await w.accounts.postJournal(w.db, { ...w.input, groupKey: `${w.input.groupKey}-1` });
  assert.equal(w.rows().length, 4);
  assert.equal((await w.post()).duplicatePrevented, true);
  w.input.lines.push({ accountCode: "1020-Payment Gateway Clearing", debit: 2, credit: 2 });
  await assert.rejects(w.post, /integrity|mismatch|conflict/i);
  assert.deepEqual(w.rows().filter(row => parent.some(original => original.id === row.id)), parent);
});

test("R04: Unicode and SQL wildcard characters in group keys remain literal", async t => {
  const w = await world(t); w.input.groupKey = "R04-₹-🐾-%_?'";
  assert.equal((await w.post()).posted, true);
  assert.equal((await w.post()).duplicatePrevented, true);
  assert.equal(w.rows().length, 2);
});

test("R04: exact replay survives month close, but changed financial identity does not", async t => {
  const w = await world(t); await w.post(); const before = w.rows();
  w.sqlite.exec("CREATE TABLE finance_close_periods (period_code TEXT PRIMARY KEY,status TEXT); INSERT INTO finance_close_periods VALUES ('2026-09','locked')");
  w.input.narration = "Replay description may differ";
  assert.equal((await w.post()).duplicatePrevented, true);
  w.input.sourceId = "DIFFERENT-BOOKING";
  await assert.rejects(w.post, /integrity|mismatch|conflict/i);
  assert.deepEqual(w.rows(), before);
});

test("R04: established one-cent tolerance and signed reversal lines are retained", async t => {
  const w = await world(t);
  w.input.lines = [{ accountCode: w.accounts.ACCT.CASH, debit: -1.01 },
    { accountCode: w.accounts.ACCT.REVENUE, credit: -1 }];
  assert.equal((await w.post()).posted, true);
  const rows = w.rows(); assert.equal(rows[0].debit, -1.01); assert.equal(rows[1].credit, -1);
  assert.equal((await w.post()).duplicatePrevented, true);
});

test("R04: high-precision amounts that round to zero cannot create an empty journal", async t => {
  const w = await world(t);
  w.input.lines = [{ accountCode: w.accounts.ACCT.CASH, debit: 0.001 },
    { accountCode: w.accounts.ACCT.REVENUE, credit: 0.001 }];
  await assert.rejects(w.post, /non-zero|round/i); assert.equal(w.rows().length, 0);
});
