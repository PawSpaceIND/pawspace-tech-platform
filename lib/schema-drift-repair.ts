/**
 * Schema drift repair.
 *
 * Two modules may both declare the same table with `CREATE TABLE IF NOT EXISTS`. That statement is a
 * no-op once the table exists, so if the two declarations disagree, **whichever module ran first
 * silently decides the real shape** and the other one's writes fail forever against a live database.
 * Nothing catches it: each module's own tests create their own table and pass.
 *
 * Unifying the declarations fixes a FRESH database. It does nothing for one that already exists with
 * the wrong shape, which is why this file exists: it adds the missing columns in place.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const REQUIRED_COLUMNS: Array<{ table: string; column: string; definition: string; why: string }> = [
  {
    table: "finance_close_periods", column: "checklist_json", definition: "text NOT NULL DEFAULT '[]'",
    why: "lib/gst-accounting.ts created this table without the column that app/api/finance-control/route.ts writes",
  },
  {
    table: "customer_contact_preferences", column: "opt_out", definition: "INTEGER NOT NULL DEFAULT 0",
    why: "lib/customer-360.ts created this table without the opt-out flag lib/revenue-opportunity-governance.ts filters on",
  },
  {
    table: "booking_package_upgrade_requests", column: "claim_token", definition: "TEXT",
    why: "package-upgrade approval uses a claim-token compare-and-set",
  },
  {
    table: "booking_refund_cases", column: "claim_token", definition: "TEXT",
    why: "refund status decisions require a per-attempt claim token so concurrent finance actors cannot both emit side effects",
  },
  {
    table: "order_notifications", column: "delivery_status", definition: "TEXT NOT NULL DEFAULT 'pending'",
    why: "notification records must distinguish inbox persistence from downstream communication delivery so failed queue attempts remain retryable",
  },
  {
    table: "order_notifications", column: "delivery_attempts", definition: "INTEGER NOT NULL DEFAULT 0",
    why: "notification retry attempts must be durable and auditable",
  },
  {
    table: "order_notifications", column: "delivery_error", definition: "TEXT",
    why: "failed communication queue attempts must leave a durable recovery reason instead of being silently swallowed",
  },
];

async function tableExists(db: Db, name: string) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}

export async function repairSchemaDrift(db: Db) {
  const repaired: string[] = [];
  for (const item of REQUIRED_COLUMNS) {
    if (!await tableExists(db, item.table)) continue;
    const columns = await db.prepare(`PRAGMA table_info(${item.table})`).all<Row>().catch(() => ({ results: [] as Row[] }));
    if (columns.results.some(row => String(row.name) === item.column)) continue;
    try {
      await db.prepare(`ALTER TABLE ${item.table} ADD COLUMN ${item.column} ${item.definition}`).run();
      repaired.push(`${item.table}.${item.column}`);
    } catch (error) {
      const after = await db.prepare(`PRAGMA table_info(${item.table})`).all<Row>().catch(() => ({ results: [] as Row[] }));
      if (!after.results.some(row => String(row.name) === item.column)) throw error;
    }
  }
  return { repaired };
}

export const REQUIRED_COLUMN_REPAIRS = REQUIRED_COLUMNS;
