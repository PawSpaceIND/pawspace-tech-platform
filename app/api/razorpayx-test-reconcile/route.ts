import {authError,authorize,database,securityAudit} from "../../../lib/server-auth";
import {reconcileRecordedRazorpayXPayout} from "../../../lib/razorpayx-payout-runtime";
import {reconcileRazorpayXProviderStatusFromApi} from "../../../lib/razorpayx-provider-status-sync";

const json=(value:unknown,status=200)=>Response.json(value,{status,headers:{"cache-control":"no-store"}});
type Body={payoutId?:unknown;action?:unknown};
/** Default action is bookkeeping-only. action=sync_provider_status fetches RazorpayX TEST status (Path B) without creating a payout or forging webhooks. */
export async function POST(request:Request){
 try{
  const origin=request.headers.get("origin");
  if(origin&&origin!==new URL(request.url).origin)return json({error:"Cross-origin payout reconciliation blocked"},403);
  const actor=await authorize(request,"finance.manage");
  const body=await request.json() as Body;
  if(!body||typeof body!=="object"||Array.isArray(body)||typeof body.payoutId!=="string"||!body.payoutId.trim())return json({error:"Choose a payout instruction"},400);
  const payoutId=body.payoutId.trim(),action=typeof body.action==="string"?body.action.trim():"reconcile_books";
  const db=await database(),{env}=await import("cloudflare:workers");
  const envRecord=env as unknown as Record<string,unknown>;
  if(action==="sync_provider_status"){
   const data=await reconcileRazorpayXProviderStatusFromApi(db,envRecord,{payoutId,actorId:actor.email});
   const reconciliationRequired=Boolean(data.reconciliationRequired)||(data.connected?!["awaiting_provider","principal_settled"].includes(String(data.accounting?.status||"")):true);
   await securityAudit(db,actor,"partner.payout.provider_status_sync","payout",payoutId,data.connected?"completed":"blocked",{source:data.source,providerPayoutId:data.providerPayoutId,providerStatus:data.connected?data.providerStatus:null,advanced:data.connected?data.advanced:false,accountingStatus:data.connected?data.accounting?.status:null,reconciliationRequired,connected:data.connected,liveMoney:false,environment:"sandbox"});
   return json({data:{...data,reconciliationRequired}},data.connected?(reconciliationRequired?202:200):503);
  }
  if(action!=="reconcile_books"&&action!=="reconcile_payout_books")return json({error:"Unsupported reconciliation action"},400);
  // Bookkeeping only: this path never dispatches a payout or contacts the provider.
  const data=await reconcileRecordedRazorpayXPayout(db,envRecord,payoutId);
  const reconciliationRequired=!["awaiting_provider","principal_settled"].includes(data.status);
  await securityAudit(db,actor,"partner.payout.reconcile","payout",payoutId,"completed",{status:data.status,reconciliationRequired,bankStatementReconciled:false,liveMoney:false});
  return json({data:{...data,reconciliationRequired}},reconciliationRequired?202:200);
 }catch(error){if(error instanceof Response)return json({error:await error.text()},error.status);return authError(error,"Unable to reconcile recorded TEST payout");}
}
