import {razorpayXDispatchNeedsReview} from "./razorpayx-dispatch-notice";
import {prepareRazorpayXPayoutAccounting} from "./razorpayx-payout-accounting";
import {ensureContractorPayoutTables,contractorDispatchGuard} from "./contractor-payout";
import {razorpayXPayoutIdentityProblem} from "./razorpayx-payout-identity";
import{verifyRazorpayRawBody,sha256Hex}from"./financial-lifecycle";
import{createRazorpayXSandboxPayout,razorpayXSandboxReadiness}from"./razorpayx-client";
import{ensureProviderCommissionTables}from"./provider-commission-governance";
import{ensurePartnerSettlementTables}from"./partner-settlement-governance";
import{ensurePayoutBeneficiarySnapshotSchema}from"./payout-beneficiary-verification";

type Db=D1Database;type Env=Record<string,unknown>;type Row=Record<string,unknown>;
export type RazorpayXPayoutSource="commission"|"settlement"|"contractor";
const text=(v:unknown)=>String(v??"").trim();
const number=(v:unknown)=>Number(v??0);
const now=()=>Date.now();

export async function ensureRazorpayXPayoutRuntime(db:Db){
 await ensureProviderCommissionTables(db);await ensurePartnerSettlementTables(db);await ensurePayoutBeneficiarySnapshotSchema(db);await ensureContractorPayoutTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_receipt_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT razorpayx_receipt_current CHECK(ok=1))"),
  db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_payout_provider_state (local_payout_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,booking_id TEXT,statement_id TEXT,provider_id TEXT NOT NULL,amount_paise INTEGER NOT NULL,currency TEXT NOT NULL,fund_account_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,provider_payout_id TEXT UNIQUE,provider_status TEXT,last_utr TEXT,last_error TEXT,last_payload_sha256 TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_webhook_events (event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,provider_payout_id TEXT,payload_sha256 TEXT NOT NULL,processing_status TEXT NOT NULL,reason TEXT,received_at INTEGER NOT NULL,processed_at INTEGER)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_rpx_webhook_payout ON razorpayx_webhook_events(provider_payout_id,received_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_live_reconciliation_holds (local_payout_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,provider_payout_id TEXT,status TEXT NOT NULL CHECK(status IN ('RECONCILIATION_REQUIRED','CLEARED_BY_HUMAN')),automatic_retry_allowed INTEGER NOT NULL DEFAULT 0 CHECK(automatic_retry_allowed=0),failure_reason TEXT NOT NULL,failed_at INTEGER NOT NULL,cleared_by TEXT,cleared_reason TEXT,cleared_at INTEGER,updated_at INTEGER NOT NULL)"),
 ]);
}

function rupeesToPaise(amount:unknown){const value=number(amount);if(!Number.isFinite(value)||value<=0)throw new Error("Payout amount must be greater than zero");const paise=Math.round(value*100);if(Math.abs(value-paise/100)>1e-8||!Number.isSafeInteger(paise)||paise<100)throw new Error("Payout amount must resolve to integer paise of at least 100");return paise;}

async function sourceRow(db:Db,source:RazorpayXPayoutSource,id:string){
 if(source==="commission")return db.prepare("SELECT id,booking_id,NULL statement_id,provider_id,amount,currency,environment,status,razorpayx_fund_account_id,idempotency_key,provider_reference FROM provider_order_payouts WHERE id=?").bind(id).first<Row>();
 return db.prepare(`SELECT id,NULL booking_id,statement_id,provider_id,amount,currency,environment,status,razorpayx_fund_account_id,idempotency_key,provider_reference,last_error FROM ${sourceTable(source)} WHERE id=?`).bind(id).first<Row>();
}
const sourceTable=(source:RazorpayXPayoutSource)=>source==="commission"?"provider_order_payouts":source==="contractor"?"contractor_payout_instructions":"partner_payout_instructions";
const sourceReady=(source:RazorpayXPayoutSource,status:string)=>source==="commission"?["queued_sandbox","retry_pending_sandbox"].includes(status):["approved_sandbox","retry_pending_sandbox"].includes(status);
const sourceTerminal=(status:string)=>["payout_processed_sandbox","paid_sandbox","payout_reversed_sandbox","reversed_sandbox","failed_sandbox"].includes(status);
function providerStatus(status:unknown){const value=text(status).toLowerCase();if(value==="processed")return"processed";if(value==="reversed")return"reversed";if(value==="failed")return"failed";if(value==="queued")return"queued";if(value==="pending")return"pending";if(value==="initiated"||value==="processing")return"processing";return value||"unknown";}
function sourceStatus(source:RazorpayXPayoutSource,status:string){if(status==="processed")return source==="commission"?"payout_processed_sandbox":"paid_sandbox";if(status==="reversed")return source==="commission"?"payout_reversed_sandbox":"reversed_sandbox";if(status==="failed")return"failed_sandbox";if(status==="queued")return"provider_queued_sandbox";if(status==="pending")return"provider_pending_sandbox";return"provider_processing_sandbox";}

