import{recordIntakeLeadAttribution,recordWhatsAppLeadAttribution}from"./whatsapp-conversion-feedback";

type Db=D1Database;
type Row=Record<string,unknown>;
export type LeadAdAttributionInput={contactId:string;leadId:string;threadId?:string|null;gclid?:string|null;fbclid?:string|null;wbraid?:string|null;utmSource?:string|null;utmMedium?:string|null;utmCampaign?:string|null;campaignId?:string|null;adId?:string|null;landingUrl?:string|null;now?:number};
const text=(value:unknown,max=255)=>String(value??"").replace(/[\u0000-\u001F\u007F]/g," ").trim().slice(0,max);
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export function normalizeLeadAdAttribution(input:Partial<LeadAdAttributionInput>){
 const gclid=text(input.gclid,180),fbclid=text(input.fbclid,180),wbraid=text(input.wbraid,180),utmSource=text(input.utmSource,120),utmMedium=text(input.utmMedium,120),utmCampaign=text(input.utmCampaign,180),campaignId=text(input.campaignId,180),adId=text(input.adId,180),landingUrl=text(input.landingUrl,500);
 const sourcePlatform:"google"|"meta"|"web"=gclid||wbraid?"google":fbclid?"meta":"web";
 const clickId=gclid||fbclid||wbraid;
 return{gclid:gclid||null,fbclid:fbclid||null,wbraid:wbraid||null,utmSource:utmSource||null,utmMedium:utmMedium||null,utmCampaign:utmCampaign||null,campaignId:campaignId||null,adId:adId||null,landingUrl:landingUrl||null,sourcePlatform,clickId:clickId||null,hasAttribution:Boolean(clickId||utmSource||utmMedium||utmCampaign||campaignId||adId)};
}

export async function ensureLeadIntakeAdAttribution(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS lead_intake_ad_attribution (id TEXT PRIMARY KEY,contact_id TEXT NOT NULL UNIQUE,lead_id TEXT NOT NULL UNIQUE,source_platform TEXT NOT NULL,gclid TEXT,fbclid TEXT,wbraid TEXT,click_id TEXT,utm_source TEXT,utm_medium TEXT,utm_campaign TEXT,campaign_id TEXT,ad_id TEXT,landing_url TEXT,metadata_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_lead_intake_ad_campaign ON lead_intake_ad_attribution(source_platform,campaign_id,ad_id,created_at)"),
]);}

export async function recordLeadIntakeAdAttribution(db:Db,input:LeadAdAttributionInput){
 await ensureLeadIntakeAdAttribution(db);const normalized=normalizeLeadAdAttribution(input);if(!normalized.hasAttribution)return{recorded:false,reason:"no_ad_attribution",mirroredToWhatsApp:false,downstreamBound:false};
 const now=input.now??Date.now(),existing=await db.prepare("SELECT * FROM lead_intake_ad_attribution WHERE lead_id=? OR contact_id=? LIMIT 1").bind(input.leadId,input.contactId).first<Row>();
 if(!existing)await db.prepare("INSERT INTO lead_intake_ad_attribution (id,contact_id,lead_id,source_platform,gclid,fbclid,wbraid,click_id,utm_source,utm_medium,utm_campaign,campaign_id,ad_id,landing_url,metadata_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
  .bind(uid("ATTR"),input.contactId,input.leadId,normalized.sourcePlatform,normalized.gclid,normalized.fbclid,normalized.wbraid,normalized.clickId,normalized.utmSource,normalized.utmMedium,normalized.utmCampaign,normalized.campaignId,normalized.adId,normalized.landingUrl,JSON.stringify({capturedAtIntake:true}),now,now).run();
 let downstreamBound=false,mirroredToWhatsApp=false;const threadId=text(input.threadId,120);
 if(normalized.sourcePlatform==="google"||normalized.sourcePlatform==="meta"){
  const sourceEventId=`public-intake:${input.leadId}`;
  await recordIntakeLeadAttribution(db,{sourcePlatform:normalized.sourcePlatform,sourceEventId,leadId:input.leadId,customerId:input.contactId,campaignId:normalized.campaignId,adId:normalized.adId,clickId:normalized.clickId,gclid:normalized.gclid,fbclid:normalized.fbclid,wbraid:normalized.wbraid,utmSource:normalized.utmSource,utmMedium:normalized.utmMedium,utmCampaign:normalized.utmCampaign,landingUrl:normalized.landingUrl,metadata:{origin:"public_contact",capturedAtIntake:true},now});downstreamBound=true;
  if(threadId){await recordWhatsAppLeadAttribution(db,{sourcePlatform:normalized.sourcePlatform,sourceEventId,leadId:input.leadId,customerId:input.contactId,threadId,campaignId:normalized.campaignId,adId:normalized.adId,clickId:normalized.clickId,utmSource:normalized.utmSource,utmMedium:normalized.utmMedium,utmCampaign:normalized.utmCampaign,metadata:{origin:"public_contact",gclid:normalized.gclid,fbclid:normalized.fbclid,wbraid:normalized.wbraid,landingUrl:normalized.landingUrl}});mirroredToWhatsApp=true;}
 }
 return{recorded:true,duplicatePrevented:Boolean(existing),sourcePlatform:normalized.sourcePlatform,clickId:normalized.clickId,mirroredToWhatsApp,downstreamBound};
}
