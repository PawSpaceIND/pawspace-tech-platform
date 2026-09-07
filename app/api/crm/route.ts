import { authError, authorize, database, securityAudit } from "../../../lib/server-auth";
import{maskName,maskPhone}from"../../../lib/platform-security";
import{customerDataAccessResolver}from"../../../lib/purpose-based-access";
import{assignLeadOwner}from"../../../lib/lead-owner-identity";
import{startWhatsAppAiLead}from"../../../lib/whatsapp-ai-lead-orchestration";
import{ensureLeadIntakeAdAttribution,normalizeLeadAdAttribution,recordLeadIntakeAdAttribution}from"../../../lib/lead-intake-ad-attribution";
import{CRM_MANAGER_DOMAIN,requireManagerDomain,resolveManagerOrganizationalScope}from"../../../lib/organizational-scope";

async function getDatabase(){
  const { env } = await import("cloudflare:workers");
  return env.DB;
}

const crmExtendedColumns:[string,string][]=[
 ["city_id","TEXT"],["team_code","TEXT"],["department_code","TEXT"],
 ["gclid","TEXT"],["fbclid","TEXT"],["wbraid","TEXT"],["gbraid","TEXT"],["utm_source","TEXT"],["utm_medium","TEXT"],["utm_campaign","TEXT"],["utm_content","TEXT"],["utm_term","TEXT"],["campaign_id","TEXT"],["ad_id","TEXT"],
];
async function ensureExtendedColumns(db:D1Database){const info=await db.prepare("PRAGMA table_info(crm_contacts)").all<Record<string,unknown>>();const existing=new Set(info.results.map(row=>String(row.name||"")));for(const[column,type]of crmExtendedColumns)if(!existing.has(column))await db.prepare(`ALTER TABLE crm_contacts ADD COLUMN ${column} ${type}`).run();}
async function ensureTables(){
  const db=await getDatabase();
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_activities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_tasks (id TEXT PRIMARY KEY, contact_id TEXT, title TEXT NOT NULL, owner TEXT NOT NULL, due_at INTEGER, priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Open', created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_automations (id TEXT PRIMARY KEY, name TEXT NOT NULL, trigger_name TEXT NOT NULL, action_name TEXT NOT NULL, enabled INTEGER DEFAULT 1, runs INTEGER DEFAULT 0, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
  ]);
  await Promise.all([ensureExtendedColumns(db),ensureLeadIntakeAdAttribution(db)]);
}

const clean=(value:unknown,max:number)=>String(value??"").replace(/[\u0000-\u001F\u007F]/g," ").replace(/\s+/g," ").trim().slice(0,max);
const normaliseOrg=(value:unknown,fallback:string)=>clean(value,80).toLowerCase().replace(/_/g,"-")||fallback;

export async function GET(request:Request){try{
  const crmActor=await authorize(request,"customers.view"); await ensureTables();
  const db=await getDatabase();
  const scope=await resolveManagerOrganizationalScope(db,crmActor);requireManagerDomain(scope,CRM_MANAGER_DOMAIN);
  const result=scope
    ?await db.prepare("SELECT * FROM crm_contacts WHERE lower(COALESCE(city_id,''))=? AND lower(COALESCE(team_code,''))=? AND lower(COALESCE(department_code,''))=? ORDER BY updated_at DESC LIMIT 100").bind(scope.cityId,scope.teamCode,scope.departmentCode).all<Record<string,unknown>>()
    :await db.prepare("SELECT * FROM crm_contacts ORDER BY updated_at DESC LIMIT 100").all<Record<string,unknown>>();
  const contacts=result.results;
  if(contacts.length){
    const ids=contacts.map(row=>String(row.id));
    const totals=new Map<string,number>();
    const read=new Set<string>();
    for(let index=0;index<ids.length;index+=50){
      const slice=ids.slice(index,index+50);
      const rows=await db.prepare(`SELECT customer_id,COALESCE(SUM(total_amount),0) total FROM canonical_bookings WHERE status NOT IN ('cancelled','draft') AND customer_id IN (${slice.map(()=>"?").join(",")}) GROUP BY customer_id`)
        .bind(...slice).all<Record<string,unknown>>().catch(()=>null);
      if(!rows)continue;
      for(const id of slice)read.add(id);
      for(const row of rows.results)totals.set(String(row.customer_id),Number(row.total||0));
    }
    for(const contact of contacts){
      const known=read.has(String(contact.id));
      const booked=totals.get(String(contact.id))??0;
      contact.lifetime_value=known?booked:null;
      contact.lifetime_value_basis=!known?"unavailable":booked>0?"recognized_bookings":"no_recognized_bookings";
    }
  }
  const access=await customerDataAccessResolver(db);
  const crmSubject={email:crmActor.email,roleCode:crmActor.roleCode,permissions:crmActor.permissions};
  const served=contacts.map(row=>{
    const record=row as Record<string,unknown>;
    const view=access.view({actor:crmSubject,purpose:"sales",
      subject:{customerId:String(record.id),name:String(record.name||""),phone:String(record.primary_phone||""),email:record.email?String(record.email):null,address:{area:record.area?String(record.area):null}},
      assignment:{type:"lead",id:String(record.id),assignedTo:record.owner?String(record.owner):null,status:String(record.stage||"")}});
    return{...record,name:maskName(String(record.name||"")),primary_phone:view.contact.phone,secondary_phone:record.secondary_phone?maskPhone(String(record.secondary_phone)):null,email:view.contact.email,revealed:view.revealed};
  });
  return Response.json({contacts:served,policyVersion:access.policyVersion,organizationalScope:scope??"global"});
}catch(error){return authError(error,"Unable to load CRM");}}

