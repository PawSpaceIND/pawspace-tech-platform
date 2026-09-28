type Row = Record<string, unknown>;
/** Read-only enforcement: an approved exit cuts off staff access even if the scheduled writer is late.
 * This never changes an identity or authenticates a caller. Missing configuration means no exit,
 * while a database failure propagates rather than granting access. Rehire needs an explicit workflow. */
export async function employeeAccessHasEnded(db:D1Database,email:string,asOf=Date.now()) {
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_exit_cases'").first<Row>();
  if(!exists)return false;
  return Boolean(await db.prepare(EMPLOYEE_EXIT_CUTOFF_SQL).bind(email.trim().toLowerCase(),email.trim().toLowerCase(),asOf).first<Row>());
}

/** Canonical cutoff query, reused inside the lead INSERT so approval cannot race a prior read. */
export const EMPLOYEE_EXIT_CUTOFF_SQL = "SELECT id FROM employee_exit_cases WHERE (identity_email=? OR user_id IN (SELECT id FROM app_users WHERE lower(email)=?)) AND status IN ('approved','access_revoked','settled_sandbox') AND access_ends_at<=? LIMIT 1";

/** Shared schema only: no identity, exit, approval or salary records are created here. */
export function employeeExitAccessSchema(db:D1Database):D1PreparedStatement[]{return[
  db.prepare("CREATE TABLE IF NOT EXISTS employee_exit_cases (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,employee_id TEXT NOT NULL,user_id TEXT NOT NULL,identity_email TEXT NOT NULL,employee_snapshot_json TEXT NOT NULL,access_ends_at INTEGER NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','access_revoked','cancelled','settled_sandbox')),requested_by TEXT NOT NULL,created_at INTEGER NOT NULL,approved_by TEXT,approved_at INTEGER,revoked_at INTEGER,cancelled_by TEXT,cancel_reason TEXT,clearance_reference TEXT,settlement_reference TEXT,settlement_snapshot_json TEXT,settled_by TEXT,settled_at INTEGER,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS employee_exit_one_open_idx ON employee_exit_cases(employee_id) WHERE status<>'cancelled'"),
  db.prepare("CREATE INDEX IF NOT EXISTS employee_exit_due_idx ON employee_exit_cases(status,access_ends_at)"),
];}
