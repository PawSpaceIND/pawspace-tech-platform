// Test-only SQLite D1 adapter; no connection to a deployed or on-disk customer database.
import { DatabaseSync } from 'node:sqlite';
export function betaD1() {
  const sqlite = new DatabaseSync(':memory:');
  const statement = (sql, args = []) => ({
    bind: (...values) => statement(sql, values),
    first: async (column) => { const row = sqlite.prepare(sql).get(...args); return row ? (column ? row[column] : row) : null; },
    all: async () => ({ success: true, results: sqlite.prepare(sql).all(...args) }),
    run: async () => { const result = sqlite.prepare(sql).run(...args); return { success: true, meta: { changes: Number(result.changes) } }; },
  });
  const db = {
    prepare: sql => statement(sql),
    batch: async statements => {
      sqlite.exec('BEGIN IMMEDIATE');
      try { const result = []; for (const s of statements) result.push(await s.run()); sqlite.exec('COMMIT'); return result; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    exec: async sql => { sqlite.exec(sql); return { count: 0, duration: 0 }; },
  };
  return { sqlite, db, close: () => sqlite.close() };
}
export function betaBooking(sqlite, { id = 'beta-booking', amount = 1899, due = amount, status = 'created' } = {}) {
  sqlite.exec(`CREATE TABLE IF NOT EXISTS canonical_bookings
    (id TEXT PRIMARY KEY,customer_id TEXT,service_code TEXT,city_id TEXT,total_amount REAL,status TEXT);
    CREATE TABLE IF NOT EXISTS booking_payments
    (id TEXT PRIMARY KEY,booking_id TEXT UNIQUE,customer_id TEXT,amount REAL,amount_due_now REAL,currency TEXT,status TEXT,method TEXT);
    CREATE TABLE IF NOT EXISTS stay_payment_schedules
    (booking_id TEXT PRIMARY KEY,paid_now_amount REAL,balance_amount REAL,status TEXT);
    CREATE TABLE IF NOT EXISTS payment_reconciliation_records (payment_id TEXT PRIMARY KEY,captured_amount REAL);`);
  sqlite.prepare("INSERT INTO canonical_bookings VALUES (?,'beta-customer','grooming','blr',?,'confirmed')").run(id, amount);
  sqlite.prepare("INSERT INTO booking_payments VALUES (?,?,'beta-customer',?,?,'INR',?,'upi')").run('pay-'+id, id, amount, due, status);
  return id;
}
