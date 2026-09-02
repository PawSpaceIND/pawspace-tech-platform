import{authError}from"../../../lib/server-auth";
import{captureHaptikLead,captureHaptikCallback,fetchHaptikTimeSlots,requestHaptikBooking}from"../../../lib/haptik-integration-governance";
import{recordBotCallDisposition}from"../../../lib/bot-call-disposition";
import{createHaptikInquiry,transferHaptikToAgent}from"../../../lib/haptik-inbound-inquiry";

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
    // "Create an Inquiry in CRM" - the LOE's inbound classification endpoint. Distinct from
    // capture_lead: only the six SERVICE categories create pipeline; pricing/availability/general are
    // logged, and complaints/veterinary are routed to a human instead of a sales queue.
    if(action==="create_inquiry")return json({data:await createHaptikInquiry(db,{idempotencyKey:String(body.idempotencyKey||""),phone:String(body.phone||""),name:body.name as string,category:String(body.category||body.intent||""),message:body.message as string,channel:body.channel as string,cityId:body.city as string,actorId})},201);
    // "Transfer to an agent" - reuses the existing ai_handoffs queue agents already watch, rather than
    // opening a second queue that nobody is looking at.
    if(action==="transfer_to_agent")return json({data:await transferHaptikToAgent(db,{phone:String(body.phone||""),reason:body.reason as string,name:body.name as string,inquiryId:body.inquiryId as string,sessionId:body.sessionId as string,actorId})},201);
    return json({error:"Unsupported Haptik action. Use capture_lead | capture_callback | fetch_slots | request_booking | record_call_outcome | create_inquiry | transfer_to_agent"},400);
  }catch(error){
    if(error instanceof Response){const t=await error.text().catch(()=>"" );return json(t?JSON.parse(t):{error:"Haptik request rejected"},error.status);}
    return authError(error,"Unable to process Haptik request");
  }
}
