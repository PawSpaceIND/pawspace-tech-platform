import { DatabaseSync } from "node:sqlite";

/**
 * D1-compatible SQLite harness for transaction fault injection.
 *
 * The failure is deliberately raised AFTER a statement has executed but BEFORE the surrounding
 * batch commits. This models the dangerous boundary we care about: local state has changed inside
 * the transaction, then the worker/runtime/database connection disappears before the audit, ledger,
 * outbox, or companion write can commit.
 */
export class SimulatedTransactionFailure extends Error {
  constructor(message = "simulated transactional connection drop") {
    super(message);
    this.name = "SimulatedTransactionFailure";
    this.code = "SIMULATED_CONNECTION_DROP";
  }
}

export function createTransactionalChaosD1(options = {}) {
  const sqlite = options.sqlite ?? new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const trace = [];
  let batchNumber = 0;

  const injection = {
    batch: options.failBatch ?? null,
    statement: options.failAfterStatement ?? null,
    sql: options.failAfterSql ?? null,
    once: options.failOnce !== false,
    fired: false,
  };

  function shouldFail({ batch, statement, sql }) {
    if (injection.fired && injection.once) return false;
    if (injection.batch != null && injection.batch !== batch) return false;
    if (injection.statement != null && injection.statement !== statement) return false;
    if (injection.sql && !injection.sql.test(String(sql))) return false;
    if (injection.batch == null && injection.statement == null && !injection.sql) return false;
    injection.fired = true;
    return true;
  }

  function isRuntimeSchemaBatch(statements) {
    if (!Array.isArray(statements) || statements.length === 0) return false;
    return statements.every((statement) => /^\s*CREATE\s+(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\b/i.test(String(statement.sql || "")));
  }

  function boundStatement(sql, args = []) {
    return {
      sql,
      args,
      bind: (...bound) => boundStatement(sql, bound),
      first: async () => sqlite.prepare(sql).get(...args) ?? null,
      all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
      run: async () => {
        const info = sqlite.prepare(sql).run(...args);
        trace.push({ kind: "run", sql: String(sql), changes: Number(info.changes || 0) });
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
      runSync: () => {
        const info = sqlite.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(info.changes || 0) } };
      },
    };
  }

  const db = {
    prepare: (sql) => boundStatement(sql),
    batch: async (statements) => {
      // Runtime schema bootstrap is setup, not the transactional fault surface under test.
      // Let the shared schema materialize completely before arming/counting chaos batches.
      if (isRuntimeSchemaBatch(statements)) {
        trace.push({ kind: "schema-begin", size: statements.length });
        sqlite.exec("BEGIN IMMEDIATE");
        try {
          const results = statements.map((statement) => {
            const info = sqlite.prepare(statement.sql).run(...(statement.args ?? []));
            return { success: true, meta: { changes: Number(info.changes || 0) } };
          });
          sqlite.exec("COMMIT");
          trace.push({ kind: "schema-commit", size: statements.length });
          return results;
        } catch (error) {
          sqlite.exec("ROLLBACK");
          trace.push({ kind: "schema-rollback", error: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      }

      const currentBatch = ++batchNumber;
      trace.push({ kind: "begin", batch: currentBatch, size: statements.length });
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const results = [];
        for (let index = 0; index < statements.length; index += 1) {
          const statement = statements[index];
          const info = sqlite.prepare(statement.sql).run(...(statement.args ?? []));
          const step = index + 1;
          trace.push({ kind: "batch-run", batch: currentBatch, statement: step, sql: String(statement.sql), changes: Number(info.changes || 0) });
          results.push({ success: true, meta: { changes: Number(info.changes || 0) } });
          if (shouldFail({ batch: currentBatch, statement: step, sql: statement.sql })) {
            throw new SimulatedTransactionFailure(`simulated connection drop after batch ${currentBatch} statement ${step}`);
          }
        }
        sqlite.exec("COMMIT");
        trace.push({ kind: "commit", batch: currentBatch });
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        trace.push({ kind: "rollback", batch: currentBatch, error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    },
    exec: async (sql) => {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };

  return {
    sqlite,
    db,
    trace,
    injected: () => injection.fired,
    close: () => sqlite.close(),
    scalar: (sql, ...args) => Number(sqlite.prepare(sql).get(...args)?.value || 0),
    row: (sql, ...args) => sqlite.prepare(sql).get(...args) ?? null,
  };
}

export async function assertRolledBack(assert, harness, expectations) {
  for (const expectation of expectations) {
    const actual = harness.scalar(expectation.sql, ...(expectation.args ?? []));
    assert.equal(actual, expectation.expected ?? 0, expectation.label ?? expectation.sql);
  }
  assert.ok(harness.trace.some((entry) => entry.kind === "rollback"), "fault injection must have forced a rollback");
  assert.equal(harness.trace.some((entry) => entry.kind === "commit"), false, "the faulted transaction must never commit");
}