async function resolvePayoutSource(db:Db,id:string){
 const sources:RazorpayXPayoutSource[]=["commission","settlement","contractor"],found=[];
 for(const source of sources){const row=await sourceRow(db,source,id);if(row)found.push({source,row});}
 if(found.length>1)throw new Response("Payout identity is ambiguous across finance sources",{status:409});
 return found[0]??null;
}

export async function assertRazorpayXLiveAutomationAllowed(db:Db,payoutId:string){
 await ensureRazorpayXPayoutRuntime(db);const id=text(payoutId);
 const hold=await db.prepare("SELECT status,automatic_retry_allowed,failure_reason FROM razorpayx_live_reconciliation_holds WHERE local_payout_id=?").bind(id).first<Row>();
 if(hold&&text(hold.status)==="RECONCILIATION_REQUIRED")throw new Response("RazorpayX live payout is locked for human reconciliation; automated retry is forbidden",{status:409});
 return{payoutId:id,allowed:true};
}

export async function recordRazorpayXLivePayoutFailure(db:Db,input:{payoutId:string;providerPayoutId?:string|null;reason:string}){
 await ensureRazorpayXPayoutRuntime(db);const id=text(input.payoutId),reason=text(input.reason);if(!id||!reason)throw new Response("Payout id and failure reason are required",{status:400});
 const resolved=await resolvePayoutSource(db,id);if(!resolved)throw new Response("Live payout record not found",{status:404});const{source,row}=resolved;
 if(text(row.environment)!=="live")throw new Response("Live reconciliation quarantine only accepts live payout records",{status:409});
 const providerPayoutId=text(input.providerPayoutId)||text(row.provider_reference)||null,t=now(),table=sourceTable(source),sourceError=source==="settlement"?",last_error=?":"",sourceBinds=source==="settlement"?[reason,t,id]:[t,id];
 const statements=[
  db.prepare(`UPDATE ${table} SET status='RECONCILIATION_REQUIRED'${sourceError},updated_at=? WHERE id=? AND environment='live'`).bind(...sourceBinds),
  db.prepare("INSERT INTO razorpayx_live_reconciliation_holds (local_payout_id,source_type,provider_payout_id,status,automatic_retry_allowed,failure_reason,failed_at,cleared_by,cleared_reason,cleared_at,updated_at) VALUES (?,?,?,'RECONCILIATION_REQUIRED',0,?,?,NULL,NULL,NULL,?) ON CONFLICT(local_payout_id) DO UPDATE SET source_type=excluded.source_type,provider_payout_id=COALESCE(excluded.provider_payout_id,razorpayx_live_reconciliation_holds.provider_payout_id),status='RECONCILIATION_REQUIRED',automatic_retry_allowed=0,failure_reason=excluded.failure_reason,failed_at=excluded.failed_at,cleared_by=NULL,cleared_reason=NULL,cleared_at=NULL,updated_at=excluded.updated_at").bind(id,source,providerPayoutId,reason,t,t),
 ];
 if(source==="commission"){statements.push(db.prepare("UPDATE provider_order_commissions SET status='RECONCILIATION_REQUIRED',updated_at=? WHERE payout_id=?").bind(t,id));}
 else if(text(row.statement_id)){statements.push(db.prepare("UPDATE partner_settlement_statements SET status='held',updated_at=? WHERE id=? AND status IN ('approved','paid','settled')").bind(t,text(row.statement_id)));}
 await db.batch(statements);
 return{payoutId:id,source,status:"RECONCILIATION_REQUIRED" as const,automaticRetryAllowed:false,humanInterventionRequired:true,providerPayoutId,reason};
}

