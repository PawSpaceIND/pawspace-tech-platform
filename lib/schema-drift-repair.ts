/**
 * Schema drift repair.
 *
 * Two modules may both declare the same table with `CREATE TABLE IF NOT EXISTS`. That statement is a
 * no-op once the table exists, so if the two declarations disagree, whichever module ran first silently
 * decides the real shape. This repair remains available for startup/migration contexts, but the deployed
 * staging Worker is migrated before pilot traffic and must not re-run multi-table schema inspection on
 * every concurrent customer request.
 */

type Db = D1Database;
type Row = Record<string, unknown>;

const REQUIRED_COLUMNS: Array<{ table: string; column: string; definition: string; why: string }> = [
  { table: "scheduling_reservations", column: "attempt_id", definition: "text", why: "scheduling attempt compare-and-set identity" },
  { table: "finance_close_periods", column: "checklist_json", definition: "text NOT NULL DEFAULT '[]'", why: "finance close checklist" },
  { table: "customer_contact_preferences", column: "opt_out", definition: "INTEGER NOT NULL DEFAULT 0", why: "contact opt-out governance" },
  { table: "booking_package_upgrade_requests", column: "claim_token", definition: "TEXT", why: "package-upgrade compare-and-set" },
  { table: "order_notifications", column: "delivery_status", definition: "TEXT NOT NULL DEFAULT 'pending'", why: "durable notification delivery state" },
  { table: "order_notifications", column: "delivery_attempts", definition: "INTEGER NOT NULL DEFAULT 0", why: "durable notification attempts" },
  { table: "order_notifications", column: "delivery_error", definition: "TEXT", why: "durable notification failure reason" },
];

async function tableExists(db: Db, name: string) {
  const row = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>();
  return Boolean(row);
}

let stagingRuntimePromise: Promise<boolean> | undefined;
async function stagingRuntime() {
  stagingRuntimePromise ??= import("cloudflare:workers")
    .then(({ env }) => String((env as unknown as Record<string, unknown>).PAWSPACE_DEPLOYMENT_ENV || "").trim().toLowerCase() === "staging")
    .catch(() => false);
  return stagingRuntimePromise;
}

/**
 * Add any missing column listed above. In deployed staging, schema preparation is a deployment concern,
 * not customer-request work: return immediately and let the workflow preflight fail if the schema is not
 * ready. Production/local behavior is unchanged until the repository moves this fully into migrations.
 */
export async function repairSchemaDrift(db: Db) {
  if (await stagingRuntime()) return { repaired: [], preflighted: true };
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