export async function POST(request:Request){
  try{const actor=await authorize(request,"customers.manage"); await ensureTables(); const body=await request.json() as Record<string,unknown>; const now=Date.now(); const id=`CU-${Math.floor(10000+Math.random()*89999)}`;
  const db=await database();const scope=await resolveManagerOrganizationalScope(db,actor);requireManagerDomain(scope,CRM_MANAGER_DOMAIN);
  const cityId=scope?.cityId??normaliseOrg(body.cityId,"blr"),teamCode=scope?.teamCode??normaliseOrg(body.teamCode,"sales"),departmentCode=scope?.departmentCode??normaliseOrg(body.departmentCode,"cc-sales");
  const ownership=await assignLeadOwner(db,{customerId:id,service:String(body.service||body.opportunity||""),preferred:String(body.owner||"")});
  const assignedOwner=ownership.owner;
  const leadId=`LEAD-${now}`;
  const nested=body.attribution&&typeof body.attribution==="object"&&!Array.isArray(body.attribution)?body.attribution as Record<string,unknown>:{};
  const value=(camel:string,snake:string)=>body[camel]??body[snake]??nested[snake]??nested[camel];
  const attribution=normalizeLeadAdAttribution({gclid:clean(value("gclid","gclid"),180),fbclid:clean(value("fbclid","fbclid"),180),wbraid:clean(value("wbraid","wbraid"),180),gbraid:clean(value("gbraid","gbraid"),180),utmSource:clean(value("utmSource","utm_source"),120),utmMedium:clean(value("utmMedium","utm_medium"),120),utmCampaign:clean(value("utmCampaign","utm_campaign"),180),utmContent:clean(value("utmContent","utm_content"),180),utmTerm:clean(value("utmTerm","utm_term"),180),campaignId:clean(value("campaignId","campaign_id"),180),adId:clean(value("adId","ad_id"),180),landingUrl:clean(value("landingUrl","landing_url"),500)});
  await db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,city_id,team_code,department_code,gclid,fbclid,wbraid,gbraid,utm_source,utm_medium,utm_campaign,utm_content,utm_term,campaign_id,ad_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,String(body.name||"New customer"),String(body.primaryPhone||""),body.secondaryPhone?String(body.secondaryPhone):null,body.email?String(body.email):null,String(body.area||"Bangalore"),String(body.petNames||"Pet"),String(body.petSummary||"Profile incomplete"),String(body.stage||"New lead"),assignedOwner,String(body.source||"Staff CRM"),0,String(body.nextAction||"Call within 10 minutes"),String(body.opportunity||body.service||"Discover requirement"),cityId,teamCode,departmentCode,attribution.gclid,attribution.fbclid,attribution.wbraid,attribution.gbraid,attribution.utmSource,attribution.utmMedium,attribution.utmCampaign,attribution.utmContent,attribution.utmTerm,attribution.campaignId,attribution.adId,now,now).run();
  await db.prepare("INSERT INTO crm_activities (id,contact_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)").bind(`ACT-${now}`,id,"lead_created","Lead created",JSON.stringify({source:String(body.source||"Staff CRM"),attributionBound:attribution.hasAttribution,organizationalScope:{cityId,teamCode,departmentCode}}),now).run();
  await db.batch([
    db.prepare("INSERT INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(`TASK-${now}`,id,"First response to new lead",assignedOwner,now+10*60*1000,"High","Open",now),
    db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,?,?, ?,0,0,?,?)").bind(leadId,id,String(body.source||"Staff CRM"),String(body.service||"Discover requirement"),assignedOwner,"Sales Manager",now,now+10*60000,now+30*60000,0,0,now+10*60000,now,now),
  ]);
  await securityAudit(db,actor,"create","crm_contact",id,"completed",{source:body.source||"Staff CRM",assignedOwner,firstResponseMinutes:10,managerAlertMinutes:30,cityId,teamCode,departmentCode,attributionBound:attribution.hasAttribution});
  let whatsappAi:Record<string,unknown>;try{whatsappAi=await startWhatsAppAiLead(db,{leadId,contactId:id,idempotencyKey:`lead-created:${leadId}`,consentGranted:body.whatsappConsent===true,consentSource:String(body.whatsappConsentSource||"manual_crm"),consentEvidenceRef:String(body.whatsappConsentEvidence||""),actorId:actor.email,assignedTo:assignedOwner,cityId});}catch(error){whatsappAi={status:"failed",reason:"internal_automation_error",externalDelivery:false,marketing:false};await securityAudit(db,actor,"whatsapp_ai.lead_trigger","lead",leadId,"rejected",{reason:error instanceof Error?error.message:"unknown"});}
  if(attribution.hasAttribution)await recordLeadIntakeAdAttribution(db,{contactId:id,leadId,threadId:clean(whatsappAi.thread_id,120)||null,origin:"staff_crm",gclid:attribution.gclid,fbclid:attribution.fbclid,wbraid:attribution.wbraid,gbraid:attribution.gbraid,utmSource:attribution.utmSource,utmMedium:attribution.utmMedium,utmCampaign:attribution.utmCampaign,utmContent:attribution.utmContent,utmTerm:attribution.utmTerm,campaignId:attribution.campaignId,adId:attribution.adId,landingUrl:attribution.landingUrl,now});
  return Response.json({ok:true,id,leadId,assignedOwner,ownerResolved:ownership.resolved,ownerMappingException:ownership.resolved?null:ownership.reason,attributionBound:attribution.hasAttribution,organizationalScope:{cityId,teamCode,departmentCode},whatsappAi},{status:201});}catch(error){return authError(error,"Unable to create CRM contact");}
}
