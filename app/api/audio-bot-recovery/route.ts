import{authError,authorize,database,requirePermission,securityAudit}from"../../../lib/server-auth";
import{triggerAudioBotRecovery,settleAudioBotRecovery,audioBotRecoverySnapshot,type AudioBotOutcome}from"../../../lib/audio-bot-recovery";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin write blocked",{status:403});}
const OUTCOMES=new Set(["acknowledged","reassured","no_answer","failed","agent_requested","opt_out"]);

export async function GET(request:Request){
 try{
  await authorize(request,"communications.call");
  const db=await database(),url=new URL(request.url),bookingId=String(url.searchParams.get("bookingId")||"").trim();
  return json({data:await audioBotRecoverySnapshot(db,bookingId?{bookingId}:undefined)});
 }catch(error){return authError(error,"Unable to load Audio Bot recovery");}
}

export async function POST(request:Request){
 try{
  sameOrigin(request);
  const actor=await authorize(request,"customers.manage");
  requirePermission(actor,"communications.call");
  const db=await database(),body=await request.json() as Record<string,unknown>;
  const action=String(body.action||"trigger"),bookingId=String(body.bookingId||"").trim(),recoveryReason=String(body.recoveryReason||"").trim();
  const{env}=await import("cloudflare:workers");
  if(action==="trigger"){
   const result=await triggerAudioBotRecovery(db,env as unknown as Record<string,unknown>,{bookingId,recoveryReason,actorId:actor.email});
   await securityAudit(db,actor,"audio_bot_recovery.trigger","audio_bot_recovery",`${bookingId}:${recoveryReason}`,result.ok?"completed":"blocked",{status:result.status,reason:result.reason,blockedBy:result.blockedBy});
   return json({data:result},result.ok?200:409);
  }
  if(action==="settle"){
   const outcome=String(body.outcome||"");
   if(!OUTCOMES.has(outcome))return json({error:"A valid bot outcome is required"},400);
   const result=await settleAudioBotRecovery(db,{bookingId,recoveryReason,outcome:outcome as AudioBotOutcome,actorId:actor.email});
   await securityAudit(db,actor,"audio_bot_recovery.settle","audio_bot_recovery",`${bookingId}:${recoveryReason}`,"completed",{status:result.status,outcome});
   return json({data:result});
  }
  return json({error:"Unsupported Audio Bot recovery action"},400);
 }catch(error){return authError(error,"Unable to update Audio Bot recovery");}
}
