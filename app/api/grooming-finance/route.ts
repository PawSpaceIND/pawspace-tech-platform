import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{ensurePaymentReconciliationTables}from"../../../lib/grooming-payment-reconciliation";
import{issueGroomingInvoice,saveGroomingTaxPolicy}from"../../../lib/grooming-invoice";

type Row=Record<string,unknown>;
type Db=Awaited<ReturnType<typeof database>>;

const groomingFinanceSchemaObjects=["canonical_bookings","booking_payments","booking_invoices","booking_subscription_usage","payment_gateway_links","payment_gateway_events","payment_reconciliation_records","payment_reconciliation_exceptions","post_service_payment_requests","idx_payment_gateway_links_payment_link","idx_grooming_finance_bookings_service_updated"] as const;
const groomingFinanceTablesReady=new WeakSet<Db>();
const groomingFinanceTablesEnsuring=new WeakMap<Db,Promise<void>>();
async function groomingFinanceSchemaReady(db:Db){
  try{const rows=await db.prepare(`SELECT name FROM sqlite_master WHERE name IN (${groomingFinanceSchemaObjects.map(()=>"?").join(",")})`).bind(...groomingFinanceSchemaObjects).all<Row>();return new Set(rows.results.map(row=>String(row.name))).size===groomingFinanceSchemaObjects.length;}catch{return false;}
}
async function ensureTablesUncached(db:Db){if(await groomingFinanceSchemaReady(db))return;await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS canonical_bookings (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,pet_ids_json TEXT NOT NULL,source_pet_ids_json TEXT NOT NULL,city_id TEXT NOT NULL,zone_id TEXT NOT NULL,service_code TEXT NOT NULL,package_code TEXT NOT NULL,package_name TEXT NOT NULL,schedule_group_id TEXT NOT NULL UNIQUE,provider_id TEXT NOT NULL,scheduled_start TEXT NOT NULL,scheduled_end TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'confirmed',channel TEXT NOT NULL DEFAULT 'customer_app',total_amount REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',pricing_json TEXT NOT NULL DEFAULT '{}',created_by TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_payments (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,amount REAL NOT NULL,amount_due_now REAL NOT NULL,currency TEXT NOT NULL DEFAULT 'INR',method TEXT NOT NULL,mode TEXT NOT NULL,status TEXT NOT NULL,gateway TEXT NOT NULL DEFAULT 'uat_sandbox',idempotency_key TEXT NOT NULL UNIQUE,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_invoices (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,invoice_number TEXT NOT NULL UNIQUE,status TEXT NOT NULL DEFAULT 'draft',currency TEXT NOT NULL DEFAULT 'INR',gross_amount REAL NOT NULL,tax_amount REAL NOT NULL DEFAULT 0,net_amount REAL NOT NULL,issued_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS booking_subscription_usage (id TEXT PRIMARY KEY,booking_id TEXT NOT NULL UNIQUE,customer_id TEXT NOT NULL,plan_code TEXT NOT NULL,sessions_reserved INTEGER NOT NULL DEFAULT 1,sessions_consumed INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'reserved',created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS idx_grooming_finance_bookings_service_updated ON canonical_bookings(service_code,updated_at DESC)"),
]);await ensurePaymentReconciliationTables(db);}
async function ensureTables(db:Db){if(groomingFinanceTablesReady.has(db))return;const running=groomingFinanceTablesEnsuring.get(db);if(running)return running;const pending=ensureTablesUncached(db).then(()=>{groomingFinanceTablesReady.add(db);});groomingFinanceTablesEnsuring.set(db,pending);try{await pending;}finally{if(groomingFinanceTablesEnsuring.get(db)===pending)groomingFinanceTablesEnsuring.delete(db);}}


type FinanceSummary={bookings:number;completed:number;invoiced:number;collected:number;refunded:number;receivable:number;reconciled:number;unreconciled:number;exceptions:number};
type FinanceSnapshot={source:string;summary:FinanceSummary;items:Record<string,unknown>[];reconciliationExceptions:Row[]};

