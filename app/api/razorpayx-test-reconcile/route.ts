import {authError,authorize,database,securityAudit} from "../../../lib/server-auth";
import {reconcileRecordedRazorpayXPayout} from "../../../lib/razorpayx-payout-runtime";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
/** Bookkeeping only: this endpoint never dispatches a payout or contacts the provider. */
export async function POST(request:Request){
 try{
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return json({error:"Cross-origin payout reconciliation blocked"},403);
  const actor=await authorize(request,"finance.manage");
  const body=await request.json() as {payoutId?:unknown};
  if(!body||typeof body!=="object"||Array.isArray(body)||typeof body.payoutId!=="string"||!body.payoutId.trim())return json({error:"Choose a payout instruction"},400);
  const payoutId=body.payoutId.trim(),db=await database(),{env}=await import("cloudflare:workers");
  const data=await reconcileRecordedRazorpayXPayout(db,env as unknown as Record<string,unknown>,payoutId);
  const reconciliationRequired=!["awaiting_provider","principal_settled"].includes(data.status);
  await securityAudit(db,actor,"partner.payout.reconcile","payout",payoutId,"completed",{status:data.status,reconciliationRequired,bankStatementReconciled:false,liveMoney:false});
  return json({data:{...data,reconciliationRequired}},reconciliationRequired?202:200);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to reconcile recorded TEST payout");}
}
