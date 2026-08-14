/**
 * A D1 shim that behaves like D1.
 *
 * `db.batch()` in Cloudflare D1 is ONE transaction: if any statement fails, none of them are
 * applied. Almost every shim in this suite implements it as a loop:
 *
 *     batch: async (list) => { const out = []; for (const item of list) out.push(await item.run()); return out; }
 *
 * which commits each statement as it goes. So a test where step 3 of 5 fails leaves steps 1 and 2
 * written, while production would have rolled all five back. Any test asserting "the booking is not
 * half-created" or "the claim is released on failure" is therefore asserting the wrong machine, and
 * 73 of the 78 shims in this directory are that loop. That is why a stuck-state defect survived a
 * green suite during the #177 review: the suite structurally could not see it.
 *
 * This models the real thing:
 *   - batch() wraps the statements in BEGIN / COMMIT, and ROLLBACKs the whole set on any failure.
 *   - batch() is serialised, because SQLite has no nested transactions and two overlapping batches
 *     would otherwise interleave their BEGIN/COMMIT and corrupt each other.
 *   - statements are lazy, so a prepared statement runs inside the transaction rather than before it.
 *
 * It also exposes the hook a race needs: `park` lets a test hold one statement open while another
 * caller proceeds, which is how you drive two writers at one slot and prove exactly one wins.
 *
 * Usage:
 *   import { createD1 } from "./helpers/d1.mjs";
 *   const db = createD1(sqlite);
 *   const db = createD1(sqlite, { park: (sql) => sql.includes("scheduling_reservations") ? gate : null });
 */

/** Serialises batches. SQLite cannot nest transactions, so overlapping batches must queue. */
function createLock() {
  let tail = Promise.resolve();
  return (work) => {
    const run = tail.then(work, work);
    // Keep the chain alive after a rejection, or one failed batch wedges every later one.
    tail = run.then(() => undefined, () => undefined);
    return run;
  };
}

/** D1 rejects a statement with more than ~100 bound parameters; node:sqlite accepts thousands. */
export const D1_MAX_BOUND_PARAMS = 100;

export function createD1(sqlite, options = {}) {
  const { park = () => null, onStatement = null, maxBoundParams = D1_MAX_BOUND_PARAMS } = options;
  const withLock = createLock();
  let inTransaction = false;

  const execute = (sql, args, mode) => {
    if (onStatement) onStatement(sql, args, mode);
    const prepared = sqlite.prepare(sql);
    if (mode === "first") {
      const row = prepared.get(...args);
      return row === undefined ? null : row;
    }
    if (mode === "all") return { results: prepared.all(...args), success: true };
    const info = prepared.run(...args);
    // rows_written is part of D1's meta and several guards read it (the invoice race guard decides
    // whether it won the row by checking it), so a shim that omits it silently changes their branch.
    const changes = Number(info.changes ?? 0);
    return { success: true, meta: { changes, rows_written: changes, last_row_id: Number(info.lastInsertRowid ?? 0) } };
  };

  /** A gate returned by `park` lets the test decide when this statement is allowed to proceed. */
  const awaitGate = async (sql) => {
    const gate = park(sql);
    if (gate && typeof gate.then === "function") await gate;
  };

  function statement(sql, args) {
    // Refused at bind time, as D1 does. A shim that accepts an unbounded "?" list lets a query whose
    // width grows with the row count pass every test and fail on the deployed database - which is
    // precisely how /api/unit-economics shipped "too many SQL variables at offset 301".
    if (args.length > maxBoundParams) {
      throw new Error(`D1_ERROR: too many SQL variables (${args.length} > ${maxBoundParams}): ${String(sql).slice(0, 90)}`);
    }
    return {
      bind: (...bound) => statement(sql, bound),
      first: async () => { await awaitGate(sql); return execute(sql, args, "first"); },
      all: async () => { await awaitGate(sql); return execute(sql, args, "all"); },
      run: async () => {
        await awaitGate(sql);
        // A bare run() outside batch() is its own transaction, exactly as in D1.
        return execute(sql, args, "run");
      },
      /** Used only by batch(): runs synchronously inside the open transaction. */
      __runInTransaction: () => execute(sql, args, "run"),
      __sql: sql,
    };
  }

  return {
    prepare: (sql) => statement(sql, []),

    batch: (list) => withLock(async () => {
      // Gates are awaited BEFORE the transaction opens. Holding a SQLite transaction open across an
      // await would block every other writer and turn a race test into a deadlock - which is exactly
      // what happened the first time this was attempted during the #177 review.
      for (const item of list) await awaitGate(item.__sql ?? "");

      if (inTransaction) throw new Error("createD1: nested batch() - the lock should have prevented this");
      inTransaction = true;
      sqlite.exec("BEGIN");
      try {
        const out = list.map((item) => {
          if (typeof item.__runInTransaction !== "function") {
            throw new Error("createD1: batch() received something that is not a prepared statement");
          }
          return item.__runInTransaction();
        });
        sqlite.exec("COMMIT");
        return out;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    }),

    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    dump: async () => new ArrayBuffer(0),
    withSession: () => { throw new Error("createD1: withSession is not modelled"); },
  };
}

/** Convenience for the common case: a fresh in-memory database with the given DDL applied. */
export function createD1From(DatabaseSync, ddl, options = {}) {
  const sqlite = new DatabaseSync(":memory:");
  if (ddl) sqlite.exec(ddl);
  return { sqlite, db: createD1(sqlite, options) };
}
