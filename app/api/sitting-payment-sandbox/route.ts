import{refuseUnlessGatewayPermits}from"../../../lib/api-gateway";
import{database}from"../../../lib/server-auth";
import{captureSittingQuoteSandbox}from"../../../lib/sitting-payment-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOriginWrite(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Sitting sandbox payment blocked",{status:403});}
async function failure(error:unknown){if(error instanceof Response){const message=await error.text().catch(()=>"");return json({error:message||"Sitting sandbox payment failed"},error.status||500);}return json({error:error instanceof Error?error.message:"Sitting sandbox payment failed"},500);}

export async function POST(request:Request){const denied=await refuseUnlessGatewayPermits(request);if(denied)return denied;try{
 sameOriginWrite(request);const body=await request.json() as {quoteId?:string;amount?:number};const quoteId=String(body.quoteId||"").trim(),amount=Number(body.amount);
 if(!quoteId||!Number.isFinite(amount)||amount<0)return json({error:"Quote and valid amount are required"},400);
 const{env}=await import("cloudflare:workers");if(String((env as unknown as Record<string,unknown>).PAWSPACE_PAYMENT_ENV||"sandbox").toLowerCase()!=="sandbox")return json({error:"Sitting sandbox payment is disabled outside sandbox"},403);
 const result=await captureSittingQuoteSandbox(await database(),{quoteId,amount});return json({data:{...result,liveMoney:false,synthetic:true}},201);
}catch(error){return failure(error);}}
