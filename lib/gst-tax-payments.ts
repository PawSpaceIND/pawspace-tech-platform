/**
 * Paying over the GST and TCS the books owe, and checking the payables against what is filed (audit G9).
 *
 * Completion credits 2130-GST Payable (PawSpace's own GST on its commission or own supply) and 2140-TCS Payable (s.52 TCS
 * withheld from GST-registered providers). Nothing ever debited them, so both payables only grew and could not be matched
 * with the returns. recordTaxPayment is the "return filed / tax paid" step: Finance (finance.manage, checked by the route)
 * records the challan, the payable is debited against 1010-Bank in one balanced journal, and the payment is audited. It is
 * refused for more than the books owe for that month. A TCS payment is also the GSTR-8 deposit (tcs_deposits), which must
 * equal the TCS computed for the month.
 *
 * taxPayableReconciliation is the read-only view for one month: each account's opening, accrued, paid and closing balance
 * next to the service GST the supply register files (and the latest GSTR-3B / statutory package), and next to
 * tcs_collections / GSTR-8, with the per-booking differences. Journals are dated by completion (UTC date) while returns use
 * IST months, so a supply completed between midnight and 05:30 IST on the 1st can sit in the neighbouring month - the
 * same-booking comparison is the exact one. No live money moves here: this records a payment Finance made on the portal.
 */
import{ACCT,periodOf,postJournal}from"./finance-accounts";
import{governedJsonError}from"./governed-http-error";
import{ensureGstAccountingTables}from"./gst-accounting";
import{ensureTcsTables,recordTcsDeposit}from"./tcs-governance";
import{istMonthWindow,serviceVerticalOutputTax}from"./service-output-tax";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0;};
const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const isDate=(v:string)=>/^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(`${v}T00:00:00Z`))&&new Date(`${v}T00:00:00Z`).toISOString().slice(0,10)===v;
export const TAX_PAYABLE_ACCOUNTS={gst:"2130-GST Payable",tcs:"2140-TCS Payable"} as const;
export type TaxKind=keyof typeof TAX_PAYABLE_ACCOUNTS;
const KIND_LABEL:Record<TaxKind,string>={gst:"GST",tcs:"s.52 TCS"};

export async function ensureTaxPaymentTables(db:Db){
 await ensureGstAccountingTables(db);await ensureTcsTables(db);
 await db.prepare("CREATE TABLE IF NOT EXISTS statutory_tax_payments (id TEXT PRIMARY KEY,tax_kind TEXT NOT NULL,period_code TEXT NOT NULL,amount REAL NOT NULL,challan_reference TEXT NOT NULL,paid_on TEXT NOT NULL,return_reference TEXT,reason TEXT NOT NULL,journal_group TEXT NOT NULL,recorded_by TEXT NOT NULL,recorded_at INTEGER NOT NULL,UNIQUE(tax_kind,challan_reference))").run();
}

/** Balance of a payable: credits of months up to and including the period, less every payment debited so far. */
async function outstanding(db:Db,account:string,period:string){
 const row=await db.prepare("SELECT COALESCE(SUM(CASE WHEN period_code<=? THEN credit ELSE 0 END),0)-COALESCE(SUM(debit),0) owed FROM finance_journal_entries WHERE account_code=?").bind(period,account).first<Row>();
 return round2(num(row?.owed));
}

