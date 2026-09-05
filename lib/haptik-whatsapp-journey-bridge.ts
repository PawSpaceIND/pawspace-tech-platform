import{enqueueCommunication,ensureCommunicationTables,type CommunicationPurpose}from"./communication-engine";
import{ensureCustomer360Tables}from"./customer-360";
import{ensureWhatsAppUatTables}from"./whatsapp-uat-adapter";

type Db=D1Database;
type Env=Record<string,unknown>;
type Row=Record<string,unknown>;

const text=(value:unknown)=>String(value??"").trim();
const phone=(value:unknown)=>text(value).replace(/\D/g,"").slice(-10);
const parse=<T>(value:unknown,fallback:T):T=>{try{return JSON.parse(String(value??""))as T}catch{return fallback}};

export const HAPTIK_WHATSAPP_JOURNEY_CODES=["lead_qualified","booking_intent","subscription_renewal_interest"]as const;
export type HaptikWhatsAppJourneyCode=(typeof HAPTIK_WHATSAPP_JOURNEY_CODES)[number];

const JOURNEYS:Record<HaptikWhatsAppJourneyCode,{templateEnv:string;purpose:CommunicationPurpose}>={
 lead_qualified:{templateEnv:"HAPTIK_WHATSAPP_LEAD_QUALIFIED_TEMPLATE",purpose:"lifecycle"},
 booking_intent:{templateEnv:"HAPTIK_WHATSAPP_BOOKING_INTENT_TEMPLATE",purpose:"lifecycle"},
 subscription_renewal_interest:{templateEnv:"HAPTIK_WHATSAPP_SUBSCRIPTION_RENEWAL_TEMPLATE",purpose:"lifecycle"},
};

export type HaptikWhatsAppBridgeInput={
 dispositionId:string;
 dispositionIdempotencyKey:string;
 journeyCode?:string|null;
 paymentLinkPath?:string|null;
 bookingId?:string|null;
 actorId?:string;
 asOf?:number;
};

function result(status:string,detail:Record<string,unknown>={}){return{queued:false,status,externalDelivery:false,...detail};}

function inferJourney(input:HaptikWhatsAppBridgeInput,row:Row,tags:string[],services:string[]):HaptikWhatsAppJourneyCode|null{
 const explicit=text(input.journeyCode).toLowerCase();
 if(explicit)return(HAPTIK_WHATSAPP_JOURNEY_CODES as readonly string[]).includes(explicit)?explicit as HaptikWhatsAppJourneyCode:null;
 const normalizedServices=services.map(item=>item.toLowerCase());
 if(normalizedServices.some(item=>item.includes("subscription")||item.includes("renewal")))return"subscription_renewal_interest";
 if(text(input.bookingId))return"booking_intent";
 if(tags.includes("interested")||tags.includes("cross_sell_potential")||text(row.primary_tag)==="interested")return"lead_qualified";
 return null;
}

function paymentUrl(env:Env,rawValue:unknown){
 const raw=text(rawValue);if(!raw)return null;
 let origin:URL;try{origin=new URL(text(env.PAWSPACE_APPLICATION_ORIGIN)||"https://app.pawspace.in");}catch{return null;}
 if(origin.protocol!=="https:")return null;
 if(raw.startsWith("//"))return null;
 let url:URL;try{url=new URL(raw,origin);}catch{return null;}
 if(url.protocol!=="https:"||url.origin!==origin.origin)return null;
 return url.toString();
}

