import{ACCT,periodOf,postJournal,round,type JournalLine}from"./finance-accounts";

type Db=D1Database;
type Row=Record<string,unknown>;
export type EscrowState="CUSTODY_HELD"|"DISPUTE_FROZEN"|"ARBITRATION_REFUND_CUSTOMER"|"ARBITRATION_RELEASE_PROVIDER"|"PARTIAL_SPLIT";
export type ArbitrationDecision="ARBITRATION_REFUND_CUSTOMER"|"ARBITRATION_RELEASE_PROVIDER"|"PARTIAL_SPLIT";

export const ESCROW_PAYMENT_ENV="sandbox" as const;
export const ESCROW_LIVE_APPROVED=false as const;
export const ESCROW_ACCOUNTS={custody:"2240-Escrow Custody Liability",providerPayable:"2250-Provider Payable",customerRefundPayable:"2260-Customer Refund Payable"} as const;

const text=(value:unknown)=>String(value??"").trim();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const truthy=(value:unknown)=>["1","true","yes","on"].includes(text(value).toLowerCase());
const money=(value:unknown)=>round(Math.max(0,Number(value||0)));
const day=()=>new Date().toISOString().slice(0,10);

async function runtimePaymentPolicy(){
 let runtime:Record<string,unknown>={};
 try{const imported=await import("cloudflare:workers");runtime=(imported.env||{}) as unknown as Record<string,unknown>;}catch{}
 const environment=text(runtime.PAWSPACE_PAYMENT_ENV||ESCROW_PAYMENT_ENV).toLowerCase();
 const liveApproved=truthy(runtime.PAWSPACE_PAYMENT_LIVE_APPROVED);
 if(environment!==ESCROW_PAYMENT_ENV||liveApproved)throw new Error("escrow_payment_isolation_violation: escrow custody is sandbox-only and live approval must remain false");
 return{environment:ESCROW_PAYMENT_ENV,liveApproved:false};
}
export async function assertEscrowSandboxIsolation(){return runtimePaymentPolicy();}

