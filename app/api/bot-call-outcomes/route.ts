import{authError,authorize,database}from"../../../lib/server-auth";
import{botCallDispositionSummary,pendingBotCallClaims,recordBotCallDisposition,reconcileBotCallClaim,BOT_CALL_TAGS}from"../../../lib/bot-call-disposition";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin bot outcome write blocked",{status:403});}

type BotCallBindings={DB?:D1Database;IDEMPOTENCY_KV?:unknown;CALL_ARTIFACTS?:unknown};
async function bindingReadiness(){const{env}=await import("cloudflare:workers");const runtime=env as unknown as BotCallBindings;return{runtime,missingRequired:runtime.DB?[]:["DB"],optional:{IDEMPOTENCY_KV:Boolean(runtime.IDEMPOTENCY_KV),CALL_ARTIFACTS:Boolean(runtime.CALL_ARTIFACTS)}};}
async function requireBotCallBindings(){const state=await bindingReadiness();if(state.missingRequired.length)return{response:json({error:"Bot call outcome runtime bindings are unavailable",code:"BOT_CALL_BINDINGS_MISSING",missingBindings:state.missingRequired,optionalBindings:state.optional},503)};return{response:null,optionalBindings:state.optional};}

// Staff/CRM view of what the AI bot calls actually produced, plus the reconciliation queue for the
// claims a bot cannot verify itself (converted / paid). Haptik's own post-call webhook writes through
// /api/haptik (action=record_call_outcome); this route is the internal surface.
// DB is the only binding this route currently consumes. KV/R2 are surfaced as optional readiness
// signals so test harnesses can omit them without turning a healthy CRM-only invocation into a 500.
export async function GET(request:Request){
  try{
    const bindings=await requireBotCallBindings();if(bindings.response)return bindings.response;
    const actor=await authorize(request,"customers.view"),url=new URL(request.url),db=await database();
    void actor;
    const scope=url.searchParams.get("scope")||"summary";
    if(scope==="pending_claims")return json({data:await pendingBotCallClaims(db,Number(url.searchParams.get("limit")||100)),bindings:bindings.optionalBindings});
    if(scope==="tags")return json({data:{tags:BOT_CALL_TAGS},bindings:bindings.optionalBindings});
    const since=Number(url.searchParams.get("since")||0);
    return json({data:await botCallDispositionSummary(db,{since:Number.isFinite(since)?since:0,leadId:url.searchParams.get("leadId")||undefined}),bindings:bindings.optionalBindings});
  }catch(error){return authError(error,"Unable to load bot call outcomes");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const bindings=await requireBotCallBindings();if(bindings.response)return bindings.response;
    const body=await request.json().catch(()=>({}))as Record<string,unknown>,action=String(body.action||"record").trim();
    const db=await database();
    if(action==="reconcile"){
      const actor=await authorize(request,"customers.manage");
      return json({data:await reconcileBotCallClaim(db,{dispositionId:String(body.dispositionId||""),outcome:String(body.outcome||"")as"confirmed"|"not_found",note:String(body.note||""),actorId:actor.email}),bindings:bindings.optionalBindings},201);
    }
    // Second gate, matched to the first: a bot disposition writes the same CRM rows the human path
    // writes, and that path requires customers.manage (PTJA W2-B4-M03).
    const actor=await authorize(request,"customers.manage");
    return json({data:await recordBotCallDisposition(db,{idempotencyKey:String(body.idempotencyKey||""),leadId:body.leadId as string,phone:String(body.phone||""),channel:body.channel==="whatsapp"?"whatsapp":"voice",botProvider:String(body.botProvider||"pawspace_voice_bot"),callRef:body.callRef as string,primaryTag:String(body.primaryTag||""),secondaryTags:Array.isArray(body.tags)?body.tags as string[]:[],crossSellServices:Array.isArray(body.crossSellServices)?body.crossSellServices as string[]:[],callbackAt:body.callbackAt as number,talkTimeSeconds:body.talkTimeSeconds as number,sentiment:body.sentiment as string,notes:body.notes as string,transcriptRef:body.transcriptRef as string,actorId:actor.email}),bindings:bindings.optionalBindings},201);
  }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to record bot call outcome");}
}
