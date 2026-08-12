import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{getPetPassport,createPetPassportShare,revokePetPassportShare}from"../../../lib/pet-passport-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin pet passport write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    const petId=String(url.searchParams.get("petId")||"").trim();
    if(!petId)return json({error:"A pet is required"},400);
    return json({data:await getPetPassport(db,{customerId,petId})});
  }catch(error){return authError(error,"Unable to load pet passport");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {action?:string;customerId?:string;petId?:string;token?:string};
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    if(body.action==="revoke_share"){
      if(!body.token)return json({error:"A share token is required"},400);
      const data=await revokePetPassportShare(db,{customerId,token:body.token});
      await securityAudit(db,actor,"pet.passport.share.revoke","customer",customerId,"completed",{token:body.token});
      return json({data},200);
    }
    // default: create (or reuse) a share link
    if(!body.petId)return json({error:"A pet is required"},400);
    const data=await createPetPassportShare(db,{customerId,petId:body.petId,actorId:customerId});
    await securityAudit(db,actor,"pet.passport.share.create","customer",customerId,"completed",{petId:body.petId});
    return json({data},201);
  }catch(error){return authError(error,"Unable to complete pet passport request");}
}
