import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{HAPTIK_CAMPAIGNS,buildOutboundAudience,triggerOutboundCampaign,listOutboundCalls,outboundReadiness}from"../../../lib/haptik-outbound-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin outbound write blocked",{status:403});}
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Haptik OUTBOUND trigger side: preview an audience and (human-launched) place voice calls. Fully
// guardrailed - fail-closed on keys, consent-filtered, quiet-hours + frequency-cap enforced.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.view");
    const mode=url.searchParams.get("mode")||"campaigns";
    if(mode==="calls")return json({data:await listOutboundCalls(db,{campaign:url.searchParams.get("campaign")||undefined,limit:Number(url.searchParams.get("limit"))||undefined})});
    if(mode==="readiness")return json({data:await outboundReadiness(db)});
    if(mode==="audience"){const campaign=url.searchParams.get("campaign")||"";return json({data:{campaign,audience:await buildOutboundAudience(db,{campaign,limit:Number(url.searchParams.get("limit"))||undefined})}});}
    return json({data:{campaigns:HAPTIK_CAMPAIGNS,readiness:await outboundReadiness(db)}});
  }catch(error){return authError(error,"Unable to load outbound campaigns");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),env=await runtime(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
    const body=await request.json().catch(()=>({})) as {campaign?:string;limit?:number;force?:boolean};
    const campaign=String(body.campaign||"").trim();
    if(!campaign)return json({error:"A campaign is required (new_lead_followup | reactivation | subscription_pitch)"},400);
    const data=await triggerOutboundCampaign(db,env,{campaign,limit:body.limit,actorId:actor.email||"marketing",force:Boolean(body.force)});
    // `force` removes the 21:00-09:00 IST quiet-hours bar, and the audit record did not say it had been
    // used - so a campaign dialled in the middle of the night was indistinguishable in the trail from
    // one dialled at noon. It is recorded now. NOT changed here: that a caller-supplied boolean can
    // lift the bar for a bulk run at all. The code's own refusal calls it an override "for an urgent
    // callback", singular, while the same call proceeds over an audience of up to the 5000 clamp -
    // but choosing what force may legitimately cover is a marketing/compliance decision, not one to
    // invent here. It is carried in the audit ledger with this wording as the evidence.
    await securityAudit(db,actor,"haptik_outbound.trigger","haptik_outbound",campaign,data.connected?"completed":"blocked",{campaign,dialled:data.dialled,skipped:data.skipped,failed:data.failed,audience:data.audience,reason:data.reason,quietHoursOverride:Boolean(body.force)});
    return json({data},data.connected?201:200);
  }catch(error){return authError(error,"Unable to trigger outbound campaign");}
}
