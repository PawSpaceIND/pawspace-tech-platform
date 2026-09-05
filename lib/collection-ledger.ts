/**
 * Money the business actually took, posted to the books. [PTJA-W2-B2-R04]
 *
 * WHAT WAS MEASURED. A month holding one completed grooming booking of Rs 5,000 with a captured UPI
 * payment of Rs 5,000:
 *
 *   GET /api/cash-flow-statement?period=2026-08
 *   -> {"openingCash":0,"closingCash":0,"netChangeInCash":0,"operating":{"total":0,"lines":[]},
 *       "reconciled":true,"detail":[]}
 *   SELECT COUNT(*) FROM finance_journal_entries -> 0, before and after the read.
 *
 * The statement asserted its own integrity - `reconciled: true` - while omitting every rupee collected.
 * Its only input is finance_journal_entries, and no booking-payment capture path anywhere ever called
 * postJournal. Absent journal was read as no cash, and opening + movement == closing was trivially
 * satisfied by 0 = 0. That is this audit's recurring shape once more: absence read as a value.
 *
 * THE APPROVED RULES. A collection posts when payment becomes successfully CAPTURED, never when a booking
 * is created:
 *
 *   online payment captured       Dr Payment Gateway Clearing   Cr Customer Collections
 *   cash collected and confirmed  Dr Cash in Hand               Cr Customer Collections
 *   bank transfer verified        Dr Bank                       Cr Customer Collections
 *   gateway settlement received   Dr Bank                       Cr Payment Gateway Clearing
 *   refund completed              Dr Refunds                    Cr gateway / bank / cash
 *   payment failed or pending     nothing at all
 *
 * WHY AN ONLINE CAPTURE IS NOT CASH. Gateway clearing is not a cash account, so a capture does not move
 * the cash-flow statement until the gateway settles. That is the correct answer rather than a compromise:
 * the money is real, it is visible as a collection immediately, and it becomes cash when it reaches the
 * bank. The old statement could not draw that distinction because it had nothing to draw it from.
 *
 * MANUAL ENTRIES ARE NOT FINAL. A collection somebody typed in posts as pending_finance_verification and
 * is reported separately from verified collections until a finance role confirms it. It is never hidden -
 * a manual collection that vanished until approved would be as misleading as one that counted too soon.
 */
import{ACCT,periodOf,postJournal,round,type JournalMetadata}from"./finance-accounts";
import{registerServicePolicyDomain,resolveServicePolicy}from"./service-policy-governance";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(value:unknown)=>String(value??"").trim();

export const COLLECTION_LEDGER_DOMAIN="collection_ledger_policy";

/** Which instrument a collection or refund moved through. */
export type CollectionInstrument="gateway"|"cash"|"bank";
export type CollectionEvent=
  |"online_payment_captured"|"cash_collected_confirmed"|"bank_transfer_verified"
  |"gateway_settlement_received"|"refund_completed"|"payment_failed"|"payment_pending";

export type CollectionLedgerConfig={
  accounts:{gatewayClearing:string;cash:string;bank:string;customerCollections:string;refunds:string};
  /** Events that must never produce a posting. Money that has not arrived is not in the books. */
  nonPostingEvents:string[];
  manualCollectionRequiresFinanceVerification:boolean;
  financeVerificationPermissions:string[];
  /** Cash without a named collector is not an auditable collection. */
  requireCollectorForCash:boolean;
};

export const APPROVED_COLLECTION_LEDGER:CollectionLedgerConfig={
  accounts:{gatewayClearing:ACCT.GATEWAY_CLEARING,cash:ACCT.CASH,bank:ACCT.BANK,customerCollections:ACCT.CUSTOMER_COLLECTIONS,refunds:ACCT.REFUNDS},
  nonPostingEvents:["payment_failed","payment_pending"],
  manualCollectionRequiresFinanceVerification:true,
  financeVerificationPermissions:["finance.manage"],
  requireCollectorForCash:true,
};

