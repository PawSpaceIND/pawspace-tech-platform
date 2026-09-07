import{round}from"./finance-accounts";
export type Db=D1Database;
export type Row=Record<string,unknown>;
export type EscrowState="CUSTODY_HELD"|"DISPUTE_FROZEN"|"ARBITRATION_REFUND_CUSTOMER"|"ARBITRATION_RELEASE_PROVIDER"|"PARTIAL_SPLIT";
export type ArbitrationDecision="ARBITRATION_REFUND_CUSTOMER"|"ARBITRATION_RELEASE_PROVIDER"|"PARTIAL_SPLIT";
export type SettlementState="NONE"|"REFUND_PENDING"|"PAYOUT_PENDING"|"PARTIAL_SETTLEMENT_PENDING"|"REFUNDED"|"RELEASED"|"PARTIAL_SETTLED";
export type SettlementKind="REFUND"|"PAYOUT";

export const ESCROW_PAYMENT_ENV="sandbox" as const;
export const ESCROW_LIVE_APPROVED=false as const;
export const ESCROW_ACCOUNTS={custody:"2240-Escrow Custody Liability",providerPayable:"2250-Provider Payable",customerRefundPayable:"2260-Customer Refund Payable"} as const;

export const text=(value:unknown)=>String(value??"").trim();
export const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
const truthy=(value:unknown)=>["1","true","yes","on"].includes(text(value).toLowerCase());
export const money=(value:unknown)=>round(Math.max(0,Number(value||0)));
export const day=()=>new Date().toISOString().slice(0,10);
export const json=(value:unknown)=>JSON.stringify(value??{});
export const changes=(result:unknown)=>Number((result as {meta?:{changes?:number}}|undefined)?.meta?.changes||0);
export const isLedgerConflict=(error:unknown)=>/(escrow_ledger_head_conflict|UNIQUE constraint failed: (finance_refund_payables|provider_payable_queue|escrow_settlement_outbox|escrow_ledger_transactions|escrow_audit_events)\.idempotency_key)/i.test(error instanceof Error?error.message:String(error));

export async function runtimePaymentPolicy(){
 let runtime:Record<string,unknown>={};
 try{const imported=await import("cloudflare:workers");runtime=(imported.env||{}) as unknown as Record<string,unknown>;}catch{}
 const processEnvironment=text(typeof process!=="undefined"?process.env.PAWSPACE_PAYMENT_ENV:"");
 const forbidProduction=text(typeof process!=="undefined"?process.env.FORBID_PRODUCTION:"").toLowerCase();
 const environment=text(runtime.PAWSPACE_PAYMENT_ENV||processEnvironment||ESCROW_PAYMENT_ENV).toLowerCase();
 const liveApproved=truthy(runtime.PAWSPACE_PAYMENT_LIVE_APPROVED||((typeof process!=="undefined")?process.env.PAWSPACE_PAYMENT_LIVE_APPROVED:""));
 if(environment!==ESCROW_PAYMENT_ENV||liveApproved)throw new Error("escrow_payment_isolation_violation: escrow custody is sandbox-only and live approval must remain false");
 if(typeof process!=="undefined"&&process.env.NODE_ENV==="test"&&forbidProduction!=="true")throw new Error("escrow_forbid_production_guard_required_in_test");
 return{environment:ESCROW_PAYMENT_ENV,liveApproved:false};
}
export async function assertEscrowSandboxIsolation(){return runtimePaymentPolicy();}

const escrowReady=new WeakSet<Db>();
async function ensureColumn(db:Db,table:string,column:string,definition:string){
 const info=await db.prepare(`PRAGMA table_info(${table})`).all<Row>();
 if(info.results.some(row=>text(row.name)===column))return;
 await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
}

