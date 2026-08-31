import{assignLeadOwner}from"./lead-owner-identity";
import{ensureLeadWorkItemsTable}from"./lead-conversion-attribution";
import{ensureInboundLead,normalizeLeadServiceCode}from"./lead-lifecycle-governance";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const phone=(v:unknown)=>text(v).replace(/\D/g,"").slice(-10);
const email=(v:unknown)=>text(v).toLowerCase();
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export type MetaLeadChange={leadgenId:string;pageId:string;formId:string;adId:string;createdAt:number};
export function parseMetaLeadAdsWebhook(payload:unknown):MetaLeadChange[]{
  if(!payload||typeof payload!=="object")return[];const root=payload as Row,entries=Array.isArray(root.entry)?root.entry:[],out:MetaLeadChange[]=[];
  for(const entry of entries){if(!entry||typeof entry!=="object")continue;const e=entry as Row,changes=Array.isArray(e.changes)?e.changes:[];for(const raw of changes){if(!raw||typeof raw!=="object")continue;const change=raw as Row;if(text(change.field)!=="leadgen")continue;const value=change.value&&typeof change.value==="object"?change.value as Row:{};const leadgenId=text(value.leadgen_id);if(!leadgenId)continue;out.push({leadgenId,pageId:text(value.page_id||e.id),formId:text(value.form_id),adId:text(value.ad_id),createdAt:Number(value.created_time||0)*1000||Date.now()});}}
  return out;
}

export async function ensureMetaLeadAdsTables(db:Db){await ensureLeadWorkItemsTable(db);await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS meta_lead_ads_events (leadgen_id TEXT PRIMARY KEY,page_id TEXT,form_id TEXT,ad_id TEXT,campaign_id TEXT,adset_id TEXT,customer_id TEXT,lead_id TEXT,status TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS meta_lead_ingestion_exceptions (id TEXT PRIMARY KEY,leadgen_id TEXT NOT NULL,reason TEXT NOT NULL,candidate_customer_ids_json TEXT NOT NULL DEFAULT '[]',detail_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'open',created_at INTEGER NOT NULL,resolved_at INTEGER,resolved_by TEXT)"),
 db.prepare("CREATE INDEX IF NOT EXISTS meta_lead_ingestion_exception_idx ON meta_lead_ingestion_exceptions(status,created_at)"),
]);}

function fields(data:Row){const values:Record<string,string>={};const list=Array.isArray(data.field_data)?data.field_data:[];for(const raw of list){if(!raw||typeof raw!=="object")continue;const item=raw as Row,key=text(item.name).toLowerCase(),arr=Array.isArray(item.values)?item.values:[];if(key&&arr.length)values[key]=text(arr[0]);}return values;}
function first(values:Record<string,string>,keys:string[]){for(const key of keys){if(text(values[key]))return text(values[key]);}return"";}

async function resolveOrCreateCustomer(db:Db,input:{leadgenId:string;profile:Row;cityId:string;now:number}){
  const f=fields(input.profile),p=phone(first(f,["phone_number","phone","mobile","mobile_number"])),e=email(first(f,["email","email_address"]));
  if(!p&&!e)throw new Error("Meta lead has no usable phone or email identity");
  const customers=await db.prepare("SELECT id,primary_phone,email FROM canonical_customers").all<Row>();
  const matches=customers.results.filter(row=>(p&&phone(row.primary_phone)===p)||(e&&email(row.email)===e));
  const unique=[...new Set(matches.map(row=>text(row.id)).filter(Boolean))];
  if(unique.length>1)return{customerId:null,ambiguous:unique,fields:f};
  if(unique.length===1)return{customerId:unique[0],ambiguous:[] as string[],fields:f};
  const customerId=`CU-META-${input.leadgenId.replace(/[^A-Za-z0-9]/g,"").slice(-18)||crypto.randomUUID().slice(0,12)}`;
  const name=first(f,["full_name","name"])||[first(f,["first_name"]),first(f,["last_name"])].filter(Boolean).join(" ")||"Meta lead";
  await db.prepare("INSERT OR IGNORE INTO canonical_customers (id,city_id,name,primary_phone,secondary_phone,email,source,consent_json,created_at,updated_at) VALUES (?,?,?,?,NULL,?,'meta_lead_ads','{}',?,?)")
    .bind(customerId,input.cityId,name,p||"not_provided",e||null,input.now,input.now).run();
  return{customerId,ambiguous:[] as string[],fields:f};
}

