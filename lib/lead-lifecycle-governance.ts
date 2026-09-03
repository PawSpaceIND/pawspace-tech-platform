type Db=D1Database;
type Row=Record<string,unknown>;

export type LeadLifecycleState="new"|"contacted"|"qualified"|"converted"|"dropped";
export const LEAD_LIFECYCLE_TRANSITIONS:Record<LeadLifecycleState,LeadLifecycleState[]>={
  new:["contacted","qualified","dropped"],
  contacted:["qualified","dropped"],
  qualified:["converted","dropped"],
  converted:[],
  dropped:[],
};

const text=(value:unknown)=>String(value??"").trim();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const ensured=new WeakSet<Db>();

export function normalizeLeadServiceCode(value:unknown){
  const raw=text(value).toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"");
  const aliases:Record<string,string>={
    grooming:"grooming",pet_grooming:"grooming",dog_grooming:"grooming",doorstep_grooming:"grooming",
    training:"training",dog_training:"training",pet_training:"training",puppy_training:"training",
    boarding:"boarding",pet_boarding:"boarding",home_boarding:"boarding",dog_boarding:"boarding",cat_boarding:"boarding",
    sitting:"pet_sitting",pet_sitting:"pet_sitting",home_pet_sitting:"pet_sitting",dog_sitting:"pet_sitting",cat_sitting:"pet_sitting",
    walking:"dog_walking",dog_walking:"dog_walking",pet_walking:"dog_walking",
    taxi:"pet_taxi",pet_taxi:"pet_taxi",pet_transport:"pet_taxi",pick_and_drop:"pet_taxi",pickup_and_drop:"pet_taxi",
    fresh_food:"fresh_food",food:"fresh_food",pet_food:"fresh_food",
    vet:"vet",veterinary:"vet",at_home_vet:"vet",home_vet:"vet",
    funeral:"funeral",cremation:"funeral",pet_funeral:"funeral",
    general:"general_inquiry",general_inquiry:"general_inquiry",whatsapp:"general_inquiry",
  };
  return aliases[raw]??raw;
}

export async function ensureLeadLifecycleColumn(db:Db){
  if(ensured.has(db))return;
  const columns=await db.prepare("PRAGMA table_info(lead_work_items)").all<Row>();
  if(!columns.results.some(column=>text(column.name)==="lifecycle_state")){
    await db.prepare("ALTER TABLE lead_work_items ADD COLUMN lifecycle_state TEXT NOT NULL DEFAULT 'new'").run().catch(async error=>{
      const after=await db.prepare("PRAGMA table_info(lead_work_items)").all<Row>();
      if(!after.results.some(column=>text(column.name)==="lifecycle_state"))throw error;
    });
  }
  await db.prepare("UPDATE lead_work_items SET lifecycle_state=CASE WHEN converted_booking_id IS NOT NULL OR status='converted' THEN 'converted' WHEN status='closed' THEN 'dropped' WHEN status='qualified' THEN 'qualified' WHEN first_action_at IS NOT NULL THEN 'contacted' ELSE 'new' END WHERE lifecycle_state IS NULL OR lifecycle_state='' OR (lifecycle_state='new' AND (converted_booking_id IS NOT NULL OR status IN ('converted','closed','qualified') OR first_action_at IS NOT NULL))").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_work_items_lifecycle ON lead_work_items(lifecycle_state,customer_id,assigned_at)").run().catch(()=>{});
  ensured.add(db);
}

export async function transitionLeadLifecycle(db:Db,input:{leadId:string;to:LeadLifecycleState;actorId:string;now?:number;detail?:Record<string,unknown>}){
  await ensureLeadLifecycleColumn(db);
  const row=await db.prepare("SELECT lifecycle_state,converted_booking_id FROM lead_work_items WHERE id=?").bind(input.leadId).first<Row>();
  if(!row)throw new Error("Lead not found");
  const from=(text(row.lifecycle_state)||"new") as LeadLifecycleState;
  if(from===input.to)return{leadId:input.leadId,from,to:input.to,duplicatePrevented:true};
  if(!LEAD_LIFECYCLE_TRANSITIONS[from]?.includes(input.to))throw new Error(`Lead cannot move from ${from} to ${input.to}`);
  if(input.to==="converted"&&!text(row.converted_booking_id))throw new Error("A lead cannot be converted without a converted booking");
  const now=input.now??Date.now();
  const status=input.to==="converted"?"converted":input.to==="dropped"?"closed":null;
  const result=status
    ?await db.prepare("UPDATE lead_work_items SET lifecycle_state=?,status=?,updated_at=? WHERE id=? AND lifecycle_state=?").bind(input.to,status,now,input.leadId,from).run()
    :await db.prepare("UPDATE lead_work_items SET lifecycle_state=?,updated_at=? WHERE id=? AND lifecycle_state=?").bind(input.to,now,input.leadId,from).run();
  if(Number(result.meta?.changes||0)!==1)throw new Error("Lead changed concurrently; reload before retrying");
  const auditTable=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='crm_engine_audit_events'").first<Row>().catch(()=>null);
  if(auditTable)await db.prepare("INSERT INTO crm_engine_audit_events (id,entity_type,entity_id,action,actor_email,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(uid("LEADAUD"),"lead",input.leadId,"lifecycle_transition",input.actorId,JSON.stringify({from,to:input.to,...(input.detail??{})}),now).run();
  return{leadId:input.leadId,from,to:input.to,duplicatePrevented:false};
}

export async function ensureInboundLead(db:Db,input:{customerId:string;source:string;service?:string|null;owner:string;manager?:string|null;now?:number}){
  await ensureLeadLifecycleColumn(db);
  const existing=await db.prepare("SELECT id,lifecycle_state FROM lead_work_items WHERE customer_id=? AND converted_booking_id IS NULL AND lifecycle_state NOT IN ('converted','dropped') ORDER BY assigned_at DESC LIMIT 1").bind(input.customerId).first<Row>();
  if(existing)return{leadId:text(existing.id),created:false,lifecycleState:text(existing.lifecycle_state)||"new"};
  const now=input.now??Date.now(),leadId=`LEAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`,service=normalizeLeadServiceCode(input.service||"general_inquiry")||"general_inquiry";
  await db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,lifecycle_state,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,first_action_at,call_attempts,whatsapp_attempts,last_outcome,next_action_at,recycle_at,recycle_cycle,opt_out,converted_booking_id,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','new','day_1',1,?,?,?,NULL,0,0,'inbound_received',?,NULL,0,0,NULL,?,?)")
    .bind(leadId,input.customerId,text(input.source)||"inbound",service,input.owner,text(input.manager)||"Sales Manager",now,now+10*60_000,now+30*60_000,now,now,now).run();
  return{leadId,created:true,lifecycleState:"new"};
}
