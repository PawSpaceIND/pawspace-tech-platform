import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";
import{maskName,maskPhone}from"../../../lib/platform-security";
import{customerDataAccessResolver}from"../../../lib/purpose-based-access";
import{assignLeadOwner}from"../../../lib/lead-owner-identity";
import{startWhatsAppAiLead}from"../../../lib/whatsapp-ai-lead-orchestration";
import{ensureLeadLifecycleColumn,normalizeLeadServiceCode}from"../../../lib/lead-lifecycle-governance";

async function getDatabase(){const { env } = await import("cloudflare:workers");return env.DB;}

async function ensureTables(){
  const db=await getDatabase();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_activities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_tasks (id TEXT PRIMARY KEY, contact_id TEXT, title TEXT NOT NULL, owner TEXT NOT NULL, due_at INTEGER, priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Open', created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger_name TEXT NOT NULL, action_name TEXT NOT NULL, enabled INTEGER DEFAULT 1, runs INTEGER DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
  await ensureLeadLifecycleColumn(db);
}

export async function GET(request:Request){try{
  const crmActor=await authorize(request,"customers.view"); await ensureTables();
  const db=await getDatabase();
  const result=await db.prepare("SELECT * FROM crm_contacts ORDER BY updated_at DESC LIMIT 100").all<Record<string,unknown>>();
  const contacts=result.results;
  if(contacts.length){
    const ids=contacts.map(row=>String(row.id));const totals=new Map<string,number>();const read=new Set<string>();
    for(let index=0;index<ids.length;index+=50){const slice=ids.slice(index,index+50);const rows=await db.prepare(`SELECT customer_id,COALESCE(SUM(total_amount),0) total FROM canonical_bookings WHERE status NOT IN ('cancelled','draft') AND customer_id IN (${slice.map(()=>"?").join(",")}) GROUP BY customer_id`).bind(...slice).all<Record<string,unknown>>().catch(()=>null);if(!rows)continue;for(const id of slice)read.add(id);for(const row of rows.results)totals.set(String(row.customer_id),Number(row.total||0));}
    for(const contact of contacts){const known=read.has(String(contact.id)),booked=totals.get(String(contact.id))??0;contact.lifetime_value=known?booked:null;contact.lifetime_value_basis=!known?"unavailable":booked>0?"recognized_bookings":"no_recognized_bookings";}
  }
  const access=await customerDataAccessResolver(db);const crmSubject={email:crmActor.email,roleCode:crmActor.roleCode,permissions:crmActor.permissions};
  const served=contacts.map(row=>{const record=row as Record<string,unknown>;const view=access.view({actor:crmSubject,purpose:"sales",subject:{customerId:String(record.id),name:String(record.name||""),phone:String(record.primary_phone||""),email:record.email?String(record.email):null,address:{area:record.area?String(record.area):null}},assignment:{type:"lead",id:String(record.id),assignedTo:record.owner?String(record.owner):null,status:String(record.stage||"")}});return{...record,name:maskName(String(record.name||"")),primary_phone:view.contact.phone,secondary_phone:record.secondary_phone?maskPhone(String(record.secondary_phone)):null,email:view.contact.email,revealed:view.revealed};});
  return Response.json({contacts:served,policyVersion:access.policyVersion});
}catch(error){return authError(error,"Unable to load CRM");}}

export async function POST(request:Request){
  try{
    const actor=await authorize(request,"customers.manage");await ensureTables();const body=await request.json() as Record<string,unknown>;const now=Date.now();const id=`CU-${crypto.randomUUID().slice(0,12).toUpperCase()}`;const db=await database();
    const source=String(body.source||"manual_crm"),service=normalizeLeadServiceCode(body.service||body.opportunity||"general_inquiry")||"general_inquiry";
    const ownership=await assignLeadOwner(db,{customerId:id,service,preferred:String(body.owner||"")});const assignedOwner=ownership.owner,leadId=`LEAD-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
    await db.batch([
      db.prepare("INSERT INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").bind(id,String(body.cityId||"blr"),String(body.name||"New customer"),String(body.primaryPhone||""),body.secondaryPhone?String(body.secondaryPhone):null,body.email?String(body.email):null,source,JSON.stringify({whatsapp:body.whatsappConsent===true,source:String(body.whatsappConsentSource||"manual_crm")}),now,now),
      db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,String(body.name||"New customer"),String(body.primaryPhone||""),body.secondaryPhone?String(body.secondaryPhone):null,body.email?String(body.email):null,String(body.area||"Bangalore"),String(body.petNames||"Pet"),String(body.petSummary||"Profile incomplete"),String(body.stage||"New lead"),assignedOwner,source,0,String(body.nextAction||"Call within 10 minutes"),String(body.opportunity||body.service||"Discover requirement"),now,now),
      db.prepare("INSERT INTO crm_activities (id,contact_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)").bind(`ACT-${crypto.randomUUID().slice(0,12).toUpperCase()}`,id,"lead_created","Lead created",`Source: ${source}`,now),
      db.prepare("INSERT INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`TASK-${crypto.randomUUID().slice(0,12).toUpperCase()}`,id,"First response to new lead",assignedOwner,now+10*60*1000,"High","Open",now),
      db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,lifecycle_state,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','new','day_1',1,?,?,?,?,?,?,0,0,?,?)").bind(leadId,id,source,service,assignedOwner,"Sales Manager",now,now+10*60000,now+30*60000,0,0,now+10*60000,now,now),
    ]);
    await securityAudit(db,actor,"create","crm_contact",id,"completed",{source,service,leadId,assignedOwner,firstResponseMinutes:10,managerAlertMinutes:30,canonicalCustomerCreated:true,lifecycleState:"new"});
    let whatsappAi:Record<string,unknown>;try{whatsappAi=await startWhatsAppAiLead(db,{leadId,contactId:id,idempotencyKey:`lead-created:${leadId}`,consentGranted:body.whatsappConsent===true,consentSource:String(body.whatsappConsentSource||"manual_crm"),consentEvidenceRef:String(body.whatsappConsentEvidence||""),actorId:actor.email,assignedTo:assignedOwner,cityId:String(body.cityId||"blr")});}catch(error){whatsappAi={status:"failed",reason:"internal_automation_error",externalDelivery:false,marketing:false};await securityAudit(db,actor,"whatsapp_ai.lead_trigger","lead",leadId,"rejected",{reason:error instanceof Error?error.message:"unknown"});}
    return Response.json({ok:true,id,leadId,lifecycleState:"new",assignedOwner,ownerResolved:ownership.resolved,ownerMappingException:ownership.resolved?null:ownership.reason,whatsappAi},{status:201});
  }catch(error){return authError(error,"Unable to create CRM contact");}
}
