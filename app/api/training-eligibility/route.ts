import {authError,database,resolveActor,requirePermission,requireCustomerOwnership} from "../../../lib/server-auth";
import {assertTrainingPetEligibility} from "../../../lib/training-pet-eligibility";
export async function POST(request:Request){
  try {
    const origin=request.headers.get("origin");
    if(origin && origin!==new URL(request.url).origin)return Response.json({error:"This request must come from PawSpace."},{status:403});
    const actor=await resolveActor(request);
    requirePermission(actor,"scheduling.book");
    const body=await request.json().catch(()=>null) as {customerId?:string;petIds?:string[];packageCode?:string}|null;
    if(!body || typeof body.customerId!=="string" || !Array.isArray(body.petIds) || typeof body.packageCode!=="string")return Response.json({error:"Customer, saved dogs and programme are required."},{status:400});
    const db=await database();
    await requireCustomerOwnership(db,actor,body.customerId);
    await assertTrainingPetEligibility(db,{customerId:body.customerId,petIds:body.petIds,packageCode:body.packageCode});
    return Response.json({data:{eligible:true}},{headers:{"cache-control":"no-store"}});
  }catch(error){
    if(error instanceof Response && error.status>=400 && error.status<500)return Response.json({error:await error.text()},{status:error.status,headers:{"cache-control":"no-store"}});
    return authError(error,"Unable to check training eligibility");
  }
}
