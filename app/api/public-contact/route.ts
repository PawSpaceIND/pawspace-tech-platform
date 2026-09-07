import{authError}from"../../../lib/server-auth";
import{governedJsonError}from"../../../lib/governed-http-error";
import{assignLeadOwner}from"../../../lib/lead-owner-identity";
import{startWhatsAppAiLead}from"../../../lib/whatsapp-ai-lead-orchestration";
import{ensureLeadIntakeAdAttribution,normalizeLeadAdAttribution,recordLeadIntakeAdAttribution}from"../../../lib/lead-intake-ad-attribution";
// Public, unauthenticated lead-capture endpoint for the marketing site's contact form.
// This intentionally does NOT reuse the staff-only /api/crm route directly - that route
// requires "customers.manage" and exposes broader staff capability. This route is create-only.
async function getDatabase(){
  const{env}=await import("cloudflare:workers");
  return env.DB;
}

const crmAttributionColumns:[string,string][]=[
 ["gclid","TEXT"],["fbclid","TEXT"],["wbraid","TEXT"],["utm_source","TEXT"],["utm_medium","TEXT"],["utm_campaign","TEXT"],["campaign_id","TEXT"],["ad_id","TEXT"],
];
async function ensureCrmAttributionColumns(db:D1Database){
 const info=await db.prepare("PRAGMA table_info(crm_contacts)").all<Record<string,unknown>>();const existing=new Set(info.results.map(row=>String(row.name||"")));
 for(const[column,type]of crmAttributionColumns)if(!existing.has(column))await db.prepare(`ALTER TABLE crm_contacts ADD COLUMN ${column} ${type}`).run();
}
async function ensureTables(db:D1Database){
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS crm_contacts (id TEXT PRIMARY KEY, name TEXT NOT NULL, primary_phone TEXT NOT NULL, secondary_phone TEXT, email TEXT, area TEXT, pet_names TEXT, pet_summary TEXT, stage TEXT NOT NULL DEFAULT 'New lead', owner TEXT DEFAULT 'Unassigned', source TEXT DEFAULT 'Website', lifetime_value REAL DEFAULT 0, next_action TEXT, opportunity TEXT, gclid TEXT, fbclid TEXT, wbraid TEXT, utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, campaign_id TEXT, ad_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_activities (id TEXT PRIMARY KEY, contact_id TEXT NOT NULL, type TEXT NOT NULL, title TEXT NOT NULL, detail TEXT, created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS crm_tasks (id TEXT PRIMARY KEY, contact_id TEXT, title TEXT NOT NULL, owner TEXT NOT NULL, due_at INTEGER, priority TEXT DEFAULT 'Normal', status TEXT DEFAULT 'Open', created_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS lead_work_items (id TEXT PRIMARY KEY, customer_id TEXT NOT NULL, source TEXT NOT NULL, service TEXT NOT NULL, owner TEXT NOT NULL, manager TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active', stage TEXT NOT NULL DEFAULT 'day_1', work_day INTEGER NOT NULL DEFAULT 1, assigned_at INTEGER NOT NULL, first_action_due_at INTEGER NOT NULL, manager_alert_at INTEGER NOT NULL, first_action_at INTEGER, call_attempts INTEGER NOT NULL DEFAULT 0, whatsapp_attempts INTEGER NOT NULL DEFAULT 0, last_outcome TEXT, next_action_at INTEGER, recycle_at INTEGER, recycle_cycle INTEGER NOT NULL DEFAULT 0, opt_out INTEGER NOT NULL DEFAULT 0, converted_booking_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS public_contact_rate_limits (fingerprint TEXT PRIMARY KEY, window_started_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL)"),
  ]);
  await Promise.all([ensureCrmAttributionColumns(db),ensureLeadIntakeAdAttribution(db)]);
}

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
const RATE_WINDOW_MS=10*60*1000;
const RATE_LIMIT=5;
function clean(value:unknown,max:number){return String(value??"").replace(/[\u0000-\u001F\u007F]/g," ").replace(/\s+/g," ").trim().slice(0,max);}
async function fingerprintFor(request:Request){
  const ip=clean(request.headers.get("cf-connecting-ip"),80);
  if(!ip)throw governedJsonError({error:"Request origin could not be verified"},429);
  const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest)).map(value=>value.toString(16).padStart(2,"0")).join("");
}
async function enforceAbuseGate(db:D1Database,request:Request,now:number){
  const fingerprint=await fingerprintFor(request),cutoff=now-RATE_WINDOW_MS;
  await db.prepare("INSERT OR IGNORE INTO public_contact_rate_limits (fingerprint,window_started_at,attempts,updated_at) VALUES (?,?,0,?)").bind(fingerprint,now,now).run();
  await db.prepare("UPDATE public_contact_rate_limits SET attempts=CASE WHEN window_started_at<? THEN 1 ELSE attempts+1 END,window_started_at=CASE WHEN window_started_at<? THEN ? ELSE window_started_at END,updated_at=? WHERE fingerprint=?").bind(cutoff,cutoff,now,now,fingerprint).run();
  const state=await db.prepare("SELECT attempts FROM public_contact_rate_limits WHERE fingerprint=?").bind(fingerprint).first<{attempts:number}>();
  if(!state||Number(state.attempts)>RATE_LIMIT)throw governedJsonError({error:"Too many contact requests. Please try again later."},429);
}

