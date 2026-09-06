import{ensureLeadLifecycleColumn,normalizeLeadServiceCode}from"./lead-lifecycle-governance";

type Db=D1Database;
type Row=Record<string,unknown>;

const leadWorkItemsEnsured=new WeakSet<Db>();
export async function ensureLeadWorkItemsTable(db:Db){
  if(leadWorkItemsEnsured.has(db))return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_work_items_customer ON lead_work_items(customer_id,status,assigned_at)"),
  ]);
  const columns=await db.prepare("PRAGMA table_info(lead_work_items)").all<Row>().catch(()=>({results:[] as Row[]}));
  if(columns.results.length&&!columns.results.some(column=>String(column.name)==="initiated_booking_id")){
    await db.prepare("ALTER TABLE lead_work_items ADD COLUMN initiated_booking_id TEXT").run().catch(async error=>{
      const after=await db.prepare("PRAGMA table_info(lead_work_items)").all<Row>();
      if(!after.results.some(column=>String(column.name)==="initiated_booking_id"))throw error;
    });
  }
  await ensureLeadLifecycleColumn(db);
  await db.prepare("CREATE TABLE IF NOT EXISTS booking_attribution (booking_id TEXT PRIMARY KEY,customer_id TEXT NOT NULL,service_code TEXT NOT NULL,attribution_type TEXT NOT NULL,lead_id TEXT,source TEXT NOT NULL DEFAULT 'system',detail_json TEXT NOT NULL DEFAULT '{}',recorded_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_booking_attribution_type ON booking_attribution(attribution_type,recorded_at)").run().catch(()=>{});
  leadWorkItemsEnsured.add(db);
}

export type BookingAttributionType="lead"|"direct_booking";

async function recordAttribution(db:Db,input:{bookingId:string;customerId:string;serviceCode:string;type:BookingAttributionType;leadId?:string|null;detail?:unknown}){
  await db.prepare("INSERT OR IGNORE INTO booking_attribution (booking_id,customer_id,service_code,attribution_type,lead_id,source,detail_json,recorded_at) VALUES (?,?,?,?,?,?,?,?)")
    .bind(input.bookingId,input.customerId,input.serviceCode,input.type,input.leadId??null,input.type==="lead"?"lead_work_item":"system_direct_booking",JSON.stringify(input.detail??{}),Date.now()).run();
}

export async function bookingAttributionSummary(db:Db,input:{from?:number;to?:number}={}){
  await ensureLeadWorkItemsTable(db);
  const rows=await db.prepare("SELECT attribution_type,COUNT(*) n FROM booking_attribution WHERE recorded_at>=? AND recorded_at<=? GROUP BY attribution_type")
    .bind(input.from??0,input.to??Number.MAX_SAFE_INTEGER).all<Row>();
  const summary:Record<string,number>={lead:0,direct_booking:0};
  for(const row of rows.results)summary[String(row.attribution_type)]=Number(row.n||0);
  return summary;
}

export async function attributeBookingToOpenLead(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string|null;converted:boolean;attribution:BookingAttributionType}>{
  await ensureLeadWorkItemsTable(db);
  const booked=await db.prepare("SELECT service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);
  const bookedService=normalizeLeadServiceCode(booked?.service_code);
  const candidates=bookedService?await db.prepare(
    "SELECT id,service FROM lead_work_items WHERE customer_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') AND lifecycle_state NOT IN ('converted','dropped') ORDER BY assigned_at DESC LIMIT 100"
  ).bind(input.customerId).all<Row>().catch(()=>({results:[] as Row[]})):{results:[] as Row[]};
  const openLead=candidates.results.find(row=>normalizeLeadServiceCode(row.service)===bookedService)||null;
  if(!openLead){
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"direct_booking",
      detail:{reason:bookedService?"no_open_lead_for_this_service":"booking_service_unknown"}});
    return{leadId:null,converted:false,attribution:"direct_booking"};
  }
  const leadId=String(openLead.id),now=Date.now();
  const payment=await db.prepare("SELECT status FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>().catch(()=>null);
  const captured=String(payment?.status||"")==="captured";
  await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:bookedService,type:"lead",leadId,detail:{matchedOn:"customer_and_normalized_service"}});
  if(captured){
    await db.prepare("UPDATE lead_work_items SET converted_booking_id=?,status='converted',lifecycle_state='converted',updated_at=? WHERE id=? AND converted_booking_id IS NULL AND lifecycle_state!='dropped'").bind(input.bookingId,now,leadId).run();
    return{leadId,converted:true,attribution:"lead"};
  }
  await db.prepare("UPDATE lead_work_items SET last_outcome='booking_initiated',initiated_booking_id=?,lifecycle_state=CASE WHEN lifecycle_state IN ('new','contacted') THEN 'qualified' ELSE lifecycle_state END,next_action_at=?,updated_at=? WHERE id=? AND converted_booking_id IS NULL AND lifecycle_state NOT IN ('converted','dropped')").bind(input.bookingId,now,now,leadId).run();
  return{leadId,converted:false,attribution:"lead"};
}

export async function convertLeadOnPaymentCaptured(db:Db,input:{customerId:string;bookingId:string}):Promise<{leadId:string}|null>{
  await ensureLeadWorkItemsTable(db);
  const openLead=await db.prepare(
    "SELECT id FROM lead_work_items WHERE customer_id=? AND initiated_booking_id=? AND converted_booking_id IS NULL AND status NOT IN ('closed','converted') AND lifecycle_state NOT IN ('converted','dropped') ORDER BY assigned_at DESC LIMIT 1"
  ).bind(input.customerId,input.bookingId).first<Row>().catch(()=>null);
  if(!openLead){
    const booked=await db.prepare("SELECT service_code FROM canonical_bookings WHERE id=?").bind(input.bookingId).first<Row>().catch(()=>null);
    await recordAttribution(db,{bookingId:input.bookingId,customerId:input.customerId,serviceCode:normalizeLeadServiceCode(booked?.service_code),
      type:"direct_booking",detail:{reason:"no_lead_linked_at_booking_creation"}});
    return null;
  }
  const leadId=String(openLead.id),now=Date.now();
  const changed=await db.prepare("UPDATE lead_work_items SET converted_booking_id=?,status='converted',lifecycle_state='converted',updated_at=? WHERE id=? AND converted_booking_id IS NULL AND lifecycle_state NOT IN ('converted','dropped')").bind(input.bookingId,now,leadId).run();
  if(Number(changed.meta?.changes||0)!==1)return null;
  return{leadId};
}
