import{verifyRazorpayRawBody,sha256Hex}from"./financial-lifecycle";
import{createRazorpayXSandboxPayout,razorpayXSandboxReadiness}from"./razorpayx-client";
import{ensureProviderCommissionTables}from"./provider-commission-governance";
import{ensurePartnerSettlementTables}from"./partner-settlement-governance";
import{ensurePayoutBeneficiarySnapshotSchema}from"./payout-beneficiary-verification";

type Db=D1Database;type Env=Record<string,unknown>;type Row=Record<string,unknown>;
export type RazorpayXPayoutSource="commission"|"settlement";
const text=(v:unknown)=>String(v??"").trim();
const number=(v:unknown)=>Number(v??0);
const now=()=>Date.now();

export async function ensureRazorpayXPayoutRuntime(db:Db){
 await ensureProviderCommissionTables(db);await ensurePartnerSettlementTables(db);await ensurePayoutBeneficiarySnapshotSchema(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_payout_provider_state (local_payout_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,booking_id TEXT,statement_id TEXT,provider_id TEXT NOT NULL,amount_paise INTEGER NOT NULL,currency TEXT NOT NULL,fund_account_id TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,provider_payout_id TEXT UNIQUE,provider_status TEXT,last_utr TEXT,last_error TEXT,last_payload_sha256 TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_webhook_events (event_id TEXT PRIMARY KEY,event_type TEXT NOT NULL,provider_payout_id TEXT,payload_sha256 TEXT NOT NULL,processing_status TEXT NOT NULL,reason TEXT,received_at INTEGER NOT NULL,processed_at INTEGER)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_rpx_webhook_payout ON razorpayx_webhook_events(provider_payout_id,received_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_live_reconciliation_holds (local_payout_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,provider_payout_id TEXT,status TEXT NOT NULL CHECK(status IN ('RECONCILIATION_REQUIRED','CLEARED_BY_HUMAN')),automatic_retry_allowed INTEGER NOT NULL DEFAULT 0 CHECK(automatic_retry_allowed=0),failure_reason TEXT NOT NULL,failed_at INTEGER NOT NULL,cleared_by TEXT,cleared_reason TEXT,cleared_at INTEGER,updated_at INTEGER NOT NULL)"),
 ]);
}

function rupeesToPaise(amount:unknown){const value=number(amount);if(!Number.isFinite(value)||value<=0)throw new Error("Payout amount must be greater than zero");const paise=Math.round(value*100);if(Math.abs(value-paise/100)>1e-8||!Number.isSafeInteger(paise)||paise<100)throw new Error("Payout amount must resolve to integer paise of at least 100");return paise;}

async function sourceRow(db:Db,source:RazorpayXPayoutSource,id:string){
 if(source==="commission")return db.prepare("SELECT id,booking_id,NULL statement_id,provider_id,amount,currency,environment,status,razorpayx_fund_account_id,idempotency_key,provider_reference FROM provider_order_payouts WHERE id=?").bind(id).first<Row>();
 return db.prepare("SELECT id,NULL booking_id,statement_id,provider_id,amount,currency,environment,status,razorpayx_fund_account_id,idempotency_key,provider_reference,last_error FROM partner_payout_instructions WHERE id=?").bind(id).first<Row>();
}
const sourceTable=(source:RazorpayXPayoutSource)=>source==="commission"?"provider_order_payouts":"partner_payout_instructions";
const sourceReady=(source:RazorpayXPayoutSource,status:string)=>source==="commission"?["queued_sandbox","retry_pending_sandbox"].includes(status):["approved_sandbox","retry_pending_sandbox"].includes(status);
const sourceTerminal=(status:string)=>["payout_processed_sandbox","paid_sandbox","payout_reversed_sandbox","reversed_sandbox","failed_sandbox"].includes(status);
function providerStatus(status:unknown){const value=text(status).toLowerCase();if(value==="processed")return"processed";if(value==="reversed")return"reversed";if(value==="failed")return"failed";if(value==="queued")return"queued";if(value==="pending")return"pending";if(value==="initiated"||value==="processing")return"processing";return value||"unknown";}
function sourceStatus(source:RazorpayXPayoutSource,status:string){if(status==="processed")return source==="commission"?"payout_processed_sandbox":"paid_sandbox";if(status==="reversed")return source==="commission"?"payout_reversed_sandbox":"reversed_sandbox";if(status==="failed")return"failed_sandbox";if(status==="queued")return"provider_queued_sandbox";if(status==="pending")return"provider_pending_sandbox";return"provider_processing_sandbox";}

async function resolvePayoutSource(db:Db,id:string){
 const commission=await sourceRow(db,"commission",id),settlement=await sourceRow(db,"settlement",id);
 if(commission&&settlement)throw new Response("Payout identity is ambiguous across finance sources",{status:409});
 if(commission)return{source:"commission" as const,row:commission};
 if(settlement)return{source:"settlement" as const,row:settlement};
 return null;
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

export async function dispatchRazorpayXSandboxPayout(db:Db,env:Env,input:{payoutId:string}){
 await ensureRazorpayXPayoutRuntime(db);const id=text(input.payoutId),resolved=await resolvePayoutSource(db,id);if(!resolved)throw new Response("Sandbox payout record not found",{status:404});const{source,row}=resolved;
 if(text(row.environment)!=="sandbox")throw new Response("Only sandbox payout records may reach RazorpayX TEST",{status:409});
 const readiness=razorpayXSandboxReadiness(env);if(!readiness.ready)throw new Response(`RazorpayX TEST is not configured: ${readiness.problems.join("; ")}`,{status:503});
 const prior=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(id).first<Row>();
 if(prior&&text(prior.provider_payout_id))return{connected:true,duplicatePrevented:true,payoutId:id,source,providerPayoutId:text(prior.provider_payout_id),providerStatus:text(prior.provider_status),environment:"sandbox",liveMoney:false};
 const status=text(row.status);if(sourceTerminal(status))return{connected:true,duplicatePrevented:true,payoutId:id,source,providerPayoutId:text(row.provider_reference)||null,providerStatus:status,environment:"sandbox",liveMoney:false};
 if(!sourceReady(source,status))throw new Response(`Payout is not ready for RazorpayX TEST dispatch (${status||"unknown"})`,{status:409});
 const fund=text(row.razorpayx_fund_account_id);if(!/^fa_[A-Za-z0-9]+$/.test(fund))throw new Response("Verified RazorpayX TEST fund account is required",{status:409});
 const paise=rupeesToPaise(row.amount),key=text(row.idempotency_key);if(!key)throw new Response("Payout idempotency key is required",{status:409});
 const claimed=await db.prepare(`UPDATE ${sourceTable(source)} SET status='provider_dispatching_sandbox',updated_at=? WHERE id=? AND status=?`).bind(now(),id,status).run();
 if(Number(claimed.meta?.changes||0)!==1)throw new Response("Another RazorpayX TEST dispatch already owns this payout",{status:409});
 const createdAt=now();await db.prepare("INSERT INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,statement_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,last_utr,last_error,last_payload_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,NULL,'dispatching',NULL,NULL,NULL,?,?) ON CONFLICT(local_payout_id) DO UPDATE SET provider_status='dispatching',last_error=NULL,updated_at=excluded.updated_at").bind(id,source,row.booking_id||null,row.statement_id||null,text(row.provider_id),paise,text(row.currency)||"INR",fund,key,createdAt,createdAt).run();
 const result=await createRazorpayXSandboxPayout(env,{localPayoutId:id,bookingId:text(row.booking_id)||null,statementId:text(row.statement_id)||null,providerId:text(row.provider_id),fundAccountId:fund,amountPaise:paise,currency:text(row.currency)||"INR",idempotencyKey:key});
 if(!result.connected){await db.batch([db.prepare(`UPDATE ${sourceTable(source)} SET status='retry_pending_sandbox',${source==="settlement"?"last_error=?,":""}updated_at=? WHERE id=? AND status='provider_dispatching_sandbox'`).bind(...(source==="settlement"?[result.reason,now(),id]:[now(),id])),db.prepare("UPDATE razorpayx_payout_provider_state SET provider_status='retry_pending',last_error=?,updated_at=? WHERE local_payout_id=?").bind(result.reason,now(),id)]);return{connected:false,reason:result.reason,payoutId:id,source,environment:"sandbox",liveMoney:false};}
 const payout=result.payout,providerId=text(payout.id),pStatus=providerStatus(payout.status),next=sourceStatus(source,pStatus),utr=text(payout.utr)||null,hash=await sha256Hex(JSON.stringify(payout));
 await db.batch([db.prepare(`UPDATE ${sourceTable(source)} SET provider_reference=?,status=?,${source==="settlement"?"last_error=NULL,":""}updated_at=? WHERE id=? AND status='provider_dispatching_sandbox'`).bind(providerId,next,now(),id),db.prepare("UPDATE razorpayx_payout_provider_state SET provider_payout_id=?,provider_status=?,last_utr=?,last_error=NULL,last_payload_sha256=?,updated_at=? WHERE local_payout_id=?").bind(providerId,pStatus,utr,hash,now(),id)]);
 return{connected:true,duplicatePrevented:false,payoutId:id,source,providerPayoutId:providerId,providerStatus:pStatus,environment:"sandbox",liveMoney:false};
}

export function razorpayXWebhookGate(env:Env){const readiness=razorpayXSandboxReadiness(env),secret=text(env.RAZORPAYX_WEBHOOK_SECRET_SANDBOX);if(!readiness.ready)return{ok:false as const,status:503,reason:`RazorpayX TEST is not configured: ${readiness.problems.join("; ")}`};if(!secret)return{ok:false as const,status:503,reason:"RAZORPAYX_WEBHOOK_SECRET_SANDBOX is not configured"};return{ok:true as const,secret,environment:"sandbox" as const};}
const ALLOWED=new Set(["payout.queued","payout.initiated","payout.processed","payout.reversed"]);
const rank=(status:string)=>status==="reversed"?60:status==="processed"?50:status==="processing"?30:status==="queued"?20:0;

export async function processRazorpayXWebhook(db:Db,env:Env,input:{rawBody:string;signature:string;eventId?:string|null}){
 await ensureRazorpayXPayoutRuntime(db);const gate=razorpayXWebhookGate(env);if(!gate.ok)throw new Response(gate.reason,{status:gate.status});
 if(!input.signature||!await verifyRazorpayRawBody(input.rawBody,input.signature,gate.secret))throw new Response("Invalid RazorpayX webhook signature",{status:401});
 const hash=await sha256Hex(input.rawBody);let body:Record<string,unknown>;try{body=JSON.parse(input.rawBody)as Record<string,unknown>;}catch{throw new Response("Invalid RazorpayX webhook JSON",{status:400});}
 const event=text(body.event);if(!ALLOWED.has(event))throw new Response("Unsupported RazorpayX webhook event",{status:400});const payload=body.payload&&typeof body.payload==="object"?body.payload as Row:{},wrapper=payload.payout&&typeof payload.payout==="object"?payload.payout as Row:{},payout=wrapper.entity&&typeof wrapper.entity==="object"?wrapper.entity as Row:{};
 const providerPayoutId=text(payout.id);if(!providerPayoutId.startsWith("pout_"))throw new Response("RazorpayX webhook payout id is required",{status:400});const eventId=text(input.eventId)||`${event}:${providerPayoutId}:${hash.slice(0,24)}`;
 const seen=await db.prepare("SELECT payload_sha256,processing_status FROM razorpayx_webhook_events WHERE event_id=?").bind(eventId).first<Row>();if(seen){if(text(seen.payload_sha256)!==hash)throw new Response("RazorpayX event id was replayed with a different payload",{status:409});return{ok:true,duplicatePrevented:true,eventId,status:text(seen.processing_status),environment:"sandbox"};}
 await db.prepare("INSERT INTO razorpayx_webhook_events (event_id,event_type,provider_payout_id,payload_sha256,processing_status,reason,received_at,processed_at) VALUES (?,?,?,?, 'RECEIVED',NULL,?,NULL)").bind(eventId,event,providerPayoutId,hash,now()).run();
 let state=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE provider_payout_id=?").bind(providerPayoutId).first<Row>();const reference=text(payout.reference_id);
 if(!state&&reference){const sourceCommission=await db.prepare("SELECT id FROM provider_order_payouts WHERE id=?").bind(reference).first<Row>(),sourceSettlement=sourceCommission?null:await db.prepare("SELECT id FROM partner_payout_instructions WHERE id=?").bind(reference).first<Row>();const source=sourceCommission?"commission":sourceSettlement?"settlement":null;if(source){const row=await sourceRow(db,source,reference);if(row){await db.prepare("INSERT OR IGNORE INTO razorpayx_payout_provider_state (local_payout_id,source_type,booking_id,statement_id,provider_id,amount_paise,currency,fund_account_id,idempotency_key,provider_payout_id,provider_status,last_utr,last_error,last_payload_sha256,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?, 'unknown',NULL,NULL,NULL,?,?)").bind(reference,source,row.booking_id||null,row.statement_id||null,text(row.provider_id),rupeesToPaise(row.amount),text(row.currency)||"INR",text(row.razorpayx_fund_account_id),text(row.idempotency_key),providerPayoutId,now(),now()).run();state=await db.prepare("SELECT * FROM razorpayx_payout_provider_state WHERE local_payout_id=?").bind(reference).first<Row>();}}}
 if(!state){await db.prepare("UPDATE razorpayx_webhook_events SET processing_status='UNMATCHED',reason='unknown_payout',processed_at=? WHERE event_id=?").bind(now(),eventId).run();return{ok:true,matched:false,eventId,providerPayoutId,environment:"sandbox"};}
 const amountPaise=number(payout.amount),currency=text(payout.currency);if(!Number.isSafeInteger(amountPaise)||amountPaise!==number(state.amount_paise)||currency!==text(state.currency)){await db.prepare("UPDATE razorpayx_webhook_events SET processing_status='REJECTED',reason='payout_identity_or_amount_mismatch',processed_at=? WHERE event_id=?").bind(now(),eventId).run();throw new Response("RazorpayX payout amount/currency does not match PawSpace payout",{status:409});}
 const eventStatus=event.replace(/^payout\./,"")==="initiated"?"processing":event.replace(/^payout\./,"");const nextProvider=providerStatus(eventStatus),current=providerStatus(state.provider_status),allowReversal=current==="processed"&&nextProvider==="reversed",terminal=["processed","reversed","failed"].includes(current),advance=allowReversal||!terminal&&rank(nextProvider)>=rank(current);const effective=advance?nextProvider:current,source=text(state.source_type) as RazorpayXPayoutSource,localId=text(state.local_payout_id),utr=text(payout.utr)||text(state.last_utr)||null;
 await db.prepare("UPDATE razorpayx_payout_provider_state SET provider_status=?,last_utr=?,last_error=?,last_payload_sha256=?,updated_at=? WHERE local_payout_id=?").bind(effective,utr,["reversed","failed"].includes(effective)?text((payout.status_details as Row|undefined)?.description)||effective:null,hash,now(),localId).run();
 if(advance){const nextSource=sourceStatus(source,effective),table=sourceTable(source);await db.prepare(`UPDATE ${table} SET status=?,provider_reference=?,${source==="settlement"?"last_error=?,":""}updated_at=? WHERE id=?`).bind(...(source==="settlement"?[nextSource,providerPayoutId,["reversed","failed"].includes(effective)?text((payout.status_details as Row|undefined)?.description)||effective:null,now(),localId]:[nextSource,providerPayoutId,now(),localId])).run();if(source==="commission"){const bookingId=text(state.booking_id);if(bookingId)await db.prepare("UPDATE provider_order_commissions SET status=?,updated_at=? WHERE booking_id=?").bind(nextSource,now(),bookingId).run();}else{const statementId=text(state.statement_id);if(statementId&&effective==="processed")await db.prepare("UPDATE partner_settlement_statements SET status='paid',updated_at=? WHERE id=? AND status='approved'").bind(now(),statementId).run();if(statementId&&["reversed","failed"].includes(effective))await db.prepare("UPDATE partner_settlement_statements SET status='held',updated_at=? WHERE id=? AND status IN ('approved','paid')").bind(now(),statementId).run();}}
 await db.prepare("UPDATE razorpayx_webhook_events SET processing_status='PROCESSED',reason=NULL,processed_at=? WHERE event_id=?").bind(now(),eventId).run();return{ok:true,matched:true,duplicatePrevented:false,eventId,providerPayoutId,localPayoutId:localId,providerStatus:effective,advanced:advance,environment:"sandbox"};
}
