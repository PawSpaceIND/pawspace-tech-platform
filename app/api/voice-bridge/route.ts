import{authError,database,requireCustomerOwnership,requireProviderOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{initiateVoiceBridge}from"../../../lib/voice-bridge-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}

/**
 * Start a number-masked two-leg call between the two parties of a booking. The caller must be the
 * booking's pet parent or its assigned provider - authorized here by the recognized ownership guards, and
 * narrowed to a BOUND party (never staff) inside initiateVoiceBridge. The client sends only a bookingId
 * and an optional recordRequested flag; it never supplies or receives either party's phone number.
 */
export async function POST(request:Request){
 try{
  sameOrigin(request);
  const actor=await resolveActor(request);
  const db=await database();
  const body=await request.json() as Record<string,unknown>;
  const bookingId=String(body.bookingId||"").trim();
  if(!bookingId)return json({error:"booking_id_required"},400);
  let booking:Record<string,unknown>|null=null;
  try{booking=await db.prepare("SELECT id,customer_id,provider_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Record<string,unknown>>();}catch{booking=null;}
  if(!booking)return json({error:"booking_not_found"},404);
  // Party ownership (the recognized guards); the strict non-staff party match is re-checked in governance.
  try{await requireCustomerOwnership(db,actor,String(booking.customer_id));}
  catch{await requireProviderOwnership(db,actor,String(booking.provider_id));}
  const{env}=await import("cloudflare:workers");
  const result=await initiateVoiceBridge(db,env as unknown as Record<string,unknown>,{bookingId,actor:{email:actor.email,identitySource:actor.identitySource,principalType:actor.principalType,principalKey:actor.principalKey},recordRequested:body.recordRequested===true});
  await securityAudit(db,actor,"voice.bridge.initiate","voice_bridge",result.ok?result.sessionId:bookingId,result.ok?"completed":"blocked",{bookingId,reason:result.ok?"initiating":result.reason,recording:result.ok?result.recording:false});
  if(!result.ok)return json({error:result.reason,...(result.detail||{})},result.status);
  return json({data:result},201);
 }catch(error){return authError(error,"Unable to start the masked call");}
}