async function canonicalCustomer(db:Db,row:Row){
 const contactId=text(row.contact_id),dialled=phone(row.phone||row.contact_phone);
 const byId=contactId?await db.prepare("SELECT id,city_id,name,primary_phone FROM canonical_customers WHERE id=?").bind(contactId).first<Row>().catch(()=>null):null;
 if(byId){if(dialled&&phone(byId.primary_phone)!==dialled)return{customer:null as Row|null,reason:"contact_identity_mismatch"};return{customer:byId,reason:null};}
 if(!dialled)return{customer:null as Row|null,reason:"canonical_customer_missing"};
 const matches=await db.prepare("SELECT id,city_id,name,primary_phone FROM canonical_customers WHERE replace(replace(replace(primary_phone,' ',''),'-',''),'+','') LIKE ? ORDER BY updated_at DESC LIMIT 3").bind(`%${dialled}`).all<Row>().catch(()=>({results:[]as Row[]}));
 if(matches.results.length!==1)return{customer:null as Row|null,reason:matches.results.length>1?"canonical_customer_ambiguous":"canonical_customer_missing"};
 return{customer:matches.results[0],reason:null};
}

async function approvedTemplate(db:Db,key:string){
 const row=await db.prepare("SELECT template_key,status,category,approved_language FROM whatsapp_uat_templates WHERE template_key=?").bind(key).first<Row>().catch(()=>null);
 if(!row||text(row.status)!=="approved")return null;
 return{key:text(row.template_key),category:text(row.category).toLowerCase(),language:text(row.approved_language)||"en"};
}

export async function persistHaptikVoiceOptOut(db:Db,input:{dispositionId:string;actorId?:string;asOf?:number}){
 await ensureCustomer360Tables(db);
 const row=await db.prepare("SELECT d.contact_id,d.phone,d.opted_out,c.primary_phone AS contact_phone FROM bot_call_dispositions d JOIN crm_contacts c ON c.id=d.contact_id WHERE d.id=? AND d.bot_provider='haptik' AND d.channel='voice'").bind(text(input.dispositionId)).first<Row>().catch(()=>null);
 if(!row||Number(row.opted_out||0)!==1)return{persisted:false,reason:"not_opted_out"};
 const identity=await canonicalCustomer(db,row);if(!identity.customer)return{persisted:false,reason:identity.reason||"canonical_customer_required"};
 const customerId=text(identity.customer.id),now=input.asOf??Date.now(),actor=text(input.actorId)||"haptik_voice";
 await db.prepare("INSERT INTO customer_contact_preferences (customer_id,marketing_consent,service_consent,whatsapp_consent,sms_consent,email_consent,opt_out,source,updated_by,updated_at) VALUES (?,0,0,0,0,0,1,'haptik_voice_opt_out',?,?) ON CONFLICT(customer_id) DO UPDATE SET marketing_consent=0,whatsapp_consent=0,opt_out=1,source='haptik_voice_opt_out',updated_by=excluded.updated_by,updated_at=excluded.updated_at").bind(customerId,actor,now).run();
 return{persisted:true,customerId};
}

