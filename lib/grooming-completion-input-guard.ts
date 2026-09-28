import { ensureGstAccountingTables } from "./gst-accounting";
import { ensurePaymentReconciliationTables } from "./grooming-payment-reconciliation";
import { REFUND_TABLES } from "./settlement-parity";

type Row = Record<string, unknown>;
type Source = { table: string; predicate: string; columns?: string[] };
const quote = (name: string) => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name)) throw new Error("Invalid completion input column");
  return `"${name}"`;
};
const sources: Source[] = [
  { table: "canonical_bookings", predicate: "id=?", columns: ["id","customer_id","provider_id","service_code","total_amount","currency","pricing_json"] },
  ...["booking_payments","service_cash_collections","service_completion_collection_overrides",
    "payment_reconciliation_records","booking_refund_cases","stay_payment_schedules",
    "taxi_payment_schedules",...REFUND_TABLES].map(table => ({ table, predicate: "booking_id=?" })),
  { table: "finance_adjustment_documents", predicate: "invoice_id IN (SELECT id FROM finance_invoices WHERE source_type='booking' AND source_id=?)" },
  { table: "pawspace_wallet_ledger", predicate: "source_type='booking' AND source_id=?" },
  { table: "paw_points_ledger", predicate: "booking_id=?" },
  { table: "review_reward_codes", predicate: "redeemed_booking_id=?" },
];

/** Freeze the inputs of collection and finance, then compare them inside finalization's transaction.
 * This is optimistic concurrency control, not a new tax/refund formula or a webhook lock.
 * An absent optional source must stay absent; a newly provisioned source requires a fresh attempt.
 */
export async function captureGroomingCompletionInputs(db: D1Database, bookingId: string) {
  await ensureGstAccountingTables(db);
  await ensurePaymentReconciliationTables(db);
  const present = new Set((await db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all<{name:string}>()).results.map(row => row.name));
  const reads = await Promise.all(sources.map(async source => {
    if (!present.has(source.table)) return {
      sql: `(SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='${source.table}')`, binds: [] as unknown[],
    };
    const info = (await db.prepare(`PRAGMA table_info(${quote(source.table)})`).all<{name:string;pk:number}>()).results;
    const names = info.map(row => row.name);
    const columns = source.columns ? source.columns.filter(name => names.includes(name)) : names;
    const order = info.filter(row => row.pk).sort((a,b) => a.pk-b.pk).map(row => quote(row.name));
    const pairs = columns.flatMap(name => [`'${name}'`,quote(name)]).join(",");
    if (!pairs) throw new Error("Completion source has no verifiable columns");
    return { sql: `(SELECT json_group_array(json_object(${pairs})) FROM
      (SELECT * FROM ${quote(source.table)} WHERE ${source.predicate} ORDER BY ${order.length ? order.join(",") : columns.map(quote).join(",")}))`,
      binds: [bookingId] as unknown[] };
  }));
  const statement = `SELECT ${reads.map((read,index) => `${read.sql} AS s${index}`).join(",")}`;
  const readBinds = reads.flatMap(read => read.binds);
  const snapshot = await db.prepare(statement).bind(...readBinds).first<Row>();
  if (!snapshot) throw new Error("Completion input snapshot is unavailable");
  if (sources.some((source,index) => !present.has(source.table) && snapshot[`s${index}`] !== 0))
    throw new Error("Completion input schema changed; retry with a fresh snapshot");
  const sql = reads.map(read => `(${read.sql} IS ?)`).join(" AND ");
  const binds = reads.flatMap((read,index) => [...read.binds,snapshot[`s${index}`]]);
  return { sql, binds, unchanged: async () => {
    const row = await db.prepare(`SELECT CASE WHEN ${sql} THEN 1 ELSE 0 END AS ok`).bind(...binds).first<{ok:number}>();
    return row?.ok === 1;
  } };
}