/** Record that Finance paid a month's GST or TCS: debits the payable against the bank with the challan reference. */
export async function recordTaxPayment(db:Db,input:{taxKind:string;periodCode:string;amount:number;challanReference:string;paidOn:string;reason:string;returnReference?:string|null},actor:string){
 await ensureTaxPaymentTables(db);
 const kind=text(input.taxKind) as TaxKind,period=text(input.periodCode),amount=round2(num(input.amount)),challan=text(input.challanReference),paidOn=text(input.paidOn),reason=text(input.reason),returnReference=text(input.returnReference)||null;
 if(!(kind in TAX_PAYABLE_ACCOUNTS))throw governedJsonError({error:"Choose GST or TCS"},400);
 if(!/^\d{4}-\d{2}$/.test(period))throw governedJsonError({error:"The month the tax is for must be YYYY-MM"},400);
 if(!(amount>0))throw governedJsonError({error:"The amount paid must be more than zero"},400);
 if(challan.length<4)throw governedJsonError({error:"The challan reference (CPIN / CIN) is required"},400);
 if(!isDate(paidOn)||paidOn<`${period}-01`)throw governedJsonError({error:"A real payment date on or after the start of that month is required"},400);
 if(reason.length<8)throw governedJsonError({error:"A clear reason of at least 8 characters is required"},400);
 const account=TAX_PAYABLE_ACCOUNTS[kind],prior=await db.prepare("SELECT * FROM statutory_tax_payments WHERE tax_kind=? AND challan_reference=?").bind(kind,challan).first<Row>();
 if(prior){if(text(prior.period_code)===period&&round2(num(prior.amount))===amount)return{...prior,duplicatePrevented:true};throw governedJsonError({error:`Challan ${challan} is already recorded for ${text(prior.period_code)} (${num(prior.amount)}); a challan is recorded once`},409);}
 const owed=await outstanding(db,account,period);
 if(amount>owed+0.01)throw governedJsonError({error:`${KIND_LABEL[kind]} payable up to ${period} is ${owed}; a payment of ${amount} is more than the books owe`},409);
 if(kind==="tcs"){const computed=await db.prepare("SELECT COALESCE(SUM(tcs_total),0) total FROM tcs_collections WHERE period=?").bind(period).first<Row>(),due=round2(num(computed?.total)),deposited=await db.prepare("SELECT amount FROM tcs_deposits WHERE period=?").bind(period).first<Row>();if(!deposited&&Math.abs(due-amount)>0.01)throw governedJsonError({error:`The TCS deposit for ${period} must equal the TCS computed for GSTR-8 (${due}); compute the month's TCS first`},409);}
 const id=`TAXPAY-${crypto.randomUUID().slice(0,12).toUpperCase()}`,now=Date.now();
 const journal=await postJournal(db,{groupKey:`TAX-PAYMENT-${kind.toUpperCase()}-${challan}`,entryDate:paidOn,periodCode:periodOf(paidOn),sourceType:`${kind}_payment`,sourceId:period,narration:`${KIND_LABEL[kind]} for ${period} paid, challan ${challan}`,metadata:{settlementId:challan,transactionAt:now,verificationStatus:"recorded"},lines:[{accountCode:account,debit:amount},{accountCode:ACCT.BANK,credit:amount}]})
  .catch((error:unknown)=>{const message=error instanceof Error?error.message:String(error);if(/period_locked/.test(message))throw governedJsonError({error:`The payment date falls in a closed month (${periodOf(paidOn)}); record it with a date in an open month`},409);throw error;});
 await db.batch([
  db.prepare("INSERT INTO statutory_tax_payments (id,tax_kind,period_code,amount,challan_reference,paid_on,return_reference,reason,journal_group,recorded_by,recorded_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)").bind(id,kind,period,amount,challan,paidOn,returnReference,reason,journal.journalGroup,actor,now),
  db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,?,?,?,?,?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,"tax_payment",id,`${kind}_paid`,JSON.stringify({outstanding:owed}),JSON.stringify({taxKind:kind,periodCode:period,amount,challanReference:challan,paidOn,returnReference,journalGroup:journal.journalGroup,outstandingAfter:round2(owed-amount)}),actor,reason,now),
 ]);
 const deposit=kind==="tcs"?await recordTcsDeposit(db,{period,challanReference:challan,amount,actorId:actor}):null;
 return{id,taxKind:kind,periodCode:period,amount,challanReference:challan,paidOn,returnReference,account,journalGroup:journal.journalGroup,outstandingBefore:owed,outstandingAfter:round2(owed-amount),tcsDeposit:deposit,duplicatePrevented:false};
}

async function accountMovement(db:Db,account:string,period:string){
 const row=await db.prepare("SELECT COALESCE(SUM(CASE WHEN period_code<? THEN credit-debit ELSE 0 END),0) opening,COALESCE(SUM(CASE WHEN period_code=? THEN credit ELSE 0 END),0) accrued,COALESCE(SUM(CASE WHEN period_code=? THEN debit ELSE 0 END),0) paid FROM finance_journal_entries WHERE account_code=? AND period_code<=?").bind(period,period,period,account,period).first<Row>();
 const opening=round2(num(row?.opening)),accrued=round2(num(row?.accrued)),paid=round2(num(row?.paid));
 return{account,opening,accrued,paid,closing:round2(opening+accrued-paid)};
}
async function latestSummary(db:Db,sql:string,binds:unknown[]){const row=await db.prepare(sql).bind(...binds).first<Row>().catch(()=>null);if(!row)return null;try{return JSON.parse(text(row.summary_json)) as Row;}catch{return null;}}