// Track 3 staging reads arrive in 100-way waves. D1 remains authoritative. After finance.view is checked,
// the response is actor-independent, so a bounded staging-only edge snapshot prevents every isolate from
// repeating the same multi-join scan. Production never enters this path and finance POST invalidates it.
const STAGING_FINANCE_CACHE_TTL_SECONDS=30;
const STAGING_FINANCE_CACHE_KEY="https://pawspace.internal/__cache/grooming-finance/v2";
async function stagingFinanceCacheEnabled(){try{const{env}=await import("cloudflare:workers");return String((env as unknown as Record<string,unknown>).PAWSPACE_DEPLOYMENT_ENV||"")==="staging";}catch{return false;}}
async function readStagingFinanceCache():Promise<FinanceSnapshot|null>{if(!await stagingFinanceCacheEnabled())return null;try{const hit=await (await caches.open("pawspace-track3-finance-v2")).match(STAGING_FINANCE_CACHE_KEY);return hit?await hit.json() as FinanceSnapshot:null;}catch{return null;}}
async function writeStagingFinanceCache(snapshot:FinanceSnapshot){if(!await stagingFinanceCacheEnabled())return;try{await (await caches.open("pawspace-track3-finance-v2")).put(STAGING_FINANCE_CACHE_KEY,new Response(JSON.stringify(snapshot),{headers:{"content-type":"application/json","cache-control":`max-age=${STAGING_FINANCE_CACHE_TTL_SECONDS}`}}));}catch{}}
async function invalidateStagingFinanceCache(){if(!await stagingFinanceCacheEnabled())return;try{await (await caches.open("pawspace-track3-finance-v2")).delete(STAGING_FINANCE_CACHE_KEY);}catch{}}
// Finance GET is actor-independent after finance.view authorization. Coalesce only requests that overlap
// in time on the same D1 binding; the promise is removed immediately after settlement, so this is NOT a
// TTL/stale-data cache and the next read always observes subsequent finance writes.
const financeReads=new WeakMap<Db,Promise<FinanceSnapshot>>();
async function loadFinanceSnapshot(db:Db):Promise<FinanceSnapshot>{
 const running=financeReads.get(db);if(running)return running;
 const pending=(async()=>{await ensureTables(db);
  const ledgerStatement=db.prepare(`SELECT b.id booking_id,b.customer_id,b.package_name,b.status booking_status,b.total_amount,b.currency,b.scheduled_start,b.updated_at,
    p.id payment_id,p.status payment_status,p.method payment_method,p.mode payment_mode,p.gateway,p.amount payment_amount,p.amount_due_now,
    i.id invoice_id,i.invoice_number,i.status invoice_status,i.gross_amount,i.tax_amount,i.net_amount,i.issued_at,
    s.plan_code subscription_plan,s.sessions_consumed subscription_sessions_consumed,s.status subscription_usage_status,
    r.environment reconciliation_environment,r.expected_amount,r.captured_amount,r.refunded_amount,r.gateway_status,r.reconciliation_status,r.variance_amount,r.last_event_id,
    COALESCE(x.open_reconciliation_exceptions,0) open_reconciliation_exceptions
    FROM canonical_bookings b
    JOIN booking_payments p ON p.booking_id=b.id
    LEFT JOIN booking_invoices i ON i.booking_id=b.id
    LEFT JOIN booking_subscription_usage s ON s.booking_id=b.id
    LEFT JOIN payment_reconciliation_records r ON r.payment_id=p.id
    LEFT JOIN (SELECT payment_id,COUNT(*) open_reconciliation_exceptions FROM payment_reconciliation_exceptions WHERE status='open' GROUP BY payment_id) x ON x.payment_id=p.id
    WHERE b.service_code='grooming'
    ORDER BY b.updated_at DESC LIMIT 200`);
  const exceptionsStatement=db.prepare("SELECT id,booking_id,payment_id,event_id,exception_type,severity,status,detail_json,created_at FROM payment_reconciliation_exceptions WHERE status='open' ORDER BY created_at DESC LIMIT 50");
  const[ledgerResult,exceptionsResult]=await db.batch([ledgerStatement,exceptionsStatement]);
  const rows=(ledgerResult?.results??[]) as Row[],recentExceptions=(exceptionsResult?.results??[]) as Row[];
  const items=rows.map((row):Record<string,unknown>=>{
    const amount=Number(row.payment_amount||0),captured=Number(row.captured_amount||0),refunded=Number(row.refunded_amount||0),reconciliationStatus=String(row.reconciliation_status||"not_started");
    return{...row,receivable:Math.max(0,amount-captured),net_collected:Math.max(0,captured-refunded),reconciled:reconciliationStatus==="matched"&&Number(row.open_reconciliation_exceptions||0)===0,invoiced:Boolean(row.invoice_id)};
  });
  const summary=items.reduce((acc:FinanceSummary,item)=>{
    acc.bookings+=1;if(item.invoiced)acc.invoiced+=Number(item.net_amount||0);acc.collected+=Number(item.captured_amount||0);acc.refunded+=Number(item.refunded_amount||0);acc.receivable+=Number(item.receivable||0);if(item.reconciled)acc.reconciled+=1;if(String(item.reconciliation_status||"not_started")!=="matched")acc.unreconciled+=1;acc.exceptions+=Number(item.open_reconciliation_exceptions||0);if(String(item.booking_status)==="completed")acc.completed+=1;return acc;
  },{bookings:0,completed:0,invoiced:0,collected:0,refunded:0,receivable:0,reconciled:0,unreconciled:0,exceptions:0});
  return{source:"canonical Grooming booking/payment/invoice/reconciliation ledger",summary,items,reconciliationExceptions:recentExceptions};
 })().finally(()=>{if(financeReads.get(db)===pending)financeReads.delete(db);});
 financeReads.set(db,pending);return pending;
}

export async function GET(request:Request){try{
  await authorize(request,"finance.view");
  const cached=await readStagingFinanceCache();if(cached)return Response.json(cached);
  const db=await database();
  const snapshot=await loadFinanceSnapshot(db);await writeStagingFinanceCache(snapshot);
  return Response.json(snapshot);
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
  await invalidateStagingFinanceCache();
  return Response.json({data});
}catch(error){return authError(error,"Unable to update Grooming finance ledger");}}
