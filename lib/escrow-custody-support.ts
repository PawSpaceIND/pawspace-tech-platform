import{ensureFinanceJournalTable,periodOf,round,type JournalLine}from"./finance-accounts";
import{ESCROW_ACCOUNTS,digest,day,json,money,text,uid,type ArbitrationDecision,type Db,type Row,type SettlementState}from"./escrow-custody-schema";
export async function ledgerHead(db:Db,accountId:string){
 let head=await db.prepare("SELECT last_sequence,last_hash FROM escrow_ledger_heads WHERE custodial_account_id=?").bind(accountId).first<Row>();
 if(head)return{sequence:Number(head.last_sequence||0),hash:text(head.last_hash)||"GENESIS"};
 const legacy=await db.prepare("SELECT COUNT(*) count,MAX(created_at) latest FROM escrow_ledger_transactions WHERE custodial_account_id=? AND sequence IS NULL").bind(accountId).first<Row>();
 const count=Number(legacy?.count||0),latest=Number(legacy?.latest||0);const anchor=count?`LEGACY:${count}:${latest}`:"GENESIS";
 await db.prepare("INSERT OR IGNORE INTO escrow_ledger_heads (custodial_account_id,last_sequence,last_hash,updated_at) VALUES (?,0,?,?)").bind(accountId,anchor,Date.now()).run();
 head=await db.prepare("SELECT last_sequence,last_hash FROM escrow_ledger_heads WHERE custodial_account_id=?").bind(accountId).first<Row>();
 if(!head)throw new Error("escrow_ledger_head_initialization_failed");
 return{sequence:Number(head.last_sequence||0),hash:text(head.last_hash)||anchor};
}

