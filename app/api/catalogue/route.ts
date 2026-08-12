import{authError,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{createCataloguePackage,updateCataloguePackage,listCataloguePackages}from"../../../lib/catalogue-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin catalogue write blocked",{status:403});}

// Generalized catalogue: create/update packages + prices for ANY service, city/zone-wise.
export async function GET(request:Request){
  try{
    const url=new URL(request.url),db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.view");
    return json({data:await listCataloguePackages(db,{serviceCode:url.searchParams.get("serviceCode")||undefined,cityId:url.searchParams.get("cityId")||undefined,includeInactive:url.searchParams.get("includeInactive")==="1"})});
  }catch(error){return authError(error,"Unable to load catalogue");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.manage");
    const body=await request.json().catch(()=>({})) as Record<string,unknown>;
    const data=await createCataloguePackage(db,{serviceCode:String(body.serviceCode||""),packageCode:String(body.packageCode||""),cityId:body.cityId as string,zoneId:body.zoneId as string,name:String(body.name||""),description:body.description as string,basePrice:Number(body.basePrice),currency:body.currency as string,taxInclusive:body.taxInclusive as boolean,slotMinutes:body.slotMinutes as number,blockingMinutes:body.blockingMinutes as number,effectiveFrom:body.effectiveFrom as string,effectiveTo:body.effectiveTo as string,reason:body.reason as string,actorId:actor.email});
    await securityAudit(db,actor,"catalogue.create_package","catalogue_package",data.id,"completed",{serviceCode:data.serviceCode,packageCode:data.packageCode,cityId:data.cityId});
    return json({data},201);
  }catch(error){return authError(error,"Unable to create package");}
}

export async function PATCH(request:Request){
  try{
    sameOrigin(request);
    const db=await database(),actor=await resolveActor(request);requirePermission(actor,"pricing.manage");
    const body=await request.json().catch(()=>({})) as {id?:string;changes?:Record<string,unknown>;reason?:string};
    if(!body.id)return json({error:"Package id is required"},400);
    const data=await updateCataloguePackage(db,{id:body.id,changes:body.changes||{},reason:String(body.reason||""),actorId:actor.email});
    await securityAudit(db,actor,"catalogue.update_package","catalogue_package",body.id,"completed",{changes:Object.keys(body.changes||{})});
    return json({data});
  }catch(error){return authError(error,"Unable to update package");}
}