const escrowReady=new WeakSet<Db>();
export async function ensureEscrowCustodyTables(db:Db){
 if(escrowReady.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_custodial_accounts (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,customer_id TEXT,currency TEXT NOT NULL DEFAULT 'INR',custody_amount REAL NOT NULL CHECK(custody_amount>=0),held_amount REAL NOT NULL CHECK(held_amount>=0),released_provider_amount REAL NOT NULL DEFAULT 0 CHECK(released_provider_amount>=0),refunded_customer_amount REAL NOT NULL DEFAULT 0 CHECK(refunded_customer_amount>=0),state TEXT NOT NULL CHECK(state IN ('CUSTODY_HELD','DISPUTE_FROZEN','ARBITRATION_REFUND_CUSTOMER','ARBITRATION_RELEASE_PROVIDER','PARTIAL_SPLIT')),environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),live_approved INTEGER NOT NULL DEFAULT 0 CHECK(live_approved=0),capture_evidence_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_holds (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,payment_reference TEXT,amount REAL NOT NULL CHECK(amount>=0),currency TEXT NOT NULL DEFAULT 'INR',state TEXT NOT NULL DEFAULT 'HELD' CHECK(state IN ('HELD','RELEASED_PROVIDER','REFUND_CUSTOMER','PARTIAL_SPLIT')),source_reference TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,held_at INTEGER NOT NULL,released_at INTEGER,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS dispute_freezes (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,dispute_reference TEXT NOT NULL UNIQUE,amount_frozen REAL NOT NULL CHECK(amount_frozen>=0),reason TEXT NOT NULL,evidence_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVING','RESOLVED')),resolution TEXT,opened_by TEXT NOT NULL,opened_at INTEGER NOT NULL,resolved_by TEXT,resolved_at INTEGER,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_ledger_transactions (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>=0),provider_amount REAL NOT NULL DEFAULT 0 CHECK(provider_amount>=0),customer_amount REAL NOT NULL DEFAULT 0 CHECK(customer_amount>=0),state_from TEXT,state_to TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,journal_group TEXT,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_escrow_accounts_state ON escrow_custodial_accounts(state,updated_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_dispute_freezes_booking ON dispute_freezes(booking_id,status,updated_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_escrow_ledger_booking ON escrow_ledger_transactions(booking_id,created_at)"),
 ]);
 escrowReady.add(db);
}

async function capturedEvidence(db:Db,bookingId:string){
 const rows=await db.prepare("SELECT p.id payment_id,p.customer_id,p.currency,p.status,COALESCE(r.captured_amount,CASE WHEN p.status IN ('captured','partially_refunded','refunded') THEN p.amount ELSE 0 END) captured_amount,COALESCE(r.refunded_amount,0) refunded_amount FROM booking_payments p LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id WHERE p.booking_id=?").bind(bookingId).all<Row>();
 const usable=rows.results.map(row=>({paymentId:text(row.payment_id),customerId:text(row.customer_id)||null,currency:text(row.currency)||"INR",captured:money(row.captured_amount),refunded:money(row.refunded_amount)}));
 const netCaptured=round(usable.reduce((sum,row)=>sum+Math.max(0,row.captured-row.refunded),0));
 return{rows:usable,netCaptured,customerId:usable.find(row=>row.customerId)?.customerId??null,currency:usable.find(row=>row.currency)?.currency??"INR"};
}
async function reserveLedgerExists(db:Db,bookingId:string){return db.prepare("SELECT id,journal_group FROM escrow_ledger_transactions WHERE booking_id=? AND event_type='CUSTODY_RESERVED' LIMIT 1").bind(bookingId).first<Row>();}

export async function reserveEscrowForProviderPayout(db:Db,input:{bookingId:string;providerId:string;amount:number;currency?:string;actorId:string;reason?:string}){
 await runtimePaymentPolicy();await ensureEscrowCustodyTables(db);
 const amount=money(input.amount);if(amount<=0)throw new Error("escrow_reserve_amount_required");
 const providerId=text(input.providerId);if(!providerId)throw new Error("escrow_provider_required");
 const reason=text(input.reason)||"Reserve captured customer funds before provider payout approval";
 const evidence=await capturedEvidence(db,input.bookingId);
 if(evidence.netCaptured+0.009<amount)throw new Error(`escrow_capture_insufficient: captured ${evidence.netCaptured.toFixed(2)} cannot reserve provider amount ${amount.toFixed(2)}`);
 const currency=text(input.currency)||evidence.currency||"INR";if(currency!==evidence.currency&&evidence.rows.length)throw new Error("escrow_currency_mismatch");
 const now=Date.now(),accountId=uid("ESC"),holdId=uid("HOLD"),reserveKey=`escrow-reserve:${input.bookingId}`;
 await db.prepare("INSERT OR IGNORE INTO escrow_custodial_accounts (id,booking_id,provider_id,customer_id,currency,custody_amount,held_amount,released_provider_amount,refunded_customer_amount,state,environment,live_approved,capture_evidence_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,0,0,'CUSTODY_HELD','sandbox',0,?,?,?)")
  .bind(accountId,input.bookingId,providerId,evidence.customerId,currency,amount,amount,JSON.stringify({netCaptured:evidence.netCaptured,payments:evidence.rows}),now,now).run();
 const account=await db.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id=?").bind(input.bookingId).first<Row>();
 if(!account)throw new Error("escrow_account_reservation_failed");
 if(text(account.provider_id)!==providerId||money(account.custody_amount)!==amount||text(account.currency)!==currency)throw new Error("escrow_reserve_conflict");
 let ledger=await reserveLedgerExists(db,input.bookingId);
 if(!ledger){
  const entryDate=day();
  const journal=await postJournal(db,{groupKey:`ESCROW-RESERVE-${input.bookingId}`,entryDate,periodCode:periodOf(entryDate),sourceType:"escrow_custody_reserve",sourceId:input.bookingId,narration:`Escrow reserve for ${input.bookingId}`,lines:[{accountCode:ACCT.CUSTOMER_COLLECTIONS,debit:amount},{accountCode:ESCROW_ACCOUNTS.custody,credit:amount}],metadata:{bookingId:input.bookingId,customerId:evidence.customerId,paymentId:evidence.rows[0]?.paymentId??null,transactionAt:now,verificationStatus:"posted"}});
  await db.batch([
   db.prepare("INSERT OR IGNORE INTO escrow_holds (id,custodial_account_id,booking_id,payment_reference,amount,currency,state,source_reference,idempotency_key,held_at,updated_at) VALUES (?,?,?,?,?,?,'HELD',?,?,?,?)").bind(holdId,text(account.id),input.bookingId,evidence.rows.map(row=>row.paymentId).filter(Boolean).join(",")||null,amount,currency,"captured_customer_funds",reserveKey,now,now),
   db.prepare("INSERT OR IGNORE INTO escrow_ledger_transactions (id,custodial_account_id,booking_id,event_type,amount,provider_amount,customer_amount,state_from,state_to,actor_id,reason,idempotency_key,journal_group,created_at) VALUES (?,?,?,'CUSTODY_RESERVED',?,0,0,NULL,'CUSTODY_HELD',?,?,?,?,?)").bind(uid("ESCL"),text(account.id),input.bookingId,amount,input.actorId,reason,reserveKey,journal.journalGroup,now),
  ]);
  ledger=await reserveLedgerExists(db,input.bookingId);
 }
 if(!ledger?.journal_group)throw new Error("escrow_reserve_journal_missing");
 return{accountId:text(account.id),bookingId:input.bookingId,state:text(account.state) as EscrowState,custodyAmount:amount,heldAmount:money(account.held_amount),environment:"sandbox",liveApproved:false,duplicatePrevented:text(account.id)!==accountId};
}

export async function freezeEscrowForDispute(db:Db,input:{bookingId:string;disputeReference:string;reason:string;evidence?:Record<string,unknown>;actorId:string}){
 await runtimePaymentPolicy();await ensureEscrowCustodyTables(db);
 const disputeReference=text(input.disputeReference),reason=text(input.reason);if(disputeReference.length<4)throw new Error("dispute_reference_required");if(reason.length<8)throw new Error("dispute_reason_required");
 const account=await db.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!account)throw new Error("escrow_custody_required");
 const existing=await db.prepare("SELECT * FROM dispute_freezes WHERE dispute_reference=?").bind(disputeReference).first<Row>();if(existing)return{freezeId:text(existing.id),accountId:text(account.id),state:text(account.state),duplicatePrevented:true};
 if(text(account.state)!=="CUSTODY_HELD")throw new Error(`escrow_not_freezable:${text(account.state)}`);
 const now=Date.now(),freezeId=uid("DSP");
 const changed=await db.prepare("UPDATE escrow_custodial_accounts SET state='DISPUTE_FROZEN',updated_at=? WHERE id=? AND state='CUSTODY_HELD'").bind(now,account.id).run();
 if(Number(changed.meta?.changes||0)!==1)throw new Error("escrow_state_changed_before_dispute_freeze");
 await db.batch([
  db.prepare("INSERT INTO dispute_freezes (id,custodial_account_id,booking_id,dispute_reference,amount_frozen,reason,evidence_json,status,opened_by,opened_at,updated_at) VALUES (?,?,?,?,?,?,?,'OPEN',?,?,?)").bind(freezeId,account.id,input.bookingId,disputeReference,money(account.held_amount),reason,JSON.stringify(input.evidence||{}),input.actorId,now,now),
  db.prepare("INSERT OR IGNORE INTO escrow_ledger_transactions (id,custodial_account_id,booking_id,event_type,amount,provider_amount,customer_amount,state_from,state_to,actor_id,reason,idempotency_key,journal_group,created_at) VALUES (?,?,?,'DISPUTE_FREEZE',?,0,0,'CUSTODY_HELD','DISPUTE_FROZEN',?,?,?,NULL,?)").bind(uid("ESCL"),account.id,input.bookingId,money(account.held_amount),input.actorId,reason,`escrow-freeze:${disputeReference}`,now),
 ]);
 return{freezeId,accountId:text(account.id),state:"DISPUTE_FROZEN" as const,amountFrozen:money(account.held_amount),duplicatePrevented:false};
}

