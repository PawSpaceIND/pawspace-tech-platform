import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{savePetBirthday,redeemBirthdayReward,listBirthdayRewards}from"../../../lib/pet-birthday-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin pet birthday write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    return json({data:{rewards:await listBirthdayRewards(db,customerId)}});
  }catch(error){return authError(error,"Unable to load birthday rewards");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {action?:string;customerId?:string;petId?:string;dateOfBirth?:string;code?:string;bookingId?:string};
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    let data:unknown;
    if(body.action==="redeem_reward"){
      if(!body.code||!body.bookingId)return json({error:"Reward code and booking are required"},400);
      data=await redeemBirthdayReward(db,{code:body.code,customerId,bookingId:body.bookingId,actorId:customerId});
    }else{
      if(!body.petId||!body.dateOfBirth)return json({error:"Pet and date of birth are required"},400);
      data=await savePetBirthday(db,{petId:body.petId,customerId,dateOfBirth:body.dateOfBirth,actorId:customerId});
    }
    await securityAudit(db,actor,`pet.birthday.${body.action||"save"}`,"customer",customerId,"completed",{petId:body.petId,code:body.code});
    return json({data},201);
  }catch(error){return authError(error,"Unable to complete birthday request");}
}
