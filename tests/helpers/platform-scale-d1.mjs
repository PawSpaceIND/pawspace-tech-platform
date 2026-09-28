// Scoped SQLite adapter for the platform matrix; no hosted database or payment calls.
// D1 batch returns ordered results and rolls back the whole batch on failure:
// https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
export function makePlatformScaleD1(sqlite) {
  let sequence = 0;
  function execute(sql, args) {
    const before = sqlite.prepare("SELECT total_changes() AS n").get().n;
    // all() also executes DDL/DML once, preserving SELECT and RETURNING rows.
    const results = sqlite.prepare(sql).all(...args);
    const meta = sqlite.prepare("SELECT total_changes() AS total, changes() AS changed, last_insert_rowid() AS id").get();
    const changes = meta.total === before ? 0 : Number(meta.changed);
    return { results, success: true, meta: { changes, last_row_id: Number(meta.id), rows_written: changes } };
  }
  const statement = (sql, args = []) => ({
    sql, args,
    bind: (...bound) => statement(sql, bound),
    first: async (column) => {
      const row = sqlite.prepare(sql).get(...args);
      return row === undefined ? null : column ? row[column] : row;
    },
    run: async () => execute(sql, args),
    all: async () => execute(sql, args),
    raw: async () => sqlite.prepare(sql).all(...args).map((row) => Object.values(row)),
  });
  return {
    prepare: (sql) => statement(sql),
    batch: async (list) => {
      const savepoint = `platform_batch_${++sequence}`;
      sqlite.exec(`SAVEPOINT ${savepoint}`);
      try {
        // Deliberately synchronous: concurrent callers cannot interleave a batch.
        const results = list.map((item) => execute(item.sql, item.args));
        sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
        return results;
      } catch (error) {
        sqlite.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        sqlite.exec(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    },
    exec: async (sql) => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
    dump: async () => new ArrayBuffer(0),
  };
}