async function postReleaseJournal(db:Db,input:{bookingId:string;accountId:string;amount:number;providerAmount:number;customerAmount:number;reason:string;decision:string}){
 const lines:JournalLine[]=[{accountCode:ESCROW_ACCOUNTS.custody,debit:input.amount}];
 if(input.providerAmount>0)lines.push({accountCode:ESCROW_ACCOUNTS.providerPayable,credit:input.providerAmount});
 if(input.customerAmount>0)lines.push({accountCode:ESCROW_ACCOUNTS.customerRefundPayable,credit:input.customerAmount});
 const entryDate=day();
 return postJournal(db,{groupKey:`ESCROW-RELEASE-${input.bookingId}`,entryDate,periodCode:periodOf(entryDate),sourceType:"escrow_release",sourceId:input.accountId,narration:`${input.decision} ${input.bookingId}: ${input.reason}`,lines,metadata:{bookingId:input.bookingId,transactionAt:Date.now(),verificationStatus:"posted"}});
}

export async function releaseUndisputedEscrowToProvider(db:Db,input:{bookingId:string;actorId:string;reason:string}){
 await runtimePaymentPolicy();await ensureEscrowCustodyTables(db);
 const reason=text(input.reason);if(reason.length<8)throw new Error("escrow_release_reason_required");
 let account=await db.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!account)throw new Error("escrow_custody_required");
 const prior=await db.prepare("SELECT * FROM escrow_ledger_transactions WHERE booking_id=? AND event_type='RELEASE_PROVIDER' LIMIT 1").bind(input.bookingId).first<Row>();if(prior)return{accountId:text(account.id),state:text(account.state),providerAmount:money(prior.provider_amount),duplicatePrevented:true};
 if(text(account.state)!=="CUSTODY_HELD")throw new Error(`escrow_release_blocked:${text(account.state)}`);
 const amount=money(account.custody_amount),now=Date.now();
 const claim=await db.prepare("UPDATE escrow_custodial_accounts SET state='ARBITRATION_RELEASE_PROVIDER',updated_at=? WHERE id=? AND state='CUSTODY_HELD'").bind(now,account.id).run();if(Number(claim.meta?.changes||0)!==1)throw new Error("escrow_release_raced");
 try{
  const journal=await postReleaseJournal(db,{bookingId:input.bookingId,accountId:text(account.id),amount,providerAmount:amount,customerAmount:0,reason,decision:"NO_DISPUTE_RELEASE_PROVIDER"});
  await db.batch([
   db.prepare("UPDATE escrow_custodial_accounts SET held_amount=0,released_provider_amount=?,refunded_customer_amount=0,updated_at=? WHERE id=? AND state='ARBITRATION_RELEASE_PROVIDER'").bind(amount,now,account.id),
   db.prepare("UPDATE escrow_holds SET state='RELEASED_PROVIDER',released_at=?,updated_at=? WHERE custodial_account_id=? AND state='HELD'").bind(now,now,account.id),
   db.prepare("INSERT OR IGNORE INTO escrow_ledger_transactions (id,custodial_account_id,booking_id,event_type,amount,provider_amount,customer_amount,state_from,state_to,actor_id,reason,idempotency_key,journal_group,created_at) VALUES (?,?,?,'RELEASE_PROVIDER',?,?,0,'CUSTODY_HELD','ARBITRATION_RELEASE_PROVIDER',?,?,?,?,?)").bind(uid("ESCL"),account.id,input.bookingId,amount,amount,input.actorId,reason,`escrow-release-provider:${input.bookingId}`,journal.journalGroup,now),
  ]);
 }catch(error){await db.prepare("UPDATE escrow_custodial_accounts SET state='CUSTODY_HELD',updated_at=? WHERE id=? AND state='ARBITRATION_RELEASE_PROVIDER' AND released_provider_amount=0 AND refunded_customer_amount=0").bind(Date.now(),account.id).run().catch(()=>{});throw error;}
 account=await db.prepare("SELECT * FROM escrow_custodial_accounts WHERE id=?").bind(account.id).first<Row>();
 return{accountId:text(account?.id),state:"ARBITRATION_RELEASE_PROVIDER" as const,providerAmount:amount,duplicatePrevented:false};
}

