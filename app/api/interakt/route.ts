import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{INTERAKT_LINKS,interaktReadiness,listInteraktSends,setInteraktLink,setInteraktTemplate,runInteraktDispatchSweep,dispatchInteraktMessage}from"../../../lib/interakt-whatsapp-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Interakt write blocked",{status:403});}
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Internal ops surface for the Interakt WhatsApp integration: what is configured, what the voice agent
// promised customers, and whether it reached them. The bot's own send goes through /api/haptik
// (action=send_whatsapp) - this route configures and observes, it is not a way to message a customer
// on demand (a dispatch here can only push a message the governed engine already accepted).
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),env=await runtime(),actor=await resolveActor(request);requirePermission(actor,"marketing.view");
    const mode=url.searchParams.get("mode")||"readiness";
    if(mode==="sends")return json({data:await listInteraktSends(db,{linkKey:url.searchParams.get("link")||undefined,limit:Number(url.searchParams.get("limit"))||undefined})});
    if(mode==="links")return json({data:{links:INTERAKT_LINKS}});
    return json({data:await interaktReadiness(db,env)});
  }catch(error){return authError(error,"Unable to load the Interakt integration state");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),env=await runtime(),actor=await resolveActor(request);requirePermission(actor,"communications.manage");
    const body=await request.json().catch(()=>({}))as Record<string,unknown>;
    const action=String(body.action||"").trim();
    if(action==="set_link"){
      const data=await setInteraktLink(db,{linkKey:String(body.linkKey||""),url:String(body.url||""),actorId:actor.email});
      await securityAudit(db,actor,"interakt.set_link","interakt_link",data.linkKey,"completed",{linkKey:data.linkKey,url:data.url});
      return json({data},201);
    }
    if(action==="set_template"){
      const data=await setInteraktTemplate(db,{templateKey:String(body.templateKey||""),linkKey:String(body.linkKey||""),status:body.status as string,language:body.language as string,category:body.category as string,actorId:actor.email});
      await securityAudit(db,actor,"interakt.set_template","interakt_template",data.templateKey,"completed",{...data});
      return json({data},201);
    }
    // Drain the queued messages now instead of waiting for the scheduler sweep. This cannot invent a
    // send: it only dispatches messages the communication engine already queued, and each one is
    // re-checked for consent and template approval inside the dispatcher.
    if(action==="dispatch"){
      const messageId=String(body.messageId||"").trim();
      const data=messageId?await dispatchInteraktMessage(db,env,{messageId}):await runInteraktDispatchSweep(db,{env,limit:Number(body.limit)||undefined});
      await securityAudit(db,actor,"interakt.dispatch","interakt_message",messageId||"sweep","completed",{messageId:messageId||null,...data});
      return json({data});
    }
    return json({error:"Unsupported action. Use set_link | set_template | dispatch"},400);
  }catch(error){return authError(error,"Unable to update the Interakt integration");}
}