async function recordMarketingAttribution(db:Db,input:{leadId:string;customerId:string;profile:Row;now:number}){
  const table=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='marketing_attribution_facts'").first<Row>().catch(()=>null);if(!table)return;
  const campaign=text(input.profile.campaign_id),adset=text(input.profile.adset_id),ad=text(input.profile.ad_id),form=text(input.profile.form_id);
  if(!campaign)return;
  await db.prepare("INSERT OR IGNORE INTO marketing_attribution_facts (id,customer_id,lead_id,booking_id,campaign_id,source,medium,content,term,booked_revenue,collected_revenue,created_at) VALUES (?,?,?,NULL,?,'meta','lead_ads',?,?,0,0,?)")
    .bind(`ATTR-META-${input.leadId}`,input.customerId,input.leadId,campaign,ad||form,adset,input.now).run().catch(()=>{});
}

export async function ingestMetaLeadChange(db:Db,input:{change:MetaLeadChange;graphProfile:Row;defaultCityId:string;actorId?:string}){
  await ensureMetaLeadAdsTables(db);const now=input.change.createdAt||Date.now();
  const prior=await db.prepare("SELECT * FROM meta_lead_ads_events WHERE leadgen_id=?").bind(input.change.leadgenId).first<Row>();if(prior&&text(prior.status)==="ingested")return{leadgenId:input.change.leadgenId,customerId:text(prior.customer_id),leadId:text(prior.lead_id),duplicatePrevented:true};
  const profile:Row={...input.graphProfile,ad_id:text(input.graphProfile.ad_id||input.change.adId),form_id:text(input.graphProfile.form_id||input.change.formId)};
  const resolved=await resolveOrCreateCustomer(db,{leadgenId:input.change.leadgenId,profile,cityId:input.defaultCityId||"blr",now});
  if(!resolved.customerId){const exceptionId=uid("METALEAD-EX");await db.batch([
    db.prepare("INSERT OR IGNORE INTO meta_lead_ingestion_exceptions (id,leadgen_id,reason,candidate_customer_ids_json,detail_json,status,created_at) VALUES (?,?,?,? ,?,'open',?)").bind(exceptionId,input.change.leadgenId,"ambiguous_customer_identity",JSON.stringify(resolved.ambiguous),JSON.stringify(profile),now),
    db.prepare("INSERT OR REPLACE INTO meta_lead_ads_events (leadgen_id,page_id,form_id,ad_id,campaign_id,adset_id,customer_id,lead_id,status,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,NULL,NULL,'identity_review',?,?,?)").bind(input.change.leadgenId,input.change.pageId,input.change.formId,input.change.adId,text(profile.campaign_id)||null,text(profile.adset_id)||null,JSON.stringify({exceptionId}),now,now),
  ]);return{leadgenId:input.change.leadgenId,status:"identity_review",exceptionId,duplicatePrevented:false};}
  const service=normalizeLeadServiceCode(first(resolved.fields,["service","service_interest","interested_service","service_required","requirement"])||"general_inquiry")||"general_inquiry";
  const assignment=await assignLeadOwner(db,{customerId:resolved.customerId,service});
  const initialized=await ensureInboundLead(db,{customerId:resolved.customerId,source:"meta_lead_ads",service,owner:assignment.owner,manager:"Sales Manager",now});
  await db.prepare("INSERT OR REPLACE INTO meta_lead_ads_events (leadgen_id,page_id,form_id,ad_id,campaign_id,adset_id,customer_id,lead_id,status,detail_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?, 'ingested',?,?,?)")
    .bind(input.change.leadgenId,input.change.pageId,input.change.formId,input.change.adId,text(profile.campaign_id)||null,text(profile.adset_id)||null,resolved.customerId,initialized.leadId,JSON.stringify({service,owner:assignment.owner,ownerResolved:assignment.resolved}),now,Date.now()).run();
  await recordMarketingAttribution(db,{leadId:initialized.leadId,customerId:resolved.customerId,profile,now});
  return{leadgenId:input.change.leadgenId,customerId:resolved.customerId,leadId:initialized.leadId,lifecycleState:"new",service,owner:assignment.owner,leadCreated:initialized.created,duplicatePrevented:false};
}