export async function ensureEscrowCustodyTables(db:Db){
 if(escrowReady.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_custodial_accounts (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,customer_id TEXT,currency TEXT NOT NULL DEFAULT 'INR',custody_amount REAL NOT NULL CHECK(custody_amount>=0),held_amount REAL NOT NULL CHECK(held_amount>=0),allocated_provider_amount REAL NOT NULL DEFAULT 0 CHECK(allocated_provider_amount>=0),allocated_customer_amount REAL NOT NULL DEFAULT 0 CHECK(allocated_customer_amount>=0),released_provider_amount REAL NOT NULL DEFAULT 0 CHECK(released_provider_amount>=0),refunded_customer_amount REAL NOT NULL DEFAULT 0 CHECK(refunded_customer_amount>=0),state TEXT NOT NULL CHECK(state IN ('CUSTODY_HELD','DISPUTE_FROZEN','ARBITRATION_REFUND_CUSTOMER','ARBITRATION_RELEASE_PROVIDER','PARTIAL_SPLIT')),settlement_state TEXT NOT NULL DEFAULT 'NONE',active_dispute_id TEXT,adjudication_dispute_id TEXT,settlement_external_reference TEXT,settlement_confirmed_at INTEGER,environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),live_approved INTEGER NOT NULL DEFAULT 0 CHECK(live_approved=0),capture_evidence_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_holds (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,payment_reference TEXT,amount REAL NOT NULL CHECK(amount>=0),currency TEXT NOT NULL DEFAULT 'INR',state TEXT NOT NULL DEFAULT 'HELD' CHECK(state IN ('HELD','RELEASED_PROVIDER','REFUND_CUSTOMER','PARTIAL_SPLIT')),source_reference TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,held_at INTEGER NOT NULL,released_at INTEGER,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS dispute_freezes (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,dispute_reference TEXT NOT NULL UNIQUE,amount_frozen REAL NOT NULL CHECK(amount_frozen>=0),reason TEXT NOT NULL,evidence_json TEXT NOT NULL DEFAULT '{}',status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','RESOLVING','RESOLVED')),resolution TEXT,opened_by TEXT NOT NULL,opened_at INTEGER NOT NULL,resolved_by TEXT,resolved_at INTEGER,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_ledger_transactions (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>=0),provider_amount REAL NOT NULL DEFAULT 0 CHECK(provider_amount>=0),customer_amount REAL NOT NULL DEFAULT 0 CHECK(customer_amount>=0),state_from TEXT,state_to TEXT NOT NULL,actor_id TEXT NOT NULL,reason TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,journal_group TEXT,sequence INTEGER,previous_hash TEXT,event_hash TEXT,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_ledger_heads (custodial_account_id TEXT PRIMARY KEY,last_sequence INTEGER NOT NULL DEFAULT 0,last_hash TEXT NOT NULL DEFAULT 'GENESIS',updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_refund_payables (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>0),currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DISPATCHING','CONFIRMED','FAILED','DEAD_LETTER')),idempotency_key TEXT NOT NULL UNIQUE,external_reference TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,confirmed_at INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS provider_payable_queue (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>0),currency TEXT NOT NULL DEFAULT 'INR',status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DISPATCHING','CONFIRMED','FAILED','DEAD_LETTER')),idempotency_key TEXT NOT NULL UNIQUE,external_reference TEXT,attempt_count INTEGER NOT NULL DEFAULT 0,last_error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,confirmed_at INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_settlement_outbox (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('REFUND','PAYOUT')),amount REAL NOT NULL CHECK(amount>0),currency TEXT NOT NULL DEFAULT 'INR',payload_json TEXT NOT NULL DEFAULT '{}',idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','PROCESSING','RETRY','DELIVERED','DEAD_LETTER')),attempt_count INTEGER NOT NULL DEFAULT 0,next_attempt_at INTEGER NOT NULL,locked_by TEXT,locked_at INTEGER,last_error TEXT,external_reference TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,delivered_at INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_settlement_receipts (outbox_id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,booking_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('REFUND','PAYOUT')),amount REAL NOT NULL CHECK(amount>0),external_reference TEXT NOT NULL,confirmed_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_audit_events (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_lifecycle_outbox (id TEXT PRIMARY KEY,custodial_account_id TEXT NOT NULL,dispute_id TEXT,booking_id TEXT NOT NULL,event_type TEXT NOT NULL,payload_json TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','DELIVERED')),created_at INTEGER NOT NULL,delivered_at INTEGER)"),
  db.prepare("CREATE TABLE IF NOT EXISTS escrow_reconciliation_alarms (id TEXT PRIMARY KEY,booking_id TEXT,custodial_account_id TEXT,dispute_id TEXT,alarm_type TEXT NOT NULL,severity TEXT NOT NULL CHECK(severity IN ('P0','P1','P2')),details_json TEXT NOT NULL,fingerprint TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'OPEN' CHECK(status IN ('OPEN','ACKNOWLEDGED','RESOLVED')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_escrow_accounts_state ON escrow_custodial_accounts(state,updated_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_dispute_freezes_booking ON dispute_freezes(booking_id,status,updated_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_escrow_ledger_booking ON escrow_ledger_transactions(booking_id,created_at)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_escrow_settlement_due ON escrow_settlement_outbox(status,next_attempt_at,created_at)"),
 ]);
 await ensureColumn(db,"escrow_custodial_accounts","allocated_provider_amount","REAL NOT NULL DEFAULT 0 CHECK(allocated_provider_amount>=0)");
 await ensureColumn(db,"escrow_custodial_accounts","allocated_customer_amount","REAL NOT NULL DEFAULT 0 CHECK(allocated_customer_amount>=0)");
 await ensureColumn(db,"escrow_custodial_accounts","settlement_state","TEXT NOT NULL DEFAULT 'NONE'");
 await ensureColumn(db,"escrow_custodial_accounts","active_dispute_id","TEXT");
 await ensureColumn(db,"escrow_custodial_accounts","adjudication_dispute_id","TEXT");
 await ensureColumn(db,"escrow_custodial_accounts","settlement_external_reference","TEXT");
 await ensureColumn(db,"escrow_custodial_accounts","settlement_confirmed_at","INTEGER");
 await ensureColumn(db,"escrow_ledger_transactions","sequence","INTEGER");
 await ensureColumn(db,"escrow_ledger_transactions","previous_hash","TEXT");
 await ensureColumn(db,"escrow_ledger_transactions","event_hash","TEXT");
 await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS ux_escrow_ledger_sequence ON escrow_ledger_transactions(custodial_account_id,sequence) WHERE sequence IS NOT NULL").run();
 await db.batch([
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_ledger_no_update BEFORE UPDATE ON escrow_ledger_transactions BEGIN SELECT RAISE(ABORT,'escrow_ledger_append_only'); END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_ledger_no_delete BEFORE DELETE ON escrow_ledger_transactions BEGIN SELECT RAISE(ABORT,'escrow_ledger_append_only'); END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_audit_no_update BEFORE UPDATE ON escrow_audit_events BEGIN SELECT RAISE(ABORT,'escrow_audit_append_only'); END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_audit_no_delete BEFORE DELETE ON escrow_audit_events BEGIN SELECT RAISE(ABORT,'escrow_audit_append_only'); END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_receipt_no_update BEFORE UPDATE ON escrow_settlement_receipts BEGIN SELECT RAISE(ABORT,'escrow_settlement_receipt_append_only'); END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_receipt_no_delete BEFORE DELETE ON escrow_settlement_receipts BEGIN SELECT RAISE(ABORT,'escrow_settlement_receipt_append_only'); END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_ledger_head_guard BEFORE INSERT ON escrow_ledger_transactions WHEN NEW.sequence IS NOT NULL BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM escrow_ledger_heads h WHERE h.custodial_account_id=NEW.custodial_account_id AND h.last_sequence=NEW.sequence-1 AND h.last_hash=NEW.previous_hash) THEN RAISE(ABORT,'escrow_ledger_head_conflict') END; END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_escrow_settlement_ledger_receipt_guard BEFORE INSERT ON escrow_ledger_transactions WHEN NEW.event_type='SETTLEMENT_CONFIRMED' BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM escrow_settlement_receipts r WHERE NEW.idempotency_key='settlement-confirm:'||r.outbox_id) THEN RAISE(ABORT,'settlement_confirmation_receipt_required') END; END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_dispute_insert_requires_frozen_custody BEFORE INSERT ON dispute_freezes BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM escrow_custodial_accounts a WHERE a.id=NEW.custodial_account_id AND a.state='DISPUTE_FROZEN' AND a.active_dispute_id=NEW.id) THEN RAISE(ABORT,'dispute_freeze_atomic_guard_failed') END; END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_dispute_resolving_requires_claim BEFORE UPDATE OF status ON dispute_freezes WHEN NEW.status='RESOLVING' BEGIN SELECT CASE WHEN OLD.status<>'OPEN' OR NOT EXISTS(SELECT 1 FROM escrow_custodial_accounts a WHERE a.id=OLD.custodial_account_id AND a.adjudication_dispute_id=OLD.id AND a.state IN ('ARBITRATION_REFUND_CUSTOMER','ARBITRATION_RELEASE_PROVIDER','PARTIAL_SPLIT')) THEN RAISE(ABORT,'arbitration_atomic_claim_guard_failed') END; END"),
  db.prepare("CREATE TRIGGER IF NOT EXISTS trg_settlement_outbox_requires_committed_intent BEFORE INSERT ON escrow_settlement_outbox BEGIN SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM escrow_custodial_accounts a WHERE a.id=NEW.custodial_account_id AND ((NEW.kind='REFUND' AND a.settlement_state IN ('REFUND_PENDING','PARTIAL_SETTLEMENT_PENDING') AND a.allocated_customer_amount>=NEW.amount) OR (NEW.kind='PAYOUT' AND a.settlement_state IN ('PAYOUT_PENDING','PARTIAL_SETTLEMENT_PENDING') AND a.allocated_provider_amount>=NEW.amount))) THEN RAISE(ABORT,'settlement_outbox_without_committed_intent') END; SELECT CASE WHEN NEW.dispute_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM dispute_freezes d WHERE d.id=NEW.dispute_id AND d.status='RESOLVED') THEN RAISE(ABORT,'settlement_outbox_requires_resolved_dispute') END; END"),
 ]);
 escrowReady.add(db);
}

