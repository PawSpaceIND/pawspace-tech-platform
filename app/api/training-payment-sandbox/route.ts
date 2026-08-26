import{authError,database}from"../../../lib/server-auth";
import{sandboxCapabilitiesUnlocked}from"../../../lib/payment-environment";
import{captureTrainingQuoteSandbox}from"../../../lib/training-commercial-governance";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOriginWrite(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin Training sandbox payment blocked",{status:403});}
async function failure(error:unknown){if(error instanceof Response&&error.status>=400&&error.status<500){const message=await error.text().catch(()=>"");return json({error:message||"Training sandbox payment failed"},error.status);}return authError(error,"Training sandbox payment failed");}

export async function POST(request:Request){try{
 sameOriginWrite(request);const paymentKey=String(request.headers.get("x-payment-capture-key")||"").trim();if(!paymentKey)return json({error:"MISSING_CAPTURE_KEY"},400);
 const body=await request.json() as {quoteId?:string;amount?:number};const quoteId=String(body.quoteId||"").trim(),amount=Number(body.amount);
 if(!quoteId||!Number.isFinite(amount)||amount<0)return json({error:"Quote and valid amount are required"},400);
 const{env}=await import("cloudflare:workers");if(!sandboxCapabilitiesUnlocked(env as unknown as Record<string,unknown>))return json({error:"Training sandbox payment is disabled unless PAWSPACE_PAYMENT_ENV is explicitly set to sandbox"},403);
 const result=await captureTrainingQuoteSandbox(await database(),{quoteId,amount,paymentKey});return json({data:{...result,liveMoney:false,synthetic:true}},201);
}catch(error){return failure(error);}}