export async function arbitrateEscrow(db:Db,input:{bookingId:string;decision:ArbitrationDecision;providerAmount?:number;customerAmount?:number;reason:string;evidence?:Record<string,unknown>;actorId:string}){
 await runtimePaymentPolicy();await ensureEscrowCustodyTables(db);
 const reason=text(input.reason);if(reason.length<8)throw new Error("arbitration_reason_required");
 const account=await db.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!account)throw new Error("escrow_custody_required");
 const prior=await db.prepare("SELECT * FROM escrow_ledger_transactions WHERE booking_id=? AND event_type='ARBITRATION_DECISION' LIMIT 1").bind(input.bookingId).first<Row>();if(prior)return{accountId:text(account.id),state:text(prior.state_to) as EscrowState,providerAmount:money(prior.provider_amount),customerAmount:money(prior.customer_amount),duplicatePrevented:true};
 if(text(account.state)!=="DISPUTE_FROZEN")throw new Error(`escrow_arbitration_requires_frozen_dispute:${text(account.state)}`);
 const freeze=await db.prepare("SELECT * FROM dispute_freezes WHERE booking_id=? AND status='OPEN' ORDER BY opened_at DESC LIMIT 1").bind(input.bookingId).first<Row>();if(!freeze)throw new Error("open_dispute_freeze_required");
 const amount=money(account.custody_amount);let providerAmount=0,customerAmount=0;
 if(input.decision==="ARBITRATION_RELEASE_PROVIDER")providerAmount=amount;
 else if(input.decision==="ARBITRATION_REFUND_CUSTOMER")customerAmount=amount;
 else{providerAmount=money(input.providerAmount);customerAmount=money(input.customerAmount);if(providerAmount<=0||customerAmount<=0||Math.abs(round(providerAmount+customerAmount)-amount)>0.01)throw new Error("partial_split_must_allocate_full_custody_between_provider_and_customer");}
 const now=Date.now();
 const freezeClaim=await db.prepare("UPDATE dispute_freezes SET status='RESOLVING',updated_at=? WHERE id=? AND status='OPEN'").bind(now,freeze.id).run();if(Number(freezeClaim.meta?.changes||0)!==1)throw new Error("dispute_already_resolving");
 const accountClaim=await db.prepare("UPDATE escrow_custodial_accounts SET state=?,updated_at=? WHERE id=? AND state='DISPUTE_FROZEN'").bind(input.decision,now,account.id).run();
 if(Number(accountClaim.meta?.changes||0)!==1){await db.prepare("UPDATE dispute_freezes SET status='OPEN',updated_at=? WHERE id=? AND status='RESOLVING'").bind(Date.now(),freeze.id).run();throw new Error("escrow_state_changed_before_arbitration");}
 try{
  const journal=await postReleaseJournal(db,{bookingId:input.bookingId,accountId:text(account.id),amount,providerAmount,customerAmount,reason,decision:input.decision});
  const commissionStatements:D1PreparedStatement[]=[];
  if(input.decision==="PARTIAL_SPLIT")commissionStatements.push(db.prepare("UPDATE provider_order_commissions SET commission_amount=?,commission_source='escrow_arbitration',override_reason=?,updated_at=? WHERE booking_id=? AND status IN ('awaiting_approval_1','awaiting_approval_2')").bind(providerAmount,reason,now,input.bookingId));
  if(input.decision==="ARBITRATION_REFUND_CUSTOMER")commissionStatements.push(db.prepare("UPDATE provider_order_commissions SET status='escrow_refunded_customer',override_reason=?,updated_at=? WHERE booking_id=? AND status IN ('awaiting_approval_1','awaiting_approval_2')").bind(reason,now,input.bookingId));
  await db.batch([
   db.prepare("UPDATE escrow_custodial_accounts SET held_amount=0,released_provider_amount=?,refunded_customer_amount=?,updated_at=? WHERE id=? AND state=?").bind(providerAmount,customerAmount,now,account.id,input.decision),
   db.prepare("UPDATE escrow_holds SET state=?,released_at=?,updated_at=? WHERE custodial_account_id=? AND state='HELD'").bind(input.decision==="ARBITRATION_RELEASE_PROVIDER"?"RELEASED_PROVIDER":input.decision==="ARBITRATION_REFUND_CUSTOMER"?"REFUND_CUSTOMER":"PARTIAL_SPLIT",now,now,account.id),
   db.prepare("UPDATE dispute_freezes SET status='RESOLVED',resolution=?,evidence_json=?,resolved_by=?,resolved_at=?,updated_at=? WHERE id=? AND status='RESOLVING'").bind(input.decision,JSON.stringify(input.evidence||{}),input.actorId,now,now,freeze.id),
   db.prepare("INSERT OR IGNORE INTO escrow_ledger_transactions (id,custodial_account_id,booking_id,event_type,amount,provider_amount,customer_amount,state_from,state_to,actor_id,reason,idempotency_key,journal_group,created_at) VALUES (?,?,?,'ARBITRATION_DECISION',?,?,?,'DISPUTE_FROZEN',?,?,?,?,?,?)").bind(uid("ESCL"),account.id,input.bookingId,amount,providerAmount,customerAmount,input.decision,input.actorId,reason,`escrow-arbitration:${input.bookingId}`,journal.journalGroup,now),
   ...commissionStatements,
  ]);
 }catch(error){await db.batch([db.prepare("UPDATE escrow_custodial_accounts SET state='DISPUTE_FROZEN',updated_at=? WHERE id=? AND state=? AND released_provider_amount=0 AND refunded_customer_amount=0").bind(Date.now(),account.id,input.decision),db.prepare("UPDATE dispute_freezes SET status='OPEN',updated_at=? WHERE id=? AND status='RESOLVING'").bind(Date.now(),freeze.id)]).catch(()=>{});throw error;}
 return{accountId:text(account.id),state:input.decision,providerAmount,customerAmount,duplicatePrevented:false};
}