registerServicePolicyDomain<CollectionLedgerConfig&Record<string,unknown>>({
  domain:COLLECTION_LEDGER_DOMAIN,
  label:"Collection ledger posting rules",
  managePermission:"settings.manage",
  defaults:APPROVED_COLLECTION_LEDGER as CollectionLedgerConfig&Record<string,unknown>,
  problem(config){
    const accounts=config.accounts as CollectionLedgerConfig["accounts"]|undefined;
    if(!accounts||typeof accounts!=="object")return "An account mapping is required";
    for(const key of ["gatewayClearing","cash","bank","customerCollections","refunds"]){
      if(!text((accounts as Record<string,unknown>)[key]))return `accounts.${key} is required`;
    }
    // Gateway clearing and bank are different places money can be. Collapsing them would report a
    // capture as cash in the bank, which is the opposite error to the one being fixed.
    if(accounts.gatewayClearing===accounts.bank)return "Gateway clearing and the bank account must be different - a capture is not yet cash";
    if(accounts.customerCollections===accounts.refunds)return "Collections and refunds must post to different accounts";
    const nonPosting=config.nonPostingEvents;
    if(!Array.isArray(nonPosting))return "nonPostingEvents must be a list";
    for(const required of["payment_failed","payment_pending"]){
      if(!nonPosting.map(String).includes(required))return `nonPostingEvents must include ${required} - money that has not arrived is not in the books`;
    }
    if(config.manualCollectionRequiresFinanceVerification===false)return "A manually entered collection must not become final without finance verification";
    if(!Array.isArray(config.financeVerificationPermissions)||!config.financeVerificationPermissions.length)return "At least one permission must be able to verify a manual collection";
    return null;
  },
});

export async function resolveCollectionLedgerPolicy(db:Db,scope:{serviceCode?:string|null;cityId?:string|null}={},at=new Date()){
  return resolveServicePolicy<CollectionLedgerConfig&Record<string,unknown>>(db,COLLECTION_LEDGER_DOMAIN,scope,at);
}

const ledgerReady=new WeakSet<Db>();
const ledgerEnsuring=new WeakMap<Db,Promise<void>>();
async function collectionLedgerSchemaReady(db:Db){
  try{
    const rows=await db.prepare("SELECT name FROM sqlite_master WHERE name IN ('collection_ledger_postings','idx_collection_postings_period')").all<Row>();
    const names=new Set(rows.results.map(row=>text(row.name)));
    return names.has("collection_ledger_postings")&&names.has("idx_collection_postings_period");
  }catch{return false;}
}
async function ensureCollectionLedgerTablesUncached(db:Db){
  const{ensureFinanceJournalTable}=await import("./finance-accounts");
  const[,ledgerSchemaReady]=await Promise.all([ensureFinanceJournalTable(db),collectionLedgerSchemaReady(db)]);
  if(ledgerSchemaReady)return;
  await db.prepare("CREATE TABLE IF NOT EXISTS collection_ledger_postings (group_key TEXT PRIMARY KEY,event TEXT NOT NULL,payment_id TEXT,settlement_id TEXT,reversal_reference TEXT,amount REAL NOT NULL,period_code TEXT NOT NULL,manual_entry INTEGER NOT NULL DEFAULT 0,verification_status TEXT NOT NULL DEFAULT 'posted',verified_by TEXT,verified_at INTEGER,verification_reason TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)").run();
  await db.prepare("CREATE INDEX IF NOT EXISTS idx_collection_postings_period ON collection_ledger_postings(period_code,verification_status)").run();
}
export async function ensureCollectionLedgerTables(db:Db){
  if(ledgerReady.has(db))return;
  const inFlight=ledgerEnsuring.get(db);
  if(inFlight)return inFlight;
  const work=ensureCollectionLedgerTablesUncached(db)
    .then(()=>{ledgerReady.add(db);})
    .finally(()=>{ledgerEnsuring.delete(db);});
  ledgerEnsuring.set(db,work);
  return work;
}

