import{googleAdIdentifier,hasMarketingAttribution,inferMarketingSourcePlatform,normalizeMarketingAttribution,type MarketingAttributionCapture}from"./marketing-attribution";

type Db=D1Database;type Row=Record<string,unknown>;type Runtime=Record<string,unknown>;type Fetcher=(input:RequestInfo|URL,init?:RequestInit)=>Promise<Response>;
export type MarketingConversionEvent="lead_qualified"|"booking_created"|"payment_captured";
const text=(v:unknown)=>String(v??"").trim();
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const truthy=(v:unknown)=>["1","true","yes","on"].includes(text(v).toLowerCase());

export async function ensureFirstPartyMarketingAttribution(db:Db){
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS lead_marketing_attribution (id TEXT PRIMARY KEY,lead_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,source_platform TEXT NOT NULL,gclid TEXT,wbraid TEXT,gbraid TEXT,fbclid TEXT,utm_source TEXT,utm_medium TEXT,utm_campaign TEXT,utm_content TEXT,utm_term TEXT,landing_url TEXT,referrer_url TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS lead_marketing_attribution_customer_idx ON lead_marketing_attribution(customer_id,created_at DESC)"),
  db.prepare("CREATE TABLE IF NOT EXISTS marketing_conversion_facts (id TEXT PRIMARY KEY,event_type TEXT NOT NULL,business_reference TEXT NOT NULL,lead_id TEXT NOT NULL,customer_id TEXT NOT NULL,booking_id TEXT,payment_id TEXT,value_minor INTEGER NOT NULL DEFAULT 0,currency TEXT NOT NULL DEFAULT 'INR',occurred_at INTEGER NOT NULL,created_at INTEGER NOT NULL,UNIQUE(event_type,business_reference))"),
  db.prepare("CREATE TABLE IF NOT EXISTS marketing_conversion_outbox (id TEXT PRIMARY KEY,fact_id TEXT NOT NULL,platform TEXT NOT NULL,payload_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,last_error TEXT,provider_request_id TEXT,external_mutation INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,UNIQUE(fact_id,platform))"),
  db.prepare("CREATE INDEX IF NOT EXISTS marketing_conversion_outbox_due_idx ON marketing_conversion_outbox(status,next_attempt_at)"),
 ]);
}

export function attributionInsertStatement(db:Db,input:{leadId:string;customerId:string;capture:MarketingAttributionCapture;landingUrl?:string|null;referrerUrl?:string|null;now?:number}){
 const capture=normalizeMarketingAttribution(input.capture as Record<string,unknown>),now=input.now??Date.now(),platform=inferMarketingSourcePlatform(capture);
 return db.prepare("INSERT INTO lead_marketing_attribution (id,lead_id,customer_id,source_platform,gclid,wbraid,gbraid,fbclid,utm_source,utm_medium,utm_campaign,utm_content,utm_term,landing_url,referrer_url,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(lead_id) DO UPDATE SET customer_id=excluded.customer_id,source_platform=excluded.source_platform,gclid=COALESCE(excluded.gclid,lead_marketing_attribution.gclid),wbraid=COALESCE(excluded.wbraid,lead_marketing_attribution.wbraid),gbraid=COALESCE(excluded.gbraid,lead_marketing_attribution.gbraid),fbclid=COALESCE(excluded.fbclid,lead_marketing_attribution.fbclid),utm_source=COALESCE(excluded.utm_source,lead_marketing_attribution.utm_source),utm_medium=COALESCE(excluded.utm_medium,lead_marketing_attribution.utm_medium),utm_campaign=COALESCE(excluded.utm_campaign,lead_marketing_attribution.utm_campaign),utm_content=COALESCE(excluded.utm_content,lead_marketing_attribution.utm_content),utm_term=COALESCE(excluded.utm_term,lead_marketing_attribution.utm_term),landing_url=COALESCE(excluded.landing_url,lead_marketing_attribution.landing_url),referrer_url=COALESCE(excluded.referrer_url,lead_marketing_attribution.referrer_url),updated_at=excluded.updated_at")
  .bind(uid("MATTR"),input.leadId,input.customerId,platform,capture.gclid??null,capture.wbraid??null,capture.gbraid??null,capture.fbclid??null,capture.utm_source??null,capture.utm_medium??null,capture.utm_campaign??null,capture.utm_content??null,capture.utm_term??null,text(input.landingUrl)||null,text(input.referrerUrl)||null,now,now);
}

export async function persistLeadMarketingAttribution(db:Db,input:{leadId:string;customerId:string;capture:MarketingAttributionCapture;landingUrl?:string|null;referrerUrl?:string|null;now?:number}){
 await ensureFirstPartyMarketingAttribution(db);
 if(!hasMarketingAttribution(input.capture))return{persisted:false,platform:"direct" as const};
 await attributionInsertStatement(db,input).run();
 return{persisted:true,platform:inferMarketingSourcePlatform(input.capture)};
}

