import{authError,authorize,database}from"../../../lib/server-auth";

type Row=Record<string,unknown>;

async function ensureTables(db:Awaited<ReturnType<typeof database>>){await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
]);}

export async function GET(request:Request){try{
  await authorize(request,"finance.view");
  const db=await database();await ensureTables(db);
  const rows=await db.prepare(`SELECT b.id booking_id,b.customer_id,b.package_name,b.status booking_status,b.total_amount,b.currency,b.scheduled_start,b.updated_at,
    p.id payment_id,p.status payment_status,p.method payment_method,p.mode payment_mode,p.gateway,p.amount payment_amount,p.amount_due_now,
    i.id invoice_id,i.invoice_number,i.status invoice_status,i.gross_amount,i.tax_amount,i.net_amount,i.issued_at,
    s.plan_code subscription_plan,s.sessions_consumed subscription_sessions_consumed,s.status subscription_usage_status
    FROM canonical_bookings b
    JOIN booking_payments p ON p.booking_id=b.id
    LEFT JOIN booking_invoices i ON i.booking_id=b.id
    LEFT JOIN booking_subscription_usage s ON s.booking_id=b.id
    WHERE b.service_code='grooming'
    ORDER BY b.updated_at DESC LIMIT 200`).all<Row>();
  const items=rows.results.map(row=>({
    ...row,
    receivable:Number(row.payment_amount||0)-(String(row.payment_status)==="captured"?Number(row.payment_amount||0):0),
    reconciled:String(row.payment_status)==="captured",
    invoiced:Boolean(row.invoice_id),
  }));
  const summary=items.reduce((acc,item)=>{
    const amount=Number(item.payment_amount||0);
    acc.bookings+=1;
    if(item.invoiced)acc.invoiced+=Number(item.net_amount||0);
    if(item.reconciled)acc.collected+=amount;else acc.receivable+=amount;
    if(String(item.booking_status)==="completed")acc.completed+=1;
    return acc;
  },{bookings:0,completed:0,invoiced:0,collected:0,receivable:0});
  return Response.json({source:"canonical grooming ledger",summary,items});
}catch(error){return authError(error,"Unable to load Grooming finance ledger");}}
