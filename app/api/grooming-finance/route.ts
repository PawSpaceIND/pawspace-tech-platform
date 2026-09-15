import{authError,authorize,database,securityAudit}from"../../../lib/server-auth";
import{ensurePaymentReconciliationTables}from"../../../lib/grooming-payment-reconciliation";
import{ensureGroomingInvoiceTables,issueGroomingInvoice,saveGroomingTaxPolicy}from"../../../lib/grooming-invoice";

type Row=Record<string,unknown>;
type Db=Awaited<ReturnType<typeof database>>;

const groomingFinanceSchemaObjects=["canonical_bookings","booking_payments","booking_invoices","booking_subscription_usage","payment_gateway_links","payment_gateway_events","payment_reconciliation_records","payment_reconciliation_exceptions","post_service_payment_requests","idx_payment_gateway_links_payment_link"] as const;
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
]);await ensurePaymentReconciliationTables(db);}
async function ensureTables(db:Db){if(groomingFinanceTablesReady.has(db))return;const running=groomingFinanceTablesEnsuring.get(db);if(running)return running;const pending=ensureTablesUncached(db).then(()=>{groomingFinanceTablesReady.add(db);});groomingFinanceTablesEnsuring.set(db,pending);try{await pending;}finally{if(groomingFinanceTablesEnsuring.get(db)===pending)groomingFinanceTablesEnsuring.delete(db);}}


/* Captured and Receivable are payment-ledger facts; the reconciliation figures are reported BESIDE
 * them, never in place of them. [FIN-W1-D4]
 *
 * `captured` was read from payment_reconciliation_records.captured_amount through a LEFT JOIN and
 * `receivable` was payment_amount minus that. payment_reconciliation_records is empty on this
 * deployment - it is written by the gateway webhook receiver, which nothing has exercised - so every
 * captured payment counted as Rs 0 collected and 100% receivable. The screen read
 * "Invoiced Rs 0 · Captured Rs 0 · Refunded Rs 0 · Receivable Rs 9,594" over rows whose own Payment
 * column said `captured`, against booking_payments holding nine captured rows totalling Rs 20,793.
 *
 * The defect was never "the table is empty". It was that a figure meaning "captured AND confirmed
 * against the gateway statement" was labelled plain *Captured*, and *Receivable* was labelled as
 * money owed by customers when it was really money not yet reconciled. An operator reading it
 * believed Rs 9,594 was uncollected.
 *
 * So: `collected`/`receivable`/`captured_amount` now come from booking_payments - the same source and
 * the same status vocabulary lib/accounts-business-view.ts uses for the company-level receivable
 * (['captured','paid'], widened here by the two refund states, because a refunded payment was
 * captured first). The reconciliation figures keep their own names -
 * capturedPerReconciliation / reconciled_captured_amount / capturedAwaitingReconciliation - so
 * assurance coverage is still visible and still zero when it is zero. Every money figure names its
 * source in `basis`, and every row carries `captured_basis`; nothing was switched quietly. */
