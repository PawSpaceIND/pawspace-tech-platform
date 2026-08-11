// Shared hook called by every real booking-creation route right after a NEW canonical_booking is
// created (never on an idempotent replay of an existing one). Closes a real, previously-confirmed
// gap: lead_work_items.converted_booking_id was read by sales-productivity-governance.ts and
// revenue-mission-command-center.ts, but nothing anywhere ever wrote it - every conversion-attributed
// figure those modules compute was structurally guaranteed to be zero.
//
// lead_work_items itself is only ever created inline inside app/api/crm/route.ts and
// app/api/revenue-crm/route.ts (not exported as a shared ensure-function from a lib module), so this
// file carries its own defensive CREATE TABLE IF NOT EXISTS with the exact same column list, to avoid
// a "no such table" crash if this runs before either of those routes ever has - the same bug class
// already found and fixed once this session in the groomer incentive engine.

type Db=D1Database;
type Row=Record<string,unknown>;

export async function ensureLeadWorkItemsTable(db:Db){
  await db.prepare(
    "CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
  ).run();
}

export async function attributeBookingToOpenLead(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string}|null>{
  await ensureLeadWorkItemsTable(db);
  const openLead=await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') ORDER BY assigned_at DESC LIMIT 1"
  ).bind(input.customerId).first<Row>();
  if(!openLead)return null;
  const leadId=String(openLead.id),now=Date.now();
  await db.prepare(
    "UPDATE lead_work_items SET converted_booking_id=?,status='converted',updated_at=? WHERE id=? AND converted_booking_id IS NULL"
  ).bind(input.bookingId,now,leadId).run();
  return{leadId};
}
