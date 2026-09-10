import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{dispatchRazorpayXSandboxPayout}from"../../../lib/razorpayx-payout-runtime";

type Body={payoutId?:string};
const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin&&origin!==new URL(request.url).origin)throw new Response("Cross-origin RazorpayX TEST dispatch blocked",{status:403});}

export async function POST(request:Request){
 try{
  sameOrigin(request);
  const actor=await authorize(request,"finance.manage"),body=await request.json() as Body,payoutId=String(body.payoutId||"").trim();
  if(!payoutId)return json({error:"Payout ID is required"},400);
  const db=await database(),{env}=await import("cloudflare:workers");
  const data=await dispatchRazorpayXSandboxPayout(db,env as unknown as Record<string,unknown>,{payoutId});
  await securityAudit(db,actor,"partner.payout.razorpayx_test_dispatch","payout",payoutId,data.connected?"completed":"blocked",{source:data.source,providerPayoutId:data.connected?data.providerPayoutId:null,environment:"sandbox",liveMoney:false,reason:data.connected?null:data.reason});
  return json({data},data.connected?200:503);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to dispatch RazorpayX TEST payout");}
}
