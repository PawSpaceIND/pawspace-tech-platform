import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createD1 } from "./helpers/d1.mjs";

// ---------------------------------------------------------------------------
// The shim has to behave like D1, or every atomicity test in this directory is asserting the wrong
// machine. D1's batch() is one transaction; the loop shim used by 73 of the 78 test files commits
// each statement as it goes, so a batch that fails half way leaves half its work behind while
// production would have rolled all of it back.
//
// Each test below pairs the new shim against that loop, so the difference is demonstrated rather
// than described. If createD1 ever regresses to loop behaviour, the paired assertion fails.
// ---------------------------------------------------------------------------

const DDL = `CREATE TABLE claims (id TEXT PRIMARY KEY, holder TEXT NOT NULL);
  CREATE TABLE ledger (id TEXT PRIMARY KEY, amount REAL NOT NULL);`;

function fresh() {
  const sqlite = new DatabaseSync(DDL ? ":memory:" : ":memory:");
  sqlite.exec(DDL);
  return sqlite;
}

/** The shim this repo uses almost everywhere, reproduced so the contrast is executable. */
function loopShim(sqlite) {
  const statement = (sql, args) => ({
    bind: (...bound) => statement(sql, bound),
    run: async () => { const info = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(info.changes) } }; },
    first: async () => { const row = sqlite.prepare(sql).get(...args); return row === undefined ? null : row; },
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
  });
  return {
    prepare: (sql) => statement(sql, []),
    batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; },
  };
}

const count = (sqlite, table) => Number(sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n);

test("a batch that fails part way applies none of it", async () => {
  const sqlite = fresh();
  const db = createD1(sqlite);

  await assert.rejects(() => db.batch([
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('L1',100)"),
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('L2',200)"),
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('L1',300)"), // duplicate primary key
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('L3',400)"),
  ]), "a failing batch must reject");

  assert.equal(count(sqlite, "ledger"), 0, "a rolled-back batch must leave nothing behind");
});

test("the loop shim used elsewhere keeps the partial writes, which is why this matters", async () => {
  const sqlite = fresh();
  const db = loopShim(sqlite);

  await assert.rejects(() => db.batch([
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('L1',100)"),
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('L2',200)"),
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('L1',300)"),
  ]));

  // Two rows survived a failed transaction. In production there would be none. A test built on this
  // shim can assert "no half-written booking" and pass while the code leaves one.
  assert.equal(count(sqlite, "ledger"), 2, "documents the defect this helper exists to remove");
});

test("a batch that succeeds applies all of it, and reports each statement", async () => {
  const sqlite = fresh();
  const db = createD1(sqlite);

  const results = await db.batch([
    db.prepare("INSERT INTO ledger (id,amount) VALUES (?,?)").bind("L1", 100),
    db.prepare("INSERT INTO ledger (id,amount) VALUES (?,?)").bind("L2", 250),
  ]);

  assert.equal(results.length, 2);
  assert.equal(results[0].success, true);
  assert.equal(results[0].meta.changes, 1);
  assert.equal(count(sqlite, "ledger"), 2);
  assert.equal(Number(sqlite.prepare("SELECT amount FROM ledger WHERE id='L2'").get().amount), 250);
});

test("a statement outside a batch commits on its own, as D1 does", async () => {
  const sqlite = fresh();
  const db = createD1(sqlite);
  await db.prepare("INSERT INTO ledger (id,amount) VALUES ('solo',5)").run();
  assert.equal(count(sqlite, "ledger"), 1);
});

test("a failed batch does not wedge the batches after it", async () => {
  const sqlite = fresh();
  const db = createD1(sqlite);

  await assert.rejects(() => db.batch([
    db.prepare("INSERT INTO ledger (id,amount) VALUES ('X',1)"),
    db.prepare("INSERT INTO nope (id) VALUES ('boom')"),
  ]));
  // The lock chain has to survive a rejection, or one bad batch silently hangs the rest of the test.
  await db.batch([db.prepare("INSERT INTO ledger (id,amount) VALUES ('Y',2)")]);
  assert.equal(count(sqlite, "ledger"), 1);
  assert.ok(sqlite.prepare("SELECT id FROM ledger WHERE id='Y'").get(), "the later batch must apply");
});

test("two callers racing for one claim: exactly one wins, and the loser leaves nothing", async () => {
  const sqlite = fresh();

  // Hold the first writer at the door until the second has been prepared, so both genuinely believe
  // the claim is free - the shape of a real double-booking, which no loop-shim test can reproduce.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let parked = false;
  const db = createD1(sqlite, {
    park: (sql) => {
      if (!parked && sql.includes("INSERT INTO claims")) { parked = true; return gate; }
      return null;
    },
  });

  const claim = (holder) => db.batch([
    db.prepare("INSERT INTO claims (id,holder) VALUES ('slot-1',?)").bind(holder),
    db.prepare("INSERT INTO ledger (id,amount) VALUES (?,1)").bind(`fee-${holder}`),
  ]);

  const first = claim("alice");
  const second = claim("bob");
  release();

  const outcomes = await Promise.allSettled([first, second]);
  const won = outcomes.filter((o) => o.status === "fulfilled").length;

  assert.equal(won, 1, "exactly one caller may take the slot");
  assert.equal(count(sqlite, "claims"), 1, "the slot must be held once");
  // The loser's fee must not survive. This is the assertion the loop shim cannot make: there, the
  // loser's first statement commits before its second one fails.
  assert.equal(count(sqlite, "ledger"), 1, "the losing caller must leave no partial write");
});

test("the hand-rolled loop shims only ever decrease", async () => {
  // 60 files still implement batch() as a loop, so any atomicity claim they make is measured against
  // the wrong machine. Migrating one means checking its assertions still hold under a real
  // transaction, per file - and a blanket edit across tests/ went wrong once already, so this is a
  // burn-down rather than a sweep. The count may fall, never rise: a new hand-rolled shim fails here,
  // and each migration lowers the number visibly in the diff.
  const BASELINE = 60;
  const { readdir, readFile } = await import("node:fs/promises");

  const files = (await readdir("tests")).filter((f) => f.endsWith(".test.mjs") && f !== "d1-shim-contract.test.mjs");
  const remaining = [];
  for (const file of files) {
    const source = await readFile(`tests/${file}`, "utf8");
    if (!/batch:/.test(source)) continue;
    if (/ROLLBACK/.test(source) || /helpers\/d1\.mjs/.test(source)) continue;
    remaining.push(file);
  }

  assert.ok(
    remaining.length <= BASELINE,
    `hand-rolled batch() shims rose from ${BASELINE} to ${remaining.length}. Use createD1 from tests/helpers/d1.mjs:\n  ${remaining.slice(0, 5).join("\n  ")}`,
  );
  if (remaining.length < BASELINE) console.log(`  ${BASELINE - remaining.length} migrated since the baseline; lower BASELINE to ${remaining.length}.`);
  console.log(`  ${remaining.length} files still measure atomicity against a loop.`);
});
