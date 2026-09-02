import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{GROOMING_COAT_TYPES,GROOMING_SIZE_CLASSES,GROOMING_SPECIES,groomingPackageBriefing,listGroomingPackageRules,recommendGroomingPackage,upsertGroomingPackageRule}from"../../../lib/grooming-package-advisor";
import{HAPTIK_INQUIRY_CATEGORIES,haptikInboundSummary,listHaptikTransferTargets,setHaptikTransferTarget}from"../../../lib/haptik-inbound-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Haptik config write blocked",{status:403});}

// Everything the voice agents read but only PawSpace may write: which grooming package suits which
// pet, where a live call may be transferred, and what the inbound agent has been capturing. The bot
// reaches these through /api/haptik with its own key; this route is the staff side.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.view");
    const mode=url.searchParams.get("mode")||"briefing";
    if(mode==="rules")return json({data:{rules:await listGroomingPackageRules(db,{includeInactive:url.searchParams.get("includeInactive")==="1"}),vocabulary:{species:GROOMING_SPECIES,coatTypes:GROOMING_COAT_TYPES,sizeClasses:GROOMING_SIZE_CLASSES}}});
    if(mode==="transfers")return json({data:{targets:await listHaptikTransferTargets(db)}});
    if(mode==="inbound")return json({data:await haptikInboundSummary(db,{since:Number(url.searchParams.get("since"))||0,limit:Number(url.searchParams.get("limit"))||undefined})});
    if(mode==="categories")return json({data:{categories:HAPTIK_INQUIRY_CATEGORIES}});
    // A dry run of the recommendation the bot would give, so a rule change can be checked against a
    // real pet before a customer hears the answer.
    if(mode==="recommend")return json({data:await recommendGroomingPackage(db,{species:url.searchParams.get("species")||undefined,breed:url.searchParams.get("breed")||undefined,coatType:url.searchParams.get("coatType")||undefined,sizeClass:url.searchParams.get("sizeClass")||undefined,ageMonths:Number(url.searchParams.get("ageMonths"))||undefined,cityId:url.searchParams.get("city")||undefined})});
    return json({data:await groomingPackageBriefing(db,{cityId:url.searchParams.get("city")||undefined})});
  }catch(error){return authError(error,"Unable to load the Haptik configuration");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);
    const body=await request.json().catch(()=>({}))as Record<string,unknown>;
    const action=String(body.action||"").trim();
    if(action==="upsert_rule"){
      // A recommendation rule decides what a customer is offered and therefore charged, so it sits
      // behind the same permission as the rest of grooming commercial policy.
      requirePermission(actor,"grooming.manage");
      const data=await upsertGroomingPackageRule(db,{ruleCode:String(body.ruleCode||""),species:body.species as string,coatType:body.coatType as string,sizeClass:body.sizeClass as string,minAgeMonths:body.minAgeMonths as number,maxAgeMonths:body.maxAgeMonths as number,breedPattern:body.breedPattern as string,packageCode:String(body.packageCode||""),priority:body.priority as number,active:body.active as boolean,notes:body.notes as string,actorId:actor.email});
      await securityAudit(db,actor,"haptik_config.upsert_rule","grooming_package_rule",data.ruleCode,"completed",{...data});
      return json({data},201);
    }
    if(action==="set_transfer_target"){
      requirePermission(actor,"communications.manage");
      const data=await setHaptikTransferTarget(db,{queueCode:String(body.queueCode||""),label:String(body.label||""),destination:String(body.destination||""),active:body.active as boolean,actorId:actor.email});
      await securityAudit(db,actor,"haptik_config.set_transfer_target","haptik_transfer_target",data.queueCode,"completed",{queueCode:data.queueCode,label:data.label,destinationLast4:data.destinationLast4,active:data.active});
      return json({data},201);
    }
    return json({error:"Unsupported action. Use upsert_rule | set_transfer_target"},400);
  }catch(error){return authError(error,"Unable to update the Haptik configuration");}
}
