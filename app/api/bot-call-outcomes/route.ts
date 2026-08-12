import{authError,authorize,database}from"../../../lib/server-auth";
import{botCallDispositionSummary,pendingBotCallClaims,recordBotCallDisposition,reconcileBotCallClaim,BOT_CALL_TAGS}from"../../../lib/bot-call-disposition";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin bot outcome write blocked",{status:403});}

// Staff/CRM view of what the AI bot calls actually produced, plus the reconciliation queue for the
// claims a bot cannot verify itself (converted / paid). Haptik's own post-call webhook writes through
// /api/haptik (action=record_call_outcome); this route is the internal surface.
export async function GET(request:Request){
  try{
    const actor=await authorize(request,"customers.view"),url=new URL(request.url),db=await database();
    void actor;
    const scope=url.searchParams.get("scope")||"summary";
    if(scope==="pending_claims")return json({data:await pendingBotCallClaims(db,Number(url.searchParams.get("limit")||100))});
    if(scope==="tags")return json({data:{tags:BOT_CALL_TAGS}});
    const since=Number(url.searchParams.get("since")||0);
    return json({data:await botCallDispositionSummary(db,{since:Number.isFinite(since)?since:0,leadId:url.searchParams.get("leadId")||undefined})});
  }catch(error){return authError(error,"Unable to load bot call outcomes");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json().catch(()=>({}))as Record<string,unknown>,action=String(body.action||"record").trim();
    const db=await database();
    if(action==="reconcile"){
      const actor=await authorize(request,"customers.manage");
      return json({data:await reconcileBotCallClaim(db,{dispositionId:String(body.dispositionId||""),outcome:String(body.outcome||"")as"confirmed"|"not_found",note:String(body.note||""),actorId:actor.email})},201);
    }
    const actor=await authorize(request,"communications.call");
    return json({data:await recordBotCallDisposition(db,{idempotencyKey:String(body.idempotencyKey||""),leadId:body.leadId as string,phone:String(body.phone||""),channel:body.channel==="whatsapp"?"whatsapp":"voice",botProvider:String(body.botProvider||"pawspace_voice_bot"),callRef:body.callRef as string,primaryTag:String(body.primaryTag||""),secondaryTags:Array.isArray(body.tags)?body.tags as string[]:[],crossSellServices:Array.isArray(body.crossSellServices)?body.crossSellServices as string[]:[],callbackAt:body.callbackAt as number,talkTimeSeconds:body.talkTimeSeconds as number,sentiment:body.sentiment as string,notes:body.notes as string,transcriptRef:body.transcriptRef as string,actorId:actor.email})},201);
  }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to record bot call outcome");}
}
