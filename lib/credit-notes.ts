/**
 * Credit notes for refunds after completion (owner decision D, 27 Sept 2026): Section 34 of the CGST Act and Rule 53.
 *
 * ONE credit note per processed escalation refund (lib/escalation-refunds.ts), issued by the seller of record against the
 * customer's original invoice: the customer tax invoice the seller in the tax policy issued at completion
 * (lib/booking-tax-invoice.ts; finance_invoices, source_event_key "booking-invoice:<id>"), else a canonical invoice Finance
 * issued by hand for the booking, else the booking's own service invoice (booking_invoices). The note reuses what that invoice
 * printed (seller, recipient, place of supply, SAC). Without any invoice there is nothing to reference, so the note waits (the
 * refund itself never does) and the settlement sweep issues it once the invoice exists.
 *
 * VALUE, per the owner's report model (decision A: "PawSpace pays 18% GST on the amount it makes"), taken from the payout
 * record completion posted from (provider_payout_computations), never from today's settings:
 *   commission booking  taxable value reduced = PawSpace's share of the refund (its commission % x refund), GST = 18% of it:
 *                       20% of a Rs 1,000 booking at 70/30 -> refund 200, taxable 60, GST 10.80 (CGST 5.40 + SGST 5.40);
 *   own supply          taxable value reduced = the refund, GST = 18% of it: 200 -> 200 and 36;
 *   funeral / memorial  no GST, reversed in the section the supply was filed under (the invoice's line, else Finance's funeral
 *                       GST treatment on the supply's date, lib/funeral-gst-treatment.ts): outside GST under Schedule III by
 *                       default, so PawSpace's share reduces the non-GST value (GSTR-3B 3.1(e), GSTR-1 Table 8); exempt when
 *                       Finance chose exempt (3.1(c)). A funeral Finance made taxable was recorded with GST and is taxed.
 * Only the supplier issues a credit note (s.34(1)): on a commission booking PawSpace's note covers ONLY its own fee portion;
 * the provider's portion of the refund is recorded on the provider payout (reduction or recovery), never on PawSpace's return.
 * The booking's own GST method is followed ("extract_inclusive" takes the GST out of the share instead of adding 18% to it).
 * The output tax may be reduced only because the tax was passed back (proviso to s.34(2)): a note is issued only for a refund
 * the gateway processed, and it carries that refund's reference. It must be declared by 30 November after the financial year
 * of the original invoice (s.34(2)); a note that would fall later is refused and the settlement records it as time-barred.
 *
 * NUMBERING: its own financial-year series in finance_document_series_v2 (document_type 'credit_note'), claimed through the
 * same serial-claim table and 16-character rule as invoices (lib/statutory-invoicing.ts). Finance can set the series; when
 * none is set for the year, one is opened from the policy seller's name: TK PETCARE -> "TKC/26-27/" + 5 digits (15
 * characters, room for 99,999 notes a year).
 *
 * PERIOD: the IST month the refund was processed. If that month is already closed and locked, the note is issued in the
 * month it is actually issued, as every other correction is (lib/finance-accounts.ts "post corrections in the next open
 * period"); a note is never written into a locked month.
 *
 * BOOKS: the GST reduction is a balanced journal (Dr 2130-GST Payable, Cr 4900-Refunds) and a finance_tax_ledger
 * 'adjustment' row per component, the same mechanism the existing credit note path (issueAdjustment) uses, so the
 * statutory package and GSTR-9 net it. For a GST-registered commission provider the s.52 TCS on the returned value is
 * reversed in the refund month (Dr 2140-TCS Payable, Cr 4900-Refunds) and the TCS base (net value) is reduced there.
 *
 * FILING: creditNoteFilingAdjustments() returns what each return needs for an entity and period, and the small hooks below
 * apply it: GSTR-1 (cdnr for a registered customer; cdnur for an unregistered B2C Large invoice; otherwise the B2CS, HSN
 * and Table 8 figures are reduced), GSTR-3B 3.1(a)/3.1(c)/3.1(e), the monthly close, the tax payable reconciliation and GSTR-8.
 * Import-safe for `node --experimental-strip-types`.
 */
import{ACCT,prepareJournalPosting}from"./finance-accounts";
import{ConfigurationRequired}from"./gst-accounting";
import{ensureStatutoryInvoiceTables,statutorySeriesRules}from"./statutory-invoicing";
import{CITY_STATE_CODE}from"./tcs-governance";
import{providerTcs,recordedTcsDecision}from"./provider-tcs";
import{COMMISSION_ENGAGEMENT_MODELS}from"./provider-commercial-terms";
import{governedJsonError}from"./governed-http-error";
import{bookingInvoiceEventKey,supplySac}from"./service-output-tax";
import{GST_STATE_NAMES,normaliseSac,sacDescription}from"./service-sac-defaults";
import{resolveFuneralGstTreatment,type FuneralGstTreatment}from"./funeral-gst-treatment";

type Db=D1Database;type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0;};
const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const money=(v:unknown)=>round2(Math.max(0,num(v)));
const IST=330*60_000;
/** The India calendar date (YYYY-MM-DD) of an instant. */
export const istDate=(ms:number)=>new Date(ms+IST).toISOString().slice(0,10);
const parse=(value:unknown):Row=>{try{const v=JSON.parse(text(value)||"{}");return v&&typeof v==="object"&&!Array.isArray(v)?v as Row:{};}catch{return{};}};

export const CREDIT_NOTE_SOURCE_TYPE="escalation_refund";
/** Journal source types: the GST a credit note takes off 2130, and the s.52 TCS a refund takes off 2140. */
export const CREDIT_NOTE_JOURNAL_SOURCE="escalation_credit_note";
export const TCS_ADJUSTMENT_JOURNAL_SOURCE="escalation_refund_tcs";
const GST_PAYABLE="2130-GST Payable",TCS_PAYABLE="2140-TCS Payable";
/** GSTR-1 B2C Large: an inter-state invoice to an unregistered person above Rs 1,00,000 (Rs 2,50,000 before 1 Aug 2024). */
export const b2clThreshold=(invoiceDate:string)=>text(invoiceDate)>="2024-08-01"?100000:250000;

async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
async function columnsOf(db:Db,name:string){return new Set((await db.prepare(`PRAGMA table_info(${name})`).all<Row>()).results.map(r=>text(r.name)));}