export async function bridgeHaptikVoiceOutcomeToWhatsApp(db:Db,env:Env,input:HaptikWhatsAppBridgeInput){
 await ensureCommunicationTables(db);await ensureCustomer360Tables(db);await ensureWhatsAppUatTables(db);
 const dispositionId=text(input.dispositionId),dispositionKey=text(input.dispositionIdempotencyKey);
 if(!dispositionId||!dispositionKey)return result("disposition_identity_required");
 const row=await db.prepare("SELECT d.*,l.opt_out AS lead_opt_out,l.service AS lead_service,c.name AS contact_name,c.primary_phone AS contact_phone,c.email AS contact_email,c.area AS contact_area FROM bot_call_dispositions d JOIN lead_work_items l ON l.id=d.lead_id JOIN crm_contacts c ON c.id=d.contact_id WHERE d.id=?").bind(dispositionId).first<Row>().catch(()=>null);
 if(!row)return result("disposition_not_found");
 if(text(row.bot_provider)!=="haptik"||text(row.channel)!=="voice")return result("not_haptik_voice_outcome");
 const tags=parse<string[]>(row.tags_json,[]),services=parse<string[]>(row.cross_sell_services_json,[]);
 if(Number(row.opted_out||0)===1||Number(row.lead_opt_out||0)===1||tags.includes("do_not_call"))return result("lead_opted_out");
 if(tags.includes("paid")||tags.includes("converted"))return result("payment_or_conversion_claim_requires_reconciliation");
 const positive=tags.includes("interested")||tags.includes("cross_sell_potential")||text(row.primary_tag)==="interested";
 if(!positive)return result("outcome_not_eligible");
 const journey=inferJourney(input,row,tags,services);if(!journey)return result(text(input.journeyCode)?"unsupported_journey":"journey_not_resolved");
 const definition=JOURNEYS[journey],templateKey=text(env[definition.templateEnv]);
 if(!templateKey)return result("template_mapping_required",{journeyCode:journey,templateEnv:definition.templateEnv});
 const template=await approvedTemplate(db,templateKey);if(!template)return result("approved_template_required",{journeyCode:journey,templateKey});
 const identity=await canonicalCustomer(db,row);if(!identity.customer)return result(identity.reason||"canonical_customer_required",{journeyCode:journey,templateKey});
 const customerId=text(identity.customer.id),preference=await db.prepare("SELECT marketing_consent,service_consent,whatsapp_consent,opt_out FROM customer_contact_preferences WHERE customer_id=?").bind(customerId).first<Row>().catch(()=>null);
 if(!preference||Number(preference.whatsapp_consent||0)!==1)return result("whatsapp_consent_required",{customerId,journeyCode:journey,templateKey});
 if(Number(preference.opt_out||0)===1)return result("customer_opted_out",{customerId,journeyCode:journey,templateKey});
 if(template.category==="marketing"&&Number(preference.marketing_consent||0)!==1)return result("marketing_consent_required",{customerId,journeyCode:journey,templateKey});
 const link=paymentUrl(env,input.paymentLinkPath);if(!link)return result(text(input.paymentLinkPath)?"payment_link_origin_rejected":"payment_link_required",{customerId,journeyCode:journey,templateKey});
 const bookingId=text(input.bookingId)||null;
 if(bookingId){const booking=await db.prepare("SELECT id,customer_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>().catch(()=>null);if(!booking||text(booking.customer_id)!==customerId)return result("booking_customer_mismatch",{customerId,journeyCode:journey,templateKey,bookingId});}
 const firstName=text(row.contact_name||identity.customer.name).split(/\s+/)[0]||"there",now=input.asOf??Date.now(),purpose:CommunicationPurpose=bookingId?"transactional":definition.purpose;
 const messageText=journey==="subscription_renewal_interest"?`Hi ${firstName}, thanks for confirming your renewal interest with PawSpace. Complete the approved payment here: ${link}`:journey==="booking_intent"?`Hi ${firstName}, thanks for confirming your booking intent with PawSpace. Complete the approved payment here: ${link}`:`Hi ${firstName}, thanks for speaking with PawSpace. Continue with your qualified service request here: ${link}`;
 const queued=await enqueueCommunication(db,{customerId,cityId:text(identity.customer.city_id)||"blr",channel:"whatsapp",purpose,idempotencyKey:`haptik-voice-whatsapp:${dispositionKey}:${journey}:v1`,templateKey:template.key,payload:{source:"haptik_voice_outcome",haptikDispositionId:dispositionId,journeyCode:journey,language:template.language,bodyValues:[firstName,link],values:[firstName,link],text:messageText,forceTemplate:true,paymentLinkPath:text(input.paymentLinkPath),paymentUrl:link},createdBy:text(input.actorId)||"haptik_voice",leadId:text(row.lead_id),bookingId:bookingId||undefined,asOf:now});
 const queuedRow=queued as Record<string,unknown>,status=text(queuedRow.status||((queuedRow.message as Row|undefined)?.status));
 return{queued:status!=="suppressed",status:status||"queued",duplicatePrevented:Boolean(queuedRow.duplicatePrevented),messageId:text(queuedRow.messageId||((queuedRow.message as Row|undefined)?.id))||null,threadId:text(queuedRow.threadId||((queuedRow.message as Row|undefined)?.thread_id))||null,customerId,journeyCode:journey,templateKey:template.key,paymentUrl:link,externalDelivery:false};
}