export async function executeRazorpayXLivePayoutGuarded<T>(db:Db,input:{payoutId:string;execute:()=>Promise<T>;providerPayoutId?:(result:T)=>string|null|undefined}){
 const id=text(input.payoutId);await assertRazorpayXLiveAutomationAllowed(db,id);const resolved=await resolvePayoutSource(db,id);if(!resolved)throw new Response("Live payout record not found",{status:404});if(text(resolved.row.environment)!=="live")throw new Response("Guarded live execution only accepts live payout records",{status:409});
 try{return await input.execute();}catch(error){const reason=error instanceof Error?error.message:String(error);await recordRazorpayXLivePayoutFailure(db,{payoutId:id,reason});throw error;}
}

export async function clearRazorpayXLiveReconciliationHold(db:Db,input:{payoutId:string;actorId:string;reason:string}){
 await ensureRazorpayXPayoutRuntime(db);const id=text(input.payoutId),actor=text(input.actorId),reason=text(input.reason);if(!actor||reason.length<8)throw new Response("Human actor and reconciliation reason are required",{status:400});const t=now();
 const changed=await db.prepare("UPDATE razorpayx_live_reconciliation_holds SET status='CLEARED_BY_HUMAN',automatic_retry_allowed=0,cleared_by=?,cleared_reason=?,cleared_at=?,updated_at=? WHERE local_payout_id=? AND status='RECONCILIATION_REQUIRED'").bind(actor,reason,t,t,id).run();
 if(Number(changed.meta?.changes||0)!==1)throw new Response("No live reconciliation hold is awaiting human clearance",{status:409});
 return{payoutId:id,status:"CLEARED_BY_HUMAN" as const,automaticRetryAllowed:false,requeueRequired:true,clearedBy:actor};
}

async function dispatchAccountingReport(db:Db,env:Env,payoutId:string){
 try{const accounting=await reconcileRecordedRazorpayXPayout(db,env,payoutId);return{accounting,reconciliationRequired:razorpayXDispatchNeedsReview({accounting})};}
 catch{
  // The transfer already has a provider identity. Report the bookkeeping exception, never mislabel it as an unsent payout.
  console.error(JSON.stringify({event:"razorpayx_payout_accounting_review",environment:"sandbox",reason:"accounting_exception"}));
  return{accounting:{status:"reconciliation_required",reason:"Accounting could not be confirmed; Finance must recheck the original payout books. Do not send again.",principalOnly:true,bankStatementReconciled:false},reconciliationRequired:true};
 }
}

