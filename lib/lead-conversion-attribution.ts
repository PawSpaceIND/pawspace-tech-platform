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

const leadWorkItemsEnsured=new WeakSet<Db>();
export async function ensureLeadWorkItemsTable(db:Db){
  if(leadWorkItemsEnsured.has(db))return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_work_items_customer ON lead_work_items(customer_id,status,assigned_at)"),
  ]);
  // initiated_booking_id records WHICH booking a lead was linked to before payment, so the later
  // payment-capture conversion credits that exact lead. Without it, a customer with two open leads
  // could have the wrong one marked converted (attribution went to whichever was newest).
  // The table is created inline by several routes with a fixed column list, so migrate additively.
  const columns=await db.prepare("PRAGMA table_info(lead_work_items)").all<Row>().catch(()=>({results:[] as Row[]}));
  if(columns.results.length&&!columns.results.some(column=>String(column.name)==="initiated_booking_id")){
    await db.prepare("ALTER TABLE lead_work_items ADD COLUMN initiated_booking_id TEXT").run().catch(()=>{});
  }
  leadWorkItemsEnsured.add(db);
}

/**
 * Called right after a NEW canonical booking is created. Conversion is PAYMENT-GATED: a lead only
 * becomes `converted` once the booking's payment has reached `captured`. A booking that is started but
 * not yet paid links to the lead as `booking_initiated` and keeps the lead OPEN, so Sales still owns it
 * through the payment-recovery flow (this closes the "booked-but-unpaid ≠ converted" requirement).
 * convertLeadOnPaymentCaptured() finishes the conversion when the payment webhook confirms capture.
 */
export async function attributeBookingToOpenLead(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string;converted:boolean}|null>{
  await ensureLeadWorkItemsTable(db);
  const openLead=await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') ORDER BY assigned_at DESC LIMIT 1"
  ).bind(input.customerId).first<Row>();
  if(!openLead)return null;
  const leadId=String(openLead.id),now=Date.now();
  const payment=await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>().catch(()=>null);
  const captured=String(payment?.status||"")==="captured";
  if(captured){
    await db.prepare("UPDATE lead_work_items SET converted_booking_id=?,status='converted',updated_at=? WHERE id=? AND converted_booking_id IS NULL").bind(input.bookingId,now,leadId).run();
    return{leadId,converted:true};
  }
  // booking initiated but payment not done - keep the lead open for Sales/recovery, don't convert yet
  await db.prepare("UPDATE lead_work_items SET last_outcome='booking_initiated',initiated_booking_id=?,next_action_at=?,updated_at=? WHERE id=? AND converted_booking_id IS NULL").bind(input.bookingId,now,now,leadId).run();
  return{leadId,converted:false};
}

/** Finish the conversion when the payment is captured (called from the payment webhook hook). */
export async function convertLeadOnPaymentCaptured(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string}|null>{
  await ensureLeadWorkItemsTable(db);
  // Credit the lead this booking was actually attributed to at creation time; only fall back to the
  // newest open lead when nothing was linked (e.g. a booking created before this hook existed).
  const openLead=await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') ORDER BY CASE WHEN initiated_booking_id=? THEN 0 ELSE 1 END,assigned_at DESC LIMIT 1"
  ).bind(input.customerId,input.bookingId).first<Row>().catch(()=>null);
  if(!openLead)return null;
  const leadId=String(openLead.id),now=Date.now();
  await db.prepare("UPDATE lead_work_items SET converted_booking_id=?,status='converted',updated_at=? WHERE id=? AND converted_booking_id IS NULL").bind(input.bookingId,now,leadId).run();
  return{leadId};
}