const ready=new WeakSet<Db>();
export async function ensureCreditNoteTables(db:Db){
 if(ready.has(db))return;
 await ensureStatutoryInvoiceTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS finance_credit_notes (id TEXT PRIMARY KEY,credit_note_number TEXT NOT NULL UNIQUE,source_event_key TEXT NOT NULL UNIQUE,source_type TEXT NOT NULL,source_id TEXT NOT NULL,request_id TEXT,booking_id TEXT NOT NULL,customer_id TEXT,entity_id TEXT NOT NULL,registration_id TEXT NOT NULL,seller_gstin TEXT NOT NULL,series_id TEXT NOT NULL,financial_year TEXT NOT NULL,serial_number INTEGER NOT NULL,issue_date TEXT NOT NULL,period_code TEXT NOT NULL,original_invoice_kind TEXT NOT NULL,original_invoice_id TEXT NOT NULL,original_invoice_number TEXT NOT NULL,original_invoice_date TEXT NOT NULL,original_invoice_fy TEXT NOT NULL,treatment TEXT NOT NULL CHECK(treatment IN ('commission','own_supply','exempt','non_gst')),refund_amount REAL NOT NULL CHECK(refund_amount>0),value_reduced REAL NOT NULL,taxable_value REAL NOT NULL DEFAULT 0,exempt_value REAL NOT NULL DEFAULT 0,gst_rate REAL NOT NULL DEFAULT 0,cgst REAL NOT NULL DEFAULT 0,sgst REAL NOT NULL DEFAULT 0,igst REAL NOT NULL DEFAULT 0,tax_total REAL NOT NULL DEFAULT 0,place_of_supply TEXT NOT NULL,supply_type TEXT NOT NULL CHECK(supply_type IN ('INTRA','INTER')),recipient_gstin TEXT,recipient_registered INTEGER NOT NULL DEFAULT 0,gstr1_section TEXT NOT NULL CHECK(gstr1_section IN ('cdnr','cdnur','b2cs','nil')),sac TEXT,refund_reference TEXT,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'issued',snapshot_json TEXT NOT NULL,journal_group TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_finance_credit_notes_period ON finance_credit_notes(entity_id,registration_id,period_code,status)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_finance_credit_notes_booking ON finance_credit_notes(booking_id,created_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_tcs_base_adjustments (id TEXT PRIMARY KEY,source_event_key TEXT NOT NULL UNIQUE,period_code TEXT NOT NULL,booking_id TEXT NOT NULL,provider_id TEXT NOT NULL,service_code TEXT NOT NULL DEFAULT '',supplier_gstin TEXT NOT NULL,supplier_state TEXT NOT NULL,pos_state TEXT NOT NULL,supply_type TEXT NOT NULL CHECK(supply_type IN ('intra','inter')),completion_period TEXT NOT NULL,returned_value REAL NOT NULL CHECK(returned_value>0),cgst REAL NOT NULL DEFAULT 0,sgst REAL NOT NULL DEFAULT 0,igst REAL NOT NULL DEFAULT 0,tcs_total REAL NOT NULL CHECK(tcs_total>0),rate_version TEXT NOT NULL,rate_effective_from TEXT NOT NULL,rate_total REAL NOT NULL,refund_case_id TEXT NOT NULL,credit_note_id TEXT,journal_group TEXT,created_by TEXT NOT NULL,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_finance_tcs_base_adjustments_period ON finance_tcs_base_adjustments(period_code,booking_id)"),
 ]);
 ready.add(db);
}

export type CreditNoteTreatment="commission"|"own_supply"|"exempt"|"non_gst";
/**
 * How a funeral / memorial supply that carried no GST is reversed: in the section it was filed under. The booking's customer
 * tax invoice says so on its line (an exempt or a non-GST line); otherwise Finance's funeral GST treatment in force on the
 * supply's date (lib/funeral-gst-treatment.ts: Schedule III by default). A supply that was recorded with GST (taxable at its
 * own date) is a taxable supply and never reaches this: its note carries the GST it charged.
 */
export async function noGstTreatmentForSupply(db:Db,invoice:OriginalInvoice|null,supplyDate:string):Promise<FuneralGstTreatment>{
 if(invoice?.noGstRole)return invoice.noGstRole==="exempt"?"exempt":"schedule_iii";
 return(await resolveFuneralGstTreatment(db,invoice?.date||supplyDate)).treatment;
}
export type CreditNoteValue={treatment:CreditNoteTreatment;commissionPercent:number;valueReduced:number;taxableValue:number;exemptValue:number;ratePercent:number;tax:number;method:string};
/**
 * What a refund takes off PawSpace's supply, from the booking's payout record. Pure, so the Booking Command Center preview,
 * the Finance approval screen and the note itself show the same figures. `exemptValue` carries an exempt or a non-GST value.
 */
export function creditNoteValue(input:{refund:number;orderValue:number;platformFee:number;supplyModel:string;gstExempt:boolean;gstRatePercent:number;gstMethod?:string|null;funeralTreatment?:FuneralGstTreatment}):CreditNoteValue{
 const refund=money(input.refund),order=money(input.orderValue),own=text(input.supplyModel)==="own_supply",method=text(input.gstMethod)||"percent_of_base";
 const commissionPercent=own?100:order>0?round2(money(input.platformFee)/order*100):0;
 // PawSpace's share of the refund: all of it on its own supply, its commission % of it on a commission booking.
 const valueReduced=own?refund:order>0?round2(refund*money(input.platformFee)/order):0;
 // A supply recorded with no GST (funeral / memorial) is reversed with none, in the section it was filed under: exempt, or
 // outside GST (Schedule III). A funeral Finance made taxable was recorded with GST at its own date and is taxed like any supply.
 if(input.gstExempt)return{treatment:input.funeralTreatment==="exempt"?"exempt":"non_gst",commissionPercent,valueReduced,taxableValue:0,exemptValue:valueReduced,ratePercent:0,tax:0,method};
 const rate=num(input.gstRatePercent);
 if(method==="extract_inclusive"){const taxable=round2(valueReduced*100/(100+rate));return{treatment:own?"own_supply":"commission",commissionPercent,valueReduced,taxableValue:taxable,exemptValue:0,ratePercent:rate,tax:round2(valueReduced-taxable),method};}
 return{treatment:own?"own_supply":"commission",commissionPercent,valueReduced,taxableValue:valueReduced,exemptValue:0,ratePercent:rate,tax:round2(valueReduced*rate/100),method};
}
/** CGST + SGST (place of supply in the seller's state) or IGST. The halves always add back to the GST. */
export function creditNoteComponents(tax:number,posState:string,sellerState:string){const intra=posState===sellerState,cgst=intra?round2(tax/2):0;return{supplyType:(intra?"INTRA":"INTER") as "INTRA"|"INTER",cgst,sgst:intra?round2(tax-cgst):0,igst:intra?0:round2(tax)};}

/** The payout record completion posted from, when it carries the owner's model (supply_model is set since 26 Sept 2026). */
export async function payoutRecordForCreditNote(db:Db,bookingId:string){
 if(!await tableExists(db,"provider_payout_computations"))return null;
 const cols=await columnsOf(db,"provider_payout_computations");
 if(!["supply_model","gst_exempt","gst_rate","gst_method","taxable_commission"].every(c=>cols.has(c)))return null;
 const row=await db.prepare("SELECT * FROM provider_payout_computations WHERE booking_id=?").bind(bookingId).first<Row>();
 if(!row||!["commission","own_supply"].includes(text(row.supply_model)))return null;
 if(num(row.gst_exempt)!==1&&!(num(row.gst_rate)>0))return null;
 return row;
}
export function valueFromPayoutRecord(row:Row,refund:number,funeralTreatment?:FuneralGstTreatment){return creditNoteValue({refund,orderValue:num(row.order_value),platformFee:num(row.platform_fee),supplyModel:text(row.supply_model),gstExempt:num(row.gst_exempt)===1,gstRatePercent:num(row.gst_rate),gstMethod:text(row.gst_method),funeralTreatment});}
/** s.34(2): a credit note must be declared by 30 November after the end of the financial year of the original invoice. */
export function creditNoteDeadline(originalInvoiceDate:string){const fy=statutorySeriesRules.financialYear(originalInvoiceDate);return{financialYear:fy,deadline:`${Number(fy.slice(0,4))+1}-11-30`};}

export async function periodLocked(db:Db,period:string){
 if(!await tableExists(db,"finance_close_periods"))return false;
 const row=await db.prepare("SELECT status FROM finance_close_periods WHERE period_code=?").bind(period).first<Row>();
 return text(row?.status)==="locked";
}
/**
 * The date a correction for something that happened at `happenedAt` is written on: that IST date, or - when its month is
 * already closed and locked - the date it is actually written (asOf). Refused when both months are locked.
 */
export async function correctionDate(db:Db,happenedAt:number,asOf:number){
 const natural=istDate(happenedAt);
 if(!await periodLocked(db,natural.slice(0,7)))return{issueDate:natural,periodCode:natural.slice(0,7),movedFromLockedPeriod:null as string|null};
 const today=istDate(asOf);
 if(await periodLocked(db,today.slice(0,7)))throw governedJsonError({error:`period_locked: ${today.slice(0,7)} is closed and locked; open the month before a refund's credit note can be issued`},409);
 return{issueDate:today,periodCode:today.slice(0,7),movedFromLockedPeriod:natural.slice(0,7)};
}

/** `value` is the invoice's own value for the seller: what its own lines bill (GST included, as the document shows it), never
 * the amount it collected on the provider's behalf - a commission booking's invoice is worth PawSpace's fee; on a canonical
 * invoice without line amounts, its total; on the booking's own service invoice, its gross amount. */
type OriginalInvoice={kind:"finance_invoice"|"booking_invoice";id:string;number:string;date:string;entityId:string|null;registrationId:string|null;seller:Row|null;buyer:Row|null;recipientGstin:string|null;posState:string|null;sac:string|null;noGstRole:"exempt"|"non_gst"|null;value:number};
const asRow=(value:unknown):Row|null=>value&&typeof value==="object"&&!Array.isArray(value)?value as Row:null;
/**
 * The customer's original invoice for the booking: the customer tax invoice the seller in the tax policy issued at completion
 * (lib/booking-tax-invoice.ts, source_event_key "booking-invoice:<id>"), else a canonical invoice Finance issued by hand for the
 * booking, else the booking's own service invoice. From a canonical invoice the note reuses what it printed: the seller, the
 * recipient, the place of supply, the SAC and whether the supply was filed as exempt or outside GST.
 */
export async function originalInvoiceFor(db:Db,bookingId:string):Promise<OriginalInvoice|null>{
 if(await tableExists(db,"finance_invoices")){
  const inv=await db.prepare("SELECT * FROM finance_invoices WHERE source_type='booking' AND source_id=? AND status!='cancelled' ORDER BY CASE WHEN source_event_key=? THEN 0 ELSE 1 END,created_at,id LIMIT 1").bind(bookingId,bookingInvoiceEventKey(bookingId)).first<Row>();
  if(inv){
   const snap=parse(inv.tax_snapshot_json),document=asRow(snap.document)??{},lines=(Array.isArray(snap.lines)?snap.lines:[]) as Row[],own=lines.filter(l=>text(l.role)!=="collected_on_behalf"),supply=own[0]??null,role=text(supply?.role);
   const billed=round2(own.reduce((sum,l)=>sum+num(l.lineAmount),0)),value=own.length&&billed>0?billed:round2(num(inv.amount_received)||num(inv.total));
   const seller=asRow(document.seller)??asRow(snap.seller),buyer=asRow(document.buyer)??asRow(snap.buyer);
   return{kind:"finance_invoice",id:text(inv.id),number:text(inv.invoice_number),date:text(inv.issue_date),entityId:text(inv.entity_id)||null,registrationId:text(inv.registration_id)||null,seller,buyer,recipientGstin:text(snap.recipient_gstin)||text(buyer?.gstin)||null,posState:/^\d{2}$/.test(text(snap.pos_state))?text(snap.pos_state):null,sac:normaliseSac(supply?.classificationCode)||null,noGstRole:role==="exempt"||role==="non_gst"?role:null,value};
  }
 }
 if(await tableExists(db,"booking_invoices")){
  const owned=await tableExists(db,"service_invoice_ownership");
  const inv=await db.prepare(`SELECT bi.id,bi.invoice_number,bi.issued_at,bi.gross_amount,${owned?"o.entity_id,o.registration_id":"NULL entity_id,NULL registration_id"} FROM booking_invoices bi${owned?" LEFT JOIN service_invoice_ownership o ON o.invoice_id=bi.id":""} WHERE bi.booking_id=? AND bi.status!='cancelled' AND bi.issued_at>0 ORDER BY bi.issued_at LIMIT 1`).bind(bookingId).first<Row>();
  if(inv)return{kind:"booking_invoice",id:text(inv.id),number:text(inv.invoice_number),date:istDate(num(inv.issued_at)),entityId:text(inv.entity_id)||null,registrationId:text(inv.registration_id)||null,seller:null,buyer:null,recipientGstin:null,posState:null,sac:null,noGstRole:null,value:round2(num(inv.gross_amount))};
 }
 return null;
}
/** Which legal entity and GST registration filed the supply: the invoice's, else the supply's assignment, else the one active GSTIN. */
async function supplyOwner(db:Db,bookingId:string,invoice:OriginalInvoice|null){
 if(invoice?.entityId&&invoice.registrationId)return{entityId:invoice.entityId,registrationId:invoice.registrationId};
 if(await tableExists(db,"service_supply_ownership")){const row=await db.prepare("SELECT entity_id,registration_id FROM service_supply_ownership WHERE supply_key=?").bind(`booking:${bookingId}`).first<Row>();if(row)return{entityId:text(row.entity_id),registrationId:text(row.registration_id)};}
 const all=(await db.prepare("SELECT id,entity_id FROM tax_registrations WHERE status='active'").all<Row>()).results;
 if(all.length===1)return{entityId:text(all[0].entity_id),registrationId:text(all[0].id)};
 throw new ConfigurationRequired("credit_note_supply_owner");
}
/** The seller of record from the entity's active tax policy (tax_policy_versions.policy_json.seller). Never invented. */
async function activeSeller(db:Db,entityId:string,date:string){
 const policy=await db.prepare("SELECT * FROM tax_policy_versions WHERE entity_id=? AND status='active' AND effective_from<=? AND (effective_to IS NULL OR effective_to>=?) ORDER BY version DESC LIMIT 1").bind(entityId,date,date).first<Row>();
 if(!policy)throw new ConfigurationRequired("active_tax_policy");
 const json=parse(policy.policy_json),seller=(json.seller&&typeof json.seller==="object"?json.seller:{}) as Row;
 if(!text(seller.legalName)||!text(seller.gstin)||!text(seller.address))throw new ConfigurationRequired("active_policy_seller");
 return{policy,policyJson:json,seller};
}
/* The SAC the returns file this supply under (lib/service-output-tax.ts supplySac, with the policy's classifications read the
 * way GSTR-1 reads them), so the note reduces exactly the HSN line the supply was filed on. */
async function sacFor(db:Db,input:{policyId:string;treatment:CreditNoteTreatment;serviceCode:string}){
 const classifications=new Map<string,string>();
 if(await tableExists(db,"tax_classifications"))for(const r of(await db.prepare("SELECT service_code,classification_code FROM tax_classifications WHERE policy_id=?").bind(input.policyId).all<Row>()).results){const code=normaliseSac(r.classification_code);if(code&&!classifications.has(text(r.service_code)))classifications.set(text(r.service_code),code);}
 return supplySac({treatment:input.treatment==="non_gst"?"exempt":input.treatment,serviceCode:input.serviceCode},classifications).sac;
}
/** Two letters of the seller's name + "C" + the financial year: "TK PETCARE ..." and 2026-27 -> "TKC/26-27/". */
export function defaultCreditNotePrefix(legalName:string,financialYear:string){
 const letters=text(legalName).toUpperCase().split(/\s+/).map(word=>word.replace(/[^A-Z0-9]/g,"")).filter(Boolean).join(" ");
 const first=letters.split(" ")[0]??"",initials=(first.length>=2?first.slice(0,2):letters.replace(/\s/g,"").slice(0,2)).padEnd(2,"X");
 return`${initials}C/${financialYear.slice(2,4)}-${financialYear.slice(5,7)}/`;
}
async function creditNoteSeries(db:Db,input:{entityId:string;gstin:string;date:string;policyId:string;legalName:string;policyJson:Row;actor:string}){
 const fy=statutorySeriesRules.financialYear(input.date);
 const find=()=>db.prepare("SELECT * FROM finance_document_series_v2 WHERE entity_id=? AND gstin=? AND document_type='credit_note' AND financial_year=? AND status='active'").bind(input.entityId,input.gstin,fy).first<Row>();
 let row=await find();
 if(row)return{row,fy};
 const configured=input.policyJson.creditNoteSeries&&typeof input.policyJson.creditNoteSeries==="object"?input.policyJson.creditNoteSeries as Row:{};
 const prefix=text(configured.prefix)?text(configured.prefix).replaceAll("{FY}",`${fy.slice(2,4)}-${fy.slice(5,7)}`):defaultCreditNotePrefix(input.legalName,fy),padding=Math.max(1,num(configured.padding)||5);
 statutorySeriesRules.validateSeries(prefix,padding);
 const now=Date.now(),id=`series_cn_${crypto.randomUUID().slice(0,12)}`;
 await db.batch([
  db.prepare("INSERT OR IGNORE INTO finance_document_series_v2 (id,entity_id,gstin,document_type,financial_year,prefix,next_number,padding,policy_id,status,updated_at) VALUES (?,?,?,'credit_note',?,?,1,?,?,'active',?)").bind(id,input.entityId,input.gstin,fy,prefix,padding,input.policyId,now),
  db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) SELECT ?,?,?,?,NULL,?,?,?,? WHERE EXISTS (SELECT 1 FROM finance_document_series_v2 WHERE id=?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,"document_series",`${input.entityId}:${input.gstin}:credit_note:${fy}`,"opened_credit_note_series",JSON.stringify({prefix,padding,financialYear:fy}),input.actor,"First credit note of the financial year: its own series",now,id),
 ]);
 row=await find();
 if(!row)throw new ConfigurationRequired("credit_note_series");
 return{row,fy};
}

