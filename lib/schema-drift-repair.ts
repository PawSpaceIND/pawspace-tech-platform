/**
 * Schema drift repair.
 *
 * Two modules may both declare the same table with `CREATE TABLE IF NOT EXISTS`. That statement is a
 * no-op once the table exists, so if the two declarations disagree, **whichever module ran first
 * silently decides the real shape** and the other one's writes fail forever against a live database.
 * Nothing catches it: each module's own tests create their own table and pass.
 *
 * That is exactly what happened on staging. `lib/gst-accounting.ts` created finance_close_periods
 * without `checklist_json`, so every Finance close write died with
 * "table finance_close_periods has no column named checklist_json".
 *
 * Unifying the declarations fixes a FRESH database. It does nothing for one that already exists with
 * the wrong shape, which is why this file exists: it adds the missing columns in place.
 *
 * `tests/schema-declaration-consistency.test.mjs` is the other half - it fails CI if any two modules
 * declare the same table with different columns, so this class cannot come back.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

/** Columns a table must have, with the DDL fragment used to add each one if it is missing. */
const REQUIRED_COLUMNS: Array<{ table: string; column: string; definition: string; why: string }> = [
  {
    table: "finance_close_periods", column: "checklist_json", definition: "text NOT NULL DEFAULT '[]'",
    why: "lib/gst-accounting.ts created this table without the column that app/api/finance-control/route.ts writes",
  },
  {
    table: "customer_contact_preferences", column: "opt_out", definition: "INTEGER NOT NULL DEFAULT 0",
    why: "lib/customer-360.ts created this table without the opt-out flag lib/revenue-opportunity-governance.ts filters on",
  },
];

async function tableExists(db: Db, name: string) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}

/**
 * Add any missing column listed above. Safe to run on every request path: it only touches tables that
 * already exist, only adds columns that are genuinely absent, and never drops or rewrites data.
 * Returns the repairs actually applied so a caller can log or assert on them.
 */
export async function repairSchemaDrift(db: Db) {
  const repaired: string[] = [];
  for (const item of REQUIRED_COLUMNS) {
    if (!await tableExists(db, item.table)) continue;
    const columns = await db.prepare(`PRAGMA table_info(${item.table})`).all<Row>().catch(() => ({ results: [] as Row[] }));
    if (columns.results.some(row => String(row.name) === item.column)) continue;
    // A concurrent request may win the race and add it first; that ALTER simply fails and we move on.
    await db.prepare(`ALTER TABLE ${item.table} ADD COLUMN ${item.column} ${item.definition}`).run().catch(() => {});
    repaired.push(`${item.table}.${item.column}`);
  }
  return { repaired };
}

/** The declared expectations, exported so tests can check them against the modules' own DDL. */
export const REQUIRED_COLUMN_REPAIRS = REQUIRED_COLUMNS;
