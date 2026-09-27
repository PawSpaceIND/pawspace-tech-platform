type Row = Record<string, unknown>;
/** Read-only enforcement: an approved exit cuts off staff access even if the scheduled writer is late.
 * This never changes an identity or authenticates a caller. Missing configuration means no exit,
 * while a database failure propagates rather than granting access. Rehire needs an explicit workflow. */
export async function employeeAccessHasEnded(db:D1Database,email:string,asOf=Date.now()) {
  const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_exit_cases'").first<Row>();
  if(!exists)return false;
  return Boolean(await db.prepare("SELECT id FROM employee_exit_cases WHERE identity_email=? AND status IN ('approved','access_revoked','settled_sandbox') AND access_ends_at<=? LIMIT 1").bind(email.trim().toLowerCase(),asOf).first<Row>());
}