export type CollectionEventInput={
  event:CollectionEvent;bookingId?:string|null;customerId?:string|null;cityId?:string|null;serviceCode?:string|null;
  paymentId:string;settlementId?:string|null;refundReference?:string|null;amount:number;taxAmount?:number|null;gatewayFee?:number|null;
  paymentMethod?:string|null;collectorId?:string|null;entryDate:string;transactionAt?:number|null;actorId:string;manualEntry?:boolean;
  /** Which instrument a refund is going back through. Defaults to how the money originally arrived. */
  refundInstrument?:CollectionInstrument;
};

/** Which side of the books each event moves, straight from the approved table. */
function linesFor(event:CollectionEvent,config:CollectionLedgerConfig,amount:number,refundInstrument:CollectionInstrument){
  const{accounts}=config;
  switch(event){
    case"online_payment_captured":return[{accountCode:accounts.gatewayClearing,debit:amount},{accountCode:accounts.customerCollections,credit:amount}];
    case"cash_collected_confirmed":return[{accountCode:accounts.cash,debit:amount},{accountCode:accounts.customerCollections,credit:amount}];
    case"bank_transfer_verified":return[{accountCode:accounts.bank,debit:amount},{accountCode:accounts.customerCollections,credit:amount}];
    case"gateway_settlement_received":return[{accountCode:accounts.bank,debit:amount},{accountCode:accounts.gatewayClearing,credit:amount}];
    case"refund_completed":{
      const back=refundInstrument==="cash"?accounts.cash:refundInstrument==="bank"?accounts.bank:accounts.gatewayClearing;
      return[{accountCode:accounts.refunds,debit:amount},{accountCode:back,credit:amount}];
    }
    default:return[];
  }
}

/** The idempotency key. A gateway webhook and the reconciliation sweep both replay; neither may double-post. */
const groupKeyFor=(input:CollectionEventInput)=>
  `COLL-${input.event}-${text(input.settlementId)||text(input.refundReference)||text(input.paymentId)}`;

