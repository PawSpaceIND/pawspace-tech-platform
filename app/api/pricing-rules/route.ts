import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{createPricingRule,listPricingRules,addHoliday,seedNationalHolidays,listHolidays,suggestSurcharge,applySurchargeSuggestion}from"../../../lib/pricing-rule-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin pricing write blocked",{status:403});}

// City/zone-wise dynamic pricing rules + holiday/long-weekend surcharge auto-suggest.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.view");
    const mode=url.searchParams.get("mode")||"rules";
    if(mode==="holidays")return json({data:await listHolidays(db,{region:url.searchParams.get("region")||undefined,year:url.searchParams.has("year")?Number(url.searchParams.get("year")):undefined})});
    if(mode==="suggest"){const data=await suggestSurcharge(db,{region:url.searchParams.get("region")||undefined,year:Number(url.searchParams.get("year"))||new Date().getUTCFullYear(),serviceCode:url.searchParams.get("serviceCode")||"boarding",cityId:url.searchParams.get("cityId")||"blr",zoneId:url.searchParams.get("zoneId")||undefined,adjustmentPercent:url.searchParams.has("pct")?Number(url.searchParams.get("pct")):undefined});return json({data});}
    return json({data:await listPricingRules(db,{serviceCode:url.searchParams.get("serviceCode")||undefined,cityId:url.searchParams.get("cityId")||undefined})});
  }catch(error){return authError(error,"Unable to load pricing rules");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.manage");
    const b=await request.json().catch(()=>({})) as Record<string,unknown>;
    const action=String(b.action||"").trim();
    if(action==="create_rule"){const data=await createPricingRule(db,{name:String(b.name||""),serviceCode:String(b.serviceCode||""),packageCode:b.packageCode as string,cityId:String(b.cityId||""),zoneId:b.zoneId as string,ruleType:String(b.ruleType||""),days:b.days as number[],startTime:b.startTime as string,endTime:b.endTime as string,effectiveFrom:String(b.effectiveFrom||""),effectiveTo:b.effectiveTo as string,adjustmentType:String(b.adjustmentType||"percent"),adjustmentValue:Number(b.adjustmentValue),couponPolicy:b.couponPolicy as string,priority:b.priority as number,actorId:actor.email});await securityAudit(db,actor,"pricing_rule.create","pricing_rule",data.id,"completed",{serviceCode:data.serviceCode,cityId:data.cityId,ruleType:data.ruleType});return json({data},201);}
    if(action==="add_holiday"){const data=await addHoliday(db,{region:String(b.region||"IN"),date:String(b.date||""),name:String(b.name||""),actorId:actor.email});return json({data},201);}
    if(action==="seed_holidays"){const data=await seedNationalHolidays(db,{year:Number(b.year),region:b.region as string,actorId:actor.email});return json({data},201);}
    if(action==="apply_suggestion"){const data=await applySurchargeSuggestion(db,{name:String(b.name||""),serviceCode:String(b.serviceCode||""),cityId:String(b.cityId||""),zoneId:b.zoneId as string,startDate:String(b.startDate||""),endDate:String(b.endDate||""),adjustmentPercent:Number(b.adjustmentPercent),priority:b.priority as number,actorId:actor.email});await securityAudit(db,actor,"pricing_rule.apply_suggestion","pricing_rule",data.id,"completed",{serviceCode:data.serviceCode,cityId:data.cityId,window:`${b.startDate}..${b.endDate}`});return json({data},201);}
    return json({error:"Unsupported action. Use create_rule | add_holiday | seed_holidays | apply_suggestion"},400);
  }catch(error){return authError(error,"Unable to update pricing rules");}
}