/** One month's 2130-GST Payable and 2140-TCS Payable against the returns and tcs_collections. Read only. */
export async function taxPayableReconciliation(db:Db,input:{periodCode:string}){
 await ensureTaxPaymentTables(db);
 const period=text(input.periodCode),{startMs,endMs}=istMonthWindow(period);
 const[gstAccount,tcsAccount,services]=await Promise.all([accountMovement(db,TAX_PAYABLE_ACCOUNTS.gst,period),accountMovement(db,TAX_PAYABLE_ACCOUNTS.tcs,period),serviceVerticalOutputTax(db,startMs,endMs)]);
 const[gstr3b,pkg,payments,collections,statement,deposit,tcsByBooking]=await Promise.all([
  latestSummary(db,"SELECT summary_json FROM gst_return_documents WHERE return_type='GSTR-3B' AND period_code=? ORDER BY prepared_at DESC,version DESC LIMIT 1",[period]),
  latestSummary(db,"SELECT summary_json FROM finance_statutory_packages WHERE period_code=? ORDER BY prepared_at DESC,version DESC LIMIT 1",[period]),
  db.prepare("SELECT tax_kind,COALESCE(SUM(amount),0) amount,COUNT(*) n FROM statutory_tax_payments WHERE period_code=? GROUP BY tax_kind").bind(period).all<Row>(),
  db.prepare("SELECT COALESCE(SUM(tcs_total),0) total,COUNT(*) n FROM tcs_collections WHERE period=?").bind(period).first<Row>(),
  db.prepare("SELECT total_tcs,status FROM tcs_statements WHERE period=?").bind(period).first<Row>(),
  db.prepare("SELECT amount,challan_reference FROM tcs_deposits WHERE period=?").bind(period).first<Row>(),
  db.prepare("SELECT c.booking_id,c.tcs_total,COALESCE((SELECT SUM(j.credit-j.debit) FROM finance_journal_entries j WHERE j.account_code='2140-TCS Payable' AND j.source_type='service_completion' AND j.source_id=c.booking_id),0) posted FROM tcs_collections c WHERE c.period=?").bind(period).all<Row>(),
 ]);
 const paid=(kind:TaxKind)=>round2(num(payments.results.find(r=>text(r.tax_kind)===kind)?.amount));
 const filedGst=services.pawspaceOwnOutputTax,gstDifference=round2(gstAccount.accrued-filedGst),tcsCollections=round2(num(collections?.total));
 const tcsMismatches=tcsByBooking.results.map(r=>({bookingId:text(r.booking_id),gstr8Tcs:round2(num(r.tcs_total)),postedTcs:round2(num(r.posted))})).filter(r=>Math.abs(r.gstr8Tcs-r.postedTcs)>0.01).slice(0,50),tcsDifference=round2(tcsAccount.accrued-tcsCollections);
 const gst={...gstAccount,filedServiceGst:filedGst,serviceTaxableValue:services.pawspaceOwnTaxableValue,serviceExemptValue:services.exemptValue,notYetClassifiedGst:services.notYetClassified.gst,
  latestGstr3bServiceGst:gstr3b?round2(num(gstr3b.serviceVerticalTax)):null,latestStatutoryPackageServiceGst:pkg?round2(num(pkg.serviceOutputTax)):null,
  sameBookings:services.ledgerCheck,paymentsRecordedForPeriod:paid("gst"),unpaidForPeriod:round2(Math.max(0,filedGst-paid("gst"))),difference:gstDifference,
  explanation:Math.abs(gstDifference)<=0.01?"The GST accrued in the ledger this month equals the service GST filed for it.":"The ledger dates a completion by its UTC date and the returns use IST months; supplies invoiced before completion are filed in the invoice month; rows completed before 26 Sept 2026 filed their carve differently. The same-booking comparison shows the exact per-booking agreement."};
 const tcs={...tcsAccount,tcsCollections,tcsCollectionLines:num(collections?.n),gstr8PreparedTcs:statement?round2(num(statement.total_tcs)):null,deposit:deposit?{amount:round2(num(deposit.amount)),challanReference:text(deposit.challan_reference)}:null,
  paymentsRecordedForPeriod:paid("tcs"),sameBookings:{bookings:tcsByBooking.results.length,mismatches:tcsMismatches},difference:tcsDifference,
  explanation:Math.abs(tcsDifference)<=0.01?"The TCS withheld in the ledger this month equals the TCS computed for GSTR-8.":"GSTR-8 nets returns made after completion and skips providers without a GSTIN, while the ledger keeps what completion withheld; compute the month's TCS first if tcs_collections is empty."};
 return{periodCode:period,gst,tcs,status:Math.abs(gstDifference)<=0.01&&Math.abs(tcsDifference)<=0.01&&services.ledgerCheck.agrees&&!tcsMismatches.length?"reconciled" as const:"differences" as const,liveFilingEnabled:false};
}
