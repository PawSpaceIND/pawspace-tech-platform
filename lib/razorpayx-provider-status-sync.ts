import {prepareRazorpayXPayoutAccounting} from "./razorpayx-payout-accounting";
import {ensureContractorPayoutTables} from "./contractor-payout";
import {razorpayXPayoutIdentityProblem} from "./razorpayx-payout-identity";
import {sha256Hex} from "./financial-lifecycle";
import {fetchRazorpayXSandboxPayout,razorpayXSandboxReadiness} from "./razorpayx-client";
import {ensureProviderCommissionTables} from "./provider-commission-governance";
import {ensurePartnerSettlementTables} from "./partner-settlement-governance";
import {ensurePayoutBeneficiarySnapshotSchema} from "./payout-beneficiary-verification";

type Db=D1Database;type Env=Record<string,unknown>;type Row=Record<string,unknown>;
type RazorpayXPayoutSource="commission"|"settlement"|"contractor";
const text=(v:unknown)=>String(v??"").trim();
const number=(v:unknown)=>Number(v??0);
const now=()=>Date.now();
const sourceTable=(source:RazorpayXPayoutSource)=>source==="commission"?"provider_order_payouts":source==="contractor"?"contractor_payout_instructions":"partner_payout_instructions";
const sourceReady=(source:RazorpayXPayoutSource,status:string)=>source==="commission"?["queued_sandbox","retry_pending_sandbox"].includes(status):["approved_sandbox","retry_pending_sandbox"].includes(status);
const sourceTerminal=(status:string)=>["payout_processed_sandbox","paid_sandbox","payout_reversed_sandbox","reversed_sandbox","failed_sandbox"].includes(status);
function providerStatus(status:unknown){const value=text(status).toLowerCase();if(value==="processed")return"processed";if(value==="reversed")return"reversed";if(value==="failed")return"failed";if(value==="queued")return"queued";if(value==="pending")return"pending";if(value==="initiated"||value==="processing")return"processing";return value||"unknown";}
function sourceStatus(source:RazorpayXPayoutSource,status:string){if(status==="processed")return source==="commission"?"payout_processed_sandbox":"paid_sandbox";if(status==="reversed")return source==="commission"?"payout_reversed_sandbox":"reversed_sandbox";if(status==="failed")return"failed_sandbox";if(status==="queued")return"provider_queued_sandbox";if(status==="pending")return"provider_pending_sandbox";return"provider_processing_sandbox";}
// Same non-regressing ranks as processRazorpayXWebhook — never invent processed without provider payload.
const rank=(status:string)=>status==="reversed"?60:status==="processed"?50:status==="processing"?30:status==="queued"?20:0;
function rupeesToPaise(amount:unknown){const value=number(amount);if(!Number.isFinite(value)||value<=0)throw new Error("Payout amount must be greater than zero");const paise=Math.round(value*100);if(Math.abs(value-paise/100)>1e-8||!Number.isSafeInteger(paise)||paise<100)throw new Error("Payout amount must resolve to integer paise of at least 100");return paise;}
async function ensureRuntime(db:Db){await ensureProviderCommissionTables(db);await ensurePartnerSettlementTables(db);await ensurePayoutBeneficiarySnapshotSchema(db);await ensureContractorPayoutTables(db);await db.batch([db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_receipt_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT razorpayx_receipt_current CHECK(ok=1))"),db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_payout_provider_state (local_payout_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,booking_id TEXT,statement_id TEXT,provider_id TEXT NOT NULL,amount_paise INTEGER NOT NULL,currency TEXT NOT NULL,fund_account_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,provider_payout_id TEXT UNIQUE,provider_status TEXT,last_utr TEXT,last_error TEXT,last_payload_sha256 TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"]);}async function sourceRow(db:Db,source:RazorpayXPayoutSource,id:string){if(source==="commission")return db.prepare("SELECT id,booking_id,NULL statement_id,provider_id,amount,currency,environment,status,razorpayx_fund_account_id,idempotency_key,provider_reference FROM provider_order_payouts WHERE id=?").bind(id).first<Row>();return db.prepare(`SELECT id,NULL booking_id,statement_id,provider_id,amount,currency,environment,status,razorpayx_fund_account_id,idempotency_key,provider_reference,last_error FROM ${sourceTable(source)} WHERE id=?`).bind(id).first<Row>();}
async function resolvePayoutSource(db:Db,id:string){const sources:RazorpayXPayoutSource[]=["commission","settlement","contractor"],found=[];for(const source of sources){const row=await sourceRow(db,source,id);if(row)found.push({source,row});}if(found.length>1)throw new Response("Payout identity is ambiguous across finance sources",{status:409});return found[0]??null;}

