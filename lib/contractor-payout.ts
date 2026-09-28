import {ensureContractorPayTables} from "./contractor-pay";
import {assertActiveVerifiedPayoutBeneficiary} from "./payout-beneficiary-verification";
import {prepareJournalPosting,periodOf} from "./finance-accounts";
type Row=Record<string,unknown>;type Db=D1Database;
const text=(v:unknown)=>String(v??"").trim();
const refuse=(message:string,status=409)=>new Response(message,{status});
export function assertContractorPayoutSandbox(env:Record<string,unknown>){
 if(text(env.PAWSPACE_PAYMENT_ENV)!=="sandbox"||text(env.PAWSPACE_RAZORPAYX_ENV)!=="sandbox"||text(env.PAWSPACE_RAZORPAYX_LIVE_APPROVED)!=="false"||text(env.FORBID_PRODUCTION)!=="true"||["production","live"].includes(text(env.PAWSPACE_DEPLOYMENT_ENV)))throw refuse("Contractor payout preparation requires an isolated TEST payment environment");
}
export async function ensureContractorPayoutTables(db:Db){
 await ensureContractorPayTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS contractor_payout_instructions (id TEXT PRIMARY KEY,statement_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,amount REAL NOT NULL CHECK(amount>=1),currency TEXT NOT NULL DEFAULT 'INR' CHECK(currency='INR'),environment TEXT NOT NULL DEFAULT 'sandbox' CHECK(environment='sandbox'),status TEXT NOT NULL,razorpayx_contact_id TEXT NOT NULL,razorpayx_fund_account_id TEXT NOT NULL,beneficiary_snapshot_json TEXT NOT NULL,beneficiary_snapshot_sha256 TEXT NOT NULL,idempotency_key TEXT NOT NULL UNIQUE,provider_reference TEXT UNIQUE,last_error TEXT,statement_approved_at INTEGER NOT NULL,release_journal_group TEXT NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS contractor_payout_assertions (id TEXT PRIMARY KEY,ok INTEGER NOT NULL CONSTRAINT contractor_payout_current CHECK(ok=1))"),
  db.prepare("CREATE INDEX IF NOT EXISTS contractor_payout_status_idx ON contractor_payout_instructions(status,updated_at)"),
 ]);
}
export const contractorPayoutView=(r:Row)=>({id:text(r.id),statementId:text(r.statement_id),providerId:text(r.provider_id),amount:Number(r.amount),currency:"INR",status:text(r.status),providerReference:text(r.provider_reference)||null,environment:"sandbox",liveMoney:false});
export async function contractorPayoutDirectory(db:Db,period:string){
 await ensureContractorPayoutTables(db);
 const rows=await db.prepare("SELECT p.* FROM contractor_payout_instructions p JOIN contractor_monthly_statements s ON s.id=p.statement_id WHERE s.period_code=? ORDER BY p.created_at DESC").bind(period).all<Row>();
 return rows.results.map(contractorPayoutView);
}
export async function queueContractorPayout(db:Db,env:Record<string,unknown>,input:{statementId:string;expectedNetPayable:number;actorId:string;reason:string}){
 assertContractorPayoutSandbox(env);await ensureContractorPayoutTables(db);
 const actor=text(input.actorId),reason=text(input.reason),statementId=text(input.statementId);
 if(!actor||reason.length<8||!statementId||!Number.isFinite(input.expectedNetPayable))throw refuse("Choose an approved statement, its reviewed amount and a clear payout reason",400);
 const s=await db.prepare("SELECT * FROM contractor_monthly_statements WHERE id=?").bind(statementId).first<Row>();
 if(!s||s.status!=="approved"||!s.journal_group||!s.approved_by||!s.approved_at)throw refuse("A Finance-approved contractor statement with posted accrual is required");
 const amount=Number(s.net_payable),paise=Math.round(amount*100),providerId=text(s.provider_id);
 if(!Number.isSafeInteger(paise)||paise<100||Math.abs(amount*100-paise)>0.001||Math.abs(amount-input.expectedNetPayable)>0.001)throw refuse("The reviewed contractor amount no longer matches the approved statement");
 const prior=await db.prepare("SELECT * FROM contractor_payout_instructions WHERE statement_id=?").bind(statementId).first<Row>();
 if(prior){if(text(prior.provider_id)!==providerId||Math.abs(Number(prior.amount)-amount)>0.001)throw refuse("Contractor payout identity changed; Finance reconciliation is required");return{...contractorPayoutView(prior),duplicatePrevented:true};}
 const beneficiary=await assertActiveVerifiedPayoutBeneficiary(db,providerId);
 const at=Date.now(),id=`CPAY-${crypto.randomUUID().replaceAll("-","")}`,entryDate=new Date(at).toISOString().slice(0,10),assertionId=crypto.randomUUID();
 const plan=await prepareJournalPosting(db,{groupKey:`CONTRACTOR-PAYOUT-${statementId}`,entryDate,periodCode:periodOf(entryDate),sourceType:"contractor_payout_release",sourceId:statementId,narration:"Approved contractor TEST payout reserved; not bank paid",lines:[{accountCode:"2110-Provider Payable",debit:amount},{accountCode:"2115-Provider Payouts in Transit",credit:amount}],metadata:{settlementId:id,serviceCode:text(s.service_code),verificationStatus:"sandbox",transactionAt:at}});
 const writes=[
  db.prepare("INSERT INTO contractor_payout_assertions (id,ok) SELECT ?,CASE WHEN EXISTS(SELECT 1 FROM contractor_monthly_statements WHERE id=? AND status='approved' AND provider_id=? AND approved_at=? AND journal_group=? AND ABS(net_payable-?)<0.001) AND ABS(COALESCE((SELECT SUM(credit-debit) FROM finance_journal_entries WHERE source_type='contractor_statement' AND source_id=? AND account_code='2110-Provider Payable' AND posted=1),0)-?)<0.005 AND EXISTS(SELECT 1 FROM provider_compensation_profiles WHERE provider_id=? AND status='active' AND razorpayx_contact_id=? AND razorpayx_fund_account_id=?) AND EXISTS(SELECT 1 FROM provider_verifications WHERE id=? AND status='verified' AND (expires_at IS NULL OR expires_at>?)) THEN 1 ELSE 0 END").bind(assertionId,statementId,providerId,s.approved_at,s.journal_group,amount,statementId,amount,providerId,beneficiary.razorpayxContactId,beneficiary.razorpayxFundAccountId,beneficiary.verificationId,at),
  db.prepare("INSERT INTO contractor_payout_instructions (id,statement_id,provider_id,amount,status,razorpayx_contact_id,razorpayx_fund_account_id,beneficiary_snapshot_json,beneficiary_snapshot_sha256,idempotency_key,statement_approved_at,release_journal_group,created_by,created_at,updated_at) VALUES (?,?,?,?,'approved_sandbox',?,?,?,?,?,?,?,?,?,?)").bind(id,statementId,providerId,amount,beneficiary.razorpayxContactId,beneficiary.razorpayxFundAccountId,beneficiary.snapshotJson,beneficiary.snapshotSha256,`contractor:${statementId}`,s.approved_at,plan.journalGroup,actor,at,at),
  ...plan.statements,
  db.prepare("INSERT INTO contractor_pay_events (id,provider_id,subject_type,subject_id,event_type,actor_email,reason,detail_json,created_at) VALUES (?,?,'statement',?,'payout_prepared_sandbox',?,?,?,?)").bind(crypto.randomUUID(),providerId,statementId,actor,reason,JSON.stringify({payoutId:id,amount,environment:"sandbox",liveMoney:false}),at),
  db.prepare("DELETE FROM contractor_payout_assertions WHERE id=?").bind(assertionId),
 ];
 try{await db.batch(writes);}catch(error){const saved=await db.prepare("SELECT * FROM contractor_payout_instructions WHERE statement_id=?").bind(statementId).first<Row>();if(saved&&text(saved.provider_id)===providerId&&Math.abs(Number(saved.amount)-amount)<0.001)return{...contractorPayoutView(saved),duplicatePrevented:true};throw error;}
 return{...contractorPayoutView({id,statement_id:statementId,provider_id:providerId,amount,status:"approved_sandbox"}),duplicatePrevented:false};
}
export async function contractorDispatchGuard(db:Db,payoutId:string){
 const r=await db.prepare("SELECT p.*,s.status statement_status,s.net_payable,s.approved_at,s.provider_id statement_provider FROM contractor_payout_instructions p JOIN contractor_monthly_statements s ON s.id=p.statement_id WHERE p.id=?").bind(payoutId).first<Row>();
 if(!r||r.statement_status!=="approved"||r.provider_id!==r.statement_provider||Number(r.statement_approved_at)!==Number(r.approved_at)||Math.abs(Number(r.amount)-Number(r.net_payable))>0.001)throw refuse("Contractor statement is no longer the approved payout source");
 const beneficiary=await assertActiveVerifiedPayoutBeneficiary(db,text(r.provider_id));
 if(beneficiary.razorpayxContactId!==text(r.razorpayx_contact_id)||beneficiary.razorpayxFundAccountId!==text(r.razorpayx_fund_account_id))throw refuse("Approved contractor beneficiary changed; review the original instruction instead of redirecting it");
 return{sql:" AND EXISTS(SELECT 1 FROM contractor_monthly_statements WHERE id=? AND status='approved' AND provider_id=? AND approved_at=? AND ABS(net_payable-?)<0.001) AND EXISTS(SELECT 1 FROM provider_compensation_profiles WHERE provider_id=? AND status='active' AND razorpayx_contact_id=? AND razorpayx_fund_account_id=?) AND EXISTS(SELECT 1 FROM provider_verifications WHERE id=? AND status='verified' AND (expires_at IS NULL OR expires_at>?))",args:[r.statement_id,r.provider_id,r.approved_at,r.amount,r.provider_id,beneficiary.razorpayxContactId,beneficiary.razorpayxFundAccountId,beneficiary.verificationId,Date.now()]};
}
