import{authError,authorize,database,securityAudit}from"../../../../../lib/server-auth";
import{eraseCustomerPersonalData}from"../../../../../lib/dpdp-erasure";

type Body={customerId?:string;idempotencyKey?:string;reason?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin privacy erasure write blocked",{status:403});}

export async function POST(request:Request){
 try{
  sameOrigin(request);const actor=await authorize(request,"data.delete"),body=await request.json() as Body,customerId=String(body.customerId||"").trim(),idempotencyKey=String(body.idempotencyKey||"").trim();if(!customerId||!idempotencyKey)return json({error:"Customer ID and idempotency key are required"},400);
  const db=await database(),result=await eraseCustomerPersonalData(db,{customerId,idempotencyKey,requestedBy:actor.email,reason:body.reason});await securityAudit(db,actor,"privacy.dpdp.erasure","customer",result.customerIdHash,"completed",{requestId:result.requestId,ledgerPreserved:result.ledgerPreserved,duplicatePrevented:result.duplicatePrevented,atlasMemoryErased:true,appUserTombstoned:true});return json({data:result},result.duplicatePrevented?200:201);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to process DPDP erasure request");}
}
