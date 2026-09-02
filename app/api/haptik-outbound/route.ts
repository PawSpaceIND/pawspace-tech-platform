import{requestQuietHoursOverride}from"../../../lib/quiet-hours-override";
import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{HAPTIK_CAMPAIGNS,buildOutboundAudience,triggerOutboundCampaign,listOutboundCalls,outboundReadiness,isQuietHours}from"../../../lib/haptik-outbound-governance";
import{haptikOutboundConfigured}from"../../../lib/haptik-outbound-client";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin outbound write blocked",{status:403});}
async function runtime(){const {env}=await import("cloudflare:workers");return env as unknown as Record<string,unknown>;}

// Haptik OUTBOUND trigger side: preview an audience and (human-launched) place voice calls. Fully
// guardrailed - fail-closed on keys, consent-filtered, quiet-hours + frequency-cap enforced.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),env=await runtime(),actor=await resolveActor(request);requirePermission(actor,"marketing.view");
    const mode=url.searchParams.get("mode")||"campaigns";
    if(mode==="calls")return json({data:await listOutboundCalls(db,{campaign:url.searchParams.get("campaign")||undefined,limit:Number(url.searchParams.get("limit"))||undefined})});
    if(mode==="readiness")return json({data:await outboundReadiness(db)});
    if(mode==="audience"){
      const campaign=url.searchParams.get("campaign")||"",limit=Number(url.searchParams.get("limit"))||undefined;
      // A preview reads the audience and returns its SIZE plus masked rows. The console needs to know
      // how many people a launch would call; it does not need, and must not display, their numbers.
      const audience=await buildOutboundAudience(db,{campaign,limit});
      return json({data:{campaign,size:audience.length,audience:audience.map(c=>({contactId:c.contactId,phoneLast4:c.phone.replace(/\D/g,"").slice(-4),name:c.name,context:c.context}))}});
    }
    // The console must be able to state why it cannot dial rather than offering a button that does
    // nothing, so the connection and quiet-hours decisions are returned with the campaign list.
    return json({data:{campaigns:HAPTIK_CAMPAIGNS,readiness:await outboundReadiness(db),connected:haptikOutboundConfigured(env),quietHours:isQuietHours(Date.now())}});
  }catch(error){return authError(error,"Unable to load outbound campaigns");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),env=await runtime(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
    const body=await request.json().catch(()=>({})) as {campaign?:string;limit?:number;force?:boolean;reasonCode?:string;caseReference?:string;reason?:string};
    const campaign=String(body.campaign||"").trim();
    if(!campaign)return json({error:"A campaign is required (new_lead_followup | reactivation | subscription_pitch)"},400);
    /*
     * THE OVERRIDE IS NOW BOUNDED. [PTJA-W2-B4-M06]
     *
     * Measured before: {campaign:"new_lead_followup", limit:5000, force:true} at 03:00 IST passed the
     * quiet-hours gate and continued into the dial loop, and the audit row read outcome 'completed' with
     * nothing saying an override had been used. The earlier fix in this audit made it auditable; the
     * approved decision now bounds it - a permitted reason code, a booking or case reference, a written
     * reason, ONE call attempt, manager permission except for designated emergency roles, and compliance
     * review of repeats. `lead_followup` is named in the forbidden list, so the exact campaign measured
     * can no longer be forced at all.
     */
    let overrideVerdict=null;
    if(body.force){
      overrideVerdict=await requestQuietHoursOverride(db,{actor:{email:actor.email,roleCode:actor.roleCode,permissions:actor.permissions},
        reasonCode:String(body.reasonCode||""),caseReference:String(body.caseReference||""),reason:String(body.reason||""),
        contactCount:Number(body.limit??1),channel:"voice"});
      if(!overrideVerdict.allowed){
        return json({error:"This call cannot override quiet hours",code:overrideVerdict.reason,
          maxContactsPerOverride:overrideVerdict.maxContacts,policyVersion:overrideVerdict.policyVersion},409);
      }
    }
    const data=await triggerOutboundCampaign(db,env,{campaign,limit:body.limit,actorId:actor.email||"marketing",force:Boolean(overrideVerdict?.allowed&&overrideVerdict.overrideUsed)});
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
