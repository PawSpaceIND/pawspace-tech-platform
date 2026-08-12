import{authError,database,requireCustomerOwnership,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{pawPointsHistory,redeemPoints,grantGoodwillPoints,grantWinbackPoints}from"../../../lib/paw-points-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin PawPoints write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    return json({data:await pawPointsHistory(db,customerId)});
  }catch(error){return authError(error,"Unable to load PawPoints");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {action?:string;customerId?:string;points?:number;bookingId?:string;reason?:string;campaignKey?:string};
    // Staff-gated goodwill / win-back grants
    if(body.action==="grant_goodwill"||body.action==="grant_winback"){
      const db=await database(),actor=await resolveActor(request);requirePermission(actor,"marketing.manage");
      if(!body.customerId||!body.points)return json({error:"Customer and points are required"},400);
      const data=body.action==="grant_winback"
        ?await grantWinbackPoints(db,{customerId:body.customerId,points:body.points,campaignKey:String(body.campaignKey||""),actorId:actor.email})
        :await grantGoodwillPoints(db,{customerId:body.customerId,points:body.points,reason:String(body.reason||""),actorId:actor.email});
      await securityAudit(db,actor,`paw_points.${body.action}`,"customer",body.customerId,"completed",{points:body.points});
      return json({data},201);
    }
    // Customer redemption
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    if(!body.points||!body.bookingId)return json({error:"Points and a booking are required to redeem"},400);
    const data=await redeemPoints(db,{customerId,points:body.points,bookingId:body.bookingId,actorId:customerId});
    await securityAudit(db,actor,"paw_points.redeem","customer",customerId,"completed",{bookingId:body.bookingId,pointsRedeemed:data.pointsRedeemed});
    return json({data},201);
  }catch(error){return authError(error,"Unable to complete PawPoints request");}
}
