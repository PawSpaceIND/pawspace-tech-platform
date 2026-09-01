// Shared booking-to-lead attribution and payment-gated conversion boundary.
type Db=D1Database;
type Row=Record<string,unknown>;

const leadWorkItemsEnsured=new WeakSet<Db>();
export async function ensureLeadWorkItemsTable(db:Db){
  if(leadWorkItemsEnsured.has(db))return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_work_items_customer ON lead_work_items(customer_id,status,assigned_at)"),
  ]);
  const columns=await db.prepare("PRAGMA table_info(lead_work_items)").all<Row>().catch(()=>({results:[] as Row[]}));
  if(columns.results.length&&!columns.results.some(column=>String(column.name)==="initiated_booking_id")){
    await db.prepare("ALTER TABLE lead_work_items ADD COLUMN initiated_booking_id TEXT").run().catch(()=>{});
  }
  await db.prepare("CREATE TABLE IF NOT EXISTS booking_attribution (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,attribution_type TEXT NOT NULL,lead_id TEXT,source TEXT NOT NULL DEFAULT 'system',detail_json TEXT NOT NULL DEFAULT '{}',recorded_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_attribution_type ON booking_attribution(attribution_type,recorded_at)").run().catch(()=>{});
  leadWorkItemsEnsured.add(db);
}

/** How a booking came to exist. `lead` is a genuine campaign conversion; `direct_booking` is not. */
export type BookingAttributionType="lead"|"direct_booking";

async function recordAttribution(db:Db,input:{bookingId:string;customerId:string;serviceCode:string;type:BookingAttributionType;leadId?:string|null;detail?:unknown}){
  await db.prepare("INSERT OR IGNORE INTO booking_attribution (booking_id,customer_id,service_code,attribution_type,lead_id,source,detail_json,recorded_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(input.bookingId,input.customerId,input.serviceCode,input.type,input.leadId??null,input.type==="lead"?"lead_work_item":"system_direct_booking",JSON.stringify(input.detail??{}),Date.now()).run();
}

async function ensureCrmContactForCustomer(db:Db,customerId:string,now:number){
  const existing=await db.prepare("SELECT id FROM crm_contacts WHERE id=?").bind(customerId).first<Row>();
  if(existing)return true;
  const canonical=await db.prepare("SELECT id,name,primary_phone,secondary_phone,email,source,created_at FROM canonical_customers WHERE id=?").bind(customerId).first<Row>().catch(()=>null);
  if(!canonical)return false;
  await db.prepare("INSERT OR IGNORE INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(customerId,String(canonical.name||"Customer"),String(canonical.primary_phone||""),canonical.secondary_phone?String(canonical.secondary_phone):null,canonical.email?String(canonical.email):null,"Bangalore","Pet","Profile incomplete","New lead","Unassigned",String(canonical.source||"Customer app"),0,"Booking in progress",null,Number(canonical.created_at||now),now).run();
  return Boolean(await db.prepare("SELECT id FROM crm_contacts WHERE id=?").bind(customerId).first<Row>());
}

async function claimConversion(db:Db,input:{leadId:string;customerId:string;bookingId:string;now:number}){
  if(!(await ensureCrmContactForCustomer(db,input.customerId,input.now)))throw new Error("CRM contact missing for lead conversion");
  const results=await db.batch([
    db.prepare("UPDATE lead_work_items SET converted_booking_id=?,status='converted',updated_at=? WHERE id=? AND customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') AND EXISTS (SELECT 1 FROM crm_contacts WHERE id=?)")
      .bind(input.bookingId,input.now,input.leadId,input.customerId,input.customerId),
    db.prepare("UPDATE crm_contacts SET stage='Converted',next_action='Booking converted',updated_at=? WHERE id=?")
      .bind(input.now,input.customerId),
  ]);
  const leadChanged=Number(results[0]?.meta?.changes||0)>0;
  const contactChanged=Number(results[1]?.meta?.changes||0)>0;
  if(leadChanged&&!contactChanged)throw new Error("CRM contact conversion update failed");
  return leadChanged;
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

/** Link a new booking to the matching open lead; conversion itself remains payment-gated. */
export async function attributeBookingToOpenLead(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string|null;converted:boolean;attribution:BookingAttributionType}>{
  await ensureLeadWorkItemsTable(db);
  const booked=await db.prepare("SELECT service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);
  const bookedService=String(booked?.service_code||"").trim().toLowerCase();
  const openLead=bookedService?await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') AND lower(trim(service))=? ORDER BY assigned_at DESC LIMIT 1"
  ).bind(input.customerId,bookedService).first<Row>().catch(()=>null):null;
  if(!openLead){
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"direct_booking",detail:{reason:bookedService?"no_open_lead_for_this_service":"booking_service_unknown"}});
    return{leadId:null,converted:false,attribution:"direct_booking"};
  }
  const leadId=String(openLead.id),now=Date.now();
  const payment=await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>().catch(()=>null);
  const captured=String(payment?.status||"")==="captured";
  if(captured){
    const claimed=await claimConversion(db,{leadId,customerId:input.customerId,bookingId:input.bookingId,now});
    if(!claimed){
      await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"direct_booking",detail:{reason:"lead_conversion_claim_lost"}});
      return{leadId:null,converted:false,attribution:"direct_booking"};
    }
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"lead",leadId,detail:{matchedOn:"customer_and_service"}});
    return{leadId,converted:true,attribution:"lead"};
  }
  const linked=await db.prepare("UPDATE lead_work_items SET last_outcome='booking_initiated',initiated_booking_id=?,next_action_at=?,updated_at=? WHERE id=? AND customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') AND initiated_booking_id IS NULL")
    .bind(input.bookingId,now,now,leadId,input.customerId).run();
  if(Number(linked.meta?.changes||0)===0){
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"direct_booking",detail:{reason:"lead_booking_link_claim_lost"}});
    return{leadId:null,converted:false,attribution:"direct_booking"};
  }
  await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"lead",leadId,detail:{matchedOn:"customer_and_service"}});
  return{leadId,converted:false,attribution:"lead"};
}

/** Finish the conversion when the payment is captured (called from the verified payment hook). */
export async function convertLeadOnPaymentCaptured(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string}|null>{
  await ensureLeadWorkItemsTable(db);
  const openLead=await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND initiated_booking_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') ORDER BY assigned_at DESC LIMIT 1"
  ).bind(input.customerId,input.bookingId).first<Row>().catch(()=>null);
  if(!openLead){
    const booked=await db.prepare("SELECT service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:String(booked?.service_code||"").trim().toLowerCase(),type:"direct_booking",detail:{reason:"no_lead_linked_at_booking_creation"}});
    return null;
  }
  const leadId=String(openLead.id),now=Date.now();
  const claimed=await claimConversion(db,{leadId,customerId:input.customerId,bookingId:input.bookingId,now});
  return claimed?{leadId}:null;
}