type LedgerInput={accountId:string;bookingId:string;eventType:string;amount:number;providerAmount?:number;customerAmount?:number;stateFrom?:string|null;stateTo:string;actorId:string;reason:string;idempotencyKey:string;journalGroup?:string|null;createdAt:number};
export async function prepareLedgerAppend(db:Db,input:LedgerInput){
 const existing=await db.prepare("SELECT id,sequence,event_hash FROM escrow_ledger_transactions WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
 if(existing)return{duplicate:true,existing,statements:[] as D1PreparedStatement[],sequence:Number(existing.sequence||0),eventHash:text(existing.event_hash)};
 const head=await ledgerHead(db,input.accountId),sequence=head.sequence+1,previousHash=head.hash;
 const providerAmount=money(input.providerAmount),customerAmount=money(input.customerAmount),amount=money(input.amount);
 const eventHash=await digest(JSON.stringify([input.accountId,input.bookingId,input.eventType,amount,providerAmount,customerAmount,input.stateFrom??null,input.stateTo,input.actorId,input.reason,input.idempotencyKey,input.journalGroup??null,sequence,previousHash,input.createdAt]));
 const ledgerId=uid("ESCL");
 return{duplicate:false,sequence,eventHash,statements:[
  db.prepare("INSERT INTO escrow_ledger_transactions (id,custodial_account_id,booking_id,event_type,amount,provider_amount,customer_amount,state_from,state_to,actor_id,reason,idempotency_key,journal_group,sequence,previous_hash,event_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(ledgerId,input.accountId,input.bookingId,input.eventType,amount,providerAmount,customerAmount,input.stateFrom??null,input.stateTo,input.actorId,input.reason,input.idempotencyKey,input.journalGroup??null,sequence,previousHash,eventHash,input.createdAt),
  db.prepare("UPDATE escrow_ledger_heads SET last_sequence=?,last_hash=?,updated_at=? WHERE custodial_account_id=? AND last_sequence=? AND last_hash=?").bind(sequence,eventHash,input.createdAt,input.accountId,head.sequence,head.hash),
 ]};
}

export async function prepareReleaseJournalBatch(db:Db,input:{bookingId:string;accountId:string;amount:number;providerAmount:number;customerAmount:number;reason:string;decision:string;groupSuffix:string}){
 await ensureFinanceJournalTable(db);
 const lines:JournalLine[]=[{accountCode:ESCROW_ACCOUNTS.custody,debit:input.amount}];
 if(input.providerAmount>0)lines.push({accountCode:ESCROW_ACCOUNTS.providerPayable,credit:input.providerAmount});
 if(input.customerAmount>0)lines.push({accountCode:ESCROW_ACCOUNTS.customerRefundPayable,credit:input.customerAmount});
 const totalDebit=money(lines.reduce((sum,line)=>sum+Number(line.debit||0),0)),totalCredit=money(lines.reduce((sum,line)=>sum+Number(line.credit||0),0));
 if(Math.abs(totalDebit-totalCredit)>0.01)throw new Error("escrow_release_journal_unbalanced");
 const entryDate=day(),periodCode=periodOf(entryDate);const period=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(periodCode).first<Row>().catch(()=>null);if(text(period?.status)==="locked")throw new Error(`period_locked: ${periodCode} is closed and locked; post corrections in the next open period`);
 const journalGroup=`JRN-ESCROW-RELEASE-${input.bookingId}-${input.groupSuffix}`;const now=Date.now();
 const statements=lines.map((line,index)=>db.prepare("INSERT OR IGNORE INTO finance_journal_entries (id,entry_date,source_type,source_id,account_code,cost_centre,vertical,debit,credit,narration,period_code,posted,created_at,booking_id,transaction_at,verification_status) VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)").bind(`${journalGroup}-${index+1}`,entryDate,"escrow_release",input.accountId,line.accountCode,line.costCentre??null,line.vertical??null,money(line.debit),money(line.credit),`${input.decision} ${input.bookingId}: ${input.reason}`,periodCode,now,input.bookingId,now,"posted"));
 return{journalGroup,statements};
}

export function auditStatements(db:Db,input:{accountId:string;bookingId:string;disputeId?:string|null;eventType:string;payload:Record<string,unknown>;idempotencyKey:string;now:number}){
 const payload=json(input.payload);return[
  db.prepare("INSERT INTO escrow_audit_events (id,custodial_account_id,dispute_id,booking_id,event_type,payload_json,idempotency_key,created_at) VALUES (?,?,?,?,?,?,?,?)").bind(uid("ESCA"),input.accountId,input.disputeId??null,input.bookingId,input.eventType,payload,input.idempotencyKey,input.now),
  db.prepare("INSERT OR IGNORE INTO escrow_lifecycle_outbox (id,custodial_account_id,dispute_id,booking_id,event_type,payload_json,idempotency_key,status,created_at) VALUES (?,?,?,?,?,?,?,'PENDING',?)").bind(uid("ESCO"),input.accountId,input.disputeId??null,input.bookingId,input.eventType,payload,`outbox:${input.idempotencyKey}`,input.now),
 ];
}

export function settlementState(providerAmount:number,customerAmount:number):SettlementState{return providerAmount>0&&customerAmount>0?"PARTIAL_SETTLEMENT_PENDING":customerAmount>0?"REFUND_PENDING":"PAYOUT_PENDING";}
export function splitAmounts(amount:number,input:{decision:ArbitrationDecision;providerAmount?:number;customerAmount?:number;customerPercentage?:number}){
 if(input.decision==="ARBITRATION_RELEASE_PROVIDER")return{providerAmount:amount,customerAmount:0};
 if(input.decision==="ARBITRATION_REFUND_CUSTOMER")return{providerAmount:0,customerAmount:amount};
 if(Number.isFinite(input.customerPercentage)){
  const percentage=Number(input.customerPercentage);if(percentage<=0||percentage>=100)throw new Error("partial_split_percentage_must_be_between_zero_and_one_hundred");const customerAmount=money(amount*percentage/100),providerAmount=money(amount-customerAmount);if(providerAmount<=0||customerAmount<=0)return{providerAmount:0,customerAmount:0};return{providerAmount,customerAmount};
 }
 const providerAmount=money(input.providerAmount),customerAmount=money(input.customerAmount);if(providerAmount<=0||customerAmount<=0||Math.abs(round(providerAmount+customerAmount)-amount)>0.01)return{providerAmount:0,customerAmount:0};return{providerAmount,customerAmount};
}

export function settlementIntentStatements(db:Db,input:{account:Row;freezeId?:string|null;bookingId:string;providerAmount:number;customerAmount:number;currency:string;now:number;decisionKey:string}){
 const statements:D1PreparedStatement[]=[];const accountId=text(input.account.id),providerId=text(input.account.provider_id);
 if(input.customerAmount>0){const payableKey=`refund:${input.decisionKey}`;statements.push(db.prepare("INSERT INTO finance_refund_payables (id,custodial_account_id,dispute_id,booking_id,amount,currency,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,'PENDING',?,?,?)").bind(uid("RFP"),accountId,input.freezeId??null,input.bookingId,input.customerAmount,input.currency,payableKey,input.now,input.now));statements.push(db.prepare("INSERT INTO escrow_settlement_outbox (id,custodial_account_id,dispute_id,booking_id,kind,amount,currency,payload_json,idempotency_key,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?, 'REFUND',?,?,?,?,'PENDING',0,?,?,?)").bind(uid("ESO"),accountId,input.freezeId??null,input.bookingId,input.customerAmount,input.currency,json({bookingId:input.bookingId,accountId,disputeId:input.freezeId??null,kind:"REFUND",environment:"sandbox"}),`outbox:${payableKey}`,input.now,input.now,input.now));}
 if(input.providerAmount>0){const payableKey=`payout:${input.decisionKey}`;statements.push(db.prepare("INSERT INTO provider_payable_queue (id,custodial_account_id,dispute_id,booking_id,provider_id,amount,currency,status,idempotency_key,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'PENDING',?,?,?)").bind(uid("PPQ"),accountId,input.freezeId??null,input.bookingId,providerId,input.providerAmount,input.currency,payableKey,input.now,input.now));statements.push(db.prepare("INSERT INTO escrow_settlement_outbox (id,custodial_account_id,dispute_id,booking_id,kind,amount,currency,payload_json,idempotency_key,status,attempt_count,next_attempt_at,created_at,updated_at) VALUES (?,?,?,?, 'PAYOUT',?,?,?,?,'PENDING',0,?,?,?)").bind(uid("ESO"),accountId,input.freezeId??null,input.bookingId,input.providerAmount,input.currency,json({bookingId:input.bookingId,accountId,disputeId:input.freezeId??null,providerId,kind:"PAYOUT",environment:"sandbox"}),`outbox:${payableKey}`,input.now,input.now,input.now));}
 return statements;
}
