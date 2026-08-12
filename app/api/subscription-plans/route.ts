import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{createSubscriptionPlan,updateSubscriptionPlan,listSubscriptionPlans}from"../../../lib/subscription-plan-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin plan write blocked",{status:403});}

// Service-agnostic subscription plans: create/update for ANY service, city-wise, with validity/expiry.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.view");
    return json({data:await listSubscriptionPlans(db,{serviceCode:url.searchParams.get("serviceCode")||undefined,cityId:url.searchParams.get("cityId")||undefined,includeInactive:url.searchParams.get("includeInactive")==="1"})});
  }catch(error){return authError(error,"Unable to load subscription plans");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.manage");
    const b=await request.json().catch(()=>({})) as Record<string,unknown>;
    const data=await createSubscriptionPlan(db,{serviceCode:String(b.serviceCode||""),planCode:String(b.planCode||""),cityId:String(b.cityId||""),zoneId:b.zoneId as string,name:String(b.name||""),price:Number(b.price),currency:b.currency as string,sessionCount:Number(b.sessionCount),validityValue:Number(b.validityValue),validityUnit:String(b.validityUnit||"months") as "days"|"months",servicePackageCode:String(b.servicePackageCode||""),eligiblePetTypes:b.eligiblePetTypes as string[],maxPetsPerBooking:b.maxPetsPerBooking as number,creditsPerPet:b.creditsPerPet as number,familyWallet:b.familyWallet as boolean,pauseDays:b.pauseDays as number,graceDays:b.graceDays as number,renewalWindowDays:b.renewalWindowDays as number,benefits:b.benefits as unknown[],terms:b.terms as Record<string,unknown>,effectiveFrom:b.effectiveFrom as string,effectiveTo:b.effectiveTo as string,reason:b.reason as string,actorId:actor.email});
    await securityAudit(db,actor,"subscription_plan.create","subscription_plan",data.id,"completed",{serviceCode:data.serviceCode,planCode:data.planCode,cityId:data.cityId});
    return json({data},201);
  }catch(error){return authError(error,"Unable to create subscription plan");}
}

export async function PATCH(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.manage");
    const body=await request.json().catch(()=>({})) as {id?:string;changes?:Record<string,unknown>;reason?:string};
    if(!body.id)return json({error:"Plan id is required"},400);
    const data=await updateSubscriptionPlan(db,{id:body.id,changes:body.changes||{},reason:String(body.reason||""),actorId:actor.email});
    await securityAudit(db,actor,"subscription_plan.update","subscription_plan",body.id,"completed",{changes:Object.keys(body.changes||{})});
    return json({data});
  }catch(error){return authError(error,"Unable to update subscription plan");}
}
