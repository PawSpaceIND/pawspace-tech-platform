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
  /*
   * The booking's ORIGIN, recorded once per booking. [PTJA-W3-LA]
   *
   * The approved rule says a booking with no matching lead credits nobody and is recorded as a direct
   * booking - and that if the Identity Spine needs an originating record, it gets a clearly labelled
   * system one rather than an unrelated marketing lead being modified. This is that record. PRIMARY KEY
   * on booking_id, so a replayed hook cannot inflate either figure.
   */
  await db.prepare("CREATE TABLE IF NOT EXISTS booking_attribution (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,attribution_type TEXT NOT NULL,lead_id TEXT,source TEXT NOT NULL DEFAULT 'system',detail_json TEXT NOT NULL DEFAULT '{}',recorded_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_attribution_type ON booking_attribution(attribution_type,recorded_at)").run().catch(()=>{});
  leadWorkItemsEnsured.add(db);
}

/** How a booking came to exist. `lead` is a genuine campaign conversion; `direct_booking` is not. */
export type BookingAttributionType="lead"|"direct_booking";

async function recordAttribution(db:Db,input:{bookingId:string;customerId:string;serviceCode:string;type:BookingAttributionType;leadId?:string|null;detail?:unknown}){
  // INSERT OR IGNORE: the first recorded origin stands. A booking does not change how it was won, and a
  // replayed hook must not add a second row to either column of the report.
  await db.prepare("INSERT OR IGNORE INTO booking_attribution (booking_id,customer_id,service_code,attribution_type,lead_id,source,detail_json,recorded_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(input.bookingId,input.customerId,input.serviceCode,input.type,input.leadId??null,input.type==="lead"?"lead_work_item":"system_direct_booking",JSON.stringify(input.detail??{}),Date.now()).run();
}

/** Campaign conversions and direct bookings, counted separately. */
export async function bookingAttributionSummary(db:Db,input:{from?:number;to?:number}={}){
  await ensureLeadWorkItemsTable(db);
  const rows=await db.prepare("SELECT attribution_type,COUNT(*) n FROM booking_attribution WHERE recorded_at>=? AND recorded_at<=? GROUP BY attribution_type")
    .bind(input.from??0,input.to??Number.MAX_SAFE_INTEGER).all<Row>();
  const summary:Record<string,number>={lead:0,direct_booking:0};
  for(const row of rows.results)summary[String(row.attribution_type)]=Number(row.n||0);
  return summary;
}

/**
 * Called right after a NEW canonical booking is created. Conversion is PAYMENT-GATED: a lead only
 * becomes `converted` once the booking's payment has reached `captured`. A booking that is started but
 * not yet paid links to the lead as `booking_initiated` and keeps the lead OPEN, so Sales still owns it
 * through the payment-recovery flow (this closes the "booked-but-unpaid ≠ converted" requirement).
 * convertLeadOnPaymentCaptured() finishes the conversion when the payment webhook confirms capture.
 */
export async function attributeBookingToOpenLead(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string|null;converted:boolean;attribution:BookingAttributionType}>{
  await ensureLeadWorkItemsTable(db);
  // WHICH lead converted. This used to be "the customer's newest open lead" with no reference to what was
  // booked, so a customer with an older Grooming enquiry and a newer Boarding enquiry who booked GROOMING
  // had the conversion written onto the Boarding lead: the rep who worked the grooming enquiry lost the
  // credit, the boarding lead was closed as converted by a booking unrelated to it, and the lead that
  // actually converted stayed open and kept chasing a customer who had already bought.
  //
  // Both rows already carry the answer - lead_work_items.service and canonical_bookings.service_code - so
  // the lead for the service that was actually booked is preferred, newest first within that service.
  // When NO open lead matches, the newest-open-lead behaviour is unchanged: crediting nobody would be a
  // product decision about what an unmatched conversion means. [PTJA-P1-F1]
  const booked=await db.prepare("SELECT service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);
  const bookedService=String(booked?.service_code||"").trim().toLowerCase();
  const openLead=bookedService?await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') AND lower(trim(service))=? ORDER BY assigned_at DESC LIMIT 1"
  ).bind(input.customerId,bookedService).first<Row>().catch(()=>null):null;
  if(!openLead){
    /*
     * NO MATCH IS NOT A LICENCE TO CREDIT SOMEBODY ELSE. [PTJA-W3-LA]
     *
     * This used to fall back to "the customer's newest open lead" with no reference to the service, so
     * a customer whose only open enquiry was BOARDING, who booked GROOMING, had the Boarding lead
     * marked converted by a booking that had nothing to do with it - the Boarding rep credited with a
     * conversion they never made, and the Boarding enquiry closed while the customer was still waiting
     * to hear about boarding. The booking is recorded as a direct booking and no lead is touched.
     */
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"direct_booking",
      detail:{reason:bookedService?"no_open_lead_for_this_service":"booking_service_unknown"}});
    return{leadId:null,converted:false,attribution:"direct_booking"};
  }
  const leadId=String(openLead.id),now=Date.now();
  const payment=await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>().catch(()=>null);
  const captured=String(payment?.status||"")==="captured";
  await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"lead",leadId,detail:{matchedOn:"customer_and_service"}});
  if(captured){
    await db.prepare("UPDATE lead_work_items SET converted_booking_id=?,status='converted',updated_at=? WHERE id=? AND converted_booking_id IS NULL").bind(input.bookingId,now,leadId).run();
    return{leadId,converted:true,attribution:"lead"};
  }
  // booking initiated but payment not done - keep the lead open for Sales/recovery, don't convert yet
  await db.prepare("UPDATE lead_work_items SET last_outcome='booking_initiated',initiated_booking_id=?,next_action_at=?,updated_at=? WHERE id=? AND converted_booking_id IS NULL").bind(input.bookingId,now,now,leadId).run();
  return{leadId,converted:false,attribution:"lead"};
}

/** Finish the conversion when the payment is captured (called from the payment webhook hook). */
export async function convertLeadOnPaymentCaptured(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string}|null>{
  await ensureLeadWorkItemsTable(db);
  // Credit the lead this booking was actually attributed to at creation time; only fall back to the
  // newest open lead when nothing was linked (e.g. a booking created before this hook existed).
  /*
   * ONLY the lead this booking was actually linked to. The ORDER BY here used to demote the unlinked
   * rows rather than exclude them, so a capture with nothing linked converted whichever lead happened
   * to be newest - the same false attribution as the creation path, arriving one webhook later.
   * [PTJA-W3-LA]
   */
  const openLead=await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND initiated_booking_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') ORDER BY assigned_at DESC LIMIT 1"
  ).bind(input.customerId,input.bookingId).first<Row>().catch(()=>null);
  if(!openLead){
    const booked=await db.prepare("SELECT service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:String(booked?.service_code||"").trim().toLowerCase(),
      type:"direct_booking",detail:{reason:"no_lead_linked_at_booking_creation"}});
    return null;
  }
  const leadId=String(openLead.id),now=Date.now();
  await db.prepare("UPDATE lead_work_items SET converted_booking_id=?,status='converted',updated_at=? WHERE id=? AND converted_booking_id IS NULL").bind(input.bookingId,now,leadId).run();
  return{leadId};
}
