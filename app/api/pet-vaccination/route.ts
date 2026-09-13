import{authError,authFailure,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{recordVaccination,listPetVaccinations}from"../../../lib/pet-vaccination-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin vaccination write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=await resolvePlatformSession(db,request);const sessionCustomerId=session?.subjectType==="customer"?String(session.subjectId).trim():"",requested=String(requestedCustomerId??"").trim(),customerId=requested||sessionCustomerId;if(!customerId)throw authFailure("A verified customer sign-in is required. Sign in and try again.",401);if(requested&&sessionCustomerId&&requested!==sessionCustomerId)throw authFailure("Customer ownership denied",403);await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    return json({data:{vaccinations:await listPetVaccinations(db,{customerId,petId:url.searchParams.get("petId")||undefined})}});
  }catch(error){return authError(error,"Unable to load vaccinations");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {customerId?:string;petId?:string;vaccineType?:string;administeredOn?:string;nextDueOn?:string;administeredBy?:string;notes?:string};
    if(!body.petId||!body.vaccineType||!body.administeredOn)return json({error:"Pet, vaccine type and administered date are required"},400);
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    const data=await recordVaccination(db,{petId:body.petId,customerId,vaccineType:body.vaccineType,administeredOn:body.administeredOn,nextDueOn:body.nextDueOn,administeredBy:body.administeredBy,notes:body.notes,actorId:customerId});
    await securityAudit(db,actor,"pet.vaccination.record","customer",customerId,"completed",{petId:body.petId,vaccineType:body.vaccineType});
    return json({data},201);
  }catch(error){return authError(error,"Unable to record vaccination");}
}