export async function dispatchRazorpayXSandboxPayout(db:Db,env:Env,input:{payoutId:string}){
 await ensureRazorpayXPayoutRuntime(db);const id=text(input.payoutId),resolved=await resolvePayoutSource(db,id);if(!resolved)throw new Response("Sandbox payout record not found",{status:404});const{source,row}=resolved;
 if(text(row.environment)!=="sandbox")throw new Response("Only sandbox payout records may reach RazorpayX TEST",{status:409});
 const readiness=razorpayXSandboxReadiness(env);if(!readiness.ready)throw new Response(`RazorpayX TEST is not configured: ${readiness.problems.join("; ")}`,{status:503});
 const prior=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(id).first<Row>();
 if(prior&&text(prior.provider_payout_id))return{connected:true as const,duplicatePrevented:true,payoutId:id,source,providerPayoutId:text(prior.provider_payout_id),providerStatus:text(prior.provider_status),...await dispatchAccountingReport(db,env,id),environment:"sandbox",liveMoney:false};
 const status=text(row.status);if(sourceTerminal(status))return{connected:true as const,duplicatePrevented:true,payoutId:id,source,providerPayoutId:text(row.provider_reference)||null,providerStatus:status,...await dispatchAccountingReport(db,env,id),environment:"sandbox",liveMoney:false};
 if(!sourceReady(source,status))throw new Response(`Payout is not ready for RazorpayX TEST dispatch (${status||"unknown"})`,{status:409});
 const fund=text(row.razorpayx_fund_account_id);if(!/^fa_[A-Za-z0-9]+$/.test(fund))throw new Response("Verified RazorpayX TEST fund account is required",{status:409});
 const paise=rupeesToPaise(row.amount),key=text(row.idempotency_key);if(!key)throw new Response("Payout idempotency key is required",{status:409});
 const extra=source==="contractor"?await contractorDispatchGuard(db,id):{sql:"",args:[]};
 const claimed=await db.prepare(`UPDATE ${sourceTable(source)} SET status='provider_dispatching_sandbox',updated_at=? WHERE id=? AND status=? AND environment='sandbox'${extra.sql}`).bind(now(),id,status,...extra.args).run();
 if(Number(claimed.meta?.changes||0)!==1)throw new Response("Another RazorpayX TEST dispatch already owns this payout",{status:409});
 const createdAt=now();await db.prepare("INSERT INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,statement_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,last_utr,last_error,last_payload_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,'dispatching',NULL,NULL,NULL,?,?) ON CONFLICT(local_payout_id) DO UPDATE SET provider_status='dispatching',last_error=NULL,updated_at=excluded.updated_at").bind(id,source,row.booking_id||null,row.statement_id||null,text(row.provider_id),paise,text(row.currency)||"INR",fund,key,createdAt,createdAt).run();
 const result=await createRazorpayXSandboxPayout(env,{localPayoutId:id,bookingId:text(row.booking_id)||null,statementId:text(row.statement_id)||null,providerId:text(row.provider_id),fundAccountId:fund,amountPaise:paise,currency:text(row.currency)||"INR",idempotencyKey:key});
 if(!result.connected){await db.batch([db.prepare(`UPDATE ${sourceTable(source)} SET status='retry_pending_sandbox',${source!=="commission"?"last_error=?,":""}updated_at=? WHERE id=? AND status='provider_dispatching_sandbox'`).bind(...(source!=="commission"?[result.reason,now(),id]:[now(),id])),db.prepare("UPDATE razorpayx_payout_provider_state SET provider_status='retry_pending',last_error=?,updated_at=? WHERE local_payout_id=? AND provider_status='dispatching' AND provider_payout_id IS NULL").bind(result.reason,now(),id)]);const observed=await db.prepare("SELECT provider_payout_id,provider_status FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(id).first<Row>();if(text(observed?.provider_payout_id))return{connected:true as const,duplicatePrevented:false,payoutId:id,source,providerPayoutId:text(observed?.provider_payout_id),providerStatus:text(observed?.provider_status),...await dispatchAccountingReport(db,env,id),environment:"sandbox",liveMoney:false};return{connected:false as const,reason:result.reason,payoutId:id,source,environment:"sandbox",liveMoney:false};}
 const payout=result.payout,providerId=text(payout.id),pStatus=providerStatus(payout.status),next=sourceStatus(source,pStatus),utr=text(payout.utr)||null,hash=await sha256Hex(JSON.stringify(payout));
 await db.batch([db.prepare(`UPDATE ${sourceTable(source)} SET provider_reference=?,status=?,${source!=="commission"?"last_error=NULL,":""}updated_at=? WHERE id=? AND status='provider_dispatching_sandbox'`).bind(providerId,next,now(),id),db.prepare("UPDATE razorpayx_payout_provider_state SET provider_payout_id=?,provider_status=?,last_utr=?,last_error=NULL,last_payload_sha256=?,updated_at=? WHERE local_payout_id=? AND provider_status='dispatching' AND provider_payout_id IS NULL").bind(providerId,pStatus,utr,hash,now(),id)]);
 const observed=await db.prepare("SELECT provider_payout_id,provider_status FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(id).first<Row>();
 const reporting=await dispatchAccountingReport(db,env,id);
 return{connected:true as const,duplicatePrevented:false,payoutId:id,source,providerPayoutId:text(observed?.provider_payout_id)||providerId,providerStatus:text(observed?.provider_status)||pStatus,...reporting,environment:"sandbox",liveMoney:false};
}

export function razorpayXWebhookGate(env:Env){const readiness=razorpayXSandboxReadiness(env),secret=text(env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX);if(!readiness.ready)return{ok:false as const,status:503,reason:`RazorpayX TEST is not configured: ${readiness.problems.join("; ")}`};if(!secret)return{ok:false as const,status:503,reason:"RAZORPAYX_WEBHOOK_SECRET_SANDBOX is not configured"};return{ok:true as const,secret,environment:"sandbox" as const};}
const ALLOWED=new Set(["payout.queued","payout.initiated","payout.processed","payout.reversed"]);
const rank=(status:string)=>status==="reversed"?60:status==="processed"?50:status==="processing"?30:status==="queued"?20:0;

export async function processRazorpayXWebhook(db:Db,env:Env,input:{rawBody:string;signature:string;eventId?:string|null}){
 const gate=razorpayXWebhookGate(env);if(!gate.ok)throw new Response(gate.reason,{status:gate.status});
 if(!input.signature||!await verifyRazorpayRawBody(input.rawBody,input.signature,gate.secret))throw new Response("Invalid RazorpayX webhook signature",{status:401});
 let body:Row;try{body=JSON.parse(input.rawBody) as Row;}catch{throw new Response("Invalid RazorpayX webhook JSON",{status:400});}
 if(!body||typeof body!=="object"||Array.isArray(body))throw new Response("Invalid RazorpayX webhook payload",{status:400});
 const event=text(body.event);if(!ALLOWED.has(event))throw new Response("Unsupported RazorpayX webhook event",{status:400});
 const wrapper=(body.payload as Row|undefined)?.payout as Row|undefined,payout=wrapper?.entity as Row|undefined;
 if(!payout||typeof payout!=="object"||Array.isArray(payout))throw new Response("RazorpayX payout entity is required",{status:400});
 const expectedStatus=event==="payout.initiated"?"processing":event.slice(7);
 if(text(payout.status)!==expectedStatus)throw new Response("RazorpayX event and payout status disagree",{status:400});
 const providerPayoutId=text(payout.id);if(!/^pout_[A-Za-z0-9]+$/.test(providerPayoutId))throw new Response("RazorpayX webhook payout id is required",{status:400});
 const hash=await sha256Hex(input.rawBody),eventId=text(input.eventId)||`${event}:${providerPayoutId}:${hash.slice(0,24)}`;
 await ensureRazorpayXPayoutRuntime(db);
 await db.prepare("INSERT OR IGNORE INTO razorpayx_webhook_events (event_id,event_type,provider_payout_id,payload_sha256,processing_status,received_at) VALUES (?,?,?,?,'RECEIVED',?)").bind(eventId,event,providerPayoutId,hash,now()).run();
 for(let attempt=0;attempt<3;attempt++){
  const seen=await db.prepare("SELECT payload_sha256,processing_status FROM razorpayx_webhook_events WHERE event_id=?").bind(eventId).first<Row>();
  if(!seen||text(seen.payload_sha256)!==hash)throw new Response("RazorpayX event id was replayed with a different payload",{status:409});
  if(text(seen.processing_status)==="PROCESSED")return{ok:true,duplicatePrevented:true,eventId,status:"PROCESSED",environment:"sandbox"};
  if(text(seen.processing_status)==="REJECTED")throw new Response("RazorpayX event requires reconciliation after rejection",{status:409});
  // RECEIVED and UNMATCHED are unfinished work. Never acknowledge them as processed duplicates.
  let state=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE provider_payout_id=?").bind(providerPayoutId).first<Row>();
  const reference=text(payout.reference_id);
  if(!state&&reference)state=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(reference).first<Row>();
  const localId=text(state?.local_payout_id)||reference,resolved=localId?await resolvePayoutSource(db,localId):null;
  if(!resolved){await db.prepare("UPDATE razorpayx_webhook_events SET processing_status='UNMATCHED',reason='unknown_payout',processed_at=NULL WHERE event_id=? AND payload_sha256=? AND processing_status IN ('RECEIVED','UNMATCHED')").bind(eventId,hash).run();return{ok:true,matched:false,eventId,providerPayoutId,environment:"sandbox"};}
  const{source,row}=resolved;
  if(text(row.environment)!=="sandbox")throw new Response("A RazorpayX TEST receipt cannot alter a live payout",{status:409});
  const paise=rupeesToPaise(row.amount),fund=text(row.razorpayx_fund_account_id),currency=text(row.currency);
  const identityProblem=razorpayXPayoutIdentityProblem(payout,{localPayoutId:localId,fundAccountId:fund,amountPaise:paise,currency,providerPayoutId:text(state?.provider_payout_id)||text(row.provider_reference)||null});
  if(identityProblem)throw new Response(identityProblem,{status:409});
  if((text(row.provider_reference)&&text(row.provider_reference)!==providerPayoutId)||!text(row.idempotency_key)||
    (state&&(text(state.source_type)!==source||text(state.provider_id)!==text(row.provider_id)||number(state.amount_paise)!==paise||text(state.currency)!==currency||text(state.fund_account_id)!==fund||text(state.idempotency_key)!==text(row.idempotency_key))))throw new Response("RazorpayX canonical payout identity changed; reconciliation required",{status:409});
  const rowStatus=text(row.status);
  if(!sourceReady(source,rowStatus)&&!sourceTerminal(rowStatus)&&!["provider_dispatching_sandbox","provider_queued_sandbox","provider_pending_sandbox","provider_processing_sandbox"].includes(rowStatus))throw new Response("RazorpayX payout was not authorized for dispatch",{status:409});
  const sourceTerminalStatus=["payout_reversed_sandbox","reversed_sandbox"].includes(rowStatus)?"reversed":["payout_processed_sandbox","paid_sandbox"].includes(rowStatus)?"processed":rowStatus==="failed_sandbox"?"failed":null;
  const current=sourceTerminalStatus||providerStatus(state?.provider_status),nextProvider=expectedStatus;
  const advance=(current==="processed"&&nextProvider==="reversed")||(!["processed","reversed","failed"].includes(current)&&rank(nextProvider)>=rank(current));
  const effective=advance?nextProvider:current,nextSource=sourceStatus(source,effective),utr=text(payout.utr)||text(state?.last_utr)||null;
  const at=now(),assertionId=crypto.randomUUID(),table=sourceTable(source),otherTables=(["commission","settlement","contractor"] as RazorpayXPayoutSource[]).filter(value=>value!==source).map(sourceTable);
  const sourceGuard=`EXISTS(SELECT 1 FROM ${table} WHERE id=? AND environment='sandbox' AND status=? AND provider_id=? AND ABS(amount*100-?)<0.001 AND currency=? AND razorpayx_fund_account_id=? AND idempotency_key=? AND COALESCE(provider_reference,'')=?) ${otherTables.map(other=>`AND NOT EXISTS(SELECT 1 FROM ${other} WHERE id=?)`).join(" ")}`;
  const sourceArgs=[localId,rowStatus,text(row.provider_id),paise,currency,fund,text(row.idempotency_key),text(row.provider_reference),...otherTables.map(()=>localId)];
  const stateGuard=state?"EXISTS(SELECT 1 FROM razorpayx_payout_provider_state WHERE local_payout_id=? AND source_type=? AND provider_id=? AND amount_paise=? AND currency=? AND fund_account_id=? AND idempotency_key=? AND COALESCE(provider_payout_id,'')=? AND COALESCE(provider_status,'')=? AND COALESCE(last_payload_sha256,'')=?)":"NOT EXISTS(SELECT 1 FROM razorpayx_payout_provider_state WHERE local_payout_id=? OR provider_payout_id=?)";
  const stateArgs=state?[localId,source,text(state.provider_id),paise,currency,fund,text(row.idempotency_key),text(state.provider_payout_id),text(state.provider_status),text(state.last_payload_sha256)]:[localId,providerPayoutId];
  const writes:D1PreparedStatement[]=[
   // Optimistic state + source + event guard is inside the same atomic D1 batch as all receipt effects.
   db.prepare(`INSERT INTO razorpayx_receipt_assertions (id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM razorpayx_webhook_events WHERE event_id=? AND payload_sha256=? AND processing_status IN ('RECEIVED','UNMATCHED')) AND ${sourceGuard} AND ${stateGuard} THEN 1 ELSE 0 END`).bind(assertionId,eventId,hash,...sourceArgs,...stateArgs),
   db.prepare("INSERT INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,statement_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,last_utr,last_error,last_payload_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(local_payout_id) DO UPDATE SET provider_payout_id=excluded.provider_payout_id,provider_status=excluded.provider_status,last_utr=excluded.last_utr,last_error=excluded.last_error,last_payload_sha256=excluded.last_payload_sha256,updated_at=excluded.updated_at").bind(localId,source,row.booking_id||null,row.statement_id||null,text(row.provider_id),paise,currency,fund,text(row.idempotency_key),providerPayoutId,effective,utr,["reversed","failed"].includes(effective)?effective:null,hash,number(state?.created_at)||at,at),
   db.prepare(`UPDATE ${table} SET status=?,provider_reference=?,${source!=="commission"?"last_error=?,":""}updated_at=? WHERE id=? AND environment='sandbox'`).bind(...(source!=="commission"?[nextSource,providerPayoutId,["reversed","failed"].includes(effective)?effective:null,at,localId]:[nextSource,providerPayoutId,at,localId])),
  ];
  if(source==="commission"&&text(row.booking_id))writes.push(db.prepare("UPDATE provider_order_commissions SET status=?,updated_at=? WHERE booking_id=?").bind(nextSource,at,text(row.booking_id)));
  if(source==="settlement"&&text(row.statement_id)){
   if(effective==="processed")writes.push(db.prepare("UPDATE partner_settlement_statements SET status='paid',updated_at=? WHERE id=? AND status='approved'").bind(at,text(row.statement_id)));
   if(["reversed","failed"].includes(effective))writes.push(db.prepare("UPDATE partner_settlement_statements SET status='held',updated_at=? WHERE id=? AND status IN ('approved','paid')").bind(at,text(row.statement_id)));
  }
  const accounting=await prepareRazorpayXPayoutAccounting(db,{source,row,status:effective,providerPayoutId,at});
  writes.push(...accounting.statements);
  writes.push(db.prepare("UPDATE razorpayx_webhook_events SET processing_status='PROCESSED',reason=NULL,processed_at=? WHERE event_id=? AND payload_sha256=?").bind(at,eventId,hash),db.prepare("DELETE FROM razorpayx_receipt_assertions WHERE id=?").bind(assertionId));
  try{await db.batch(writes);}catch(error){
   // A concurrent receipt may have won; re-read, recompute the non-regressing state and retry the batch.
   if(/CHECK constraint failed: razorpayx_receipt_current/i.test(error instanceof Error?error.message:String(error)))continue;
   throw error;
  }
  return{ok:true,matched:true,duplicatePrevented:false,eventId,providerPayoutId,localPayoutId:localId,providerStatus:effective,advanced:advance,accounting:{status:accounting.status,principalOnly:true,bankStatementReconciled:false},environment:"sandbox"};
 }
 throw new Response("Concurrent RazorpayX receipt processing requires retry",{status:409});
}

/** Reconcile bookkeeping from already authenticated provider state; never makes another payout or provider request. */
export async function reconcileRecordedRazorpayXPayout(db:Db,env:Env,payoutId:string){
 if(text(env.PAWSPACE_PAYMENT_ENV)!=="sandbox"||text(env.PAWSPACE_RAZORPAYX_ENV)!=="sandbox"||text(env.PAWSPACE_RAZORPAYX_LIVE_APPROVED)!=="false")throw new Response("Recorded payout reconciliation is TEST-only",{status:409});
 await ensureRazorpayXPayoutRuntime(db);
 for(let attempt=0;attempt<3;attempt++){
  const resolved=await resolvePayoutSource(db,payoutId),state=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(payoutId).first<Row>();
  if(!resolved||!state||!text(state.provider_payout_id))return{status:"awaiting_provider",principalOnly:true,bankStatementReconciled:false};
  const {source,row}=resolved,status=providerStatus(state.provider_status);
  if(row.environment!=="sandbox"||text(row.status)!==sourceStatus(source,status)||state.source_type!==source||text(row.provider_reference)!==text(state.provider_payout_id)||text(row.provider_id)!==text(state.provider_id)||rupeesToPaise(row.amount)!==number(state.amount_paise)||text(row.currency)!==text(state.currency)||text(row.razorpayx_fund_account_id)!==text(state.fund_account_id))throw new Response("Recorded payout identity does not reconcile",{status:409});
  const at=now(),plan=await prepareRazorpayXPayoutAccounting(db,{source,row,status,providerPayoutId:text(state.provider_payout_id),at}),guard=crypto.randomUUID();
  const writes=[db.prepare(`INSERT INTO razorpayx_receipt_assertions (id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM razorpayx_payout_provider_state WHERE local_payout_id=? AND provider_status=? AND updated_at=? AND provider_payout_id=?) AND EXISTS(SELECT 1 FROM ${sourceTable(source)} WHERE id=? AND environment='sandbox' AND status=? AND provider_reference=? AND ABS(amount-?)<0.001) THEN 1 ELSE 0 END`).bind(guard,payoutId,state.provider_status,state.updated_at,state.provider_payout_id,payoutId,row.status,row.provider_reference,row.amount),...plan.statements,db.prepare("DELETE FROM razorpayx_receipt_assertions WHERE id=?").bind(guard)];
  try{await db.batch(writes);return{status:plan.status,reason:plan.reason,principalOnly:true,bankStatementReconciled:false};}catch(error){if(/CHECK constraint failed: razorpayx_receipt_current/i.test(error instanceof Error?error.message:String(error)))continue;throw error;}
 }
 throw new Response("Concurrent payout reconciliation requires retry",{status:409});
}