export async function requireEscrowProviderReleaseForPayout(db:Db,input:{bookingId:string;maximumAmount:number}){
 await runtimePaymentPolicy();await ensureEscrowCustodyTables(db);
 const account=await db.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id=?").bind(input.bookingId).first<Row>();if(!account)throw new Error("escrow_custody_required_before_provider_payout");
 if(text(account.environment)!=="sandbox"||Number(account.live_approved)!==0)throw new Error("escrow_payment_isolation_violation");
 if(!["ARBITRATION_RELEASE_PROVIDER","PARTIAL_SPLIT"].includes(text(account.state)))throw new Error(`escrow_not_released_for_provider:${text(account.state)}`);
 const reserve=await reserveLedgerExists(db,input.bookingId),release=await db.prepare("SELECT id,journal_group,provider_amount FROM escrow_ledger_transactions WHERE booking_id=? AND event_type IN ('RELEASE_PROVIDER','ARBITRATION_DECISION') ORDER BY created_at DESC LIMIT 1").bind(input.bookingId).first<Row>();
 if(!reserve?.journal_group||!release?.journal_group)throw new Error("escrow_double_entry_evidence_missing");
 const providerAmount=money(release.provider_amount||account.released_provider_amount),maximum=money(input.maximumAmount);if(providerAmount<=0)throw new Error("escrow_provider_release_zero");if(providerAmount-maximum>0.01)throw new Error("escrow_release_exceeds_commission");
 return{accountId:text(account.id),state:text(account.state) as EscrowState,providerAmount,environment:"sandbox" as const,liveApproved:false};
}

export async function escrowCustodySnapshot(db:Db,bookingId?:string){
 await ensureEscrowCustodyTables(db);
 if(bookingId){const account=await db.prepare("SELECT * FROM escrow_custodial_accounts WHERE booking_id=?").bind(bookingId).first<Row>();if(!account)return null;const[holds,freezes,ledger]=await Promise.all([db.prepare("SELECT * FROM escrow_holds WHERE booking_id=? ORDER BY held_at").bind(bookingId).all<Row>(),db.prepare("SELECT * FROM dispute_freezes WHERE booking_id=? ORDER BY opened_at").bind(bookingId).all<Row>(),db.prepare("SELECT * FROM escrow_ledger_transactions WHERE booking_id=? ORDER BY created_at").bind(bookingId).all<Row>()]);return{account,holds:holds.results,freezes:freezes.results,ledger:ledger.results,paymentIsolation:{environment:"sandbox",liveApproved:false}};}
 const accounts=await db.prepare("SELECT * FROM escrow_custodial_accounts ORDER BY updated_at DESC LIMIT 250").all<Row>();return{accounts:accounts.results,paymentIsolation:{environment:"sandbox",liveApproved:false}};
}
