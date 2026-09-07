import{recordIntakeLeadAttribution,recordWhatsAppLeadAttribution}from"./whatsapp-conversion-feedback";

type Db=D1Database;type Row=Record<string,unknown>;
export type LeadAdAttributionInput={contactId:string;leadId:string;threadId?:string|null;gclid?:string|null;fbclid?:string|null;wbraid?:string|null;gbraid?:string|null;utmSource?:string|null;utmMedium?:string|null;utmCampaign?:string|null;utmContent?:string|null;utmTerm?:string|null;campaignId?:string|null;adId?:string|null;landingUrl?:string|null;now?:number};
const text=(value:unknown,max=255)=>String(value??"").replace(/[\u0000-\u001F\u007F]/g," ").trim().slice(0,max);
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const extendedColumns:[string,string][]=[["gbraid","TEXT"],["utm_content","TEXT"],["utm_term","TEXT"]];

export function normalizeLeadAdAttribution(input:Partial<LeadAdAttributionInput>){
 const gclid=text(input.gclid,180),fbclid=text(input.fbclid,180),wbraid=text(input.wbraid,180),gbraid=text(input.gbraid,180),utmSource=text(input.utmSource,120),utmMedium=text(input.utmMedium,120),utmCampaign=text(input.utmCampaign,180),utmContent=text(input.utmContent,180),utmTerm=text(input.utmTerm,180),campaignId=text(input.campaignId,180),adId=text(input.adId,180),landingUrl=text(input.landingUrl,500);
 const sourcePlatform:"google"|"meta"|"web"=gclid||wbraid||gbraid?"google":fbclid?"meta":"web";
 const clickId=gclid||wbraid||gbraid||fbclid;
 return{gclid:gclid||null,fbclid:fbclid||null,wbraid:wbraid||null,gbraid:gbraid||null,utmSource:utmSource||null,utmMedium:utmMedium||null,utmCampaign:utmCampaign||null,utmContent:utmContent||null,utmTerm:utmTerm||null,campaignId:campaignId||null,adId:adId||null,landingUrl:landingUrl||null,sourcePlatform,clickId:clickId||null,hasAttribution:Boolean(clickId||utmSource||utmMedium||utmCampaign||utmContent||utmTerm||campaignId||adId)};
}

export async function ensureLeadIntakeAdAttribution(db:Db){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS lead_intake_ad_attribution (id TEXT PRIMARY KEY,contact_id TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL UNIQUE,source_platform TEXT NOT NULL,gclid TEXT,fbclid TEXT,wbraid TEXT,gbraid TEXT,click_id TEXT,utm_source TEXT,utm_medium TEXT,utm_campaign TEXT,utm_content TEXT,utm_term TEXT,campaign_id TEXT,ad_id TEXT,landing_url TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_intake_ad_campaign ON lead_intake_ad_attribution(source_platform,campaign_id,ad_id,created_at)"),
 ]);
 const info=await db.prepare("PRAGMA table_info(lead_intake_ad_attribution)").all<Row>(),existing=new Set(info.results.map(row=>text(row.name)));
 for(const[column,type]of extendedColumns)if(!existing.has(column))await db.prepare(`ALTER TABLE lead_intake_ad_attribution ADD COLUMN ${column} ${type}`).run();
}

export async function recordLeadIntakeAdAttribution(db:Db,input:LeadAdAttributionInput){
 await ensureLeadIntakeAdAttribution(db);const normalized=normalizeLeadAdAttribution(input);if(!normalized.hasAttribution)return{recorded:false,reason:"no_ad_attribution",mirroredToWhatsApp:false,downstreamBound:false};
 const now=input.now??Date.now(),existing=await db.prepare("SELECT * FROM lead_intake_ad_attribution WHERE lead_id=? OR contact_id=? LIMIT 1").bind(input.leadId,input.contactId).first<Row>();
 if(!existing)await db.prepare("INSERT INTO lead_intake_ad_attribution (id,contact_id,lead_id,source_platform,gclid,fbclid,wbraid,gbraid,click_id,utm_source,utm_medium,utm_campaign,utm_content,utm_term,campaign_id,ad_id,landing_url,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(uid("ATTR"),input.contactId,input.leadId,normalized.sourcePlatform,normalized.gclid,normalized.fbclid,normalized.wbraid,normalized.gbraid,normalized.clickId,normalized.utmSource,normalized.utmMedium,normalized.utmCampaign,normalized.utmContent,normalized.utmTerm,normalized.campaignId,normalized.adId,normalized.landingUrl,JSON.stringify({capturedAtIntake:true,gbraid:normalized.gbraid,utmContent:normalized.utmContent,utmTerm:normalized.utmTerm}),now,now).run();
 let downstreamBound=false,mirroredToWhatsApp=false;const threadId=text(input.threadId,120);
 if(normalized.sourcePlatform==="google"||normalized.sourcePlatform==="meta"){
  const sourceEventId=`public-intake:${input.leadId}`,extendedMetadata={origin:"public_contact",capturedAtIntake:true,gbraid:normalized.gbraid,utmContent:normalized.utmContent,utmTerm:normalized.utmTerm};
  await recordIntakeLeadAttribution(db,{sourcePlatform:normalized.sourcePlatform,sourceEventId,leadId:input.leadId,customerId:input.contactId,campaignId:normalized.campaignId,adId:normalized.adId,clickId:normalized.clickId,gclid:normalized.gclid,fbclid:normalized.fbclid,wbraid:normalized.wbraid,utmSource:normalized.utmSource,utmMedium:normalized.utmMedium,utmCampaign:normalized.utmCampaign,landingUrl:normalized.landingUrl,metadata:extendedMetadata,now});downstreamBound=true;
  if(threadId){await recordWhatsAppLeadAttribution(db,{sourcePlatform:normalized.sourcePlatform,sourceEventId,leadId:input.leadId,customerId:input.contactId,threadId,campaignId:normalized.campaignId,adId:normalized.adId,clickId:normalized.clickId,utmSource:normalized.utmSource,utmMedium:normalized.utmMedium,utmCampaign:normalized.utmCampaign,metadata:{...extendedMetadata,gclid:normalized.gclid,fbclid:normalized.fbclid,wbraid:normalized.wbraid}});mirroredToWhatsApp=true;}
 }
 return{recorded:true,duplicatePrevented:Boolean(existing),sourcePlatform:normalized.sourcePlatform,clickId:normalized.clickId,mirroredToWhatsApp,downstreamBound};
}
