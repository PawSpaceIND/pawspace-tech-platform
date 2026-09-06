import{authError,database,requireCustomerOwnership,resolveActor}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{listAvailableCoupons}from"../../../lib/customer-offers";

export async function GET(request:Request){try{const db=await database(),actor=await resolveActor(request),session=await resolvePlatformSession(db,request).catch(()=>null),requested=new URL(request.url).searchParams.get("customerId"),customerId=String(requested||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)return Response.json({error:"Verified customer identity is required"},{status:401});await requireCustomerOwnership(db,actor,customerId);const offers=await listAvailableCoupons(db,{customerId});return Response.json({data:offers},{headers:{"cache-control":"no-store"}});}catch(error){return authError(error,"Unable to load offers");}}