async function attributionForLead(db:Db,leadId:string){return db.prepare("SELECT * FROM lead_marketing_attribution WHERE lead_id=?").bind(leadId).first<Row>();}
function metaPayload(input:{eventType:MarketingConversionEvent;businessReference:string;occurredAt:number;customerId:string;bookingId?:string|null;valueMinor:number;currency:string;attribution:Row}){
 const eventName=input.eventType==="lead_qualified"?"Lead":input.eventType==="booking_created"?"InitiateCheckout":"Purchase",userData:Record<string,unknown>={external_id:[input.customerId]},fbc=text(input.attribution.fbclid);if(fbc)userData.fbc=`fb.1.${Math.trunc(input.occurredAt/1000)}.${fbc}`;
 return{data:[{event_name:eventName,event_time:Math.trunc(input.occurredAt/1000),action_source:"website",event_id:`${input.eventType}:${input.businessReference}`,user_data:userData,custom_data:{currency:input.currency,value:input.valueMinor/100,booking_id:input.bookingId??undefined}}]};
}

export async function recordMarketingConversionFact(db:Db,input:{eventType:MarketingConversionEvent;businessReference:string;leadId:string;customerId:string;bookingId?:string|null;paymentId?:string|null;valueMinor?:number;currency?:string;occurredAt?:number}){
 await ensureFirstPartyMarketingAttribution(db);const businessReference=text(input.businessReference);if(!businessReference)throw new Error("Conversion business reference is required");
 const existing=await db.prepare("SELECT * FROM marketing_conversion_facts WHERE event_type=? AND business_reference=?").bind(input.eventType,businessReference).first<Row>();let factId=text(existing?.id),duplicatePrevented=Boolean(existing);const occurredAt=input.occurredAt??Date.now(),valueMinor=Math.max(0,Math.trunc(Number(input.valueMinor||0))),currency=text(input.currency)||"INR";
 if(!existing){factId=uid("MCF");await db.prepare("INSERT INTO marketing_conversion_facts (id,event_type,business_reference,lead_id,customer_id,booking_id,payment_id,value_minor,currency,occurred_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(factId,input.eventType,businessReference,input.leadId,input.customerId,text(input.bookingId)||null,text(input.paymentId)||null,valueMinor,currency,occurredAt,Date.now()).run();}
 const attribution=await attributionForLead(db,input.leadId);let queued=0;if(attribution){const google=googleAdIdentifier(attribution as MarketingAttributionCapture),fbclid=text(attribution.fbclid),now=Date.now();
  if(google){const payload={eventType:input.eventType,businessReference,leadId:input.leadId,customerId:input.customerId,bookingId:text(input.bookingId)||null,paymentId:text(input.paymentId)||null,valueMinor,currency,occurredAt,adIdentifier:google};const r=await db.prepare("INSERT OR IGNORE INTO marketing_conversion_outbox (id,fact_id,platform,payload_json,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?, 'google',?,'pending',0,?,?,?)").bind(uid("MCOUT"),factId,JSON.stringify(payload),now,now,now).run();queued+=Number(r.meta?.changes||0);}
  if(fbclid){const payload=metaPayload({eventType:input.eventType,businessReference,occurredAt,customerId:input.customerId,bookingId:text(input.bookingId)||null,valueMinor,currency,attribution});const r=await db.prepare("INSERT OR IGNORE INTO marketing_conversion_outbox (id,fact_id,platform,payload_json,status,attempts,next_attempt_at,created_at,updated_at) VALUES (?,?, 'meta',?,'pending',0,?,?,?)").bind(uid("MCOUT"),factId,JSON.stringify(payload),now,now,now).run();queued+=Number(r.meta?.changes||0);}}
 return{factId,duplicatePrevented,queued,externalMutation:false};
}

function googleDataManagerConfig(runtime:Runtime){return{accessToken:text(runtime.GOOGLE_DATA_MANAGER_OAUTH_ACCESS_TOKEN),customerId:text(runtime.GOOGLE_ADS_CUSTOMER_ID).replace(/\D/g,""),loginCustomerId:(text(runtime.GOOGLE_ADS_LOGIN_CUSTOMER_ID)||text(runtime.GOOGLE_ADS_CUSTOMER_ID)).replace(/\D/g,""),actions:{lead_qualified:text(runtime.GOOGLE_ADS_CONVERSION_ACTION_LEAD_QUALIFIED).replace(/\D/g,""),booking_created:text(runtime.GOOGLE_ADS_CONVERSION_ACTION_BOOKING_CREATED).replace(/\D/g,""),payment_captured:text(runtime.GOOGLE_ADS_CONVERSION_ACTION_PAYMENT_CAPTURED).replace(/\D/g,"")}};}
async function providerJson(response:Response,provider:string){const raw=await response.text();let body:Record<string,unknown>={};try{body=raw?JSON.parse(raw):{};}catch{body={raw:raw.slice(0,300)};}if(!response.ok)throw new Error(`${provider} request failed (${response.status}): ${text((body.error as Row)?.message||body.message||response.statusText).slice(0,300)}`);return body;}

export async function dispatchMarketingConversionOutbox(db:Db,runtime:Runtime,input:{now?:number;limit?:number;validateOnly?:boolean;allowExternalWrites?:boolean;fetchImpl?:Fetcher}={}){
 await ensureFirstPartyMarketingAttribution(db);const now=input.now??Date.now(),limit=Math.min(100,Math.max(1,input.limit||25)),fetchImpl=input.fetchImpl||fetch,allowExternalWrites=input.allowExternalWrites!==false&&truthy(runtime.PAWSPACE_MARKETING_EXTERNAL_WRITES_ENABLED)&&text(runtime.PAWSPACE_PAYMENT_ENV).toLowerCase()!=="sandbox";
 const rows=await db.prepare("SELECT * FROM marketing_conversion_outbox WHERE status IN ('pending','retry') AND next_attempt_at<=? ORDER BY created_at LIMIT ?").bind(now,limit).all<Row>(),results:Record<string,unknown>[]=[];
 for(const row of rows.results){const id=text(row.id),platform=text(row.platform),attempts=Number(row.attempts||0)+1;
  if(platform==="meta"&&!allowExternalWrites){results.push({id,platform,status:"sandbox_held",attempts:Number(row.attempts||0),externalMutation:false});continue;}
  try{let requestId="",externalMutation=false;
   if(platform==="meta"){
    if(!truthy(runtime.PAWSPACE_META_CAPI_UPLOAD_ENABLED)){results.push({id,platform,status:"provider_disabled",attempts:Number(row.attempts||0),externalMutation:false});continue;}
    const pixelId=text(runtime.META_PIXEL_ID),token=text(runtime.META_CAPI_ACCESS_TOKEN),version=text(runtime.META_ADS_API_VERSION);if(!pixelId||!token||!/^v\d+(?:\.\d+)?$/.test(version))throw new Error("Meta CAPI is not configured");
    const response=await fetchImpl(`https://graph.facebook.com/${version}/${pixelId}/events`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:text(row.payload_json)}),body=await providerJson(response,"Meta CAPI");requestId=text(response.headers.get("x-fb-trace-id")||body.fbtrace_id);externalMutation=true;
   }else if(platform==="google"){
    const config=googleDataManagerConfig(runtime),payload=JSON.parse(text(row.payload_json)||"{}")as Row,eventType=text(payload.eventType)as MarketingConversionEvent,action=text(config.actions[eventType]);if(!config.accessToken||!config.customerId||!action)throw new Error("Google Data Manager is not configured");
    const validateOnly=input.validateOnly!==false||!allowExternalWrites||!truthy(runtime.PAWSPACE_GOOGLE_DATA_MANAGER_UPLOAD_ENABLED),identifier=payload.adIdentifier as Row,adIdentifiers:Record<string,string>={},kind=text(identifier?.type),value=text(identifier?.value);if(!["gclid","wbraid","gbraid"].includes(kind)||!value)throw new Error("Typed Google ad identifier is required");adIdentifiers[kind]=value;
    const response=await fetchImpl("https://datamanager.googleapis.com/v1/events:ingest",{method:"POST",headers:{authorization:`Bearer ${config.accessToken}`,"content-type":"application/json"},body:JSON.stringify({destinations:[{operatingAccount:{accountType:"GOOGLE_ADS",accountId:config.customerId},loginAccount:{accountType:"GOOGLE_ADS",accountId:config.loginCustomerId||config.customerId},productDestinationId:action}],events:[{adIdentifiers,conversionValue:Number(payload.valueMinor||0)/100,currency:text(payload.currency)||"INR",eventTimestamp:new Date(Number(payload.occurredAt||now)).toISOString(),transactionId:text(payload.businessReference),eventSource:"WEB"}],validateOnly})}),body=await providerJson(response,"Google Data Manager");requestId=text(body.requestId);externalMutation=!validateOnly;
   }else throw new Error(`Unsupported marketing conversion platform: ${platform}`);
   await db.prepare("UPDATE marketing_conversion_outbox SET status='delivered',attempts=?,last_error=NULL,provider_request_id=?,external_mutation=?,updated_at=? WHERE id=?").bind(attempts,requestId||null,externalMutation?1:0,Date.now(),id).run();results.push({id,platform,status:"delivered",attempts,requestId:requestId||null,externalMutation});
  }catch(error){const message=error instanceof Error?error.message:String(error),dead=attempts>=5;await db.prepare("UPDATE marketing_conversion_outbox SET status=?,attempts=?,next_attempt_at=?,last_error=?,external_mutation=0,updated_at=? WHERE id=?").bind(dead?"dead_letter":"retry",attempts,dead?now:now+Math.min(3600_000,attempts*60_000),message.slice(0,500),Date.now(),id).run();results.push({id,platform,status:dead?"dead_letter":"retry",attempts,error:message,externalMutation:false});}}
 return{processed:results.length,results};
}
