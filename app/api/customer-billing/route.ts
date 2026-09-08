import{authError,database,requireCustomerOwnership,resolveActor}from'../../../lib/server-auth';
import{resolvePlatformSession}from'../../../lib/platform-session';
import{readCustomerBilling}from'../../../lib/customer-billing';
export async function GET(request:Request){try{
 const db=await database(),actor=await resolveActor(request),session=await resolvePlatformSession(db,request);
 if(session?.subjectType!=='customer'||!session.subjectId)return Response.json({error:'Sign in to your customer account to view billing.'},{status:401,headers:{'cache-control':'no-store'}});
 await requireCustomerOwnership(db,actor,session.subjectId);
 return Response.json({data:await readCustomerBilling(db,session.subjectId)},{headers:{'cache-control':'no-store'}});
}catch(error){return authError(error,'Unable to load your billing records');}}
