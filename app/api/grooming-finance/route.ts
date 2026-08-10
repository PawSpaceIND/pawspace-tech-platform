import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{ensurePaymentReconciliationTables}from"../../../lib/grooming-payment-reconciliation";
import{issueGroomingInvoice,saveGroomingTaxPolicy}from"../../../lib/grooming-invoice";

type Row=Record<string,unknown>;

async function ensureTables(db:Awaited<ReturnType<typeof database>>){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);await ensurePaymentReconciliationTables(db);}

export async function GET(request:Request){try{
  await authorize(request,"finance.view");
  const db=await database();await ensureTables(db);
  const rows=await db.prepare(`SELECT b.id booking_id,b.customer_id,b.package_name,b.status booking_status,b.total_amount,b.currency,b.scheduled_start,b.updated_at,
    p.id payment_id,p.status payment_status,p.method payment_method,p.mode payment_mode,p.gateway,p.amount payment_amount,p.amount_due_now,
    i.id invoice_id,i.invoice_number,i.status invoice_status,i.gross_amount,i.tax_amount,i.net_amount,i.issued_at,
    s.plan_code subscription_plan,s.sessions_consumed subscription_sessions_consumed,s.status subscription_usage_status,
    r.environment reconciliation_environment,r.expected_amount,r.captured_amount,r.refunded_amount,r.gateway_status,r.reconciliation_status,r.variance_amount,r.last_event_id,
    (SELECT COUNT(*) FROM payment_reconciliation_exceptions x WHERE x.payment_id=p.id AND x.status='open') open_reconciliation_exceptions
    FROM canonical_bookings b
    JOIN booking_payments p ON p.booking_id=b.id
    LEFT JOIN booking_invoices i ON i.booking_id=b.id
    LEFT JOIN booking_subscription_usage s ON s.booking_id=b.id
    LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id
    WHERE b.service_code='grooming'
    ORDER BY b.updated_at DESC LIMIT 200`).all<Row>();
  const items=rows.results.map(row=>{
    const amount=Number(row.payment_amount||0),captured=Number(row.captured_amount||0),refunded=Number(row.refunded_amount||0),reconciliationStatus=String(row.reconciliation_status||"not_started");
    return{...row,receivable:Math.max(0,amount-captured),net_collected:Math.max(0,captured-refunded),reconciled:reconciliationStatus==="matched"&&Number(row.open_reconciliation_exceptions||0)===0,invoiced:Boolean(row.invoice_id)};
  });
  const summary=items.reduce((acc,item)=>{
    acc.bookings+=1;if(item.invoiced)acc.invoiced+=Number(item.net_amount||0);acc.collected+=Number(item.captured_amount||0);acc.refunded+=Number(item.refunded_amount||0);acc.receivable+=Number(item.receivable||0);if(item.reconciled)acc.reconciled+=1;if(String(item.reconciliation_status||"not_started")!=="matched")acc.unreconciled+=1;acc.exceptions+=Number(item.open_reconciliation_exceptions||0);if(String(item.booking_status)==="completed")acc.completed+=1;return acc;
  },{bookings:0,completed:0,invoiced:0,collected:0,refunded:0,receivable:0,reconciled:0,unreconciled:0,exceptions:0});
  const recentExceptions=await db.prepare("SELECT id,booking_id,payment_id,event_id,exception_type,severity,status,detail_json,created_at FROM payment_reconciliation_exceptions WHERE status='open' ORDER BY created_at DESC LIMIT 50").all<Row>();
  return Response.json({source:"canonical Grooming booking/payment/invoice/reconciliation ledger",summary,items,reconciliationExceptions:recentExceptions.results});
}catch(error){return authError(error,"Unable to load Grooming finance ledger");}}

export async function POST(request:Request){try{
  const body=await request.json() as Record<string,unknown>;
  const actor=await authorize(request,"finance.manage");
  const db=await database();await ensureTables(db);
  const action=String(body.action||""),reason=String(body.reason||"");
  let data:unknown;
  if(action==="save_tax_policy")data=await saveGroomingTaxPolicy(db,{cityId:String(body.cityId||"blr"),taxMode:String(body.taxMode||"") as"inclusive"|"exclusive",taxRate:Number(body.taxRate),effectiveFrom:String(body.effectiveFrom||new Date().toISOString().slice(0,10)),reason,actorId:actor.email});
  else if(action==="issue_invoice")data=await issueGroomingInvoice(db,{bookingId:String(body.bookingId||""),reason,actorId:actor.email});
  else return Response.json({error:"Unsupported Grooming finance action"},{status:400});
  await securityAudit(db,actor,`grooming.finance.${action}`,"grooming_finance",String(body.bookingId||body.cityId||"blr"),"completed",{liveMoney:false,executionMode:"sandbox_not_connected"});
  return Response.json({data});
}catch(error){return authError(error,"Unable to update Grooming finance ledger");}}