export async function POST(request:Request){
  try{
    const db=await getDatabase();
    await ensureTables(db);
    const now=Date.now();
    await enforceAbuseGate(db,request,now);
    const body=await request.json() as Record<string,unknown>;
    const name=clean(body.name,80),phone=clean(body.phone,20),email=clean(body.email,160),area=clean(body.area||"Bangalore",80),petNames=clean(body.petNames||"Not shared",160),service=clean(body.service||"General enquiry",120),message=clean(body.message||"No message left",500);
    if(name.length<2)return json({error:"Please enter your name"},400);
    const phoneDigits=phone.replace(/\D/g,"");
    if(phoneDigits.length<10||phoneDigits.length>15||!/^[0-9+\s-]+$/.test(phone))return json({error:"Please enter a valid phone number"},400);
    if(email&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))return json({error:"Please enter a valid email address"},400);
    const attribution=normalizeLeadAdAttribution({gclid:clean(body.gclid,180),fbclid:clean(body.fbclid,180),wbraid:clean(body.wbraid,180),utmSource:clean(body.utmSource,120),utmMedium:clean(body.utmMedium,120),utmCampaign:clean(body.utmCampaign,180),campaignId:clean(body.campaignId,180),adId:clean(body.adId,180),landingUrl:clean(body.landingUrl,500)});
    const id=`CU-${crypto.randomUUID()}`,activityId=`ACT-${crypto.randomUUID()}`,taskId=`TASK-${crypto.randomUUID()}`,leadId=`LEAD-${crypto.randomUUID()}`;
    const ownership=await assignLeadOwner(db,{customerId:id,service});
    const assignedOwner=ownership.owner,source=attribution.hasAttribution?`Website contact form / ${attribution.sourcePlatform}`:"Website contact form";
    const activityDetail=JSON.stringify({serviceInterest:service,adAttribution:attribution.hasAttribution?{gclid:attribution.gclid,fbclid:attribution.fbclid,wbraid:attribution.wbraid,utmSource:attribution.utmSource,utmMedium:attribution.utmMedium,utmCampaign:attribution.utmCampaign,campaignId:attribution.campaignId,adId:attribution.adId}:null});
    const statements:D1PreparedStatement[]=[
      db.prepare("INSERT INTO crm_contacts (id,name,primary_phone,secondary_phone,email,area,pet_names,pet_summary,stage,owner,source,lifetime_value,next_action,opportunity,gclid,fbclid,wbraid,utm_source,utm_medium,utm_campaign,campaign_id,ad_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(id,name,phone,null,email||null,area,petNames,message,"New lead",assignedOwner,source,0,"Call within 10 minutes",service,attribution.gclid,attribution.fbclid,attribution.wbraid,attribution.utmSource,attribution.utmMedium,attribution.utmCampaign,attribution.campaignId,attribution.adId,now,now),
      db.prepare("INSERT INTO crm_activities (id,contact_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)").bind(activityId,id,"lead_created","Contact form submission",activityDetail,now),
      db.prepare("INSERT INTO crm_tasks (id,contact_id,title,owner,due_at,priority,status,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(taskId,id,"First response to new website lead",assignedOwner,now+10*60*1000,"High","Open",now),
      db.prepare("INSERT INTO lead_work_items (id,customer_id,source,service,owner,manager,status,stage,work_day,assigned_at,first_action_due_at,manager_alert_at,call_attempts,whatsapp_attempts,next_action_at,recycle_cycle,opt_out,created_at,updated_at) VALUES (?,?,?,?,?,?,'active','day_1',1,?,?,?,0,0,?,0,0,?,?)").bind(leadId,id,source,service,assignedOwner,"Sales Manager",now,now+10*60000,now+30*60000,now+10*60000,now,now),
    ];
    if(attribution.hasAttribution)statements.push(db.prepare("INSERT INTO lead_intake_ad_attribution (id,contact_id,lead_id,source_platform,gclid,fbclid,wbraid,click_id,utm_source,utm_medium,utm_campaign,campaign_id,ad_id,landing_url,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(`ATTR-${crypto.randomUUID().slice(0,12).toUpperCase()}`,id,leadId,attribution.sourcePlatform,attribution.gclid,attribution.fbclid,attribution.wbraid,attribution.clickId,attribution.utmSource,attribution.utmMedium,attribution.utmCampaign,attribution.campaignId,attribution.adId,attribution.landingUrl,JSON.stringify({capturedAtIntake:true}),now,now));
    await db.batch(statements);
    let whatsappAi:Record<string,unknown>;try{whatsappAi=await startWhatsAppAiLead(db,{leadId,contactId:id,idempotencyKey:`lead-created:${leadId}`,consentGranted:body.whatsappConsent===true,consentSource:"website_contact_checkbox",consentEvidenceRef:body.whatsappConsent===true?"public-contact-whatsapp-consent-v1":"",actorId:"public-contact",assignedTo:assignedOwner,cityId:"blr"});}catch{whatsappAi={status:"failed",reason:"internal_automation_error",externalDelivery:false,marketing:false};}
    if(attribution.hasAttribution){try{await recordLeadIntakeAdAttribution(db,{contactId:id,leadId,threadId:clean(whatsappAi.thread_id,120)||null,gclid:attribution.gclid,fbclid:attribution.fbclid,wbraid:attribution.wbraid,utmSource:attribution.utmSource,utmMedium:attribution.utmMedium,utmCampaign:attribution.utmCampaign,campaignId:attribution.campaignId,adId:attribution.adId,landingUrl:attribution.landingUrl,now});}catch(error){await db.prepare("INSERT INTO crm_activities (id,contact_id,type,title,detail,created_at) VALUES (?,?,?,?,?,?)").bind(`ACT-${crypto.randomUUID()}`,id,"attribution_mirror_failed","Ad attribution downstream mirror failed",clean(error instanceof Error?error.message:String(error),400),Date.now()).run().catch(()=>{});}}
    return json({ok:true,leadId,attributionBound:attribution.hasAttribution,whatsappAi:{status:whatsappAi.status,reason:whatsappAi.reason}},201);
  }catch(error){
    return authError(error,"Unable to submit your enquiry - please try again");
  }
}