async function placeOfSupply(db:Db,bookingId:string,invoice:OriginalInvoice|null,sellerState:string){
 // The place of supply the invoice was issued with, else the recipient's state on it.
 for(const candidate of[text(invoice?.posState),text(invoice?.buyer?.stateCode).slice(0,2)])if(/^\d{2}$/.test(candidate))return candidate;
 const booking=await db.prepare("SELECT customer_id,city_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 if(booking&&await tableExists(db,"finance_customer_tax_profiles")){const profile=await db.prepare("SELECT place_of_supply FROM finance_customer_tax_profiles WHERE customer_id=?").bind(text(booking.customer_id)).first<Row>();const pos=text(profile?.place_of_supply).slice(0,2);if(/^\d{2}$/.test(pos))return pos;}
 const city=CITY_STATE_CODE[text(booking?.city_id).toLowerCase()];
 // No address on record at all: the supplier's own state (IGST Act s.12(2)(b)), as the returns do.
 return city??sellerState;
}
async function customerDetails(db:Db,bookingId:string,invoice:OriginalInvoice|null){
 const booking=await db.prepare("SELECT customer_id,city_id,service_code,total_amount FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 const customerId=text(booking?.customer_id);
 const customer=customerId&&await tableExists(db,"canonical_customers")?await db.prepare("SELECT name,primary_phone,email FROM canonical_customers WHERE id=?").bind(customerId).first<Row>():null;
 const profile=customerId&&await tableExists(db,"finance_customer_tax_profiles")?await db.prepare("SELECT registration_reference,customer_type,place_of_supply FROM finance_customer_tax_profiles WHERE customer_id=?").bind(customerId).first<Row>():null;
 const address=await tableExists(db,"booking_service_addresses")?await db.prepare("SELECT address FROM booking_service_addresses WHERE booking_id=?").bind(bookingId).first<Row>():null;
 const buyer=invoice?.buyer??{},gstin=text(invoice?.recipientGstin)||text(buyer.gstin)||text(profile?.registration_reference);
 // A GSTIN the invoice was issued to makes the recipient registered, as the invoice filed (b2b); a profile GSTIN unless Finance marked a consumer.
 return{customerId,booking,name:text(buyer.name)||text(customer?.name)||"Customer",phone:text(buyer.phone)||text(customer?.primary_phone),email:text(customer?.email),address:text(buyer.address)||text(address?.address),gstin:gstin||null,registered:Boolean(gstin)&&(Boolean(invoice?.recipientGstin)||text(profile?.customer_type)!=="consumer")};
}

/**
 * Issue the credit note for one processed escalation refund case. Idempotent on the refund case: a replay (the webhook and
 * the sweep racing, a retried settlement) returns the note already issued. Throws ConfigurationRequired (409) while there
 * is no original invoice, seller or supply owner to issue it from; the settlement records that and retries.
 */
export async function issueEscalationCreditNote(db:Db,input:{refundCaseId:string;requestId?:string|null;bookingId:string;refundAmount:number;issueDate:string;periodCode:string;reason:string;gatewayReference?:string|null;processedAt?:number|null;actorId:string;asOf?:number}){
 await ensureCreditNoteTables(db);
 const sourceKey=`${CREDIT_NOTE_SOURCE_TYPE}:${text(input.refundCaseId)}`,id=`CN-${text(input.refundCaseId)}`;
 const prior=await db.prepare("SELECT * FROM finance_credit_notes WHERE source_event_key=?").bind(sourceKey).first<Row>();
 if(prior)return{note:prior,duplicatePrevented:true};
 const refund=money(input.refundAmount);if(refund<=0)throw governedJsonError({error:"A credit note needs a positive refund"},400);
 if(await periodLocked(db,input.periodCode))throw governedJsonError({error:`period_locked: ${input.periodCode} is closed and locked`},409);
 const payout=await payoutRecordForCreditNote(db,input.bookingId);
 if(!payout)throw new ConfigurationRequired("credit_note_payout_record");
 const invoice=await originalInvoiceFor(db,input.bookingId);
 if(!invoice)throw new ConfigurationRequired("credit_note_original_invoice");
 const limit=creditNoteDeadline(invoice.date);
 if(input.issueDate>limit.deadline)throw governedJsonError({error:`time_barred: a credit note against invoice ${invoice.number} (financial year ${limit.financialYear}) had to be declared by ${limit.deadline} (Section 34(2)). The refund stands; PawSpace's output tax cannot be reduced for it.`,code:"credit_note_time_barred"},409);
 const owner=await supplyOwner(db,input.bookingId,invoice);
 const registration=await db.prepare("SELECT * FROM tax_registrations WHERE id=? AND entity_id=?").bind(owner.registrationId,owner.entityId).first<Row>();
 const gstin=text(registration?.registration_reference).toUpperCase();
 if(!/^\d{2}[A-Z0-9]{13}$/.test(gstin))throw new ConfigurationRequired("credit_note_seller_gstin");
 const{policy,policyJson,seller:policySeller}=await activeSeller(db,owner.entityId,input.issueDate);
 // The same seller the invoice printed; the policy's when the invoice kept no snapshot of it.
 const seller=invoice.seller&&text(invoice.seller.gstin)?invoice.seller:policySeller;
 if(text(seller.gstin).toUpperCase()!==gstin)throw new ConfigurationRequired("credit_note_seller_gstin_mismatch");
 const sellerState=gstin.slice(0,2),value=valueFromPayoutRecord(payout,refund,await noGstTreatmentForSupply(db,invoice,istDate(num(payout.computed_at)||Date.now())));
 const pos=await placeOfSupply(db,input.bookingId,invoice,sellerState),split=creditNoteComponents(value.tax,pos,sellerState);
 const customer=await customerDetails(db,input.bookingId,invoice),serviceCode=text(payout.service_code)||text(customer.booking?.service_code);
 // Registered customer: Table 9B CDNR. Unregistered: CDNUR only against a B2C Large invoice (inter-State, the invoice's own value
 // above the limit - a commission booking's invoice is worth PawSpace's fee, not the amount collected for the provider); every
 // other B2C note is a negative adjustment inside Table 7 B2CS of the month it is issued. No tax: Table 8.
 const section:"cdnr"|"cdnur"|"b2cs"|"nil"=value.treatment==="exempt"||value.treatment==="non_gst"?"nil":customer.registered?"cdnr":split.supplyType==="INTER"&&invoice.value>b2clThreshold(invoice.date)?"cdnur":"b2cs";
 // The SAC the invoice printed for PawSpace's line, so the note reduces the HSN line the supply was filed on; else the returns' rule.
 const sac=invoice.sac??await sacFor(db,{policyId:text(policy.id),treatment:value.treatment,serviceCode});
 const actor=text(input.actorId)||"system:escalation-refund";
 const snapshot={seller:{legalName:text(seller.legalName),gstin,address:text(seller.address),state:text(seller.state)||GST_STATE_NAMES[sellerState]||"",stateCode:sellerState},
  customer:{id:customer.customerId,name:customer.name,phone:customer.phone,email:customer.email,address:customer.address,gstin:customer.gstin,registered:customer.registered},
  originalInvoice:{kind:invoice.kind,id:invoice.id,number:invoice.number,date:invoice.date,value:invoice.value,financialYear:limit.financialYear,declareBy:limit.deadline},
  placeOfSupply:{code:pos,name:GST_STATE_NAMES[pos]??"",supplyType:split.supplyType},
  valuation:{orderValue:money(payout.order_value),platformFee:money(payout.platform_fee),supplyModel:text(payout.supply_model),gstExempt:num(payout.gst_exempt)===1,gstRatePercent:value.ratePercent,gstMethod:value.method,commissionPercent:value.commissionPercent,providerCharges:round2(refund-value.valueReduced)},
  refund:{refundCaseId:text(input.refundCaseId),requestId:text(input.requestId)||null,amount:refund,gatewayReference:text(input.gatewayReference)||null,processedAt:input.processedAt??null},policyId:text(policy.id),sac};
 for(let attempt=0;attempt<5;attempt++){
  const{row:series,fy}=await creditNoteSeries(db,{entityId:owner.entityId,gstin,date:input.issueDate,policyId:text(policy.id),legalName:text(policySeller.legalName),policyJson,actor});
  const prefix=text(series.prefix),padding=num(series.padding);
  statutorySeriesRules.validateSeries(prefix,padding);
  const claimed=await db.prepare("SELECT COALESCE(MAX(serial_number),0) n FROM finance_invoice_serial_claims WHERE series_id=? AND financial_year=?").bind(text(series.id),fy).first<Row>();
  const serial=Math.max(num(series.next_number),num(claimed?.n)+1),number=`${prefix}${String(serial).padStart(padding,"0")}`;
  if(String(serial).length>padding||number.length>16)throw governedJsonError({error:`The ${fy} credit note series ${prefix} is full; Finance must open a new series`},409);
  const now=Date.now();
  const journal=value.tax>0?await prepareJournalPosting(db,{groupKey:`CREDIT-NOTE-${id}`,entryDate:input.issueDate,periodCode:input.periodCode,sourceType:CREDIT_NOTE_JOURNAL_SOURCE,sourceId:input.bookingId,narration:`Credit note ${number} on ${invoice.number}: GST of Rs ${value.tax.toFixed(2)} reduced for a Rs ${refund.toFixed(2)} refund after completion`,lines:[{accountCode:GST_PAYABLE,debit:value.tax},{accountCode:ACCT.REFUNDS,credit:value.tax}],metadata:{bookingId:input.bookingId,customerId:customer.customerId||null,serviceCode:serviceCode||null,taxAmount:value.tax,settlementId:number,transactionAt:input.processedAt??now,verificationStatus:"posted"}}):null;
  const components:Array<[string,number]>=[["CGST",split.cgst],["SGST",split.sgst],["IGST",split.igst]];
  const statements=[
   db.prepare("INSERT INTO finance_invoice_serial_claims (id,series_id,financial_year,serial_number,invoice_id,source_event_key,invoice_number,claimed_at) VALUES (?,?,?,?,?,?,?,?)").bind(`claim_${crypto.randomUUID().slice(0,16)}`,text(series.id),fy,serial,id,sourceKey,number,now),
   db.prepare("UPDATE finance_document_series_v2 SET next_number=MAX(next_number,?),updated_at=? WHERE id=?").bind(serial+1,now,text(series.id)),
   db.prepare("INSERT INTO finance_credit_notes (id,credit_note_number,source_event_key,source_type,source_id,request_id,booking_id,customer_id,entity_id,registration_id,seller_gstin,series_id,financial_year,serial_number,issue_date,period_code,original_invoice_kind,original_invoice_id,original_invoice_number,original_invoice_date,original_invoice_fy,treatment,refund_amount,value_reduced,taxable_value,exempt_value,gst_rate,cgst,sgst,igst,tax_total,place_of_supply,supply_type,recipient_gstin,recipient_registered,gstr1_section,sac,refund_reference,reason,status,snapshot_json,journal_group,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'issued',?,?,?,?)")
    .bind(id,number,sourceKey,CREDIT_NOTE_SOURCE_TYPE,text(input.refundCaseId),text(input.requestId)||null,input.bookingId,customer.customerId||null,owner.entityId,owner.registrationId,gstin,text(series.id),fy,serial,input.issueDate,input.periodCode,invoice.kind,invoice.id,invoice.number,invoice.date,limit.financialYear,value.treatment,refund,value.valueReduced,value.taxableValue,value.exemptValue,value.ratePercent,split.cgst,split.sgst,split.igst,value.tax,pos,split.supplyType,customer.gstin,customer.registered?1:0,section,sac,text(input.gatewayReference)||null,text(input.reason)||"Refund after completion",JSON.stringify(snapshot),journal?.journalGroup??null,actor,now),
   ...(journal?.statements??[]),
   // The existing credit note mechanism's tax ledger row (issueAdjustment): the statutory package and GSTR-9 net it.
   ...components.filter(([,amount])=>amount>0).map(([component,amount])=>db.prepare("INSERT OR IGNORE INTO finance_tax_ledger (id,entity_id,registration_id,period_code,component,ledger_type,source_type,source_id,amount,source_event_key,created_at) VALUES (?,?,?,?,?,'adjustment','credit_note',?,?,?,?)").bind(`tax_${crypto.randomUUID().slice(0,16)}`,owner.entityId,owner.registrationId,input.periodCode,component,id,-amount,`${sourceKey}:${component}`,now)),
   db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,NULL,?,?,?,?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,"credit_note",id,"issued",JSON.stringify({creditNoteNumber:number,bookingId:input.bookingId,refundCaseId:text(input.refundCaseId),originalInvoice:invoice.number,treatment:value.treatment,refund,taxableValue:value.taxableValue,exemptValue:value.exemptValue,tax:value.tax,periodCode:input.periodCode,gstr1Section:section}),actor,text(input.reason)||"Refund after completion",now),
  ];
  try{await db.batch(statements);}
  catch(error){
   const replay=await db.prepare("SELECT * FROM finance_credit_notes WHERE source_event_key=?").bind(sourceKey).first<Row>();
   if(replay)return{note:replay,duplicatePrevented:true};
   if(/UNIQUE/i.test(error instanceof Error?error.message:String(error)))continue;// another note took this serial first: claim the next one
   throw error;
  }
  return{note:await db.prepare("SELECT * FROM finance_credit_notes WHERE id=?").bind(id).first<Row>() as Row,duplicatePrevented:false};
 }
 throw governedJsonError({error:"A credit note number could not be claimed; try again"},409);
}

/** Where the booking's supply is taxed, as statutory TCS does it: the customer's place of supply, else the booking's city. */
async function tcsPlaceOfSupply(db:Db,bookingId:string){
 const booking=await db.prepare("SELECT customer_id,city_id FROM canonical_bookings WHERE id=?").bind(bookingId).first<Row>();
 if(booking&&await tableExists(db,"finance_customer_tax_profiles")){const profile=await db.prepare("SELECT place_of_supply FROM finance_customer_tax_profiles WHERE customer_id=?").bind(text(booking.customer_id)).first<Row>();const pos=text(profile?.place_of_supply).slice(0,2);if(/^\d{2}$/.test(pos))return pos;}
 const city=CITY_STATE_CODE[text(booking?.city_id).toLowerCase()];
 if(!city)throw new ConfigurationRequired(`place_of_supply:${bookingId}`);
 return city;
}
/**
 * s.52 "net value": a refund after completion is a supply returned in the month it is refunded. For a GST-registered
 * commission provider it reduces that month's TCS base by the returned value and reverses the TCS withheld on it; a provider
 * without a GSTIN had no TCS withheld, so nothing changes. Idempotent on the refund case.
 */
export async function recordEscalationTcsAdjustment(db:Db,input:{refundCaseId:string;bookingId:string;refundAmount:number;issueDate:string;periodCode:string;creditNoteId?:string|null;actorId:string}){
 await ensureCreditNoteTables(db);
 const key=`escalation-refund-tcs:${text(input.refundCaseId)}`;
 const prior=await db.prepare("SELECT * FROM finance_tcs_base_adjustments WHERE source_event_key=?").bind(key).first<Row>();
 if(prior)return{applicable:true as const,adjustment:prior,duplicatePrevented:true};
 const payout=await payoutRecordForCreditNote(db,input.bookingId);
 if(!payout||num(payout.gst_exempt)===1||text(payout.supply_model)!=="commission")return{applicable:false as const,reason:"not_a_taxable_commission_supply"};
 const engagement=text(payout.engagement_model).toLowerCase();
 if(!COMMISSION_ENGAGEMENT_MODELS.has(engagement))return{applicable:false as const,reason:"not_a_marketplace_supply"};
 const decision=await recordedTcsDecision(db,input.bookingId);
 if(!decision?.registration)return{applicable:false as const,reason:"provider_not_gst_registered"};
 const order=money(payout.order_value),base=num(payout.tcs_base)>0?money(payout.tcs_base):money(order-num(payout.provider_gst_deducted));
 const returned=order>0?round2(Math.min(base,money(input.refundAmount)*base/order)):0;
 const pos=await tcsPlaceOfSupply(db,input.bookingId);
 const tcs=providerTcs({engagementModel:engagement,registration:decision.registration,supplyValue:returned,at:decision.computedAt,placeOfSupplyState:pos,exempt:false});
 if(!(returned>0)||!(tcs.total>0))return{applicable:false as const,reason:"no_tcs_on_the_returned_value"};
 if(await periodLocked(db,input.periodCode))throw governedJsonError({error:`period_locked: ${input.periodCode} is closed and locked`},409);
 const id=`TCSADJ-${text(input.refundCaseId)}`,now=Date.now(),actor=text(input.actorId)||"system:escalation-refund";
 const journal=await prepareJournalPosting(db,{groupKey:`ESCALATION-TCS-${text(input.refundCaseId)}`,entryDate:input.issueDate,periodCode:input.periodCode,sourceType:TCS_ADJUSTMENT_JOURNAL_SOURCE,sourceId:input.bookingId,narration:`s.52 TCS of Rs ${tcs.total.toFixed(2)} reversed on Rs ${returned.toFixed(2)} returned after completion (${input.bookingId})`,lines:[{accountCode:TCS_PAYABLE,debit:tcs.total},{accountCode:ACCT.REFUNDS,credit:tcs.total}],metadata:{bookingId:input.bookingId,taxAmount:tcs.total,transactionAt:now,verificationStatus:"posted"}});
 try{
  await db.batch([
   db.prepare("INSERT INTO finance_tcs_base_adjustments (id,source_event_key,period_code,booking_id,provider_id,service_code,supplier_gstin,supplier_state,pos_state,supply_type,completion_period,returned_value,cgst,sgst,igst,tcs_total,rate_version,rate_effective_from,rate_total,refund_case_id,credit_note_id,journal_group,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .bind(id,key,input.periodCode,input.bookingId,text(payout.provider_id),text(payout.service_code),decision.registration.gstin,decision.registration.state,pos,tcs.supplyType,istDate(decision.computedAt).slice(0,7),returned,tcs.cgst,tcs.sgst,tcs.igst,tcs.total,tcs.rate.version,tcs.rate.effectiveFrom,tcs.rate.total,text(input.refundCaseId),text(input.creditNoteId)||null,journal.journalGroup,actor,now),
   ...journal.statements,
   db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,NULL,?,?,?,?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,"tcs_base_adjustment",id,"recorded",JSON.stringify({bookingId:input.bookingId,periodCode:input.periodCode,returnedValue:returned,tcs:tcs.total,supplierGstin:decision.registration.gstin}),actor,"s.52 net value: supply returned after completion",now),
  ]);
 }catch(error){const replay=await db.prepare("SELECT * FROM finance_tcs_base_adjustments WHERE source_event_key=?").bind(key).first<Row>();if(replay)return{applicable:true as const,adjustment:replay,duplicatePrevented:true};throw error;}
 return{applicable:true as const,adjustment:await db.prepare("SELECT * FROM finance_tcs_base_adjustments WHERE id=?").bind(id).first<Row>() as Row,duplicatePrevented:false};
}

// ------------------------------------------------------------------------------------------------------------------------
// Filing: what each return needs for an entity and period, and the hooks that apply it.
// ------------------------------------------------------------------------------------------------------------------------
type Components={txval:number;iamt:number;camt:number;samt:number;csamt:number};
const zero=():Components=>({txval:0,iamt:0,camt:0,samt:0,csamt:0});
const itemOf=(n:Row)=>({num:1,itm_det:{rt:num(n.gst_rate),txval:round2(num(n.taxable_value)),iamt:round2(num(n.igst)),camt:round2(num(n.cgst)),samt:round2(num(n.sgst)),csamt:0}});
export type CreditNoteFiling={
 notes:Row[];
 gstr1:{cdnr:Row[];cdnur:Row[];b2cs:Array<{sply_ty:string;pos:string;rt:number}&Components>;hsn:Array<{hsn_sc:string;desc:string}&Components>;nil:Array<{sply_ty:string;expt_amt:number;ngsup_amt:number}>};
 gstr3b:{osup_det:Components;osup_nil_exmp:{txval:number};osup_nongst:{txval:number}};
 tcs:{returnedValue:number;tcsTotal:number;adjustments:number};
 totals:{count:number;taxableValue:number;tax:number;exemptValue:number;refunded:number};
};
/**
 * For an entity and period: the GSTR-1 credit notes (cdnr for a registered customer, cdnur only against an unregistered B2C
 * Large invoice, otherwise the negative B2CS (Table 7) / HSN / Table 8 adjustment of the month of issue), the GSTR-3B 3.1(a)
 * reduction by component and the 3.1(c) exempt / 3.1(e) non-GST reduction,
 * and the s.52 TCS base change of the month (TCS is the operator's, so it is not split by entity).
 */
export async function creditNoteFilingAdjustments(db:Db,input:{entityId:string;registrationId:string;periodCode:string}):Promise<CreditNoteFiling>{
 const out:CreditNoteFiling={notes:[],gstr1:{cdnr:[],cdnur:[],b2cs:[],hsn:[],nil:[]},gstr3b:{osup_det:zero(),osup_nil_exmp:{txval:0},osup_nongst:{txval:0}},tcs:{returnedValue:0,tcsTotal:0,adjustments:0},totals:{count:0,taxableValue:0,tax:0,exemptValue:0,refunded:0}};
 if(await tableExists(db,"finance_credit_notes"))out.notes=(await db.prepare("SELECT * FROM finance_credit_notes WHERE entity_id=? AND registration_id=? AND period_code=? AND status='issued' ORDER BY issue_date,credit_note_number").bind(input.entityId,input.registrationId,input.periodCode).all<Row>()).results;
 for(const n of out.notes){
  const tax=round2(num(n.tax_total)),taxable=round2(num(n.taxable_value)),exempt=round2(num(n.exempt_value)),section=text(n.gstr1_section),pos=text(n.place_of_supply),supply=text(n.supply_type),rt=num(n.gst_rate);
  const c={txval:taxable,iamt:round2(num(n.igst)),camt:round2(num(n.cgst)),samt:round2(num(n.sgst)),csamt:0};
  out.totals.count++;out.totals.taxableValue=round2(out.totals.taxableValue+taxable);out.totals.tax=round2(out.totals.tax+tax);out.totals.exemptValue=round2(out.totals.exemptValue+exempt);out.totals.refunded=round2(out.totals.refunded+num(n.refund_amount));
  if(section==="nil"){
   // Table 8 of GSTR-1, and 3.1(c) (exempt) or 3.1(e) (non-GST, Schedule III) of GSTR-3B.
   const nonGst=text(n.treatment)==="non_gst",sply=`${supply==="INTRA"?"INTRA":"INTR"}${num(n.recipient_registered)===1?"B2B":"B2C"}`;
   let row=out.gstr1.nil.find(x=>x.sply_ty===sply);if(!row){row={sply_ty:sply,expt_amt:0,ngsup_amt:0};out.gstr1.nil.push(row);}
   if(nonGst){row.ngsup_amt=round2(row.ngsup_amt+exempt);out.gstr3b.osup_nongst.txval=round2(out.gstr3b.osup_nongst.txval+exempt);}
   else{row.expt_amt=round2(row.expt_amt+exempt);out.gstr3b.osup_nil_exmp.txval=round2(out.gstr3b.osup_nil_exmp.txval+exempt);}
   continue;
  }
  // The note's value is taxable value + tax (as the existing cdnr path files a note): PawSpace's own portion of the refund only;
  // the provider's portion is never on PawSpace's return.
  const note={ntty:"C",nt_num:text(n.credit_note_number),nt_dt:text(n.issue_date),pos,rchrg:"N",inv_typ:"R",val:round2(taxable+tax),itms:[itemOf(n)]};
  if(section==="cdnr")out.gstr1.cdnr.push({ctin:text(n.recipient_gstin),...note});
  else if(section==="cdnur")out.gstr1.cdnur.push({typ:"B2CL",...note});
  else{const key={sply_ty:supply,pos,rt},bucket=out.gstr1.b2cs.find(b=>b.sply_ty===key.sply_ty&&b.pos===key.pos&&b.rt===key.rt);if(bucket){for(const k of["txval","iamt","camt","samt"] as const)bucket[k]=round2(bucket[k]+c[k]);}else out.gstr1.b2cs.push({...key,...c});}
  const sac=text(n.sac),h=out.gstr1.hsn.find(x=>x.hsn_sc===sac);
  if(h){for(const k of["txval","iamt","camt","samt"] as const)h[k]=round2(h[k]+c[k]);}else out.gstr1.hsn.push({hsn_sc:sac,desc:text(n.treatment)==="commission"?"PawSpace commission on pet care services":"Pet care services",...c});
  for(const k of["txval","iamt","camt","samt"] as const)out.gstr3b.osup_det[k]=round2(out.gstr3b.osup_det[k]+c[k]);
 }
 if(await tableExists(db,"finance_tcs_base_adjustments")){const tcs=await db.prepare("SELECT COUNT(*) n,COALESCE(SUM(returned_value),0) returned,COALESCE(SUM(tcs_total),0) tcs FROM finance_tcs_base_adjustments WHERE period_code=?").bind(input.periodCode).first<Row>();out.tcs={returnedValue:round2(num(tcs?.returned)),tcsTotal:round2(num(tcs?.tcs)),adjustments:num(tcs?.n)};}
 return out;
}
const summaryOf=(f:CreditNoteFiling)=>({count:f.totals.count,refunded:f.totals.refunded,taxableValueReduced:f.totals.taxableValue,taxReduced:f.totals.tax,exemptValueReduced:f.totals.exemptValue,notes:f.notes.map(n=>({number:text(n.credit_note_number),date:text(n.issue_date),section:text(n.gstr1_section),originalInvoice:text(n.original_invoice_number),originalInvoiceDate:text(n.original_invoice_date),taxableValue:round2(num(n.taxable_value)),tax:round2(num(n.tax_total))})),tcsBaseReduced:f.tcs.returnedValue,tcsReduced:f.tcs.tcsTotal,note:"Credit notes for refunds after completion (Section 34) issued this month: registered customers in cdnr, B2C Large in cdnur, everything else reduces B2CS, HSN and nil/exempt of this month."});
const COMPONENT_KEYS=["txval","iamt","camt","samt","csamt"] as const;
/** Subtracts only the value and tax components; the identifying fields of a line (place of supply, rate, SAC) are left alone. */
const minus=(target:Row,delta:Partial<Components>)=>{for(const k of COMPONENT_KEYS){const v=num(delta[k]);if(v)target[k]=round2(num(target[k])-v);}};
/** A negative amount for a new line, never -0. */
const neg=(v:number)=>v?round2(-v):0;

/** GSTR-1 hook: adds this month's credit notes to cdnr/cdnur and reduces B2CS, HSN and nil/exempt by the rest. */
export async function applyCreditNotesToGstr1(db:Db,scope:{entityId:string;registrationId:string;periodCode:string},payload:Row,summary:Row){
 const f=await creditNoteFilingAdjustments(db,scope);
 if(!f.totals.count)return f;
 const list=(key:string)=>{if(!Array.isArray(payload[key]))payload[key]=[];return payload[key] as Row[];};
 list("cdnr").push(...f.gstr1.cdnr);list("cdnur").push(...f.gstr1.cdnur);
 const b2cs=list("b2cs");
 for(const a of f.gstr1.b2cs){const bucket=b2cs.find(b=>text(b.sply_ty)===a.sply_ty&&text(b.pos)===a.pos&&num(b.rt)===a.rt);if(bucket)minus(bucket,a);else b2cs.push({sply_ty:a.sply_ty,pos:a.pos,typ:"OE",rt:a.rt,txval:neg(a.txval),iamt:neg(a.iamt),camt:neg(a.camt),samt:neg(a.samt),csamt:0});}
 const hsnBlock=(payload.hsn&&typeof payload.hsn==="object"?payload.hsn:(payload.hsn={data:[]})) as Row;if(!Array.isArray(hsnBlock.data))hsnBlock.data=[];
 for(const a of f.gstr1.hsn){const line=(hsnBlock.data as Row[]).find(h=>text(h.hsn_sc)===a.hsn_sc);if(line)minus(line,a);else(hsnBlock.data as Row[]).push({hsn_sc:a.hsn_sc,desc:sacDescription(a.hsn_sc)||a.desc,txval:neg(a.txval),iamt:neg(a.iamt),camt:neg(a.camt),samt:neg(a.samt),csamt:0,num:1});}
 if(f.gstr1.nil.length){const nil=(payload.nil&&typeof payload.nil==="object"?payload.nil:(payload.nil={inv:[]})) as Row;if(!Array.isArray(nil.inv))nil.inv=[];for(const a of f.gstr1.nil){const row=(nil.inv as Row[]).find(x=>text(x.sply_ty)===a.sply_ty);if(row){row.expt_amt=round2(num(row.expt_amt)-a.expt_amt);row.ngsup_amt=round2(num(row.ngsup_amt)-a.ngsup_amt);}else(nil.inv as Row[]).push({sply_ty:a.sply_ty,expt_amt:neg(a.expt_amt),nil_amt:0,ngsup_amt:neg(a.ngsup_amt)});}}
 summary.cdnrCount=list("cdnr").length;summary.cdnurCount=list("cdnur").length;
 summary.totalOutputTax=round2(num(summary.totalOutputTax)-f.totals.tax);
 summary.creditNotes={...summaryOf(f),negativeB2cs:b2cs.some(b=>num(b.txval)<0)};
 return f;
}
/**
 * GSTR-3B hook: 3.1(a) value and tax by component, 3.1(c) exempt and 3.1(e) non-GST values are net of this month's credit notes, and the
 * output tax and net payable follow (net payable = output tax - eligible ITC, the formula the draft uses).
 */
export async function applyCreditNotesToGstr3b(db:Db,scope:{entityId:string;registrationId:string;periodCode:string},payload:Row,summary:Row){
 const f=await creditNoteFilingAdjustments(db,scope);
 if(!f.totals.count)return f;
 const sup=(payload.sup_details&&typeof payload.sup_details==="object"?payload.sup_details:(payload.sup_details={})) as Row;
 const osup=(sup.osup_det&&typeof sup.osup_det==="object"?sup.osup_det:(sup.osup_det={...zero()})) as Row;minus(osup,f.gstr3b.osup_det);
 if(f.gstr3b.osup_nil_exmp.txval){const nil=(sup.osup_nil_exmp&&typeof sup.osup_nil_exmp==="object"?sup.osup_nil_exmp:(sup.osup_nil_exmp={txval:0})) as Row;nil.txval=round2(num(nil.txval)-f.gstr3b.osup_nil_exmp.txval);}
 if(f.gstr3b.osup_nongst.txval){const nongst=(sup.osup_nongst&&typeof sup.osup_nongst==="object"?sup.osup_nongst:(sup.osup_nongst={txval:0})) as Row;nongst.txval=round2(num(nongst.txval)-f.gstr3b.osup_nongst.txval);}
 const byComponent=summary.outputTaxByComponent&&typeof summary.outputTaxByComponent==="object"?summary.outputTaxByComponent as Row:null;
 if(byComponent)minus(byComponent,{iamt:f.gstr3b.osup_det.iamt,camt:f.gstr3b.osup_det.camt,samt:f.gstr3b.osup_det.samt});
 summary.totalOutputTax=round2(num(summary.totalOutputTax)-f.totals.tax);
 summary.netTaxPayable=round2(Math.max(0,num(summary.totalOutputTax)-num(summary.eligibleInputTax)));
 summary.creditNotes=summaryOf(f);
 return f;
}

/** Monthly close hook: the month's own output tax is net of the credit notes issued in it (every entity). */
export async function applyCreditNotesToMonthlyClose(db:Db,period:string,gst:{outputTax:number}){
 if(!await tableExists(db,"finance_credit_notes"))return{count:0,tax:0};
 const row=await db.prepare("SELECT COUNT(*) n,COALESCE(SUM(tax_total),0) tax FROM finance_credit_notes WHERE period_code=? AND status='issued'").bind(period).first<Row>();
 const tax=round2(num(row?.tax));
 if(num(row?.n)>0){gst.outputTax=round2(gst.outputTax-tax);Object.assign(gst,{creditNoteTax:tax,creditNotes:num(row?.n)});}
 return{count:num(row?.n),tax};
}

/**
 * Tax payable reconciliation hook: what was filed for the month is net of its credit notes, and the GST / TCS the
 * credit-note journals took off 2130 / 2140 is a reduction of the month's accrual, not a payment. Per booking, a TCS row that
 * only carries a refund is matched with the TCS reversed for it, and a completion row also netting a same-month refund with
 * both. The closing balances are unchanged.
 */
export async function applyCreditNotesToTaxPayables(db:Db,period:string,input:{gstAccount:{accrued:number;paid:number};tcsAccount:{accrued:number;paid:number};services:{pawspaceOwnOutputTax:number;pawspaceOwnTaxableValue:number};tcsRows:Row[]}){
 const none={creditNotes:0,creditNoteGst:0,gstPosted:0,tcsPosted:0};
 if(!await tableExists(db,"finance_credit_notes"))return none;
 const notes=await db.prepare("SELECT COUNT(*) n,COALESCE(SUM(tax_total),0) tax,COALESCE(SUM(taxable_value),0) taxable FROM finance_credit_notes WHERE period_code=? AND status='issued'").bind(period).first<Row>();
 const reversals=(await db.prepare("SELECT source_type,source_id,COALESCE(SUM(debit-credit),0) amount FROM finance_journal_entries WHERE period_code=? AND ((account_code=? AND source_type=?) OR (account_code=? AND source_type=?)) GROUP BY source_type,source_id").bind(period,GST_PAYABLE,CREDIT_NOTE_JOURNAL_SOURCE,TCS_PAYABLE,TCS_ADJUSTMENT_JOURNAL_SOURCE).all<Row>()).results;
 // Nothing to net this month: the reconciliation is left exactly as it was.
 if(!num(notes?.n)&&!reversals.length)return none;
 const gstPosted=round2(reversals.filter(r=>text(r.source_type)===CREDIT_NOTE_JOURNAL_SOURCE).reduce((s,r)=>s+num(r.amount),0));
 const tcsByBooking=new Map(reversals.filter(r=>text(r.source_type)===TCS_ADJUSTMENT_JOURNAL_SOURCE).map(r=>[text(r.source_id),round2(num(r.amount))]));
 const tcsPosted=round2([...tcsByBooking.values()].reduce((s,v)=>s+v,0));
 const noteTax=round2(num(notes?.tax)),noteTaxable=round2(num(notes?.taxable));
 input.services.pawspaceOwnOutputTax=round2(input.services.pawspaceOwnOutputTax-noteTax);
 input.services.pawspaceOwnTaxableValue=round2(input.services.pawspaceOwnTaxableValue-noteTaxable);
 input.gstAccount.accrued=round2(input.gstAccount.accrued-gstPosted);input.gstAccount.paid=round2(input.gstAccount.paid-gstPosted);
 input.tcsAccount.accrued=round2(input.tcsAccount.accrued-tcsPosted);input.tcsAccount.paid=round2(input.tcsAccount.paid-tcsPosted);
 if(tcsByBooking.size&&await tableExists(db,"finance_tcs_base_adjustments")){
  const adjustments=(await db.prepare("SELECT booking_id,completion_period FROM finance_tcs_base_adjustments WHERE period_code=?").bind(period).all<Row>()).results;
  for(const row of input.tcsRows){const bookingId=text(row.booking_id),reversal=tcsByBooking.get(bookingId);if(reversal===undefined)continue;const sameMonth=adjustments.some(a=>text(a.booking_id)===bookingId&&text(a.completion_period)===period);row.posted=round2((sameMonth?num(row.posted):0)-reversal);}
 }
 if(num(notes?.n))Object.assign(input.gstAccount,{creditNoteGst:noteTax,creditNotes:num(notes?.n)});if(tcsByBooking.size)Object.assign(input.tcsAccount,{tcsReversedForRefunds:tcsPosted});
 return{creditNotes:num(notes?.n),creditNoteGst:noteTax,gstPosted,tcsPosted};
}

/** The month's TCS base changes, for the GSTR-8 computation (lib/statutory-tcs.ts). */
export async function tcsBaseAdjustmentsForPeriod(db:Db,period:string){
 if(!await tableExists(db,"finance_tcs_base_adjustments"))return[] as Row[];
 return(await db.prepare("SELECT * FROM finance_tcs_base_adjustments WHERE period_code=? ORDER BY booking_id,id").bind(period).all<Row>()).results;
}
type TcsRowLike={bookingId:string;providerId:string;serviceCode:string;supplierGstin:string;supplierState:string;operatorGstin:string;pos:string;supplyType:"intra"|"inter";gross:number;returnedGross:number;net:number;cgst:number;sgst:number;igst:number;total:number;rate:{total:number;cgst:number;sgst:number;igst:number;version:string;effectiveFrom:string}};
/**
 * GSTR-8 hook: a refund after completion is a supply returned in the month it is refunded. A booking completed in the same
 * month nets it on its own row (TCS recomputed on the net value); otherwise the month gets a returns-only row for the booking:
 * no supply, the returned value, and the TCS reversed as a negative amount.
 */
export function mergeTcsBaseAdjustments(rows:TcsRowLike[],adjustments:Row[],operatorGstin:string,issues:string[]){
 for(const a of adjustments){
  const bookingId=text(a.booking_id),providerId=text(a.provider_id),returned=round2(num(a.returned_value)),total=num(a.rate_total);
  const rate={total,cgst:total/2,sgst:total/2,igst:total,version:text(a.rate_version),effectiveFrom:text(a.rate_effective_from)};
  const row=rows.find(r=>r.bookingId===bookingId&&r.providerId===providerId);
  if(row){row.returnedGross=round2(row.returnedGross+returned);row.net=round2(Math.max(0,row.net-returned));row.cgst=row.supplyType==="intra"?round2(row.net*row.rate.cgst):0;row.sgst=row.supplyType==="intra"?round2(row.net*row.rate.sgst):0;row.igst=row.supplyType==="inter"?round2(row.net*row.rate.igst):0;row.total=round2(row.cgst+row.sgst+row.igst);continue;}
  rows.push({bookingId,providerId,serviceCode:text(a.service_code),supplierGstin:text(a.supplier_gstin),supplierState:text(a.supplier_state),operatorGstin,pos:text(a.pos_state),supplyType:text(a.supply_type)==="inter"?"inter":"intra",gross:0,returnedGross:returned,net:neg(returned),cgst:neg(num(a.cgst)),sgst:neg(num(a.sgst)),igst:neg(num(a.igst)),total:neg(num(a.tcs_total)),rate});
 }
 const bySupplier=new Map<string,number>();for(const r of rows)bySupplier.set(r.supplierGstin,round2((bySupplier.get(r.supplierGstin)??0)+r.net));
 for(const[gstin,net]of bySupplier)if(net<0)issues.push(`supplier_returns_exceed_supplies:${gstin}:${net}`);
 return rows;
}

// ------------------------------------------------------------------------------------------------------------------------
// Reading and printing.
// ------------------------------------------------------------------------------------------------------------------------
export async function listCreditNotes(db:Db,input:{limit?:number;bookingId?:string}={}){
 await ensureCreditNoteTables(db);
 const limit=Math.max(1,Math.min(500,Math.floor(num(input.limit)||100)));
 const rows=text(input.bookingId)?await db.prepare("SELECT * FROM finance_credit_notes WHERE booking_id=? ORDER BY created_at DESC LIMIT ?").bind(text(input.bookingId),limit).all<Row>():await db.prepare("SELECT * FROM finance_credit_notes ORDER BY created_at DESC LIMIT ?").bind(limit).all<Row>();
 return rows.results.map(r=>{const{snapshot_json:raw,...rest}=r;const snapshot=parse(raw);return{...rest,customerName:text((snapshot.customer as Row|undefined)?.name),printPath:`/api/credit-notes?id=${encodeURIComponent(text(r.id))}&format=html`};});
}
export async function getCreditNote(db:Db,id:string){
 await ensureCreditNoteTables(db);
 const row=await db.prepare("SELECT * FROM finance_credit_notes WHERE id=? OR credit_note_number=?").bind(text(id),text(id)).first<Row>();
 return row?{...row,snapshot:parse(row.snapshot_json)} as Row&{snapshot:Row}:null;
}
const escapeHtml=(v:unknown)=>text(v).replace(/[&<>"']/g,ch=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"})[ch]??ch);
const rupees=(v:unknown)=>`₹${num(v).toLocaleString("en-IN",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const dmy=(iso:string)=>{const[y,m,d]=text(iso).split("-");return y&&m&&d?`${d}-${m}-${y}`:text(iso);};
/** Printable A4 credit note (browser "Save as PDF"), with the Rule 53(1A) particulars. */
export function renderCreditNoteHtml(note:Row&{snapshot:Row}){
 const s=note.snapshot,seller=(s.seller??{}) as Row,customer=(s.customer??{}) as Row,place=(s.placeOfSupply??{}) as Row,refundInfo=(s.refund??{}) as Row;
 const treatment=text(note.treatment),tax=num(note.tax_total),refund=num(note.refund_amount),intra=text(note.supply_type)==="INTRA",rate=num(note.gst_rate),noTax=treatment==="exempt"||treatment==="non_gst";
 const label=treatment==="commission"?"PawSpace platform and service fee":treatment==="exempt"?"Pet funeral and memorial services (exempt supply)":treatment==="non_gst"?"Pet funeral and memorial services (non-GST, Schedule III)":"Pet care services";
 const value=noTax?note.exempt_value:note.taxable_value;
 const line=`<tr><td>${label}</td><td>${escapeHtml(text(note.sac).replace(/^[^0-9A-Za-z]+/,""))}</td><td class="n">${rupees(value)}</td><td class="n">${noTax?"-":`${rate}%`}</td><td class="n">${rupees(tax)}</td></tr>`;
 const taxRows=noTax?`<tr><td colspan="2">GST</td><td class="n">${treatment==="exempt"?"Exempt supply: no GST":"Non-GST supply (Schedule III): no GST"}</td></tr>`:intra?`<tr><td colspan="2">CGST @ ${rate/2}% reduced</td><td class="n">${rupees(note.cgst)}</td></tr><tr><td colspan="2">SGST @ ${rate/2}% reduced</td><td class="n">${rupees(note.sgst)}</td></tr>`:`<tr><td colspan="2">IGST @ ${rate}% reduced</td><td class="n">${rupees(note.igst)}</td></tr>`;
 const recipient=customer.registered&&text(customer.gstin)?`<p>GSTIN: <b>${escapeHtml(customer.gstin)}</b></p>`:"<p>Unregistered recipient</p>";
 const providerPart=round2(refund-num(note.value_reduced));
 const reference=[text(note.refund_reference)||text(refundInfo.gatewayReference),text(note.source_id)].filter(Boolean);
 return`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Credit note ${escapeHtml(note.credit_note_number)}</title><style>@page{size:A4;margin:14mm}body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d1d1f;background:#fff;margin:0;padding:24px;font-size:13px}main{max-width:760px;margin:0 auto}h1{font-size:20px;margin:0 0 4px}.muted{color:#555}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0}.box{border:1px solid #ccc;border-radius:6px;padding:10px}.box p{margin:3px 0}table{width:100%;border-collapse:collapse;margin:12px 0}th,td{border:1px solid #ccc;padding:6px;text-align:left;vertical-align:top}th{background:#f4f4f4}.n{text-align:right;white-space:nowrap}.sign{margin-top:36px;text-align:right}@media print{body{padding:0}}</style></head><body><main>
