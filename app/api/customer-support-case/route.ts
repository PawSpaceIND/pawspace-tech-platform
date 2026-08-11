import{authError,database,requireCustomerOwnership,resolveActor,securityAudit}from"../../../lib/server-auth";
import{resolvePlatformSession}from"../../../lib/platform-session";
import{listCustomerComplaints,submitCustomerComplaint}from"../../../lib/customer-support-case";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin support case write blocked",{status:403});}
async function ownedContext(request:Request,requestedCustomerId?:string){const db=await database(),actor=await resolveActor(request),session=requestedCustomerId?null:await resolvePlatformSession(db,request);const customerId=String(requestedCustomerId||(session?.subjectType==="customer"?session.subjectId:"")).trim();if(!customerId)throw new Response("Verified customer identity is required",{status:401});await requireCustomerOwnership(db,actor,customerId);return{db,actor,customerId};}

export async function GET(request:Request){
  try{
    const url=new URL(request.url),{db,customerId}=await ownedContext(request,url.searchParams.get("customerId")||undefined);
    const cases=await listCustomerComplaints(db,customerId);
    return json({data:{cases}});
  }catch(error){return authError(error,"Unable to load your reported issues");}
}

export async function POST(request:Request){
  try{
    sameOrigin(request);
    const body=await request.json() as {customerId?:string;bookingId?:string;title?:string;description?:string};
    if(!body.title||!body.description)return json({error:"A title and description are required"},400);
    const{db,actor,customerId}=await ownedContext(request,body.customerId);
    const result=await submitCustomerComplaint(db,{customerId,bookingId:body.bookingId||null,title:body.title,description:body.description});
    await securityAudit(db,actor,"customer.complaint.submit","customer",customerId,"completed",{bookingId:body.bookingId||null,caseId:(result.case as{id?:string})?.id});
    return json({data:result},result.duplicatePrevented?200:201);
  }catch(error){return authError(error,"Unable to submit your report");}
}