export async function postCollectionEvent(db:Db,input:CollectionEventInput){
  const[,policy]=await Promise.all([ensureCollectionLedgerTables(db),resolveCollectionLedgerPolicy(db,{serviceCode:input.serviceCode,cityId:input.cityId})]);
  const config=policy.config;
  const groupKey=groupKeyFor(input);

  // Money that has not arrived is not in the books. Not a provisional line, not a zero line - nothing.
  if(config.nonPostingEvents.map(String).includes(input.event)){
    return{posted:false,groupKey,reason:"non_posting_event",verificationStatus:null,duplicatePrevented:false};
  }
  const amount=round(Math.max(0,Number(input.amount||0)));
  if(amount<=0)return{posted:false,groupKey,reason:"zero_amount",verificationStatus:null,duplicatePrevented:false};
  if(config.requireCollectorForCash&&input.event==="cash_collected_confirmed"&&!text(input.collectorId)){
    throw Response.json({error:"A cash collection needs the collector who took it",code:"cash_collector_required"},{status:400});
  }

  const existing=await db.prepare("SELECT group_key,verification_status FROM collection_ledger_postings WHERE group_key=?").bind(groupKey).first<Row>();
  if(existing)return{posted:false,groupKey,reason:"already_posted",verificationStatus:text(existing.verification_status),duplicatePrevented:true};

  const manual=input.manualEntry===true;
  const verificationStatus=manual&&config.manualCollectionRequiresFinanceVerification?"pending_finance_verification":"posted";
  const lines=linesFor(input.event,config,amount,input.refundInstrument??"gateway");
  if(!lines.length)return{posted:false,groupKey,reason:"unknown_event",verificationStatus:null,duplicatePrevented:false};

  const sourceId=text(input.settlementId)||text(input.refundReference)||text(input.paymentId);
  const metadata:JournalMetadata={
    bookingId:input.bookingId??null,customerId:input.customerId??null,cityId:input.cityId??null,serviceCode:input.serviceCode??null,
    paymentId:input.paymentId??null,settlementId:input.settlementId??null,paymentMethod:input.paymentMethod??null,
    taxAmount:input.taxAmount??null,gatewayFee:input.gatewayFee??null,collectorId:input.collectorId??null,
    reversalReference:input.refundReference??null,transactionAt:input.transactionAt??null,verificationStatus,
  };
  await postJournal(db,{groupKey,entryDate:input.entryDate,periodCode:periodOf(input.entryDate),
    sourceType:input.event,sourceId,narration:`${input.event} ${sourceId}`,lines,metadata});
  await db.prepare("INSERT INTO collection_ledger_postings (group_key,event,payment_id,settlement_id,reversal_reference,amount,period_code,manual_entry,verification_status,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
    .bind(groupKey,input.event,input.paymentId??null,input.settlementId??null,input.refundReference??null,amount,periodOf(input.entryDate),manual?1:0,verificationStatus,input.actorId,Date.now()).run();
  return{posted:true,groupKey,reason:null,verificationStatus,duplicatePrevented:false};
}

/**
 * Makes a manually entered collection final. Only a finance role may, and the reason is kept - a figure
 * that becomes authoritative on somebody's say-so should say whose, and why.
 */
export async function verifyManualCollection(db:Db,input:{groupKey:string;actorId:string;actorPermissions:readonly string[];reason:string}){
  await ensureCollectionLedgerTables(db);
  const row=await db.prepare("SELECT * FROM collection_ledger_postings WHERE group_key=?").bind(input.groupKey).first<Row>();
  if(!row)throw Response.json({error:"Collection posting not found"},{status:404});
  const policy=await resolveCollectionLedgerPolicy(db,{});
  const allowed=input.actorPermissions.includes("*")||policy.config.financeVerificationPermissions.some(permission=>input.actorPermissions.includes(permission));
  if(!allowed)throw Response.json({error:"Verifying a collection requires a finance role",code:"finance_verification_not_permitted",required:policy.config.financeVerificationPermissions},{status:403});
  if(!text(input.reason)||text(input.reason).length<5)throw Response.json({error:"A clear verification reason is required"},{status:400});
  if(text(row.verification_status)!=="pending_finance_verification")throw Response.json({error:`This posting is ${text(row.verification_status)}, not awaiting verification`},{status:409});
  const now=Date.now();
  await db.batch([
    db.prepare("UPDATE collection_ledger_postings SET verification_status='verified',verified_by=?,verified_at=?,verification_reason=? WHERE group_key=?").bind(input.actorId,now,text(input.reason),input.groupKey),
    db.prepare("UPDATE finance_journal_entries SET verification_status='verified',verified_by=?,verified_at=? WHERE id LIKE ?").bind(input.actorId,now,`${input.groupKey}-%`),
  ]);
  return{groupKey:input.groupKey,verificationStatus:"verified",verifiedBy:input.actorId,verifiedAt:now};
}

/**
 * What was collected in a period, with anything awaiting finance verification reported SEPARATELY rather
 * than folded in or dropped. A manual collection that vanished until approved would mislead as badly as
 * one that counted too soon.
 */
export async function collectionsTotal(db:Db,periodCode:string){
  await ensureCollectionLedgerTables(db);
  const rows=await db.prepare("SELECT verification_status,event,SUM(amount) total FROM collection_ledger_postings WHERE period_code=? GROUP BY verification_status,event").bind(periodCode).all<Row>();
  let verified=0,pendingVerification=0,refunds=0;
  for(const row of rows.results){
    const amount=Number(row.total||0);
    if(text(row.event)==="refund_completed"){refunds+=amount;continue;}
    if(text(row.event)==="gateway_settlement_received")continue; // a settlement moves money already collected
    if(text(row.verification_status)==="pending_finance_verification")pendingVerification+=amount;else verified+=amount;
  }
  return{periodCode,verified:round(verified),pendingVerification:round(pendingVerification),refunds:round(refunds),netCollected:round(verified-refunds)};
}
