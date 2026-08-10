type Db=D1Database;
type Row=Record<string,unknown>;

export async function ensureGroomingInvoiceTables(db:Db){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_tax_policies (city_id TEXT PRIMARY KEY,tax_mode TEXT,tax_rate REAL,status TEXT NOT NULL DEFAULT 'configuration_required',version INTEGER NOT NULL DEFAULT 0,effective_from TEXT,effective_to TEXT,updated_by TEXT,reason TEXT,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS grooming_invoice_sequences (city_id TEXT NOT NULL,financial_year TEXT NOT NULL,next_number INTEGER NOT NULL DEFAULT 0,updated_at INTEGER NOT NULL,PRIMARY KEY(city_id,financial_year))"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

function invoiceAmounts(total:number,policy:Row|null){
  if(!policy||String(policy.status)!=="published"||policy.tax_rate===null||policy.tax_rate===undefined||!policy.tax_mode)return null;
  const rate=Number(policy.tax_rate),mode=String(policy.tax_mode);
  if(mode==="inclusive"){const taxable=Math.round(total/(1+rate/100)*100)/100,tax=Math.round((total-taxable)*100)/100;return{taxAmount:tax,netAmount:total};}
  const tax=Math.round(total*(rate/100)*100)/100;return{taxAmount:tax,netAmount:Math.round((total+tax)*100)/100};
}

export async function saveGroomingTaxPolicy(db:Db,input:{cityId:string;taxMode:"inclusive"|"exclusive";taxRate:number;effectiveFrom:string;actorId:string;reason:string}){
  await ensureGroomingInvoiceTables(db);
  if(!input.cityId||!input.effectiveFrom||!["inclusive","exclusive"].includes(input.taxMode)||!Number.isFinite(input.taxRate)||input.taxRate<0||input.taxRate>40||input.reason.trim().length<8)
    throw new Response("City, inclusive/exclusive tax mode, 0-40% tax rate, effective date and clear reason are required",{status:400});
  const current=await db.prepare("SELECT version FROM grooming_tax_policies WHERE city_id=?").bind(input.cityId).first<{version:number}>();
  const version=Number(current?.version||0)+1,now=Date.now();
  await db.prepare("INSERT INTO grooming_tax_policies (city_id,tax_mode,tax_rate,status,version,effective_from,effective_to,updated_by,reason,updated_at) VALUES (?,?,?,'published',?,?,NULL,?,?,?) ON CONFLICT(city_id) DO UPDATE SET tax_mode=excluded.tax_mode,tax_rate=excluded.tax_rate,status='published',version=excluded.version,effective_from=excluded.effective_from,effective_to=NULL,updated_by=excluded.updated_by,reason=excluded.reason,updated_at=excluded.updated_at")
    .bind(input.cityId,input.taxMode,input.taxRate,version,input.effectiveFrom,input.actorId,input.reason,now).run();
  return{cityId:input.cityId,status:"published",version,taxMode:input.taxMode,taxRate:input.taxRate};
}

export async function issueGroomingInvoice(db:Db,input:{bookingId:string;reason:string;actorId:string}){
  await ensureGroomingInvoiceTables(db);
  if(!input.bookingId||input.reason.trim().length<8)throw new Response("Booking and clear invoice issue reason are required",{status:400});
  const existing=await db.prepare("SELECT * FROM booking_invoices WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if(existing)return{bookingId:input.bookingId,invoiceNumber:String(existing.invoice_number),status:String(existing.status),duplicatePrevented:true,liveTaxFiling:false};
  const booking=await db.prepare("SELECT * FROM canonical_bookings WHERE id=? AND service_code='grooming'").bind(input.bookingId).first<Row>();
  if(!booking)throw new Response("Canonical Grooming booking not found",{status:404});
  const payment=await db.prepare("SELECT * FROM booking_payments WHERE booking_id=?").bind(input.bookingId).first<Row>();
  if(!payment||String(payment.status)!=="captured")throw new Response("Grooming invoice cannot be issued until the sandbox payment is captured",{status:409});
  const cityId=String(booking.city_id),policy=await db.prepare("SELECT * FROM grooming_tax_policies WHERE city_id=?").bind(cityId).first<Row>();
  const amounts=invoiceAmounts(Number(booking.total_amount||0),policy);
  if(!amounts)throw new Response("Grooming invoice is blocked until a published tax policy is configured for this city",{status:409});
  const now=Date.now(),date=new Date(now),year=date.getUTCMonth()>=3?date.getUTCFullYear():date.getUTCFullYear()-1,financialYear=`${String(year).slice(-2)}-${String(year+1).slice(-2)}`,cityCode=cityId.toUpperCase();
  await db.prepare("INSERT OR IGNORE INTO grooming_invoice_sequences (city_id,financial_year,next_number,updated_at) VALUES (?,?,0,?)").bind(cityId,financialYear,now).run();
  const sequence=await db.prepare("UPDATE grooming_invoice_sequences SET next_number=next_number+1,updated_at=? WHERE city_id=? AND financial_year=? RETURNING next_number").bind(now,cityId,financialYear).first<{next_number:number}>();
  if(!sequence)throw new Response("Grooming invoice sequence could not be reserved",{status:409});
  const invoiceNumber=`GRM-${cityCode}-${financialYear}-${String(sequence.next_number).padStart(6,"0")}`,invoiceId=`GINV-${crypto.randomUUID().slice(0,12).toUpperCase()}`,grossAmount=Number(booking.total_amount||0);
  const inserted=await db.prepare("INSERT INTO booking_invoices (id,booking_id,customer_id,invoice_number,status,currency,gross_amount,tax_amount,net_amount,issued_at,created_at,updated_at) VALUES (?,?,?,?,'issued_uat',?,?,?,?,?,?,?) ON CONFLICT(booking_id) DO NOTHING")
    .bind(invoiceId,input.bookingId,String(booking.customer_id),invoiceNumber,String(booking.currency||"INR"),grossAmount,amounts.taxAmount,amounts.netAmount,now,now,now).run();
  if(Number(inserted.meta.rows_written||0)!==1){
    const raced=await db.prepare("SELECT invoice_number,status FROM booking_invoices WHERE booking_id=?").bind(input.bookingId).first<Row>();
    if(raced?.invoice_number)return{bookingId:input.bookingId,invoiceNumber:String(raced.invoice_number),status:String(raced.status),duplicatePrevented:true,liveTaxFiling:false};
    throw new Response("Grooming invoice could not be issued",{status:409});
  }
  return{bookingId:input.bookingId,invoiceNumber,status:"issued_uat",grossAmount,taxAmount:amounts.taxAmount,netAmount:amounts.netAmount,duplicatePrevented:false,liveTaxFiling:false};
}
