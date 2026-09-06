import{authError}from"../../../lib/server-auth";
import{captureHaptikLead,captureHaptikCallback,fetchHaptikTimeSlots,requestHaptikBooking}from"../../../lib/haptik-integration-governance";
import{recordBotCallDisposition}from"../../../lib/bot-call-disposition";
import{bridgeHaptikVoiceOutcomeToWhatsApp,persistHaptikVoiceOptOut}from"../../../lib/haptik-whatsapp-journey-bridge";
import{classifyCrmInquiry,queueForCrmInquiry,recommendGroomingPackage}from"../../../lib/crm-inquiry-classification";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}
async function database(){const {env}=await import("cloudflare:workers");return (env as unknown as {DB:D1Database}).DB;}
function hex(bytes:Uint8Array){return Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");}
function constantTimeEqual(left:string,right:string){const a=left.toLowerCase(),b=right.toLowerCase(),length=Math.max(a.length,b.length);let diff=a.length^b.length;for(let i=0;i<length;i++)diff|=(a.charCodeAt(i)||0)^(b.charCodeAt(i)||0);return diff===0;}
async function expectedHaptikSignature(secret:string,rawBody:string){const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(secret),{name:"HMAC",hash:"SHA-1"},false,["sign"]);return hex(new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(rawBody))));}
async function assertHaptik(env:Record<string,unknown>,request:Request,rawBody:string){
 const secret=String(env.HAPTIK_WEBHOOK_SECRET||env.HAPTIK_API_KEY||"").trim();
 if(!secret)throw new Response(JSON.stringify({error:"Haptik integration is not connected (webhook secret not configured)"}),{status:503});
 const supplied=String(request.headers.get("x-haptik-signature")||"").trim().replace(/^sha1=/i,"");
 if(!/^[a-f0-9]{40}$/i.test(supplied))throw new Response(JSON.stringify({error:"Invalid Haptik webhook signature"}),{status:401});
 const expected=await expectedHaptikSignature(secret,rawBody);
 if(!constantTimeEqual(supplied,expected))throw new Response(JSON.stringify({error:"Invalid Haptik webhook signature"}),{status:401});
}

export async function POST(request:Request){try{const env=await runtime();const rawBody=await request.text();await assertHaptik(env,request,rawBody);const db=await database();let body:Record<string,unknown>;try{body=JSON.parse(rawBody)as Record<string,unknown>}catch{return json({error:"Malformed Haptik request body"},400)}const action=String(body.action||"").trim(),actorId="haptik_voice";
 if(action==="classify_inquiry"){const category=classifyCrmInquiry({service:body.service,message:body.message});return json({data:{category,handoffQueue:queueForCrmInquiry(category)}});}
 if(action==="recommend_grooming_package")return json({data:recommendGroomingPackage({species:body.species,size:body.size,coat:body.coat,lastGroomingDays:body.lastGroomingDays,shedding:body.shedding,skinSensitivity:body.skinSensitivity,matting:body.matting,requestedService:body.requestedService})});
 if(action==="capture_lead"){const category=classifyCrmInquiry({service:body.service,message:body.message});return json({data:{...(await captureHaptikLead(db,{idempotencyKey:String(body.idempotencyKey||""),phone:String(body.phone||""),name:body.name as string,service:category,city:body.city as string,source:body.source as string,qualification:{...(body.qualification as Record<string,unknown>||{}),inquiryCategory:category,handoffQueue:queueForCrmInquiry(category)},actorId})),inquiryCategory:category,handoffQueue:queueForCrmInquiry(category)}},201);}
 if(action==="capture_callback")return json({data:await captureHaptikCallback(db,{idempotencyKey:String(body.idempotencyKey||""),phone:String(body.phone||""),name:body.name as string,leadId:body.leadId as string,preferredAt:body.preferredAt as number,reason:body.reason as string,actorId})},201);
 if(action==="fetch_slots")return json({data:await fetchHaptikTimeSlots(db,{serviceCode:String(body.service||body.serviceCode||""),cityId:String(body.city||body.cityId||""),zoneId:body.zone as string,fromDate:body.fromDate as string,days:body.days as number})});
 if(action==="request_booking")return json({data:await requestHaptikBooking(db,{idempotencyKey:String(body.idempotencyKey||""),phone:String(body.phone||""),name:body.name as string,leadId:body.leadId as string,serviceCode:String(body.service||body.serviceCode||""),cityId:body.city as string,zoneId:body.zone as string,preferredSlot:body.preferredSlot as string,petName:body.petName as string,notes:body.notes as string,actorId})},201);
 if(action==="record_call_outcome"){
  const idempotencyKey=String(body.idempotencyKey||"");
  const disposition=await recordBotCallDisposition(db,{idempotencyKey,leadId:body.leadId as string,phone:String(body.phone||""),channel:body.channel==="whatsapp"?"whatsapp":"voice",botProvider:"haptik",callRef:body.callRef as string,primaryTag:String(body.primaryTag||body.outcome||""),secondaryTags:Array.isArray(body.tags)?body.tags as string[]:[],crossSellServices:Array.isArray(body.crossSellServices)?body.crossSellServices as string[]:[],callbackAt:body.callbackAt as number,talkTimeSeconds:body.talkTimeSeconds as number,sentiment:body.sentiment as string,notes:body.notes as string,transcriptRef:body.transcriptRef as string,actorId});
  const optedOut="optedOut"in disposition&&Boolean(disposition.optedOut);
  const optOut=optedOut?await persistHaptikVoiceOptOut(db,{dispositionId:disposition.id,actorId}):null;
  const whatsapp=await bridgeHaptikVoiceOutcomeToWhatsApp(db,env,{dispositionId:disposition.id,dispositionIdempotencyKey:idempotencyKey,journeyCode:body.journeyCode as string,paymentLinkPath:body.paymentLinkPath as string,bookingId:body.bookingId as string,actorId});
  return json({data:{...disposition,optOut,whatsapp}},201);
 }
 return json({error:"Unsupported Haptik action. Use classify_inquiry | recommend_grooming_package | capture_lead | capture_callback | fetch_slots | request_booking | record_call_outcome"},400);
 }catch(error){if(error instanceof Response){const t=await error.text().catch(()=>"");let payload:unknown={error:"Haptik request rejected"};try{payload=t?JSON.parse(t):payload}catch{payload={error:t||"Haptik request rejected"}}return json(payload,error.status)}return authError(error,"Unable to process Haptik request");}}