const CAPTURED_PAYMENT_STATUSES=new Set(["captured","paid","refunded","partially_refunded"]);
const REFUNDED_PAYMENT_STATUSES=new Set(["refunded","partially_refunded"]);
const round2=(value:number)=>Math.round(value*100)/100;
type FinanceSummary={bookings:number;completed:number;invoiced:number;collected:number;refunded:number;receivable:number;reconciled:number;unreconciled:number;exceptions:number;capturedPerPaymentLedger:number;capturedPerReconciliation:number;capturedAwaitingReconciliation:number;refundsPendingReconciliation:number;paymentsWithReconciliationRecord:number};
type FinanceSnapshot={source:string;summary:FinanceSummary;items:Record<string,unknown>[];reconciliationExceptions:Row[];basis:Record<string,string>;taxPolicies:Row[]};
// Finance GET is actor-independent after finance.view authorization. Coalesce only requests that overlap
// in time on the same D1 binding; the promise is removed immediately after settlement, so this is NOT a
// TTL/stale-data cache and the next read always observes subsequent finance writes.
const financeReads=new WeakMap<Db,Promise<FinanceSnapshot>>();
async function loadFinanceSnapshot(db:Db):Promise<FinanceSnapshot>{
 const running=financeReads.get(db);if(running)return running;
 const pending=(async()=>{await ensureTables(db);await ensureGroomingInvoiceTables(db);
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
    const amount=Number(row.payment_amount||0),paymentStatus=String(row.payment_status||"");
    // What the payment ledger says was collected - the same fact the row's own Payment column shows.
    const ledgerCaptured=CAPTURED_PAYMENT_STATUSES.has(paymentStatus)?amount:0;
    // What reconciliation has CONFIRMED against the gateway. null = no reconciliation record exists.
    const hasReconciliationRecord=row.reconciliation_status!=null||row.captured_amount!=null;
    const reconciledCaptured=hasReconciliationRecord?Number(row.captured_amount||0):null;
    const refunded=Number(row.refunded_amount||0),reconciliationStatus=String(row.reconciliation_status||"not_started");
    const reconciled=reconciliationStatus==="matched"&&Number(row.open_reconciliation_exceptions||0)===0;
    return{...row,
      captured_amount:round2(ledgerCaptured),captured_basis:"booking_payments.status+amount",
      reconciled_captured_amount:reconciledCaptured,reconciled_captured_basis:"payment_reconciliation_records.captured_amount",
      captured_awaiting_reconciliation:round2(reconciled?0:ledgerCaptured),
      refunded_amount:round2(refunded),refunded_basis:"payment_reconciliation_records.refunded_amount",
      refund_amount_unknown:REFUNDED_PAYMENT_STATUSES.has(paymentStatus)&&!hasReconciliationRecord,
      receivable:round2(Math.max(0,amount-ledgerCaptured)),net_collected:round2(Math.max(0,ledgerCaptured-refunded)),
      reconciled,invoiced:Boolean(row.invoice_id)};
  });
  const summary=items.reduce((acc:FinanceSummary,item)=>{
    acc.bookings+=1;if(item.invoiced)acc.invoiced+=Number(item.net_amount||0);acc.collected+=Number(item.captured_amount||0);acc.refunded+=Number(item.refunded_amount||0);acc.receivable+=Number(item.receivable||0);if(item.reconciled)acc.reconciled+=1;if(String(item.reconciliation_status||"not_started")!=="matched")acc.unreconciled+=1;acc.exceptions+=Number(item.open_reconciliation_exceptions||0);if(String(item.booking_status)==="completed")acc.completed+=1;
    acc.capturedPerPaymentLedger+=Number(item.captured_amount||0);acc.capturedPerReconciliation+=Number(item.reconciled_captured_amount||0);acc.capturedAwaitingReconciliation+=Number(item.captured_awaiting_reconciliation||0);
    if(item.reconciled_captured_amount!=null)acc.paymentsWithReconciliationRecord+=1;if(item.refund_amount_unknown)acc.refundsPendingReconciliation+=1;return acc;
  },{bookings:0,completed:0,invoiced:0,collected:0,refunded:0,receivable:0,reconciled:0,unreconciled:0,exceptions:0,capturedPerPaymentLedger:0,capturedPerReconciliation:0,capturedAwaitingReconciliation:0,refundsPendingReconciliation:0,paymentsWithReconciliationRecord:0});
  for(const key of ["invoiced","collected","refunded","receivable","capturedPerPaymentLedger","capturedPerReconciliation","capturedAwaitingReconciliation"] as const)summary[key]=round2(summary[key]);
  /* The published city GST policy, so the screen that publishes it can also SHOW it. Without this the
   * only way to know whether `blr` was inclusive or exclusive - the difference between every assisted
   * order succeeding and every one of them being refused - was to read the database. [R3-C/F8] */
  const taxPolicies=(await db.prepare("SELECT city_id,tax_mode,tax_rate,status,version,effective_from,updated_by,reason,updated_at FROM grooming_tax_policies ORDER BY city_id").all<Row>().catch(()=>({results:[] as Row[]}))).results;
  return{source:"canonical Grooming booking/payment/invoice ledger · Captured and Receivable from booking_payments; reconciliation reported separately",summary,items,reconciliationExceptions:recentExceptions,taxPolicies,
    basis:{
      invoiced:"booking_invoices.net_amount where an invoice has been issued",
      collected:"booking_payments.amount where status is captured/paid/refunded/partially_refunded - the money the payment ledger says reached PawSpace",
      receivable:"booking_payments.amount not in a captured status - money still owed, NOT money awaiting reconciliation",
      refunded:"payment_reconciliation_records.refunded_amount; refundsPendingReconciliation counts refunded payments whose amount no reconciliation record states",
      capturedPerReconciliation:"payment_reconciliation_records.captured_amount - gateway-confirmed only; 0 while nothing has been reconciled",
      capturedAwaitingReconciliation:"captured per the payment ledger but not yet matched against the gateway statement - the assurance gap, not a receivable",
    }};
 })().finally(()=>{if(financeReads.get(db)===pending)financeReads.delete(db);});
 financeReads.set(db,pending);return pending;
}

export async function GET(request:Request){try{
  await authorize(request,"finance.view");
  const db=await database();
  return Response.json(await loadFinanceSnapshot(db));
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
