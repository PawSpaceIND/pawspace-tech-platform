import{assertOwnershipPeriodOpen,assertOwnershipRegistration,ensureServiceInvoiceOwnershipTables,ServiceInvoiceOwnershipRequired,type ServiceInvoiceScope}from"./service-invoice-ownership";
import{CITY_STATE_CODE}from"./tcs-governance";
import{governedJsonError}from"./governed-http-error";
import{chunkedIn,idChunks}from"./d1-chunked-in";
import{DEFAULT_GST_POLICY}from"./gst-method";
import{pawspaceServices}from"./service-control";
import{PLATFORM_COMMISSION_SERVICE_CODE,serviceSacDefault,normaliseSac}from"./service-sac-defaults";
import{funeralGstTreatmentOn,funeralGstTreatmentVersions,type FuneralGstTreatment}from"./funeral-gst-treatment";
/**
 * THE service supply register: every service supply PawSpace files, one line per booking (or case / order), and the ONE
 * place that decides PawSpace's own output GST and taxable value. The monthly close, the statutory package, GSTR-1, GSTR-3B,
 * GSTR-9/9C and the tax-payable reconciliation all read it, so every "output tax" figure means the same thing.
 *
 * The model (owner decisions of 26 and 27 Sept 2026; the 27 Sept report model is owner-approved with the CA): "PawSpace pays 18%
 * GST on the amount it makes". Read from provider_payout_computations - the record completion posts its journal from - so the
 * returns and ledger account 2130-GST Payable agree for the same bookings. Every filed line has taxable value = the amount
 * PawSpace makes and GST = the rate on it, so rate x value always holds:
 *   Commission job (every vertical except funeral): taxable value = PawSpace's commission (taxable_commission), GST =
 *     platform_gst. Rs 1,000 at 70/30 -> 54 on 300.
 *   Own supply (full-time or contract provider, company vehicle): taxable value = the full amount paid
 *     (own_supply_taxable_value), GST = pawspace_gst_on_order. Rs 1,000 -> 180 on 1,000.
 *   Funeral / memorial: 0 GST, filed by Finance's funeral GST treatment (lib/funeral-gst-treatment.ts) in force on its date:
 *     outside GST under Schedule III para 4 by default (GSTR-1 Table 8 non-GST, GSTR-3B 3.1(e)), or exempt (Table 8 exempt,
 *     3.1(c)); when Finance makes it taxable, new completions are taxed by the payout engine like any other service.
 * The books are unchanged: income = amount made - GST (246 and 820). Under "extract_inclusive" (GST taken out of the amount),
 * the same record gives 45.76 on 254.24 and 152.54 on 847.46: the value is always the one the GST was charged on.
 *
 * The customer tax invoice (owner decision B): the seller in the active tax policy issues one per completed booking
 * (lib/booking-tax-invoice.ts, source_event_key "booking-invoice:<id>"). Such a booking files the INVOICE's own figures - taxable
 * value, GST by component, place of supply - and belongs to the invoice's legal entity and registration; the payout record's
 * figures are kept beside them, and a difference of more than 1 paisa (or an invoice dated in another month, or issued by
 * another entity than the one the supply was assigned to) is reported as a variance with both numbers, never silently picked.
 *
 * A booking is filed once it is completed (its payout row is final) or invoiced, in the month of whichever came first, so it
 * is filed exactly once and never moves month; a payout preview that was never completed or invoiced is not a supply yet.
 * Every vertical with a completion reaches the returns whether or not Finance issued a manual invoice: grooming, boarding,
 * sitting, walking, training, Pet Taxi (fleet and legacy) and funeral bookings, plus funeral cases and manual funeral orders.
 *
 * Kept as they are (not classified by the owner yet): relocation, vet visits and food are reported with the tax their own
 * modules compute today, labelled "not yet classified". They never reach GSTR-1 line detail; only tax they actually carry
 * reaches GSTR-3B. Payout rows written before 26 Sept (no supply_model) and invoices with no payout record keep the old
 * invoice-based rule: a legacy carve row files its platform_gst, anything else its full invoice tax (never understated).
 *
 * Ownership: every line belongs to one legal entity and GST registration. A booking with a customer tax invoice belongs to the
 * invoice's issuer; a booking with a service invoice follows that invoice's assignment; anything else is assigned as a supply
 * (service_supply_ownership). Scoped returns refuse while any line of an OPEN month is unassigned, and so does the monthly close
 * (audit G22). A closed month never gains a line: a supply first recorded after its month was locked (a manual funeral order
 * dated into it, a completion adopted late) is filed in the month it was recorded, as the journal posts corrections in the next
 * open period. A line left unassigned in a month closed before this register existed cannot be assigned any more; it is
 * disclosed (unassignedInClosedMonths), never a permanent refusal. A booking Finance invoiced by hand through the canonical path
 * (finance_invoices, source_type 'booking', any other event key) is disclosed as a possible double count for review, because
 * that invoice's tax is already in finance_tax_ledger.
 * Cold-DB safe: a missing source table or an older table shape is skipped, never a 500. Import-safe for
 * `node --experimental-strip-types` (no TS parameter properties).
 */
