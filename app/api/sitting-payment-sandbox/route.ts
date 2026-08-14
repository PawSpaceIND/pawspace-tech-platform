import{refuseUnlessGatewayPermits}from"../../../lib/api-gateway";
import{database,resolveActor,resolveCustomerForActor}from"../../../lib/server-auth";
import{captureSittingQuoteSandbox}from"../../../lib/sitting-payment-governance";
import{repairSchemaDrift}from"../../../lib/schema-drift-repair";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOriginWrite(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Sitting sandbox payment blocked",{status:403});}
async function failure(error:unknown){if(error instanceof Response){const message=await error.text().catch(()=>"");return json({error:message||"Sitting sandbox payment failed"},error.status||500);}return json({error:error instanceof Error?error.message:"Sitting sandbox payment failed"},500);}

export async function POST(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;try{
 sameOriginWrite(request);const body=await request.json() as {quoteId?:string;amount?:number};const quoteId=String(body.quoteId||"").trim(),amount=Number(body.amount);
 if(!quoteId||!Number.isFinite(amount)||amount<0)return json({error:"Quote and valid amount are required"},400);
 const{env}=await import("cloudflare:workers");if(String((env as unknown as Record<string,unknown>).PAWSPACE_PAYMENT_ENV||"sandbox").toLowerCase()!=="sandbox")return json({error:"Sitting sandbox payment is disabled outside sandbox"},403);
 const db=await database();
 // sitting_commercial_quotes.customer_id is new; a database created before it needs the column added in
 // place, or every capture fails with "no such column: customer_id".
 await repairSchemaDrift(db);
 // Which customer IS the caller? Null for staff, who capture on a customer's behalf - the UAT desk and
 // the prelaunch swarm both do, and both would break if this were read as "unowned".
 const claimFor=await resolveCustomerForActor(db,await resolveActor(request));
 const result=await captureSittingQuoteSandbox(db,{quoteId,amount,claimFor});return json({data:{...result,liveMoney:false,synthetic:true}},201);
}catch(error){return failure(error);}}
