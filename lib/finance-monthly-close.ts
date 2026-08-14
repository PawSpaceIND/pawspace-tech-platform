// Monthly finance close: one governed checklist per calendar month, computed from REAL platform
// data, gated by the founder's monthly board approval, and locked once closed.
//   revenue        - delivered (completed) and committed (booked, not yet delivered), reported apart
//   gst            - output tax from finance_invoices, eligible input tax from finance_bills via
//                    approved vendor reviews; GSTR-3B net payable = output - eligible input
//   tds            - the month's computed TDS liability + deposit status (lib/tds-governance)
//   payroll        - the month's payroll run status
//   board approval - lib/statutory-compliance board_approvals
// Close lifecycle: open -> ready (all checks green) -> closed (locked; audit event). Re-closing a
// locked month is refused - corrections happen in the next period, matching accounting practice.

import{computeMonthlyTds}from"./tds-governance";
import{ensureStatutoryTables,getBoardApproval}from"./statutory-compliance";

type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(value:number)=>Math.round(value*100)/100;

const closeTablesEnsured=new WeakSet<Db>();
export async function ensureMonthlyCloseTables(db:Db){
 if(closeTablesEnsured.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS finance_monthly_closes (period TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'open',snapshot_json TEXT NOT NULL DEFAULT '{}',closed_by TEXT,closed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_close_events (id TEXT PRIMARY KEY,period TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
 ]);
 closeTablesEnsured.add(db);
}

function monthWindow(period:string):{startMs:number;endMs:number;startDate:string;endDate:string}{
 const[year,month]=period.split("-").map(Number);
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw new Response("Close period must be YYYY-MM",{status:400});
 const next=month===12?{y:year+1,m:1}:{y:year,m:month+1};
 return{startMs:Date.UTC(year,month-1,1)-330*60_000,endMs:Date.UTC(next.y,next.m-1,1)-330*60_000,startDate:`${year}-${String(month).padStart(2,"0")}-01`,endDate:`${next.y}-${String(next.m).padStart(2,"0")}-01`};
}

async function safeFirst(db:Db,sql:string,bindings:unknown[]=[]){
 try{let statement=db.prepare(sql);if(bindings.length)statement=statement.bind(...bindings);return await statement.first<Row>();}catch{return null;}
}

export type CloseChecklistItem={key:string;label:string;ok:boolean;value:number|string|null;detail:string};
export type MonthlyCloseView={period:string;status:"open"|"ready"|"closed";checklist:CloseChecklistItem[];revenue:{delivered:number;deliveredCount:number;committed:number;committedCount:number;bookings:number;bookingCount:number;foodOrders:number;foodOrderCount:number;total:number};gst:{outputTax:number;eligibleInputTax:number;netPayable:number;invoiceCount:number};tds:{total:number;sections:Record<string,{base:number;tds:number;deductees:number}>;deposited:boolean;depositDueDate:string};payroll:{runStatus:string|null;employees:number;grossTotal:number};boardApproval:{approved:boolean;approvedBy:string|null;approvedAt:number|null};closedBy:string|null;closedAt:number|null};

/** Build (or rebuild) the month's close view from real data. Never mutates a locked close. */
export async function monthlyCloseView(db:Db,input:{period:string;actorId:string;asOf?:number}):Promise<MonthlyCloseView>{
 await ensureMonthlyCloseTables(db);await ensureStatutoryTables(db);
 const{startMs,endMs,startDate,endDate}=monthWindow(input.period);

 const stored=await db.prepare("SELECT * FROM finance_monthly_closes WHERE period=?").bind(input.period).first<Row>();
 if(stored&&String(stored.status)==="closed"){
  const snapshot=JSON.parse(String(stored.snapshot_json||"{}")) as MonthlyCloseView;
  return{...snapshot,status:"closed",closedBy:stored.closed_by?String(stored.closed_by):null,closedAt:stored.closed_at?Number(stored.closed_at):null};
 }

 // Revenue: service bookings (scheduled in the month, not cancelled) + food orders (created in month).
 // Revenue is reported as TWO figures, not one. This asked for `status NOT IN ('cancelled','refunded')`
 // and called the result revenue, so 58% of the number the board approved was work that had been booked
 // and not yet delivered - and, because the filter was a denylist of two, it also counted a booking the
 // customer never confirmed (draft, pending), one the provider never accepted (awaiting_*), and one where
 // nobody turned up (no_show). Founder's decision, recorded on task #37: split delivered from committed,
 // and drop the four that are not revenue on any basis.
 //
 // Deliberately an ALLOWLIST now. The denylist was the defect: every status added to the product since
 // became revenue by default, silently, which is how no_show came to be counted.
 const DELIVERED="('completed')";
 const COMMITTED="('confirmed','in_progress')";
 const delivered=await safeFirst(db,`SELECT COALESCE(SUM(total_amount),0) total,COUNT(*) count FROM canonical_bookings WHERE scheduled_start>=? AND scheduled_start<? AND status IN ${DELIVERED}`,[startDate,endDate]);
 const committed=await safeFirst(db,`SELECT COALESCE(SUM(total_amount),0) total,COUNT(*) count FROM canonical_bookings WHERE scheduled_start>=? AND scheduled_start<? AND status IN ${COMMITTED}`,[startDate,endDate]);
 // Food orders keep their own vocabulary: 'delivered' is the terminal state. The four booking statuses
 // above were a decision about BOOKING statuses and are not extended here - food's statuses
 // (reserved, picked, packed, revoked, ops_review_required, stock_recovery_required) need their own
 // call, so the split changes how food revenue is PRESENTED without changing which rows count.
 const foodDelivered=await safeFirst(db,"SELECT COALESCE(SUM(total_amount),0) total,COUNT(*) count FROM food_orders WHERE created_at>=? AND created_at<? AND status='delivered'",[startMs,endMs]);
 const foodCommitted=await safeFirst(db,"SELECT COALESCE(SUM(total_amount),0) total,COUNT(*) count FROM food_orders WHERE created_at>=? AND created_at<? AND status NOT IN ('cancelled','refunded','delivered')",[startMs,endMs]);

 const revenue={
  delivered:round2(Number(delivered?.total||0)+Number(foodDelivered?.total||0)),
  deliveredCount:Number(delivered?.count||0)+Number(foodDelivered?.count||0),
  committed:round2(Number(committed?.total||0)+Number(foodCommitted?.total||0)),
  committedCount:Number(committed?.count||0)+Number(foodCommitted?.count||0),
  // Kept so the two halves stay separable per stream on the screen.
  bookings:round2(Number(delivered?.total||0)+Number(committed?.total||0)),
  bookingCount:Number(delivered?.count||0)+Number(committed?.count||0),
  foodOrders:round2(Number(foodDelivered?.total||0)+Number(foodCommitted?.total||0)),
  foodOrderCount:Number(foodDelivered?.count||0)+Number(foodCommitted?.count||0),
  total:0,
 };
 revenue.total=round2(revenue.delivered+revenue.committed);

 // GST: output tax from issued invoices in the month; input tax only where the vendor review
 // approved eligibility (never claim unreviewed input credit).
 const output=await safeFirst(db,"SELECT COALESCE(SUM(tax_total),0) tax,COUNT(*) count FROM finance_invoices WHERE issue_date>=? AND issue_date<? AND status!='cancelled'",[startDate,endDate]);
 const input_=await safeFirst(db,"SELECT COALESCE(SUM(r.eligible_tax_amount),0) tax FROM finance_vendor_tax_reviews r JOIN finance_bills b ON b.id=r.bill_id WHERE r.review_status='approved' AND b.bill_date>=? AND b.bill_date<?",[startDate,endDate]);
 const gst={outputTax:round2(Number(output?.tax||0)),eligibleInputTax:round2(Number(input_?.tax||0)),netPayable:0,invoiceCount:Number(output?.count||0)};
 gst.netPayable=round2(Math.max(0,gst.outputTax-gst.eligibleInputTax));

 // TDS: recompute from source data (idempotent), then check the deposit.
 const tds=await computeMonthlyTds(db,{period:input.period,actorId:input.actorId,asOf:input.asOf});
 const deposit=await safeFirst(db,"SELECT amount FROM tds_deposits WHERE period=?",[input.period]);

 // Payroll: the month's run status.
 const run=await safeFirst(db,"SELECT p.status,COUNT(r.id) employees,COALESCE(SUM(r.gross_earnings),0) gross FROM payroll_runs p LEFT JOIN employee_payroll_results r ON r.run_id=p.id WHERE p.period_start<? AND p.period_end>? GROUP BY p.id ORDER BY p.period_start DESC LIMIT 1",[endMs,startMs]);
 const payroll={runStatus:run?String(run.status):null,employees:Number(run?.employees||0),grossTotal:round2(Number(run?.gross||0))};

 const approval=await getBoardApproval(db,input.period);
 const boardApproval={approved:Boolean(approval),approvedBy:approval?.approvedBy??null,approvedAt:approval?.approvedAt??null};

 const checklist:CloseChecklistItem[]=[
  {key:"revenue_reconciled",label:"Revenue split: delivered vs committed but not yet delivered",ok:true,value:revenue.total,detail:`delivered ${revenue.deliveredCount} for ${revenue.delivered}; committed ${revenue.committedCount} for ${revenue.committed}`},
  {key:"gst_computed",label:"GSTR-3B net payable computed (output - eligible input)",ok:true,value:gst.netPayable,detail:`output ${gst.outputTax} - eligible input ${gst.eligibleInputTax}`},
  {key:"tds_computed",label:"TDS liability computed from payroll + payouts",ok:true,value:tds.totalTds,detail:Object.entries(tds.sections).map(([section,bucket])=>`${section}: ${bucket.tds}`).join(" · ")||"no deductions this month"},
  {key:"tds_deposited",label:`TDS deposited (due ${tds.depositDueDate})`,ok:tds.totalTds===0||Boolean(deposit),value:deposit?round2(Number(deposit.amount)):null,detail:tds.totalTds===0?"no liability":deposit?"challan recorded":"deposit pending"},
  {key:"payroll_finalised",label:"Payroll run approved for the month",ok:payroll.runStatus==null||["approved","payment_prepared","completed"].includes(String(payroll.runStatus)),value:payroll.runStatus,detail:payroll.runStatus?`${payroll.employees} employees · gross ${payroll.grossTotal}`:"no payroll run in this month (acceptable for pre-payroll months)"},
  {key:"board_approved",label:"Monthly board approval recorded (founder policy)",ok:boardApproval.approved,value:boardApproval.approvedBy,detail:boardApproval.approved?`approved by ${boardApproval.approvedBy}`:"board approval pending - required before close"},
 ];
 const status:"open"|"ready"=checklist.every(item=>item.ok)?"ready":"open";
 const view:MonthlyCloseView={period:input.period,status,checklist,revenue,gst,tds:{total:tds.totalTds,sections:tds.sections,deposited:Boolean(deposit)||tds.totalTds===0,depositDueDate:tds.depositDueDate},payroll,boardApproval,closedBy:null,closedAt:null};
 const now=input.asOf??Date.now();
 await db.prepare("INSERT INTO finance_monthly_closes (period,status,snapshot_json,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(period) DO UPDATE SET status=excluded.status,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at")
  .bind(input.period,status,JSON.stringify(view),now,now).run();
 return view;
}

/** Lock the month. Requires every checklist item green (including board approval). Idempotent-safe:
 *  a second close attempt on a locked month is refused with 409. */
export async function closeMonth(db:Db,input:{period:string;actorId:string;asOf?:number}){
 await ensureMonthlyCloseTables(db);
 const existing=await db.prepare("SELECT status FROM finance_monthly_closes WHERE period=?").bind(input.period).first<Row>();
 if(existing&&String(existing.status)==="closed")throw new Response(`${input.period} is already closed and locked; post corrections in the next open period`,{status:409});
 const view=await monthlyCloseView(db,input);
 if(view.status!=="ready"){
  const blocking=view.checklist.filter(item=>!item.ok).map(item=>item.key);
  throw new Response(`Close blocked - unresolved checklist items: ${blocking.join(", ")}`,{status:409});
 }
 const now=input.asOf??Date.now();
 const result=await db.prepare("UPDATE finance_monthly_closes SET status='closed',closed_by=?,closed_at=?,snapshot_json=?,updated_at=? WHERE period=? AND status!='closed'")
  .bind(input.actorId,now,JSON.stringify({...view,status:"closed",closedBy:input.actorId,closedAt:now}),now,input.period).run();
 if(!Number(result.meta.changes))throw new Response(`${input.period} is already closed and locked`,{status:409});
 await db.prepare("INSERT INTO finance_close_events (id,period,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)")
  .bind(`FCE-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.period,"closed",input.actorId,JSON.stringify({revenue:view.revenue.total,revenueDelivered:view.revenue.delivered,revenueCommitted:view.revenue.committed,gstNetPayable:view.gst.netPayable,tds:view.tds.total}),now).run();
 return{period:input.period,status:"closed" as const,closedBy:input.actorId,closedAt:now};
}
