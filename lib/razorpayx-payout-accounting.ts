import {ACCT,prepareJournalPosting,periodOf} from "./finance-accounts";
type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const PROVIDER_TRANSIT="2115-Provider Payouts in Transit";
export async function ensureRazorpayXPayoutAccounting(db:Db){
 await db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_receipt_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT razorpayx_receipt_current CHECK(ok=1))").run();
 await db.prepare("CREATE TABLE IF NOT EXISTS razorpayx_payout_accounting (local_payout_id TEXT PRIMARY KEY,source_type TEXT NOT NULL,source_id TEXT NOT NULL,amount_paise INTEGER NOT NULL,status TEXT NOT NULL,settlement_journal_group TEXT,reversal_journal_group TEXT,reason TEXT,updated_at INTEGER NOT NULL,environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'))").run();
}
/** Prepared effects join the guarded receipt transaction. Missing opening books are an explicit review, never invented. */
export async function prepareRazorpayXPayoutAccounting(db:Db,input:{source:"commission"|"settlement"|"contractor"|"salary";row:Row;status:string;providerPayoutId:string;at:number}){
 await ensureRazorpayXPayoutAccounting(db);
 const {row,source,status,at}=input,TRANSIT=source==="salary"?"2116-Employee Salary Payouts in Transit":PROVIDER_TRANSIT,id=text(row.id),amount=Number(row.amount),paise=Math.round(amount*100);
 if(row.environment!=="sandbox")throw new Response("TEST payout accounting cannot alter live money",{status:409});
 const sourceId=text(source==="commission"?row.booking_id:row.statement_id),releaseType=source==="salary"?"employee_salary_release":source==="contractor"?"contractor_payout_release":source==="commission"?"provider_payout_release":"partner_payout_release";
 const saved=await db.prepare("SELECT * FROM razorpayx_payout_accounting WHERE local_payout_id=?").bind(id).first<Row>();
 if(saved&&(saved.source_type!==source||saved.source_id!==sourceId||Number(saved.amount_paise)!==paise))throw new Response("Payout accounting identity changed; Finance review required",{status:409});
 const writes:D1PreparedStatement[]=[],assertionId=crypto.randomUUID();let settlement=text(saved?.settlement_journal_group)||null,reversal=text(saved?.reversal_journal_group)||null;
 let ledgerStatus="awaiting_provider",reason:string|null=null;
 const exists=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='finance_journal_entries'").first();
 const release=exists?await db.prepare("SELECT COALESCE(SUM(credit-debit),0) amount FROM finance_journal_entries WHERE source_type=? AND source_id=? AND account_code=? AND posted=1").bind(releaseType,sourceId,TRANSIT).first<Row>():null;
 if(!Number.isSafeInteger(paise)||paise<100||Math.abs(amount*100-paise)>0.001)throw new Response("Payout accounting amount is invalid",{status:409});
 if(Math.abs(Number(release?.amount||0)-amount)>0.005){ledgerStatus="release_review_required";reason="Missing or mismatched release journal; no opening balance manufactured";}
 else if(["processed","reversed","failed","cancelled","rejected"].includes(status)){
  writes.push(db.prepare("INSERT INTO razorpayx_receipt_assertions (id,ok) SELECT ?,CASE WHEN ABS(COALESCE((SELECT SUM(credit-debit) FROM finance_journal_entries WHERE source_type=? AND source_id=? AND account_code=? AND posted=1),0)-?)<0.005 THEN 1 ELSE 0 END").bind(assertionId,releaseType,sourceId,TRANSIT,amount));
  const entryDate=new Date(at).toISOString().slice(0,10),base={entryDate,periodCode:periodOf(entryDate),sourceId:id,metadata:{bookingId:source==="commission"?sourceId:null,settlementId:input.providerPayoutId,verificationStatus:"sandbox",transactionAt:at}};
  if(status==="processed"){
   const plan=await prepareJournalPosting(db,{...base,groupKey:`RPX-SETTLED-${id}`,sourceType:"razorpayx_payout_settlement",narration:"RazorpayX TEST confirmed principal settlement",lines:[{accountCode:TRANSIT,debit:amount},{accountCode:ACCT.BANK,credit:amount}]});
   writes.push(...plan.statements);settlement=plan.journalGroup;ledgerStatus="principal_settled";
  }else{
   // A reversal first seen without a processed event has zero net bank movement. Never fabricate a debit.
   if(settlement&&!reversal){const plan=await prepareJournalPosting(db,{...base,groupKey:`RPX-REVERSED-${id}`,sourceType:"razorpayx_payout_reversal",narration:"RazorpayX TEST principal returned; held for Finance review, no automatic reissue",lines:[{accountCode:ACCT.BANK,debit:amount},{accountCode:TRANSIT,credit:amount}]});writes.push(...plan.statements);reversal=plan.journalGroup;}
   ledgerStatus="reconciliation_required";reason="Unpaid or returned principal remains in transit for Finance review; taxes/recoveries unchanged and automatic reissue forbidden";
  }
 }
 writes.push(db.prepare("INSERT INTO razorpayx_payout_accounting (local_payout_id,source_type,source_id,amount_paise,status,settlement_journal_group,reversal_journal_group,reason,updated_at) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(local_payout_id) DO UPDATE SET status=excluded.status,settlement_journal_group=excluded.settlement_journal_group,reversal_journal_group=excluded.reversal_journal_group,reason=excluded.reason,updated_at=excluded.updated_at").bind(id,source,sourceId,paise,ledgerStatus,settlement,reversal,reason,at));
 writes.push(db.prepare("DELETE FROM razorpayx_receipt_assertions WHERE id=?").bind(assertionId));
 return{statements:writes,status:ledgerStatus,reason,principalOnly:true,bankStatementReconciled:false};
}
export async function razorpayXPayoutAccountingDirectory(db:Db,ids:string[]){
 if(!ids.length)return[];await ensureRazorpayXPayoutAccounting(db);
 const unique=[...new Set(ids)].slice(0,500);
 return(await db.prepare(`SELECT local_payout_id,status,amount_paise,reason,settlement_journal_group,reversal_journal_group FROM razorpayx_payout_accounting WHERE local_payout_id IN (${unique.map(()=>"?").join(",")})`).bind(...unique).all<Row>()).results;
}