type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(v:number)=>Math.round((v+Number.EPSILON)*100)/100;
const num=(v:unknown)=>{const n=Number(v??0);return Number.isFinite(n)?n:0;};
const text=(v:unknown)=>String(v??"").trim();
const IST=330*60_000;
/** Far enough to mean "not yet" for a supply date, and the end of an all-time window. */
export const SUPPLY_END_OF_TIME=Date.UTC(9999,0,1);
const istDate=(ms:number)=>new Date(Math.min(Math.max(ms,0),SUPPLY_END_OF_TIME)+IST).toISOString().slice(0,10);
/** The [startMs,endMs) window of an IST calendar month (YYYY-MM). */
export function istMonthWindow(period:string){const[y,m]=period.split("-").map(Number);if(!/^\d{4}-\d{2}$/.test(period)||m<1||m>12)throw governedJsonError({error:"Period must be YYYY-MM"},400);return{startMs:Date.UTC(y,m-1,1)-IST,endMs:Date.UTC(m===12?y+1:y,m===12?0:m,1)-IST};}
async function tableExists(db:Db,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
async function columnsOf(db:Db,name:string){return await tableExists(db,name)?new Set((await db.prepare(`PRAGMA table_info(${name})`).all<Row>()).results.map(r=>text(r.name))):new Set<string>();}
const hasAll=(cols:Set<string>,names:readonly string[])=>names.every(n=>cols.has(n));
const owner=(entityId:unknown,registrationId:unknown):ServiceInvoiceScope|null=>text(entityId)&&text(registrationId)?{entityId:text(entityId),registrationId:text(registrationId)}:null;
/* The columns a payout row needs to be filed under the owner's model (written since 26 Sept 2026). */
const OWNER_MODEL_COLUMNS=["booking_id","service_code","order_value","platform_fee","platform_gst","pawspace_gst_on_order","supply_model","gst_exempt","taxable_commission","gst_rate","gst_method","computed_at","finalized_at"] as const;
/** The source_event_key of a booking's customer tax invoice is this prefix + the booking id (lib/booking-tax-invoice.ts). */
export const BOOKING_INVOICE_EVENT_PREFIX="booking-invoice:";
export const bookingInvoiceEventKey=(bookingId:string)=>`${BOOKING_INVOICE_EVENT_PREFIX}${bookingId}`;
/** SQL that keeps a booking's customer tax invoice out of a canonical-invoice read (finance_invoices): the register files
 * those, so reading them there too would count the booking twice. Empty on an older table without source_event_key. */
export async function canonicalInvoicesOnlySql(db:Db,alias=""){return(await columnsOf(db,"finance_invoices")).has("source_event_key")?` AND ${alias}source_event_key NOT LIKE '${BOOKING_INVOICE_EVENT_PREFIX}%'`:"";}

export type SupplyTreatment="commission"|"own_supply"|"exempt"|"non_gst"|"legacy"|"not_yet_classified";
/** taxable -> GSTR-3B 3.1(a); exempt -> 3.1(c) and GSTR-1 nil/exempt; unclassified -> reported and labelled, not in a section. */
export type SupplySection="taxable"|"exempt"|"non_gst"|"unclassified";
/** A booking's customer tax invoice as the returns file it: its lines (SAC, value, rate, tax by component) and totals. */
export type BookingInvoiceLineFiling={role:"taxable"|"exempt"|"non_gst"|"collected_on_behalf";sac:string;description:string;amount:number;taxableValue:number;ratePercent:number;gst:number;iamt:number;camt:number;samt:number;csamt:number;exemptValue:number};
export type BookingInvoiceFiling={id:string;invoiceNumber:string;issueDate:string;documentKind:string;entityId:string;registrationId:string;customerGstin:string|null;placeOfSupply:string|null;supplyType:"INTRA"|"INTER";amountReceived:number;taxableValue:number;gst:number;exemptValue:number;nonGstValue:number;iamt:number;camt:number;samt:number;csamt:number;lines:BookingInvoiceLineFiling[]};
export type BookingInvoiceVariance={bookingId:string;invoiceId:string;invoiceNumber:string;differences:string[];register:{taxableValue:number;gst:number;exemptValue:number;period:string;entityId:string|null;registrationId:string|null};invoice:{taxableValue:number;gst:number;exemptValue:number;period:string;entityId:string;registrationId:string}};
export type ServiceSupplyLine={
 supplyKey:string;assignKey:string;source:string;bookingId:string|null;serviceCode:string;treatment:SupplyTreatment;section:SupplySection;
 /** can become GSTR-1 line detail (b2cs / hsn / nil): owner-model and funeral supplies. */
 lineDetail:boolean;costed:boolean;supplyAt:number;period:string;orderValue:number;taxableValue:number;gst:number;exemptValue:number;ratePercent:number;
 gstMethod:string|null;providerSupplyGstOnBehalf:number;invoiceTax:number;placeOfSupply:string|null;ownership:ServiceInvoiceScope|null;
 journal:{sourceType:string;sourceId:string}|null;label:string;
 /** the line's month is closed and locked (finance_close_periods): it can no longer be assigned. */
 periodClosed:boolean;
 /** a canonical finance_invoices id for the same booking: its tax is also in finance_tax_ledger (possible double count). */
 canonicalInvoiceId:string|null;
 /** what PawSpace makes on the supply (its commission, or the full amount paid on its own supply); net income = this - gst. */
 amountMade:number;
 /** the booking's customer tax invoice: when present the line files its figures (taxableValue, gst, exemptValue above). */
 invoice:BookingInvoiceFiling|null;
 /** the payout record's own figures, kept when the line files an invoice's. */
 registerFigures:{taxableValue:number;gst:number;exemptValue:number}|null;
 invoiceVariance:BookingInvoiceVariance|null;
};
type Locks=Map<string,number>;
/* Closed months and when each was locked; a lock with no time is treated as locked for ever (nothing rolls past it). */
async function lockedPeriods(db:Db):Promise<Locks>{
 if(!hasAll(await columnsOf(db,"finance_close_periods"),["period_code","status","locked_at"]))return new Map();
 return new Map((await db.prepare("SELECT period_code,locked_at FROM finance_close_periods WHERE status='locked'").all<Row>()).results.map(r=>[text(r.period_code),num(r.locked_at)>0?num(r.locked_at):Number.POSITIVE_INFINITY]));
}
/* A supply first recorded after its month was locked is filed in the month it was recorded, so a closed month's figures never
 * change and never need an assignment it can no longer take (audit G22). Anything recorded before the lock stays put. */
const filedAt=(naturalAt:number,recordedAt:number,locks:Locks)=>{const lockedAt=locks.get(istDate(naturalAt).slice(0,7));return lockedAt!==undefined&&recordedAt>lockedAt&&recordedAt<SUPPLY_END_OF_TIME?recordedAt:naturalAt;};
const within=(at:number,startMs:number,endMs:number)=>at>=startMs&&at<endMs;
const LABELS={
 commission:"Commission job: GST on PawSpace's commission",
 own_supply:"PawSpace's own supply: GST on the amount paid",
 exempt:"Funeral / memorial: GST exempt",
 non_gst:"Funeral / memorial: outside GST (Schedule III, para 4)",
 funeralUntaxed:"Funeral / memorial recorded with no GST although the funeral GST setting says taxable: review before filing",
 legacyCarve:"Carve payout record from before 26 Sept 2026: filed from its invoice as before",
 legacyCosted:"Payout record from before 26 Sept 2026: its full invoice tax is counted, as before",
 invoiceOnly:"Service invoice with no payout record: its full invoice tax is counted",
 funeralTaxed:"Funeral closed with GST before the exemption: filed as it was posted",
 relocation:"Relocation: not classified by the owner yet; tax as its own module computes it today",
 vet:"Vet visit: not classified by the owner yet; GST as computed today (0)",
 food:"Food: not classified yet (goods, rate set by HSN); tax as its own module computes it today",
} as const;
type FuneralTreatmentAt=(supplyAt:number)=>FuneralGstTreatment;
/* A funeral / memorial supply that carries no GST is filed by the funeral GST treatment in force on its date: outside GST
 * (Schedule III) by default, exempt when Finance chose exempt. Under "taxable" a supply recorded with no GST is flagged. */
function noGstFiling(treatment:FuneralGstTreatment):{treatment:SupplyTreatment;section:SupplySection;label:string}{return treatment==="exempt"?{treatment:"exempt",section:"exempt",label:LABELS.exempt}:{treatment:"non_gst",section:"non_gst",label:treatment==="taxable_18"?LABELS.funeralUntaxed:LABELS.non_gst};}
function line(partial:Partial<ServiceSupplyLine>&Pick<ServiceSupplyLine,"supplyKey"|"source"|"treatment"|"section"|"supplyAt"|"orderValue"|"label">):ServiceSupplyLine{
 const base={assignKey:`SUPPLY:${partial.supplyKey}`,bookingId:null,serviceCode:"",lineDetail:false,costed:false,taxableValue:0,gst:0,exemptValue:0,ratePercent:0,gstMethod:null,providerSupplyGstOnBehalf:0,invoiceTax:0,placeOfSupply:null,ownership:null,journal:null,periodClosed:false,canonicalInvoiceId:null,invoice:null,registerFigures:null,invoiceVariance:null,...partial,period:istDate(partial.supplyAt).slice(0,7)};
 return{...base,amountMade:partial.amountMade??round2(base.taxableValue+base.gst+base.exemptValue)};
}
const round=(value:unknown)=>round2(num(value));

/* 1. Payout rows under the owner's model: completed (final) or invoiced, filed in the month of whichever came first (or, when
 * that month was already locked when the row first became a supply, the month it did). A row completed and finalized before the
 * window can be neither, so it is skipped before the per-row invoice lookups run. */
async function payoutLines(db:Db,startMs:number,endMs:number,hasInvoices:boolean,locks:Locks,funeralAt:FuneralTreatmentAt):Promise<ServiceSupplyLine[]>{
 const cols=await columnsOf(db,"provider_payout_computations");if(!hasAll(cols,OWNER_MODEL_COLUMNS))return[];
 const ownValue=cols.has("own_supply_taxable_value")?"p.own_supply_taxable_value":"NULL own_supply_taxable_value";
 const invoice=(expr:string)=>hasInvoices?`(SELECT ${expr} FROM booking_invoices bi WHERE bi.booking_id=p.booking_id AND bi.status!='cancelled' AND bi.issued_at>0)`:"NULL";
 const invoiceOwner=hasInvoices?"(SELECT o.entity_id||char(31)||o.registration_id FROM booking_invoices bi JOIN service_invoice_ownership o ON o.invoice_id=bi.id WHERE bi.booking_id=p.booking_id AND bi.status!='cancelled' ORDER BY bi.issued_at LIMIT 1)":"NULL";
 const firstInvoice=hasInvoices?"(SELECT bi.id FROM booking_invoices bi WHERE bi.booking_id=p.booking_id AND bi.status!='cancelled' AND bi.issued_at>0 ORDER BY bi.issued_at LIMIT 1)":"NULL";
 const first=(expr:string)=>`MIN(COALESCE(x.first_invoice_at,${SUPPLY_END_OF_TIME}),CASE WHEN x.finalized_at>0 THEN ${expr} ELSE ${SUPPLY_END_OF_TIME} END)`,at=first("x.computed_at"),recorded=first("x.finalized_at");
 const rows=(await db.prepare(`SELECT * FROM (SELECT p.booking_id,p.service_code,p.order_value,p.platform_fee,p.platform_gst,p.pawspace_gst_on_order,p.taxable_commission,${ownValue},p.supply_model,p.gst_exempt,p.gst_method,p.gst_rate,p.computed_at,p.finalized_at,${invoice("MIN(bi.issued_at)")} first_invoice_at,${invoice("COALESCE(SUM(bi.tax_amount),0)")} invoice_tax,${firstInvoice} invoice_id,${invoiceOwner} invoice_owner,s.entity_id supply_entity,s.registration_id supply_registration FROM provider_payout_computations p LEFT JOIN service_supply_ownership s ON s.supply_key='booking:'||p.booking_id WHERE p.supply_model IN ('commission','own_supply') AND NOT (COALESCE(p.finalized_at,0)>0 AND p.finalized_at<? AND p.computed_at<?)) x WHERE (${at}>=? AND ${at}<?) OR (${recorded}>=? AND ${recorded}<? AND ${at}<?)`).bind(startMs,startMs,startMs,endMs,startMs,endMs,startMs).all<Row>()).results;
 return rows.flatMap(r=>{
  const bookingId=text(r.booking_id),exempt=num(r.gst_exempt)===1,own=text(r.supply_model)==="own_supply",order=round(r.order_value),fee=round(r.platform_fee),final=num(r.finalized_at)>0;
  // Own supply files the full amount paid - the value its GST was charged on (owner decision A, 27 Sept 2026). A row whose
  // own_supply_taxable_value was never written falls back by its GST method: the whole amount, or the amount less the GST.
  const gst=exempt?0:own?round(r.pawspace_gst_on_order):round(r.platform_gst),ownValue=num(r.own_supply_taxable_value)>0?round(r.own_supply_taxable_value):text(r.gst_method)==="extract_inclusive"?round2(order-gst):order,taxable=exempt?0:own?ownValue:r.taxable_commission==null?fee:round(r.taxable_commission);
  const[invoiceEntity,invoiceRegistration]=text(r.invoice_owner).split("\u001f"),invoiceId=text(r.invoice_id)||null;
  const firstInvoiceAt=num(r.first_invoice_at)>0?num(r.first_invoice_at):SUPPLY_END_OF_TIME,completedAt=final?num(r.computed_at):SUPPLY_END_OF_TIME,finalizedAt=final?num(r.finalized_at):SUPPLY_END_OF_TIME;
  const supplyAt=filedAt(Math.min(firstInvoiceAt,completedAt),Math.min(firstInvoiceAt,finalizedAt),locks);if(!within(supplyAt,startMs,endMs))return[];
  const noGst=exempt?noGstFiling(funeralAt(supplyAt)):null,treatment:SupplyTreatment=noGst?noGst.treatment:own?"own_supply":"commission";
  return[line({supplyKey:`booking:${bookingId}`,assignKey:invoiceId??`SUPPLY:booking:${bookingId}`,source:"payout_computation",bookingId,serviceCode:text(r.service_code),treatment,section:noGst?noGst.section:"taxable",lineDetail:true,costed:true,supplyAt,orderValue:order,taxableValue:taxable,gst,exemptValue:exempt?(own?order:fee):0,amountMade:own?order:fee,ratePercent:exempt?0:num(r.gst_rate),gstMethod:text(r.gst_method)||null,invoiceTax:round(r.invoice_tax),ownership:owner(invoiceEntity,invoiceRegistration)??owner(r.supply_entity,r.supply_registration),journal:final?{sourceType:"service_completion",sourceId:bookingId}:null,label:noGst?noGst.label:LABELS[own?"own_supply":"commission"]})];
 });
}

/* 2. Service invoices with no owner-model payout row: the old invoice-based rule, unchanged. */
async function invoiceLines(db:Db,startMs:number,endMs:number):Promise<ServiceSupplyLine[]>{
 const cols=await columnsOf(db,"provider_payout_computations"),joined=cols.has("booking_id"),pc=(c:string)=>joined&&cols.has(c)?`p.${c}`:"0";
 const skipOwnerModel=hasAll(cols,OWNER_MODEL_COLUMNS)?" AND (p.booking_id IS NULL OR COALESCE(p.supply_model,'') NOT IN ('commission','own_supply'))":"";
 const rows=(await db.prepare(`SELECT bi.id,bi.booking_id,bi.gross_amount,bi.tax_amount,bi.issued_at,o.entity_id,o.registration_id,${joined?"p.booking_id":"NULL"} payout_booking,${pc("provider_gst_deducted")} carve,${pc("platform_gst")} platform_gst,${pc("platform_fee")} platform_fee FROM booking_invoices bi LEFT JOIN service_invoice_ownership o ON o.invoice_id=bi.id${joined?" LEFT JOIN provider_payout_computations p ON p.booking_id=bi.booking_id":""} WHERE bi.issued_at>=? AND bi.issued_at<? AND bi.status!='cancelled'${skipOwnerModel}`).bind(startMs,endMs).all<Row>()).results;
 return rows.map(r=>{
  const gross=round(r.gross_amount),tax=round(r.tax_amount),costed=Boolean(text(r.payout_booking)),carve=round(r.carve),legacyCarve=costed&&carve>0,platformGst=round(r.platform_gst);
  return line({supplyKey:`invoice:${text(r.id)}`,assignKey:text(r.id),source:"booking_invoice",bookingId:text(r.booking_id)||null,treatment:"legacy",section:"taxable",costed,supplyAt:num(r.issued_at),orderValue:gross,taxableValue:legacyCarve?round(r.platform_fee):round2(gross-tax),gst:legacyCarve?platformGst:tax,ratePercent:0,providerSupplyGstOnBehalf:legacyCarve?round2(carve-platformGst):0,invoiceTax:tax,ownership:owner(r.entity_id,r.registration_id),label:legacyCarve?LABELS.legacyCarve:costed?LABELS.legacyCosted:LABELS.invoiceOnly});
 });
}

/* 3. Funeral cases and manual funeral orders: no GST (owner decision A), filed by the funeral GST treatment in force on their
 * date. A row that carries GST was closed before the exemption; it is filed as it was posted so the liability is never understated. */
async function funeralLines(db:Db,startMs:number,endMs:number,locks:Locks,funeralAt:FuneralTreatmentAt):Promise<ServiceSupplyLine[]>{
 const out:ServiceSupplyLine[]=[];
 if(hasAll(await columnsOf(db,"funeral_settlements"),["case_id","gross_paid_value","vendor_cost","tax_amount","revenue_net","created_at"])){
  const rows=(await db.prepare("SELECT f.case_id,f.gross_paid_value,f.vendor_cost,f.tax_amount,f.revenue_net,f.created_at,s.entity_id,s.registration_id FROM funeral_settlements f LEFT JOIN service_supply_ownership s ON s.supply_key='funeral_case:'||f.case_id WHERE f.gross_paid_value IS NOT NULL AND f.created_at>=? AND f.created_at<?").bind(startMs,endMs).all<Row>()).results;
  for(const r of rows){const gross=round(r.gross_paid_value),tax=round(r.tax_amount),margin=round2(gross-num(r.vendor_cost)),noGst=noGstFiling(funeralAt(num(r.created_at)));out.push(line({supplyKey:`funeral_case:${text(r.case_id)}`,source:"funeral_case",serviceCode:"funeral_memorial",treatment:tax>0?"legacy":noGst.treatment,section:tax>0?"taxable":noGst.section,lineDetail:!(tax>0),supplyAt:num(r.created_at),orderValue:gross,taxableValue:tax>0?round(r.revenue_net):0,gst:tax,exemptValue:tax>0?0:margin,ownership:owner(r.entity_id,r.registration_id),journal:{sourceType:"funeral_closure",sourceId:text(r.case_id)},label:tax>0?LABELS.funeralTaxed:noGst.label}));}
 }
 const manual=await columnsOf(db,"funeral_manual_orders");
 if(hasAll(manual,["id","order_value","gst_amount","order_date"])){
  // Finance types the order date, so an order can be recorded after its month closed: it is then filed in the month it was recorded.
  const recorded=manual.has("created_at");
  const rows=(await db.prepare(`SELECT m.id,m.order_value,m.gst_amount,m.order_date,${recorded?"m.created_at":"NULL created_at"},s.entity_id,s.registration_id FROM funeral_manual_orders m LEFT JOIN service_supply_ownership s ON s.supply_key='funeral_order:'||m.id WHERE (m.order_date>=? AND m.order_date<?)${recorded?" OR (m.created_at>=? AND m.created_at<? AND m.order_date<?)":""}`).bind(istDate(startMs),istDate(endMs),...recorded?[startMs,endMs,istDate(startMs)]:[]).all<Row>()).results;
  for(const r of rows){const value=round(r.order_value),tax=round(r.gst_amount),ordered=Date.parse(`${text(r.order_date)}T12:00:00+05:30`),supplyAt=filedAt(ordered,num(r.created_at)||ordered,locks);if(!within(supplyAt,startMs,endMs))continue;const noGst=noGstFiling(funeralAt(supplyAt));out.push(line({supplyKey:`funeral_order:${text(r.id)}`,source:"funeral_manual_order",serviceCode:"funeral_memorial",treatment:tax>0?"legacy":noGst.treatment,section:tax>0?"taxable":noGst.section,lineDetail:!(tax>0),supplyAt,orderValue:value,taxableValue:tax>0?round2(value-tax):0,gst:tax,exemptValue:tax>0?0:value,ownership:owner(r.entity_id,r.registration_id),label:tax>0?LABELS.funeralTaxed:noGst.label}));}
 }
 return out;
}

/* 4. Not classified by the owner yet (decision 9): reported as their modules compute them today, never dropped. */
async function unclassifiedLines(db:Db,startMs:number,endMs:number):Promise<ServiceSupplyLine[]>{
 const out:ServiceSupplyLine[]=[],section=(tax:number):SupplySection=>tax>0?"taxable":"unclassified";
 if(hasAll(await columnsOf(db,"relocation_vendor_settlements"),["case_id","gross_paid_value","tax_amount","revenue_net","created_at"])){
  const rows=(await db.prepare("SELECT r.case_id,r.gross_paid_value,r.tax_amount,r.revenue_net,r.created_at,s.entity_id,s.registration_id FROM relocation_vendor_settlements r LEFT JOIN service_supply_ownership s ON s.supply_key='relocation:'||r.case_id WHERE r.created_at>=? AND r.created_at<?").bind(startMs,endMs).all<Row>()).results;
  for(const r of rows){const tax=round(r.tax_amount);out.push(line({supplyKey:`relocation:${text(r.case_id)}`,source:"relocation",serviceCode:"relocation",treatment:"not_yet_classified",section:section(tax),supplyAt:num(r.created_at),orderValue:round(r.gross_paid_value),taxableValue:round(r.revenue_net),gst:tax,ownership:owner(r.entity_id,r.registration_id),journal:{sourceType:"relocation_delivery",sourceId:text(r.case_id)},label:LABELS.relocation}));}
 }
 if(hasAll(await columnsOf(db,"vet_visit_kpis"),["appointment_id","provider_payout_paise","platform_retained_paise","tax_paise","created_at"])){
  const rows=(await db.prepare("SELECT v.appointment_id,v.provider_payout_paise,v.platform_retained_paise,v.tax_paise,v.created_at,s.entity_id,s.registration_id FROM vet_visit_kpis v LEFT JOIN service_supply_ownership s ON s.supply_key='vet:'||v.appointment_id WHERE v.created_at>=? AND v.created_at<?").bind(startMs,endMs).all<Row>()).results;
  for(const r of rows){const tax=round2(num(r.tax_paise)/100);out.push(line({supplyKey:`vet:${text(r.appointment_id)}`,source:"vet",serviceCode:"vet_consult",treatment:"not_yet_classified",section:section(tax),supplyAt:num(r.created_at),orderValue:round2((num(r.provider_payout_paise)+num(r.platform_retained_paise))/100),taxableValue:round2(num(r.platform_retained_paise)/100),gst:tax,ownership:owner(r.entity_id,r.registration_id),label:LABELS.vet}));}
 }
 if(hasAll(await columnsOf(db,"food_orders"),["id","total_amount","status","created_at"])){
  // Goods are supplied when delivered: the delivery handover time (else the order time), so an order placed before a month
  // closed and delivered after it never lands in the closed month. A subscription renewal's delivery order is billed by its
  // food_subscription_invoices row below; counting the order as well would report the same supply twice.
  const ledger=hasAll(await columnsOf(db,"food_supplier_settlement_ledger"),["order_id","tax_amount"]),handover=hasAll(await columnsOf(db,"food_delivery_handover_events"),["order_id","confirmed_at"]),renewals=hasAll(await columnsOf(db,"food_subscription_renewals"),["delivery_order_id"]);
  const at=handover?"COALESCE((SELECT h.confirmed_at FROM food_delivery_handover_events h WHERE h.order_id=o.id),o.created_at)":"o.created_at";
  const rows=(await db.prepare(`SELECT o.id,o.total_amount,${at} supply_at,${ledger?"l.tax_amount":"0"} tax_amount,s.entity_id,s.registration_id FROM food_orders o${ledger?" LEFT JOIN food_supplier_settlement_ledger l ON l.order_id=o.id":""} LEFT JOIN service_supply_ownership s ON s.supply_key='food_order:'||o.id WHERE o.status='delivered' AND ${at}>=? AND ${at}<?${renewals?" AND NOT EXISTS (SELECT 1 FROM food_subscription_renewals r WHERE r.delivery_order_id=o.id)":""}`).bind(startMs,endMs).all<Row>()).results;
  for(const r of rows){const total=round(r.total_amount),tax=round(r.tax_amount);out.push(line({supplyKey:`food_order:${text(r.id)}`,source:"food_order",serviceCode:"food",treatment:"not_yet_classified",section:section(tax),supplyAt:num(r.supply_at),orderValue:total,taxableValue:round2(total-tax),gst:tax,ownership:owner(r.entity_id,r.registration_id),label:LABELS.food}));}
 }
 if(hasAll(await columnsOf(db,"food_subscription_invoices"),["id","gross_amount","tax_amount","status","issued_at"])){
  const rows=(await db.prepare("SELECT f.id,f.gross_amount,f.tax_amount,f.issued_at,s.entity_id,s.registration_id FROM food_subscription_invoices f LEFT JOIN service_supply_ownership s ON s.supply_key='food_invoice:'||f.id WHERE f.status!='cancelled' AND f.issued_at>=? AND f.issued_at<?").bind(startMs,endMs).all<Row>()).results;
  for(const r of rows){const gross=round(r.gross_amount),tax=round(r.tax_amount);out.push(line({supplyKey:`food_invoice:${text(r.id)}`,source:"food_subscription_invoice",serviceCode:"food",treatment:"not_yet_classified",section:section(tax),supplyAt:num(r.issued_at),orderValue:gross,taxableValue:round2(gross-tax),gst:tax,invoiceTax:tax,ownership:owner(r.entity_id,r.registration_id),label:LABELS.food}));}
 }
 return out;
}

/* Place of supply for a booking line: the customer's recorded place of supply, else the booking's city. When neither is on
 * record the returns use the supplier's own state (IGST Act s.12(2)(b): B2C with no address on record). */
async function attachBookingDetails(db:Db,lines:ServiceSupplyLine[]){
 const bookingCols=await columnsOf(db,"canonical_bookings");if(!bookingCols.has("id"))return;
 const ids=[...new Set(lines.map(l=>l.bookingId).filter((id):id is string=>Boolean(id)))];if(!ids.length)return;
 const pick=(c:string)=>bookingCols.has(c)?c:`NULL ${c}`,bookings=new Map<string,Row>();
 for(const r of await chunkedIn(ids,async(chunk,placeholders)=>(await db.prepare(`SELECT id,${pick("service_code")},${pick("city_id")},${pick("customer_id")} FROM canonical_bookings WHERE id IN (${placeholders})`).bind(...chunk).all<Row>()).results))bookings.set(text(r.id),r);
 const profiles=new Map<string,string>(),customers=[...new Set([...bookings.values()].map(b=>text(b.customer_id)).filter(Boolean))];
 if(customers.length&&hasAll(await columnsOf(db,"finance_customer_tax_profiles"),["customer_id","place_of_supply"]))for(const r of await chunkedIn(customers,async(chunk,placeholders)=>(await db.prepare(`SELECT customer_id,place_of_supply FROM finance_customer_tax_profiles WHERE customer_id IN (${placeholders})`).bind(...chunk).all<Row>()).results)){const pos=text(r.place_of_supply).slice(0,2);if(/^\d{2}$/.test(pos))profiles.set(text(r.customer_id),pos);}
 for(const l of lines){const b=l.bookingId?bookings.get(l.bookingId):undefined;if(!b)continue;if(!l.serviceCode)l.serviceCode=text(b.service_code);if(!l.invoice)l.placeOfSupply=profiles.get(text(b.customer_id))??CITY_STATE_CODE[text(b.city_id).toLowerCase()]??null;}
}

/* A booking Finance invoiced BY HAND through the canonical path (finance_invoices, source_type 'booking', any event key but the
 * customer tax invoice's): that invoice's tax is already in finance_tax_ledger, which the returns add to this register, so the
 * booking may be counted twice. Marked so the returns disclose it for review. A booking's customer tax invoice is not marked:
 * its line files it (attachBookingInvoices) and the canonical reads leave it out, so it is counted once. */
async function markCanonicalInvoices(db:Db,lines:ServiceSupplyLine[]){
 const cols=await columnsOf(db,"finance_invoices");if(!hasAll(cols,["id","source_type","source_id","status"]))return;
 const ids=[...new Set(lines.map(l=>l.bookingId).filter((id):id is string=>Boolean(id)))];if(!ids.length)return;
 const found=new Map<string,string>(),byHand=cols.has("source_event_key")?` AND source_event_key!=('${BOOKING_INVOICE_EVENT_PREFIX}'||source_id)`:"";
 for(const r of await chunkedIn(ids,async(chunk,placeholders)=>(await db.prepare(`SELECT source_id,MIN(id) id FROM finance_invoices WHERE source_type='booking' AND status!='cancelled'${byHand} AND source_id IN (${placeholders}) GROUP BY source_id`).bind(...chunk).all<Row>()).results))found.set(text(r.source_id),text(r.id));
 for(const l of lines)if(l.bookingId&&found.has(l.bookingId))l.canonicalInvoiceId=found.get(l.bookingId)??null;
}

/* A booking's customer tax invoice (owner decision B, lib/booking-tax-invoice.ts): the line files the invoice's own figures and
 * belongs to the invoice's issuer, with the payout record's figures kept beside them and any difference reported. It runs
 * before a `keep` filter, so an invoiced booking is never offered for assignment as if it had no owner. */
async function attachBookingInvoices(db:Db,lines:ServiceSupplyLine[]){
 const cols=await columnsOf(db,"finance_invoices");if(!hasAll(cols,["id","source_type","source_id","source_event_key","status","invoice_number","issue_date","entity_id","registration_id","total","tax_snapshot_json"]))return;
 const booked=lines.filter(l=>l.bookingId&&l.source==="payout_computation");if(!booked.length)return;
 const received=cols.has("amount_received")?"COALESCE(amount_received,total) amount_received":"total amount_received",kind=cols.has("document_kind")?"document_kind":"NULL document_kind",found=new Map<string,Row>();
 for(const r of await chunkedIn([...new Set(booked.map(l=>l.bookingId as string))],async(chunk,placeholders)=>(await db.prepare(`SELECT id,source_id,invoice_number,issue_date,entity_id,registration_id,${received},${kind},tax_snapshot_json FROM finance_invoices WHERE source_type='booking' AND status!='cancelled' AND source_event_key=('${BOOKING_INVOICE_EVENT_PREFIX}'||source_id) AND source_id IN (${placeholders})`).bind(...chunk).all<Row>()).results))found.set(text(r.source_id),r);
 for(const l of booked){const r=found.get(l.bookingId as string);if(!r)continue;const filing=invoiceFiling(r),noGstValue=round2(filing.exemptValue+filing.nonGstValue),register={taxableValue:l.taxableValue,gst:l.gst,exemptValue:l.exemptValue},differences:string[]=[],period=filing.issueDate.slice(0,7);
  if(Math.abs(filing.taxableValue-register.taxableValue)>0.01)differences.push("taxable_value");if(Math.abs(filing.gst-register.gst)>0.01)differences.push("gst");if(Math.abs(noGstValue-register.exemptValue)>0.01)differences.push("exempt_value");
  if(period!==l.period)differences.push("month");if(l.ownership&&(l.ownership.entityId!==filing.entityId||l.ownership.registrationId!==filing.registrationId))differences.push("legal_entity");
  if(differences.length)l.invoiceVariance={bookingId:l.bookingId as string,invoiceId:filing.id,invoiceNumber:filing.invoiceNumber,differences,register:{...register,period:l.period,entityId:l.ownership?.entityId??null,registrationId:l.ownership?.registrationId??null},invoice:{taxableValue:filing.taxableValue,gst:filing.gst,exemptValue:noGstValue,period,entityId:filing.entityId,registrationId:filing.registrationId}};
  const rates=filing.lines.filter(x=>x.role==="taxable").map(x=>x.ratePercent);
  // A supply with no GST is filed in the section its invoice was issued under (exempt, or outside GST).
  if(l.section!=="taxable"&&!(filing.taxableValue>0))l.section=filing.nonGstValue>0?"non_gst":filing.exemptValue>0?"exempt":l.section;
  l.invoice=filing;l.registerFigures=register;l.taxableValue=filing.taxableValue;l.gst=filing.gst;l.exemptValue=noGstValue;l.placeOfSupply=filing.placeOfSupply??l.placeOfSupply;l.ownership={entityId:filing.entityId,registrationId:filing.registrationId};if(rates.length)l.ratePercent=rates[0];}
}
function invoiceFiling(r:Row):BookingInvoiceFiling{
 let snap:Row={};try{snap=JSON.parse(text(r.tax_snapshot_json)) as Row;}catch{snap={};}
 const pos=/^\d{2}$/.test(text(snap.pos_state))?text(snap.pos_state):null;
 const lines=(Array.isArray(snap.lines)?snap.lines as Row[]:[]).map((line):BookingInvoiceLineFiling=>{const components=Array.isArray(line.components)?line.components as Row[]:[],part=(match:(code:string)=>boolean)=>round2(components.filter(c=>match(text(c.code).toLowerCase())).reduce((s,c)=>s+num(c.amount),0)),role=["exempt","non_gst","collected_on_behalf"].includes(text(line.role))?text(line.role) as "exempt"|"non_gst"|"collected_on_behalf":"taxable";
  return{role,sac:normaliseSac(line.classificationCode),description:text(line.description),amount:round(line.lineAmount),taxableValue:round(line.taxableAmount),ratePercent:round2(components.reduce((s,c)=>s+num(c.rate),0)),gst:round(line.taxAmount),iamt:part(c=>c.includes("igst")),camt:part(c=>c.includes("cgst")),samt:part(c=>c.includes("sgst")||c.includes("utgst")),csamt:part(c=>c.includes("cess")),exemptValue:round(line.exemptValue)};});
 const total=(pick:(x:BookingInvoiceLineFiling)=>number)=>round2(lines.reduce((s,x)=>s+pick(x),0));
 return{id:text(r.id),invoiceNumber:text(r.invoice_number),issueDate:text(r.issue_date),documentKind:text(r.document_kind)||text(snap.document_kind)||"tax_invoice",entityId:text(r.entity_id),registrationId:text(r.registration_id),customerGstin:text(snap.recipient_gstin)||null,placeOfSupply:pos,supplyType:text(snap.supply_type)==="inter"?"INTER":"INTRA",amountReceived:round(r.amount_received),taxableValue:total(x=>x.taxableValue),gst:total(x=>x.gst),exemptValue:total(x=>x.role==="exempt"?x.exemptValue:0),nonGstValue:total(x=>x.role==="non_gst"?x.exemptValue:0),iamt:total(x=>x.iamt),camt:total(x=>x.camt),samt:total(x=>x.samt),csamt:total(x=>x.csamt),lines};
}

/** Every service supply filed in the [startMs,endMs) window (epoch ms; the returns use IST months), all entities. `keep`
 * narrows the lines before the per-booking lookups (place of supply, canonical invoices) run. */
export async function serviceSupplyRegister(db:Db,startMs:number,endMs:number,keep?:(l:ServiceSupplyLine)=>boolean):Promise<ServiceSupplyLine[]>{
 await ensureServiceInvoiceOwnershipTables(db);
 const hasInvoices=await tableExists(db,"booking_invoices"),locks=await lockedPeriods(db),funeralVersions=await funeralGstTreatmentVersions(db),funeralAt:FuneralTreatmentAt=at=>funeralGstTreatmentOn(funeralVersions,istDate(at)).treatment;
 const all=[...await payoutLines(db,startMs,endMs,hasInvoices,locks,funeralAt),...hasInvoices?await invoiceLines(db,startMs,endMs):[],...await funeralLines(db,startMs,endMs,locks,funeralAt),...await unclassifiedLines(db,startMs,endMs)];
 for(const l of all)l.periodClosed=locks.has(l.period);
 await attachBookingInvoices(db,all);
 const lines=keep?all.filter(keep):all;
 await attachBookingDetails(db,lines);await markCanonicalInvoices(db,lines);
 return lines.sort((a,b)=>a.supplyAt-b.supplyAt||a.supplyKey.localeCompare(b.supplyKey));
}

/** What ledger account 2130-GST Payable holds for the same supplies (completion, funeral closure and relocation journals). */
export async function ledgerGstForSupplies(db:Db,lines:ServiceSupplyLine[]){
 const posted=new Map<string,number>(),withJournal=lines.filter(l=>l.journal);
 if(withJournal.length&&await tableExists(db,"finance_journal_entries")){
  const byType=new Map<string,string[]>();for(const l of withJournal){const j=l.journal!,ids=byType.get(j.sourceType)??[];ids.push(j.sourceId);byType.set(j.sourceType,ids);}
  for(const[type,ids]of byType)for(const r of await chunkedIn(ids,async(chunk,placeholders)=>(await db.prepare(`SELECT source_id,COALESCE(SUM(credit-debit),0) gst FROM finance_journal_entries WHERE account_code='2130-GST Payable' AND source_type=? AND source_id IN (${placeholders}) GROUP BY source_id`).bind(type,...chunk).all<Row>()).results))posted.set(`${type}:${text(r.source_id)}`,round(r.gst));
 }
 const mismatches:Array<{supplyKey:string;filedGst:number;postedGst:number}>=[];let filed=0,ledger=0;
 for(const l of withJournal){const key=`${l.journal!.sourceType}:${l.journal!.sourceId}`,p=posted.get(key)??0;filed+=l.gst;ledger+=p;if(Math.abs(p-l.gst)>0.01&&mismatches.length<50)mismatches.push({supplyKey:l.supplyKey,filedGst:l.gst,postedGst:p});}
 return{supplies:withJournal.length,filedGst:round2(filed),postedGst:round2(ledger),difference:round2(filed-ledger),agrees:Math.abs(filed-ledger)<=0.01&&!mismatches.length,mismatches};
}

export type ServiceOutputTaxSplit={
 totalTaxCollected:number;grossTotal:number;invoiceCount:number;
 pawspaceOwnOutputTax:number;pawspaceOwnTaxableValue:number;
 providerSupplyGstOnBehalf:number;costedCount:number;uncostedTax:number;
 /** GSTR-3B 3.1(c): exempt value (funeral / memorial when Finance treats it as exempt). */
 exemptValue:number;
 /** GSTR-3B 3.1(e): non-GST value (funeral / memorial under Schedule III, the default treatment). */
 nonGstValue:number;
 /** what GSTR-1 can show line by line (b2cs / hsn), and the tax it cannot (legacy invoices, unclassified verticals). */
 lineDetailTaxableValue:number;lineDetailTax:number;taxNotInLineDetail:number;
 byTreatment:Record<SupplyTreatment,{count:number;orderValue:number;taxableValue:number;gst:number;exemptValue:number}>;
 notYetClassified:{count:number;orderValue:number;gst:number;verticals:Array<{source:string;label:string;count:number;orderValue:number;taxableValue:number;gst:number}>};
 /** lines of an open month with no legal entity yet (all entities; a scoped call refuses instead). */
 unassignedCount:number;
 /** lines left unassigned in a month that is already closed (closed before the register listed them): they can no longer be
  * assigned, so no entity's return carries them. Disclosed for the CA, never a permanent refusal (audit G22). */
 unassignedInClosedMonths:{count:number;orderValue:number;gst:number;supplies:string[]};
 /** bookings also on a canonical finance_invoices invoice, whose tax is in finance_tax_ledger too: possible double count. */
 alsoOnCanonicalInvoice:{count:number;gst:number;bookings:Array<{bookingId:string;invoiceId:string;gst:number}>};
 /** bookings filed from their customer tax invoice, and those whose invoice differs from the payout record (both numbers). */
 bookingInvoices:{count:number;taxableValue:number;gst:number;exemptValue:number};
 invoiceVariances:{count:number;supplies:BookingInvoiceVariance[]};
 /** per service: what PawSpace makes, its GST, and the net income the books keep (amount made - GST). */
 byService:ServiceIncomeRow[];
 /** rate x value on every line filed line by line: the tax is the rate on the taxable value, within 1 paisa. */
 rateCheck:{checked:number;holds:boolean;mismatches:Array<{supplyKey:string;taxableValue:number;ratePercent:number;gst:number;expected:number}>};
 gstModel:{label:string;ratePercent:number|null;approvedOn:string;note:string};
 ledgerCheck:Awaited<ReturnType<typeof ledgerGstForSupplies>>;
 lines:ServiceSupplyLine[];
};
export type ServiceIncomeRow={serviceCode:string;label:string;count:number;amountMade:number;gst:number;netIncome:number;taxableValue:number;exemptValue:number};
const SERVICE_NAMES=new Map<string,string>(pawspaceServices.map(s=>[s.code,s.name]));
function serviceIncome(lines:ServiceSupplyLine[]):ServiceIncomeRow[]{
 const rows=new Map<string,ServiceIncomeRow>();
 for(const l of lines){const code=l.serviceCode||l.source,row=rows.get(code)??{serviceCode:code,label:SERVICE_NAMES.get(code)??code.replaceAll("_"," "),count:0,amountMade:0,gst:0,netIncome:0,taxableValue:0,exemptValue:0};row.count+=1;row.amountMade=round2(row.amountMade+l.amountMade);row.gst=round2(row.gst+l.gst);row.netIncome=round2(row.amountMade-row.gst);row.taxableValue=round2(row.taxableValue+(l.section==="taxable"?l.taxableValue:0));row.exemptValue=round2(row.exemptValue+l.exemptValue);rows.set(code,row);}
 return[...rows.values()].sort((a,b)=>b.amountMade-a.amountMade||a.serviceCode.localeCompare(b.serviceCode));
}
/* rate x value: an invoice line on its own components, any other line on the payout record's GST rate. */
function rateTimesValue(lines:ServiceSupplyLine[]):ServiceOutputTaxSplit["rateCheck"]{
 const mismatches:ServiceOutputTaxSplit["rateCheck"]["mismatches"]=[];let checked=0;
 for(const l of lines){if(!l.lineDetail||l.section!=="taxable")continue;const parts=l.invoice?l.invoice.lines.filter(x=>x.role==="taxable").map(x=>({taxableValue:x.taxableValue,ratePercent:x.ratePercent,gst:x.gst})):[{taxableValue:l.taxableValue,ratePercent:l.ratePercent,gst:l.gst}];
  for(const part of parts){checked+=1;const expected=round2(part.taxableValue*part.ratePercent/100);if(Math.abs(expected-part.gst)>0.01&&mismatches.length<50)mismatches.push({supplyKey:l.supplyKey,...part,expected});}}
 return{checked,holds:!mismatches.length,mismatches};
}
/* The wording every return and GST screen uses for the model (owner decision A), with the rate the month actually filed. */
function gstModelOf(lines:ServiceSupplyLine[]):ServiceOutputTaxSplit["gstModel"]{
 const rates=[...new Set(lines.filter(l=>l.lineDetail&&l.section==="taxable"&&l.ratePercent>0).map(l=>l.ratePercent))],rate=rates.length===1?rates[0]:rates.length?null:DEFAULT_GST_POLICY.ratePercent;
 return{label:rate===null?"GST at the rate in force on the amount PawSpace makes":`GST @${rate}% on the amount PawSpace makes`,ratePercent:rate,approvedOn:"2026-09-27",note:"Owner-approved method, 27 Sept 2026: PawSpace pays GST on the amount it makes - its commission on a commission booking, the full amount the customer paid on its own supply (full-time or contract provider, company vehicle). Funeral and memorial are exempt. The books keep income as the amount made less GST."};
}

/** PawSpace's own output GST and taxable value for the [startMs,endMs) window, from the supply register. With a scope, only
 * that entity's registration, and every line of an open month must be assigned first. */
export async function serviceVerticalOutputTax(db:Db,startMs:number,endMs:number,scope?:ServiceInvoiceScope):Promise<ServiceOutputTaxSplit>{
 const all=await serviceSupplyRegister(db,startMs,endMs),unassigned=all.filter(l=>!l.ownership),blocking=unassigned.filter(l=>!l.periodClosed),stranded=unassigned.filter(l=>l.periodClosed);
 if(scope&&blocking.length>0)throw new ServiceInvoiceOwnershipRequired(blocking.length);
 const lines=scope?all.filter(l=>l.ownership?.entityId===scope.entityId&&l.ownership.registrationId===scope.registrationId):all;
 const sum=(list:ServiceSupplyLine[],pick:(l:ServiceSupplyLine)=>number)=>round2(list.reduce((a,l)=>a+pick(l),0));
 const byTreatment={} as ServiceOutputTaxSplit["byTreatment"];
 for(const t of["commission","own_supply","exempt","non_gst","legacy","not_yet_classified"] as SupplyTreatment[]){const of=lines.filter(l=>l.treatment===t);byTreatment[t]={count:of.length,orderValue:sum(of,l=>l.orderValue),taxableValue:sum(of,l=>l.taxableValue),gst:sum(of,l=>l.gst),exemptValue:sum(of,l=>l.exemptValue)};}
 const unclassified=lines.filter(l=>l.treatment==="not_yet_classified"),verticals=new Map<string,{source:string;label:string;count:number;orderValue:number;taxableValue:number;gst:number}>();
 for(const l of unclassified){const v=verticals.get(l.source)??{source:l.source,label:l.label,count:0,orderValue:0,taxableValue:0,gst:0};v.count+=1;v.orderValue=round2(v.orderValue+l.orderValue);v.taxableValue=round2(v.taxableValue+l.taxableValue);v.gst=round2(v.gst+l.gst);verticals.set(l.source,v);}
 const taxable=lines.filter(l=>l.section==="taxable"),detail=taxable.filter(l=>l.lineDetail),invoiceOnly=lines.filter(l=>l.source==="booking_invoice"&&!l.costed),invoiced=lines.filter(l=>l.invoice),variances=lines.map(l=>l.invoiceVariance).filter((v):v is BookingInvoiceVariance=>Boolean(v));
 return{totalTaxCollected:sum(lines,l=>l.invoiceTax),grossTotal:sum(lines,l=>l.orderValue),invoiceCount:lines.length,
  pawspaceOwnOutputTax:sum(lines,l=>l.gst),pawspaceOwnTaxableValue:sum(taxable,l=>l.taxableValue),
  providerSupplyGstOnBehalf:sum(lines,l=>l.providerSupplyGstOnBehalf),costedCount:lines.filter(l=>l.costed).length,uncostedTax:sum(invoiceOnly,l=>l.gst),
  exemptValue:sum(lines.filter(l=>l.section==="exempt"),l=>l.exemptValue),nonGstValue:sum(lines.filter(l=>l.section==="non_gst"),l=>l.exemptValue),lineDetailTaxableValue:sum(detail,l=>l.taxableValue),lineDetailTax:sum(detail,l=>l.gst),taxNotInLineDetail:round2(sum(lines,l=>l.gst)-sum(detail,l=>l.gst)),
  byTreatment,notYetClassified:{count:unclassified.length,orderValue:sum(unclassified,l=>l.orderValue),gst:sum(unclassified,l=>l.gst),verticals:[...verticals.values()]},
  unassignedCount:scope?0:blocking.length,unassignedInClosedMonths:{count:stranded.length,orderValue:sum(stranded,l=>l.orderValue),gst:sum(stranded,l=>l.gst),supplies:stranded.slice(0,50).map(l=>l.supplyKey)},
  alsoOnCanonicalInvoice:{count:lines.filter(l=>l.canonicalInvoiceId).length,gst:sum(lines.filter(l=>l.canonicalInvoiceId),l=>l.gst),bookings:lines.filter(l=>l.canonicalInvoiceId).slice(0,50).map(l=>({bookingId:l.bookingId??l.supplyKey,invoiceId:l.canonicalInvoiceId??"",gst:l.gst}))},
  bookingInvoices:{count:invoiced.length,taxableValue:sum(invoiced,l=>l.taxableValue),gst:sum(invoiced,l=>l.gst),exemptValue:sum(invoiced,l=>l.exemptValue)},invoiceVariances:{count:variances.length,supplies:variances.slice(0,50)},
  byService:serviceIncome(lines),rateCheck:rateTimesValue(lines),gstModel:gstModelOf(lines),
  ledgerCheck:await ledgerGstForSupplies(db,lines),lines};
}

/** CGST/SGST (supplier's own state) or IGST (another state) for one taxable line. The halves always add back to the GST. A line
 * filed from its customer tax invoice files the invoice's own place of supply and components. */
export function supplyTaxComponents(l:Pick<ServiceSupplyLine,"gst"|"placeOfSupply">&{invoice?:BookingInvoiceFiling|null},homeState:string){if(l.invoice)return{pos:l.invoice.placeOfSupply??homeState,supplyType:l.invoice.supplyType,iamt:l.invoice.iamt,camt:l.invoice.camt,samt:l.invoice.samt};const pos=l.placeOfSupply&&/^\d{2}$/.test(l.placeOfSupply)?l.placeOfSupply:homeState,intra=pos===homeState,camt=intra?round2(l.gst/2):0;return{pos,supplyType:intra?"INTRA" as const:"INTER" as const,iamt:intra?0:round2(l.gst),camt,samt:intra?round2(l.gst-camt):0};}

/* The SAC a supply with no invoice line is filed under in GSTR-1's HSN summary: Finance's classification in the active tax policy
 * (the service code, or "platform_commission" for PawSpace's commission), else the service's default in the one SAC table
 * (lib/service-sac-defaults.ts). An invoiced booking files the SAC printed on its invoice lines instead. */
export function supplySac(l:Pick<ServiceSupplyLine,"treatment"|"serviceCode">,classifications:ReadonlyMap<string,string>){
 const code=l.treatment==="commission"?PLATFORM_COMMISSION_SERVICE_CODE:l.serviceCode,configured=classifications.get(code);if(configured)return{sac:configured,source:"tax_classification"};
 const fallback=serviceSacDefault(code)??serviceSacDefault(l.treatment==="exempt"?"funeral_memorial":"grooming");return{sac:fallback?.sac??"999799",source:"default"};
}

/** Filed supplies of the month that are not assigned to a legal entity and GST registration yet. */
export async function unassignedServiceSupplies(db:Db,startMs:number,endMs:number){return serviceSupplyRegister(db,startMs,endMs,l=>!l.ownership);}

/* Ownership assignments are audited beside the other GST decisions (the reason is also kept on each ownership row). */
async function auditOwnership(db:Db,actor:string,entityId:string,action:string,after:unknown,reason:string){
 if(!await tableExists(db,"gst_accounting_audit_events"))return;
 await db.prepare("INSERT INTO gst_accounting_audit_events (id,entity_type,entity_id,action,before_json,after_json,actor_id,reason,created_at) VALUES (?,?,?,?,NULL,?,?,?,?)").bind(`ga_audit_${crypto.randomUUID().slice(0,16)}`,"service_supply_ownership",entityId,action,JSON.stringify(after),actor,reason,Date.now()).run();
}

/** Assign one filed supply that has no service invoice (a completed booking, funeral case, ...) to its legal entity and GST
 * registration: an active registration of an active entity, a reason, permanent, and never into a closed month. */
export async function assignServiceSupplyOwnership(db:Db,input:ServiceInvoiceScope&{supplyKey:string;reason:string},actor:string){
 await ensureServiceInvoiceOwnershipTables(db);
 const key=text(input.supplyKey),reason=text(input.reason);
 if(!key||!input.entityId||!input.registrationId||reason.length<8)throw governedJsonError({error:"Supply, entity, registration and a clear ownership reason are required"},400);
 await assertOwnershipRegistration(db,input);
 const[found]=await serviceSupplyRegister(db,0,SUPPLY_END_OF_TIME,l=>l.supplyKey===key);
 if(!found)throw governedJsonError({error:"A completed service supply is required"},409);
 if(found.invoice)throw governedJsonError({error:`This booking has a customer tax invoice (${found.invoice.invoiceNumber}); it is filed under the legal entity and GST registration that issued it`},409);
 if(found.assignKey!==`SUPPLY:${key}`)throw governedJsonError({error:"This supply has a service invoice; assign the invoice instead"},409);
 await assertOwnershipPeriodOpen(db,found.period);
 const inserted=await db.prepare("INSERT OR IGNORE INTO service_supply_ownership (supply_key,entity_id,registration_id,assigned_by,reason,assigned_at) VALUES (?,?,?,?,?,?)").bind(key,input.entityId,input.registrationId,actor,reason,Date.now()).run();
 const stored=await db.prepare("SELECT * FROM service_supply_ownership WHERE supply_key=?").bind(key).first<Row>();
 if(stored?.entity_id!==input.entityId||stored?.registration_id!==input.registrationId)throw governedJsonError({error:"This supply already belongs to a different entity or registration; ownership cannot be overwritten"},409);
 if(Number(inserted.meta?.changes)>0)await auditOwnership(db,actor,key,"assigned",{supplyKey:key,period:found.period,entityId:input.entityId,registrationId:input.registrationId,gst:found.gst},reason);
 return stored;
}

/** Assign every unassigned supply of an open month (invoices and supplies alike) to one entity and registration, with one
 * reason. Refused once the month is closed. */
export async function assignPeriodServiceOwnership(db:Db,input:ServiceInvoiceScope&{periodCode:string;reason:string},actor:string){
 await ensureServiceInvoiceOwnershipTables(db);
 const period=text(input.periodCode),reason=text(input.reason);
 if(!/^\d{4}-\d{2}$/.test(period)||!input.entityId||!input.registrationId||reason.length<8)throw governedJsonError({error:"Month, entity, registration and a clear ownership reason are required"},400);
 await assertOwnershipRegistration(db,input);await assertOwnershipPeriodOpen(db,period);
 const{startMs,endMs}=istMonthWindow(period),pending=await unassignedServiceSupplies(db,startMs,endMs),now=Date.now();
 const statements=pending.map(l=>l.assignKey.startsWith("SUPPLY:")?db.prepare("INSERT OR IGNORE INTO service_supply_ownership (supply_key,entity_id,registration_id,assigned_by,reason,assigned_at) VALUES (?,?,?,?,?,?)").bind(l.supplyKey,input.entityId,input.registrationId,actor,reason,now):db.prepare("INSERT OR IGNORE INTO service_invoice_ownership (invoice_id,entity_id,registration_id,assigned_by,reason,assigned_at) VALUES (?,?,?,?,?,?)").bind(l.assignKey,input.entityId,input.registrationId,actor,reason,now));
 for(const part of idChunks(statements,50))await db.batch(part);
 if(pending.length)await auditOwnership(db,actor,`period:${period}`,"period_assigned",{periodCode:period,entityId:input.entityId,registrationId:input.registrationId,assigned:pending.length,gst:round2(pending.reduce((a,l)=>a+l.gst,0)),supplies:pending.slice(0,200).map(l=>l.supplyKey)},reason);
 return{periodCode:period,entityId:input.entityId,registrationId:input.registrationId,assigned:pending.length,supplies:pending.map(l=>l.supplyKey)};
}

/** Unassigned supplies with no service invoice in an open month, shaped like serviceInvoiceOwnershipSnapshot rows so the
 * ownership screen lists them beside unassigned invoices (their id is "SUPPLY:<key>"). */
export async function serviceSupplyOwnershipSnapshot(db:Db){
 // A line in a month that is already closed cannot be assigned any more, so it is not offered here (it is disclosed in the returns).
 return(await serviceSupplyRegister(db,0,SUPPLY_END_OF_TIME,l=>!l.ownership&&!l.periodClosed&&l.assignKey.startsWith("SUPPLY:"))).slice(-100).reverse().map(l=>({id:l.assignKey,booking_id:l.bookingId??l.supplyKey,invoice_number:`No invoice (${l.period})`,gross_amount:l.orderValue,tax_amount:l.gst,issued_at:l.supplyAt,entity_id:null,registration_id:null,label:l.label}));
}
