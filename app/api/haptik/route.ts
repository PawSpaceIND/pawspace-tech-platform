import{authError}from"../../../lib/server-auth";
import{captureHaptikLead,captureHaptikCallback,fetchHaptikTimeSlots,requestHaptikBooking}from"../../../lib/haptik-integration-governance";
import{recordBotCallDisposition}from"../../../lib/bot-call-disposition";
import{queueInteraktWhatsApp}from"../../../lib/interakt-whatsapp-governance";
import{recommendGroomingPackage,groomingPackageBriefing}from"../../../lib/grooming-package-advisor";
import{createHaptikInquiry,requestHaptikAgentTransfer,haptikFaqAnswer}from"../../../lib/haptik-inbound-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
async function database(){const {env}=await import("cloudflare:workers");return (env as unknown as {DB:D1Database}).DB;}

// Haptik-facing webhook, authenticated by HAPTIK_API_KEY. Fail-closed: does nothing until the key is
// configured (503), and rejects a wrong/absent key (401). The AI/voice automation layer is entirely
// optional - with no key set, Haptik simply cannot call in and staff work leads manually.
function assertHaptik(env:Record<string,unknown>,request:Request){
  const key=String(env.HAPTIK_API_KEY||"").trim();
  if(!key)throw new Response(JSON.stringify({error:"Haptik integration is not connected (HAPTIK_API_KEY not configured)"}),{status:503});
  const provided=String(request.headers.get("x-haptik-key")||request.headers.get("authorization")||"").replace(/^Bearer\s+/i,"").trim();
  if(provided!==key)throw new Response(JSON.stringify({error:"Invalid Haptik credentials"}),{status:401});
}

const ACTIONS=["capture_lead","capture_callback","fetch_slots","request_booking","record_call_outcome","send_whatsapp","recommend_package","package_briefing","create_inquiry","transfer_to_agent","faq_answer"] as const;

export async function POST(request:Request){
  try{
    const env=await runtime();assertHaptik(env,request);
    const db=await database();
    // A malformed body is the caller's fault and must stay a permanent 400, or Haptik retries it
    // forever. Every other failure is ours and must be a retryable 500 via the governed boundary.
    let body:Record<string,unknown>;
    try{body=await request.json() as Record<string,unknown>;}
    catch{return json({error:"Malformed Haptik request body"},400);}
    const action=String(body.action||"").trim();
    const actorId="haptik_voice";
    if(action==="capture_lead")return json({data:await captureHaptikLead(db,{idempotencyKey:String(body.idempotencyKey||""),phone:String(body.phone||""),name:body.name as string,service:body.service as string,city:body.city as string,source:body.source as string,qualification:body.qualification as Record<string,unknown>,actorId})},201);
    if(action==="capture_callback")return json({data:await captureHaptikCallback(db,{idempotencyKey:String(body.idempotencyKey||""),phone:String(body.phone||""),name:body.name as string,leadId:body.leadId as string,preferredAt:body.preferredAt as number,reason:body.reason as string,actorId})},201);
    if(action==="fetch_slots")return json({data:await fetchHaptikTimeSlots(db,{serviceCode:String(body.service||body.serviceCode||""),cityId:String(body.city||body.cityId||""),zoneId:body.zone as string,fromDate:body.fromDate as string,days:body.days as number})});
    if(action==="request_booking")return json({data:await requestHaptikBooking(db,{idempotencyKey:String(body.idempotencyKey||""),phone:String(body.phone||""),name:body.name as string,leadId:body.leadId as string,serviceCode:String(body.service||body.serviceCode||""),cityId:body.city as string,zoneId:body.zone as string,preferredSlot:body.preferredSlot as string,petName:body.petName as string,notes:body.notes as string,actorId})},201);
    // What happened on the call. Haptik posts this once the bot call ends; it lands in the real CRM
    // (attempt + activity + lead state) using the same vocabulary a human rep's call uses.
    if(action==="record_call_outcome")return json({data:await recordBotCallDisposition(db,{idempotencyKey:String(body.idempotencyKey||""),leadId:body.leadId as string,phone:String(body.phone||""),channel:body.channel==="whatsapp"?"whatsapp":"voice",botProvider:"haptik",callRef:body.callRef as string,primaryTag:String(body.primaryTag||body.outcome||""),secondaryTags:Array.isArray(body.tags)?body.tags as string[]:[],crossSellServices:Array.isArray(body.crossSellServices)?body.crossSellServices as string[]:[],callbackAt:body.callbackAt as number,talkTimeSeconds:body.talkTimeSeconds as number,sentiment:body.sentiment as string,notes:body.notes as string,transcriptRef:body.transcriptRef as string,actorId})},201);
    // "Share the details on WhatsApp" - the Interakt half of the journeys. The bot ASSERTS the consent
    // the customer gave on the call (consentGranted + the call ref as evidence); the governed engine
    // then decides whether the message may actually be sent, so a refusal comes back as a reason the
    // bot can say out loud rather than a message that silently never arrives.
    if(action==="send_whatsapp")return json({data:await queueInteraktWhatsApp(db,env,{idempotencyKey:String(body.idempotencyKey||""),linkKey:String(body.link||body.linkKey||""),phone:String(body.phone||""),leadId:body.leadId as string,cityId:body.city as string,language:body.language as string,callRef:body.callRef as string,bodyValues:Array.isArray(body.bodyValues)?body.bodyValues as string[]:[],consentGranted:body.consentGranted===true,consentSource:String(body.consentSource||"voice_call_verbal_consent"),consentEvidenceRef:String(body.consentEvidenceRef||body.callRef||""),actorId})},201);
    // Package recommendation from the live catalogue + the governed rule set. handToHuman:true is a
    // real answer - the bot must not improvise a package or a price when nothing matches.
    if(action==="recommend_package")return json({data:await recommendGroomingPackage(db,{species:body.species as string||body.petType as string,breed:body.breed as string,coatType:body.coatType as string,sizeClass:body.sizeClass as string,ageMonths:body.ageMonths as number,ageYears:body.ageYears as number,cityId:body.city as string,zoneId:body.zone as string})});
    if(action==="package_briefing")return json({data:await groomingPackageBriefing(db,{cityId:body.city as string})});
    // Inbound agent: file the enquiry, ask for a human, answer an FAQ.
    if(action==="create_inquiry")return json({data:await createHaptikInquiry(db,{idempotencyKey:String(body.idempotencyKey||""),category:String(body.category||""),phone:String(body.phone||""),name:body.name as string,preferredLocation:String(body.preferredLocation||body.city||""),requirement:body.requirement as string,callRef:body.callRef as string,detail:body.detail as Record<string,unknown>,actorId})},201);
    if(action==="transfer_to_agent")return json({data:await requestHaptikAgentTransfer(db,{idempotencyKey:String(body.idempotencyKey||""),queueCode:body.queueCode as string,reason:String(body.reason||""),phone:String(body.phone||""),leadId:body.leadId as string,callRef:body.callRef as string,actorId})},201);
    if(action==="faq_answer")return json({data:await haptikFaqAnswer(db,{question:String(body.question||""),callRef:body.callRef as string,limit:body.limit as number})});
    return json({error:`Unsupported Haptik action. Use ${ACTIONS.join(" | ")}`},400);
  }catch(error){
    if(error instanceof Response){const t=await error.text().catch(()=>"" );return json(t?JSON.parse(t):{error:"Haptik request rejected"},error.status);}
    return authError(error,"Unable to process Haptik request");
  }
}