/** Path B: Finance-authenticated TEST recovery that fetches RazorpayX status then advances books. Never creates a payout or fabricates webhooks. */
export async function reconcileRazorpayXProviderStatusFromApi(db:Db,env:Env,input:{payoutId:string;actorId?:string}){
 const readiness=razorpayXSandboxReadiness(env);if(!readiness.ready)throw new Response(`RazorpayX TEST is not configured: ${readiness.problems.join("; ")}`,{status:503});
 if(text(env.PAWSPACE_PAYMENT_ENV)!=="sandbox"||text(env.PAWSPACE_RAZORPAYX_ENV)!=="sandbox"||text(env.PAWSPACE_RAZORPAYX_LIVE_APPROVED)!=="false")throw new Response("Provider-status sync is TEST-only",{status:409});
 await ensureRuntime(db);const payoutId=text(input.payoutId);if(!payoutId)throw new Response("Payout id is required",{status:400});
 for(let attempt=0;attempt<3;attempt++){
  const resolved=await resolvePayoutSource(db,payoutId);if(!resolved)throw new Response("Sandbox payout record not found",{status:404});
  const{source,row}=resolved;if(text(row.environment)!=="sandbox")throw new Response("Provider-status sync cannot alter a live payout",{status:409});
  const state=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(payoutId).first<Row>();
  const providerPayoutId=text(state?.provider_payout_id)||text(row.provider_reference);
  if(!/^pout_[A-Za-z0-9]+$/.test(providerPayoutId))throw new Response("Provider payout id is not recorded; provider-status sync cannot create a payout",{status:409});
  const fetched=await fetchRazorpayXSandboxPayout(env,providerPayoutId);
  if(!fetched.connected)return{connected:false as const,reconciliationRequired:true,payoutId,source,providerPayoutId,environment:"sandbox" as const,liveMoney:false,reason:fetched.reason};
  const payout=fetched.payout;
  const paise=rupeesToPaise(row.amount),fund=text(row.razorpayx_fund_account_id),currency=text(row.currency)||"INR";
  const identityProblem=razorpayXPayoutIdentityProblem(payout,{localPayoutId:payoutId,fundAccountId:fund,amountPaise:paise,currency,providerPayoutId});
  if(identityProblem)throw new Response(identityProblem,{status:409});
  if((text(row.provider_reference)&&text(row.provider_reference)!==text(payout.id))||!text(row.idempotency_key)||
    (state&&(text(state.source_type)!==source||text(state.provider_id)!==text(row.provider_id)||number(state.amount_paise)!==paise||text(state.currency)!==currency||text(state.fund_account_id)!==fund||text(state.idempotency_key)!==text(row.idempotency_key)||(text(state.provider_payout_id)&&text(state.provider_payout_id)!==text(payout.id)))))throw new Response("RazorpayX canonical payout identity changed; reconciliation required",{status:409});
  const incomingRaw=text(payout.status).toLowerCase();
  const allowed=new Set(["queued","pending","initiated","processing","processed","reversed","failed"]);
  if(!allowed.has(incomingRaw))throw new Response("Unsupported RazorpayX payout status for provider-status sync",{status:400});
  const rowStatus=text(row.status);
  if(!sourceReady(source,rowStatus)&&!sourceTerminal(rowStatus)&&!["provider_dispatching_sandbox","provider_queued_sandbox","provider_pending_sandbox","provider_processing_sandbox","retry_pending_sandbox"].includes(rowStatus))throw new Response("RazorpayX payout was not authorized for dispatch",{status:409});
  const sourceTerminalStatus=["payout_reversed_sandbox","reversed_sandbox"].includes(rowStatus)?"reversed":["payout_processed_sandbox","paid_sandbox"].includes(rowStatus)?"processed":rowStatus==="failed_sandbox"?"failed":null;
  const current=sourceTerminalStatus||providerStatus(state?.provider_status),nextProvider=providerStatus(incomingRaw);
  const advance=(current==="processed"&&nextProvider==="reversed")||(!["processed","reversed","failed"].includes(current)&&rank(nextProvider)>=rank(current));
  const effective=advance?nextProvider:current,nextSource=sourceStatus(source,effective),utr=text(payout.utr)||text(state?.last_utr)||null;
  const at=now(),assertionId=crypto.randomUUID(),table=sourceTable(source),otherTables=(["commission","settlement","contractor"] as RazorpayXPayoutSource[]).filter(value=>value!==source).map(sourceTable);
  const hash=await sha256Hex(JSON.stringify(payout));
  const sourceGuard=`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND environment='sandbox' AND status=? AND provider_id=? AND ABS(amount*100-?)<0.001 AND currency=? AND razorpayx_fund_account_id=? AND idempotency_key=? AND COALESCE(provider_reference,'')=?) ${otherTables.map(other=>`AND NOT EXISTS(SELECT 1 FROM ${other} WHERE id=?)`).join(" ")}`;
  const sourceArgs=[payoutId,rowStatus,text(row.provider_id),paise,currency,fund,text(row.idempotency_key),text(row.provider_reference),...otherTables.map(()=>payoutId)];
  const stateGuard=state?"EXISTS(SELECT 1 FROM razorpayx_payout_provider_state WHERE local_payout_id=? AND source_type=? AND provider_id=? AND amount_paise=? AND currency=? AND fund_account_id=? AND idempotency_key=? AND COALESCE(provider_payout_id,'')=? AND COALESCE(provider_status,'')=? AND COALESCE(last_payload_sha256,'')=?)":"NOT EXISTS(SELECT 1 FROM razorpayx_payout_provider_state WHERE local_payout_id=? OR provider_payout_id=?)";
  const stateArgs=state?[payoutId,source,text(state.provider_id),paise,currency,fund,text(row.idempotency_key),text(state.provider_payout_id),text(state.provider_status),text(state.last_payload_sha256)]:[payoutId,text(payout.id)];
  const writes:D1PreparedStatement[]=[
   db.prepare(`INSERT INTO razorpayx_receipt_assertions (id,ok) SELECT ?,CASE WHEN ${sourceGuard} AND ${stateGuard} THEN 1 ELSE 0 END`).bind(assertionId,...sourceArgs,...stateArgs),
   db.prepare("INSERT INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,statement_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,last_utr,last_error,last_payload_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_payout_id) DO UPDATE SET provider_payout_id=excluded.provider_payout_id,provider_status=excluded.provider_status,last_utr=excluded.last_utr,last_error=excluded.last_error,last_payload_sha256=excluded.last_payload_sha256,updated_at=excluded.updated_at").bind(payoutId,source,row.booking_id||null,row.statement_id||null,text(row.provider_id),paise,currency,fund,text(row.idempotency_key),text(payout.id),effective,utr,["reversed","failed"].includes(effective)?effective:null,hash,number(state?.created_at)||at,at),
   db.prepare(`UPDATE ${table} SET status=?,provider_reference=?,${source!=="commission"?"last_error=?,":""}updated_at=? WHERE id=? AND environment='sandbox'`).bind(...(source!=="commission"?[nextSource,text(payout.id),["reversed","failed"].includes(effective)?effective:null,at,payoutId]:[nextSource,text(payout.id),at,payoutId])),
  ];
  if(source==="commission"&&text(row.booking_id))writes.push(db.prepare("UPDATE provider_order_commissions SET status=?,updated_at=? WHERE booking_id=?").bind(nextSource,at,text(row.booking_id)));
  if(source==="settlement"&&text(row.statement_id)){
   if(effective==="processed")writes.push(db.prepare("UPDATE partner_settlement_statements SET status='paid',updated_at=? WHERE id=? AND status='approved'").bind(at,text(row.statement_id)));
   if(["reversed","failed"].includes(effective))writes.push(db.prepare("UPDATE partner_settlement_statements SET status='held',updated_at=? WHERE id=? AND status IN ('approved','paid')").bind(at,text(row.statement_id)));
  }
  const accounting=await prepareRazorpayXPayoutAccounting(db,{source,row,status:effective,providerPayoutId:text(payout.id),at});
  writes.push(...accounting.statements,db.prepare("DELETE FROM razorpayx_receipt_assertions WHERE id=?").bind(assertionId));
  try{await db.batch(writes);}catch(error){if(/CHECK constraint failed: razorpayx_receipt_current/i.test(error instanceof Error?error.message:String(error)))continue;throw error;}
  return{connected:true as const,duplicatePrevented:!advance&&effective===current,payoutId,source,providerPayoutId:text(payout.id),providerStatus:effective,advanced:advance,accounting:{status:accounting.status,reason:accounting.reason,principalOnly:true,bankStatementReconciled:false},reconciliationRequired:!["awaiting_provider","principal_settled"].includes(accounting.status),environment:"sandbox" as const,liveMoney:false};
 }
 throw new Response("Concurrent provider-status sync requires retry",{status:409});
}