export async function capturedEvidence(db:Db,bookingId:string){
 const rows=await db.prepare("SELECT p.id payment_id,p.customer_id,p.currency,p.status,COALESCE(r.captured_amount,CASE WHEN p.status IN ('captured','partially_refunded','refunded') THEN p.amount ELSE 0 END) captured_amount,COALESCE(r.refunded_amount,0) refunded_amount FROM booking_payments p LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id WHERE p.booking_id=?").bind(bookingId).all<Row>();
 const usable=rows.results.map(row=>({paymentId:text(row.payment_id),customerId:text(row.customer_id)||null,currency:text(row.currency)||"INR",captured:money(row.captured_amount),refunded:money(row.refunded_amount)}));
 const netCaptured=round(usable.reduce((sum,row)=>sum+Math.max(0,row.captured-row.refunded),0));
 return{rows:usable,netCaptured,customerId:usable.find(row=>row.customerId)?.customerId??null,currency:usable.find(row=>row.currency)?.currency??"INR"};
}
export async function reserveLedgerExists(db:Db,bookingId:string){return db.prepare("SELECT id,journal_group FROM escrow_ledger_transactions WHERE booking_id=? AND event_type='CUSTODY_RESERVED' LIMIT 1").bind(bookingId).first<Row>();}
export async function digest(value:string){const hash=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(value));return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,"0")).join("");}
