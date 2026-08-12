import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{raiseEmergencyRequest,listEmergencyRequests}from"../../../lib/pet-emergency-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin emergency write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    return json({data:{requests:await listEmergencyRequests(db,{customerId})}});
  }catch(error){return authError(error,"Unable to load emergency requests");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {customerId?:string;petId?:string;bookingId?:string;emergencyType?:string;description?:string;cityId?:string;zoneId?:string;locationText?:string};
    if(!body.emergencyType||!body.description||!body.cityId||!body.zoneId)return json({error:"Emergency type, description, city and zone are required"},400);
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    const data=await raiseEmergencyRequest(db,{customerId,petId:body.petId,bookingId:body.bookingId,emergencyType:body.emergencyType,description:body.description,cityId:body.cityId,zoneId:body.zoneId,locationText:body.locationText,actorId:customerId});
    await securityAudit(db,actor,"pet.emergency.raise","customer",customerId,"completed",{emergencyType:body.emergencyType,status:data.status,dispatched:Boolean(data.dispatchedProvider)});
    return json({data},201);
  }catch(error){return authError(error,"Unable to raise emergency request");}
}