<header><h1>Credit Note</h1><p class="muted">Credit note under section 34 of the CGST Act, 2017 and Rule 53${noTax?", for a supply that carried no GST":""} · Original for recipient</p></header>
<div class="grid"><section class="box"><p><b>${escapeHtml(seller.legalName)}</b></p><p>${escapeHtml(seller.address)}</p><p>GSTIN: <b>${escapeHtml(seller.gstin)}</b></p><p>State: ${escapeHtml(seller.state)} (${escapeHtml(seller.stateCode)})</p></section>
<section class="box"><p>Credit note number: <b>${escapeHtml(note.credit_note_number)}</b></p><p>Date of issue: <b>${dmy(text(note.issue_date))}</b></p><p>Original invoice: <b>${escapeHtml(note.original_invoice_number)}</b> dated ${dmy(text(note.original_invoice_date))}</p><p>Place of supply: <b>${escapeHtml(place.name)} (${escapeHtml(place.code)})</b></p><p>Booking: ${escapeHtml(note.booking_id)}</p></section></div>
<section class="box"><p><b>Recipient</b></p><p>${escapeHtml(customer.name)}</p><p>${escapeHtml(customer.address)||"Address as on the original invoice"}</p><p>State: ${escapeHtml(place.name)} (${escapeHtml(place.code)})</p>${recipient}</section>
<table><thead><tr><th>Description</th><th>SAC</th><th class="n">${noTax?"Value reduced":"Taxable value reduced"}</th><th class="n">Rate</th><th class="n">Tax reduced</th></tr></thead><tbody>${line}</tbody></table>
<table><tbody><tr><td colspan="2">${noTax?"Value reduced":"Taxable value reduced"}</td><td class="n">${rupees(value)}</td></tr>${taxRows}<tr><td colspan="2"><b>Total tax reduced</b></td><td class="n"><b>${rupees(tax)}</b></td></tr></tbody></table>
<p>Refund to the customer's original payment method: <b>${rupees(refund)}</b>${reference.length?` · Refund reference: ${reference.map(escapeHtml).join(" / ")}`:""}.${treatment==="commission"&&providerPart>0?` ${rupees(providerPart)} of it was the service provider's charge, collected on their behalf; it is settled with the provider and is not part of this credit note.`:""}</p>
<p class="muted">Reason: ${escapeHtml(note.reason)}. ${noTax?"":`GST is included in the amount refunded and is reduced by ${escapeHtml(seller.legalName)}.`} Tax payable on reverse charge: No.</p>
<p class="muted">This is a computer-generated credit note.</p><p class="sign">For ${escapeHtml(seller.legalName)}<br><br><br>Authorised signatory</p></main></body></html>`;
}
