/*
 * Refusals in this module are caller-safe and MUST survive the route's catch block. [R3-C/F8]
 *
 * Same mechanism, same reason as lib/customer-account.ts and lib/boarding-proof-governance.ts:
 * authError() trusts a raised Response only by object identity (isGovernedHttpError), so every
 * refusal here reached the operator as the route's generic "Unable to update Grooming finance
 * ledger". That mattered the moment Grooming got a save_tax_policy SCREEN: a finance manager typing a
 * three-word reason, or picking a rate above 40%, would have been refused without being told which of
 * the five requirements they missed - and the screen exists precisely to stop people having to guess.
 */
import{governedJsonError}from"./governed-http-error";

type Db=D1Database;
type Row=Record<string,unknown>;

export async function ensureGroomingInvoiceTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_tax_policies (city_id TEXT PRIMARY KEY,tax_mode TEXT,tax_rate REAL,status TEXT NOT NULL DEFAULT 'configuration_required',version INTEGER NOT NULL DEFAULT 0,effective_from TEXT,effective_to TEXT,updated_by TEXT,reason TEXT,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_invoice_sequences (city_id TEXT NOT NULL,financial_year TEXT NOT NULL,next_number INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(city_id,financial_year))"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

const round2=(value:number)=>Math.round((value+Number.EPSILON)*100)/100;

export type GroomingTaxBreakdown={basePrice:number;multiPetDiscount:number;taxableAmount:number;gstRate:number|null;gstAmount:number|null;gstMode:"inclusive"|"exclusive"|"configuration_required";totalAmount:number};

/**
 * The city's published GST policy applied to a governed grooming subtotal. [R3-C/F4]
 *
 * ONE implementation, because there were two and only one of them handled `exclusive`. The multi-pet
 * path (lib/live-grooming-governance.ts) grossed an exclusive subtotal up; the single-pet and
 * subscription path (governGroomingBooking) compared the submitted total to the BARE catalogue price.
 * generateCanonicalSalesQuote meanwhile returns the GST-added total, so with `blr` published as
 * exclusive 18% a one-pet assisted order quoted 1349 x 1.18 = 1592 and was then refused with
 * "Submitted Grooming total does not match governed catalogue ..." - a message that blamed the
 * catalogue for a disagreement about TAX. Switching the same policy to `inclusive` made the identical
 * request succeed. Both modes are first-class in the API, so both work through this one function.
 *
 * `configuration_required` - no published policy - leaves the subtotal exactly as it was, which is the
 * behaviour every city without a policy already had.
 */
export async function groomingTaxBreakdown(db:Db,cityId:string,total:number,base:number):Promise<GroomingTaxBreakdown>{
  const row=await db.prepare("SELECT tax_mode,tax_rate,status FROM grooming_tax_policies WHERE city_id=?").bind(cityId).first<Row>().catch(()=>null);
  const discount=round2(Math.max(0,base-total));
  if(!row||String(row.status)!=="published"||!row.tax_mode||row.tax_rate==null)return{basePrice:round2(base),multiPetDiscount:discount,taxableAmount:round2(total),gstRate:null,gstAmount:null,gstMode:"configuration_required",totalAmount:round2(total)};
  const rate=Number(row.tax_rate),mode=String(row.tax_mode)==="exclusive"?"exclusive" as const:"inclusive" as const;
  if(mode==="inclusive"){const taxable=round2(total/(1+rate/100));return{basePrice:round2(base),multiPetDiscount:discount,taxableAmount:taxable,gstRate:rate,gstAmount:round2(total-taxable),gstMode:mode,totalAmount:round2(total)};}
  const gst=round2(total*rate/100);
  return{basePrice:round2(base),multiPetDiscount:discount,taxableAmount:round2(total),gstRate:rate,gstAmount:gst,gstMode:mode,totalAmount:round2(total+gst)};
}

/** What disagreed, in the words of the thing that disagreed. */
export function groomingTaxNote(breakdown:GroomingTaxBreakdown,cityId:string){
  if(breakdown.gstMode==="configuration_required")return `no published GST policy for city ${cityId}, so the catalogue price is the total`;
  if(breakdown.gstMode==="inclusive")return `GST ${breakdown.gstRate}% inclusive for city ${cityId}, already inside the catalogue price`;
  return `GST ${breakdown.gstRate}% exclusive for city ${cityId} adding ${breakdown.gstAmount}`;
}

/**
 * Explicit UAT/test seed for a city tax policy. Does not overwrite an existing published policy.
 * Default is 18% GST inclusive — placeholder only, not final business policy.
 * Must NOT be called from issueGroomingInvoice (fail-closed without a published policy).
 */
const taxPolicySeeded=new WeakMap<Db,Set<string>>();
export async function seedDefaultGroomingTaxPolicy(db:Db,cityId="blr"){
  const seeded=taxPolicySeeded.get(db)??new Set<string>();
  if(seeded.has(cityId))return;
  await ensureGroomingInvoiceTables(db);
  const existing=await db.prepare("SELECT city_id,status FROM grooming_tax_policies WHERE city_id=?").bind(cityId).first<Row>();
  if(existing&&String(existing.status)==="published"){
    seeded.add(cityId);taxPolicySeeded.set(db,seeded);return;
  }
  const now=Date.now();
  await db.prepare("INSERT INTO grooming_tax_policies (city_id,tax_mode,tax_rate,status,version,effective_from,effective_to,updated_by,reason,updated_at) VALUES (?,?,?,'published',1,?,?,?,?,?) ON CONFLICT(city_id) DO NOTHING")
    .bind(cityId,"inclusive",18,"2026-01-01",null,"uat_seed","UAT default GST inclusive seed until finance publishes the final city policy",now).run();
  seeded.add(cityId);taxPolicySeeded.set(db,seeded);
}

function invoiceAmounts(total:number,policy:Row|null){
  if(!policy||String(policy.status)!=="published"||policy.tax_rate===null||policy.tax_rate===undefined||!policy.tax_mode)return null;
  const rate=Number(policy.tax_rate),mode=String(policy.tax_mode);
  if(mode==="inclusive"){const taxable=Math.round(total/(1+rate/100)*100)/100,tax=Math.round((total-taxable)*100)/100;return{taxAmount:tax,netAmount:total};}
  const tax=Math.round(total*(rate/100)*100)/100;return{taxAmount:tax,netAmount:Math.round((total+tax)*100)/100};
}

export async function saveGroomingTaxPolicy(db:Db,input:{cityId:string;taxMode:"inclusive"|"exclusive";taxRate:number;effectiveFrom:string;actorId:string;reason:string}){
  await ensureGroomingInvoiceTables(db);
  if(!input.cityId||!input.effectiveFrom||!["inclusive","exclusive"].includes(input.taxMode)||!Number.isFinite(input.taxRate)||input.taxRate<0||input.taxRate>40||input.reason.trim().length<8)
    throw governedJsonError({error:"City, inclusive/exclusive tax mode, 0-40% tax rate, effective date and clear reason are required"},400);
  const current=await db.prepare("SELECT version FROM grooming_tax_policies WHERE city_id=?").bind(input.cityId).first<{version:number}>();
  const version=Number(current?.version||0)+1,now=Date.now();
  await db.prepare("INSERT INTO grooming_tax_policies (city_id,tax_mode,tax_rate,status,version,effective_from,effective_to,updated_by,reason,updated_at) VALUES (?,?,?,'published',?,?,NULL,?,?,?) ON CONFLICT(city_id) DO UPDATE SET tax_mode=excluded.tax_mode,tax_rate=excluded.tax_rate,status='published',version=excluded.version,effective_from=excluded.effective_from,effective_to=NULL,updated_by=excluded.updated_by,reason=excluded.reason,updated_at=excluded.updated_at")
    .bind(input.cityId,input.taxMode,input.taxRate,version,input.effectiveFrom,input.actorId,input.reason,now).run();
  return{cityId:input.cityId,status:"published",version,taxMode:input.taxMode,taxRate:input.taxRate};
}

export async function issueGroomingInvoice(db:Db,input:{bookingId:string;reason:string;actorId:string}){
  await ensureGroomingInvoiceTables(db);
  if(!input.bookingId||input.reason.trim().length<8)throw governedJsonError({error:"Booking and clear invoice issue reason are required"},400);
  const existing=await db.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if(existing)return{bookingId:input.bookingId,invoiceNumber:String(existing.invoice_number),status:String(existing.status),duplicatePrevented:true,liveTaxFiling:false};
  const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(input.bookingId).first<Row>();
  if(!booking)throw governedJsonError({error:"Canonical Grooming booking not found"},404);
  const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if(!payment||String(payment.status)!=="captured")throw governedJsonError({error:"Grooming invoice cannot be issued until the sandbox payment is captured"},409);
  const cityId=String(booking.city_id);
  const policy=await db.prepare("SELECT * FROM grooming_tax_policies WHERE city_id=?").bind(cityId).first<Row>();
  const amounts=invoiceAmounts(Number(booking.total_amount||0),policy);
  if(!amounts)throw governedJsonError({error:"Grooming invoice is blocked until a published tax policy is configured for this city"},409);
  const now=Date.now(),date=new Date(now),year=date.getUTCMonth()>=3?date.getUTCFullYear():date.getUTCFullYear()-1,financialYear=`${String(year).slice(-2)}-${String(year+1).slice(-2)}`,cityCode=cityId.toUpperCase();
  await db.prepare("INSERT OR IGNORE INTO grooming_invoice_sequences (city_id,financial_year,next_number,updated_at) VALUES (?,?,0,?)").bind(cityId,financialYear,now).run();
  const sequence=await db.prepare("UPDATE grooming_invoice_sequences SET next_number=next_number+1,updated_at=? WHERE city_id=? AND financial_year=? RETURNING next_number").bind(now,cityId,financialYear).first<{next_number:number}>();
  if(!sequence)throw governedJsonError({error:"Grooming invoice sequence could not be reserved"},409);
  const invoiceNumber=`GRM-${cityCode}-${financialYear}-${String(sequence.next_number).padStart(6,"0")}`,invoiceId=`GINV-${crypto.randomUUID().slice(0,12).toUpperCase()}`,grossAmount=Number(booking.total_amount||0);
  const inserted=await db.prepare("INSERT INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES (?,?,?,?,'issued_uat',?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO NOTHING")
    .bind(invoiceId,input.bookingId,String(booking.customer_id),invoiceNumber,String(booking.currency||"INR"),grossAmount,amounts.taxAmount,amounts.netAmount,now,now,now).run();
  if(Number(inserted.meta.rows_written||0)!==1){
    const raced=await db.prepare("SELECT invoice_number,status FROM booking_invoices WHERE booking_id=?").bind(input.bookingId).first<Row>();
    if(raced?.invoice_number)return{bookingId:input.bookingId,invoiceNumber:String(raced.invoice_number),status:String(raced.status),duplicatePrevented:true,liveTaxFiling:false};
    throw governedJsonError({error:"Grooming invoice could not be issued"},409);
  }
  return{bookingId:input.bookingId,invoiceNumber,status:"issued_uat",grossAmount,taxAmount:amounts.taxAmount,netAmount:amounts.netAmount,duplicatePrevented:false,liveTaxFiling:false};
}
