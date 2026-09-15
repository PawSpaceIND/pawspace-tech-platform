// Monthly finance close: one governed checklist per calendar month, computed from REAL platform
// data, gated by the founder's monthly board approval, and locked once closed.
//   revenue        - canonical_bookings totals + food orders for the month
//   gst            - PawSpace's OWN output tax (B2B ledger + the commission/principal share of service
//                    verticals; the provider-supply GST collected on their behalf is disclosed but goes to
//                    s52 TCS/GSTR-8, not here), eligible input tax from finance_bills via approved vendor
//                    reviews; GSTR-3B net payable = own output - eligible input
//   tds            - the month's computed TDS liability + deposit status (lib/tds-governance)
//   payroll        - the runs ATTRIBUTED to the month (lib/tds-governance payrollRunPeriod: exactly
//                    one month per run, the month containing the pay period's midpoint)
//   board approval - lib/statutory-compliance board_approvals
// Close lifecycle: open -> ready (all checks green) -> closed (locked; audit event). Re-closing a
// locked month is refused - corrections happen in the next period, matching accounting practice.
//
// monthlyCloseView is a READ. [FIN-W1-D2]
// It used to upsert the finance_monthly_closes snapshot and run a destructive TDS recompute on every
// call, so `GET /api/statutory-compliance?period=2026-08` mutated the database - two consecutive
// plain GETs moved finance_monthly_closes.updated_at twice - and re-created tds_deductions from
// scratch, discarding any PAN verification with it. Persisting is now opt-in (`persist:true`), taken
// only by closeMonth, which is an explicit operator action; the recompute behind it is an idempotent
// upsert (lib/tds-governance). The only statements a plain view still issues are the CREATE TABLE IF
// NOT EXISTS ensures, which a cold database needs and which change no row.

import{computeMonthlyTds,payrollRunsForPeriod}from"./tds-governance";
import{ensureStatutoryTables,getBoardApproval}from"./statutory-compliance";
import{serviceVerticalOutputTax}from"./service-output-tax";
import{outputTaxAdjustments}from"./gst-accounting";
import{governedJsonError}from"./governed-http-error";

/* Every refusal below is the operator's own action being declined - a month that is already locked, a
 * checklist that is not green, a malformed period - so each is raised with governedJsonError(). An
 * ungoverned `new Response(...)` keeps its 409 but authError() replaces its body with the route's
 * fallback, so "Close & lock month" reported "Unable to complete the statutory compliance action"
 * whether the checklist was incomplete or the platform had actually broken. Statuses and message text
 * are unchanged; the only difference is that the reason now survives the trip out. */

type Db=D1Database;
type Row=Record<string,unknown>;
const round2=(value:number)=>Math.round(value*100)/100;

const closeTablesEnsured=new WeakSet<Db>();
export async function ensureMonthlyCloseTables(db:Db){
 if(closeTablesEnsured.has(db))return;
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS finance_monthly_closes (period TEXT PRIMARY KEY,status TEXT NOT NULL DEFAULT 'open',snapshot_json TEXT NOT NULL DEFAULT '{}',closed_by TEXT,closed_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_close_events (id TEXT PRIMARY KEY,period TEXT NOT NULL,event_type TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS finance_close_periods (period_code text PRIMARY KEY NOT NULL,status text DEFAULT 'open' NOT NULL,checklist_json text NOT NULL,locked_at integer,locked_by text,updated_at integer NOT NULL)"),
 ]);
 closeTablesEnsured.add(db);
}

function monthWindow(period:string):{startMs:number;endMs:number;startDate:string;endDate:string}{
 const[year,month]=period.split("-").map(Number);
 if(!Number.isInteger(year)||!Number.isInteger(month)||month<1||month>12)throw governedJsonError({error:"Close period must be YYYY-MM"},400);
 const next=month===12?{y:year+1,m:1}:{y:year,m:month+1};
 return{startMs:Date.UTC(year,month-1,1)-330*60_000,endMs:Date.UTC(next.y,next.m-1,1)-330*60_000,startDate:`${year}-${String(month).padStart(2,"0")}-01`,endDate:`${next.y}-${String(next.m).padStart(2,"0")}-01`};
}

async function safeFirst(db:Db,sql:string,bindings:unknown[]=[]){
 try{let statement=db.prepare(sql);if(bindings.length)statement=statement.bind(...bindings);return await statement.first<Row>();}catch{return null;}
}

export type CloseChecklistItem={key:string;label:string;ok:boolean;value:number|string|null;detail:string};
export type MonthlyCloseView={period:string;status:"open"|"ready"|"closed";checklist:CloseChecklistItem[];revenue:{bookings:number;bookingCount:number;foodOrders:number;foodOrderCount:number;total:number};gst:{outputTax:number;eligibleInputTax:number;netPayable:number;adjustments?:number;invoiceCount:number;taxCollectedFromCustomers?:number;providerSupplyGstCollectedOnBehalf?:number};tds:{total:number;sections:Record<string,{base:number;tds:number;deductees:number}>;deposited:boolean;depositDueDate:string};payroll:{runStatus:string|null;employees:number;grossTotal:number;runCount:number;runIds:string[];allFinalised:boolean};boardApproval:{approved:boolean;approvedBy:string|null;approverRole?:string|null;approvedAt:number|null};closedBy:string|null;closedAt:number|null};

/** Build the month's close view from real data. READ-ONLY unless `persist` is explicitly true; never
 *  mutates a locked close. */
export async function monthlyCloseView(db:Db,input:{period:string;actorId:string;asOf?:number;persist?:boolean}):Promise<MonthlyCloseView>{
 await ensureMonthlyCloseTables(db);await ensureStatutoryTables(db);
 const{startMs,endMs,startDate,endDate}=monthWindow(input.period);

 const stored=await db.prepare("SELECT * FROM finance_monthly_closes WHERE period=?").bind(input.period).first<Row>();
 if(stored&&String(stored.status)==="closed"){
  const snapshot=JSON.parse(String(stored.snapshot_json||"{}")) as MonthlyCloseView;
  return{...snapshot,status:"closed",closedBy:stored.closed_by?String(stored.closed_by):null,closedAt:stored.closed_at?Number(stored.closed_at):null};
 }

 // Revenue: service bookings (scheduled in the month, not cancelled) + food orders (created in month).
 const bookings=await safeFirst(db,"SELECT COALESCE(SUM(total_amount),0) total,COUNT(*) count FROM canonical_bookings WHERE scheduled_start>=? AND scheduled_start<? AND status NOT IN ('cancelled','refunded')",[startDate,endDate]);
 const food=await safeFirst(db,"SELECT COALESCE(SUM(total_amount),0) total,COUNT(*) count FROM food_orders WHERE created_at>=? AND created_at<? AND status NOT IN ('cancelled','refunded')",[startMs,endMs]);
 const revenue={bookings:round2(Number(bookings?.total||0)),bookingCount:Number(bookings?.count||0),foodOrders:round2(Number(food?.total||0)),foodOrderCount:Number(food?.count||0),total:0};
 revenue.total=round2(revenue.bookings+revenue.foodOrders);

 // GST: output tax from issued invoices in the month; input tax only where the vendor review
 // approved eligibility (never claim unreviewed input credit).
 const output=await safeFirst(db,"SELECT COALESCE(SUM(tax_total),0) tax,COUNT(*) count FROM finance_invoices WHERE issue_date>=? AND issue_date<? AND status!='cancelled'",[startDate,endDate]);
 const input_=await safeFirst(db,"SELECT COALESCE(SUM(r.eligible_tax_amount),0) tax FROM finance_vendor_tax_reviews r JOIN finance_bills b ON b.id=r.bill_id WHERE r.review_status='eligible' AND b.bill_date>=? AND b.bill_date<?",[startDate,endDate]);
 // Output tax has TWO sources and the close only ever read one. finance_invoices is written solely by
 // the B2B module (lib/gst-accounting.ts); all five service invoice modules - sitting, boarding,
 // walking, taxi, grooming - write their tax into booking_invoices.tax_amount. Reading only the first
 // made GST output structurally zero for the entire service business, and safeFirst turned the empty
 // source into 0 rather than an error, so the month closed and locked with GSTR-3B net payable
 // published as 0 under a GREEN gst_computed check. The two tables are disjoint - a B2B invoice is
 // never a booking invoice - so their tax sums and nothing is counted twice. No tax rule is decided
 // here: each invoice's own tax_amount, computed by the module that issued it, is simply included.
 // Of the service-vertical GST collected, only PawSpace's OWN output GST (commission/principal) is its
 // GSTR-3B net-payable liability; the provider-supply GST collected on their behalf is a separate
 // pass-through (remitted via s52 GST TCS / GSTR-8), disclosed but NOT part of PawSpace's net payable.
 const serviceOutput=await serviceVerticalOutputTax(db,startMs,endMs);
 // [R3-D/F3] A credit note reduces the tax owed for the period it adjusts, and a debit note raises it.
 // The close read finance_invoices.tax_total only, so it locked and published a GSTR-3B net payable that
 // overstated the liability by the full value of every credit note - the same defect GSTR-3B itself had,
 // which is why the two agreed with each other and both disagreed with GSTR-9. Same reader as the return.
 const adjustments=await outputTaxAdjustments(db,input.period);
 const gst={outputTax:round2(Number(output?.tax||0)+adjustments.tax+serviceOutput.pawspaceOwnOutputTax),eligibleInputTax:round2(Number(input_?.tax||0)),netPayable:0,adjustments:adjustments.tax,invoiceCount:Number(output?.count||0)+serviceOutput.invoiceCount,taxCollectedFromCustomers:round2(Number(output?.tax||0)+adjustments.tax+serviceOutput.totalTaxCollected),providerSupplyGstCollectedOnBehalf:serviceOutput.providerSupplyGstOnBehalf};
 gst.netPayable=round2(Math.max(0,gst.outputTax-gst.eligibleInputTax));

 // TDS: recompute from source data, then check the deposit. A plain view computes WITHOUT writing;
 // only an explicit close persists the statutory computation it locks the month on. [FIN-W1-D2]
 const tds=await computeMonthlyTds(db,{period:input.period,actorId:input.actorId,asOf:input.asOf,persist:input.persist===true});
 const deposit=await safeFirst(db,"SELECT amount FROM tds_deposits WHERE period=?",[input.period]);

 /* Payroll: every run ATTRIBUTED to this month, and only this month. [FIN-W1-D1]
  *
  * This was an overlap test (`p.period_start<:endMs AND p.period_end>:startMs`) against IST-shifted
  * month boundaries, with no proration and a LIMIT 1. Two faults, both observed on real data:
  *   - a run ending at plain-UTC end-of-month satisfied the NEXT month's window too, so
  *     SEEDRUN-AUG2026 (40 employees, gross 11,50,000) was reported in full by the 2026-08 close AND
  *     by the 2026-09 close;
  *   - LIMIT 1 then showed ONE of the month's runs while computeMonthlyTds taxed ALL of them, so the
  *     screen's payroll figure did not match the TDS computed beside it (August has two runs:
  *     44 employees, gross 13,66,000, of which the view declared 40 and 11,50,000).
  * Both surfaces now call the SAME payrollRunsForPeriod, so they cannot disagree, and every run maps
  * to exactly one month, so none is counted twice and none is lost. */
 const payrollRuns=await payrollRunsForPeriod(db,input.period);
 const FINALISED_RUN_STATUSES=["approved","payment_prepared","completed"];
 const unfinalisedRuns=payrollRuns.filter(item=>!FINALISED_RUN_STATUSES.includes(item.status));
 const payroll={
  // Show the run that BLOCKS the close when there is one, so the screen names the reason.
  runStatus:payrollRuns.length?String((unfinalisedRuns[0]??payrollRuns[payrollRuns.length-1]).status):null,
  employees:payrollRuns.reduce((sum,item)=>sum+item.employees,0),
  grossTotal:round2(payrollRuns.reduce((sum,item)=>sum+item.grossTotal,0)),
  runCount:payrollRuns.length,runIds:payrollRuns.map(item=>item.runId),allFinalised:unfinalisedRuns.length===0,
 };

 const approval=await getBoardApproval(db,input.period);
 const boardApproval={approved:Boolean(approval),approvedBy:approval?.approvedBy??null,approverRole:approval?.approverRole??null,approvedAt:approval?.approvedAt??null};

 const checklist:CloseChecklistItem[]=[
  {key:"revenue_reconciled",label:"Revenue aggregated from canonical bookings + food orders",ok:true,value:revenue.total,detail:`${revenue.bookingCount} bookings + ${revenue.foodOrderCount} food orders`},
  {key:"gst_computed",label:"GSTR-3B net payable computed (own output - eligible input)",ok:true,value:gst.netPayable,detail:`own output ${gst.outputTax}${gst.adjustments?` (net of credit/debit notes ${gst.adjustments})`:""} - eligible input ${gst.eligibleInputTax}${gst.providerSupplyGstCollectedOnBehalf?` · provider-supply GST collected on behalf ${gst.providerSupplyGstCollectedOnBehalf} -> s52 TCS/GSTR-8`:""}`},
  {key:"tds_computed",label:"TDS liability computed from payroll + payouts",ok:true,value:tds.totalTds,detail:Object.entries(tds.sections).map(([section,bucket])=>`${section}: ${bucket.tds}`).join(" · ")||"no deductions this month"},
  {key:"tds_deposited",label:`TDS deposited (due ${tds.depositDueDate})`,ok:tds.totalTds===0||Boolean(deposit),value:deposit?round2(Number(deposit.amount)):null,detail:tds.totalTds===0?"no liability":deposit?"challan recorded":"deposit pending"},
  {key:"tds_pans_verified",label:"Deductee PANs verified (s206AA)",ok:tds.panPending===0,value:tds.panPending,detail:tds.panPending===0?(tds.deducteeRows?`${tds.deducteeRows} deductee row(s), all PANs verified`:"no deductions this month"):`${tds.panPending} of ${tds.deducteeRows} deductee PAN(s) unverified - s206AA levies 20% without a PAN; record them before filing`},
  {key:"payroll_finalised",label:"Payroll run approved for the month",ok:payroll.runCount===0||payroll.allFinalised,value:payroll.runStatus,detail:payroll.runCount===0?"no payroll run attributed to this month (acceptable for pre-payroll months)":`${payroll.runCount} run(s) ${payroll.runIds.join(", ")} · ${payroll.employees} employees · gross ${payroll.grossTotal}`},
  {key:"board_approved",label:"Monthly board approval recorded (founder policy)",ok:boardApproval.approved,value:boardApproval.approvedBy,detail:boardApproval.approved?`approved by ${boardApproval.approvedBy}${boardApproval.approverRole?` (${boardApproval.approverRole})`:""}`:"board approval pending - a board-level identity (founder or superuser) must record it before close"},
 ];
 const status:"open"|"ready"=checklist.every(item=>item.ok)?"ready":"open";
 const view:MonthlyCloseView={period:input.period,status,checklist,revenue,gst,tds:{total:tds.totalTds,sections:tds.sections,deposited:Boolean(deposit)||tds.totalTds===0,depositDueDate:tds.depositDueDate},payroll,boardApproval,closedBy:null,closedAt:null};
 if(input.persist===true){
  const now=input.asOf??Date.now();
  await db.prepare("INSERT INTO finance_monthly_closes (period,status,snapshot_json,created_at,updated_at) VALUES (?,?,?,?,?) ON CONFLICT(period) DO UPDATE SET status=excluded.status,snapshot_json=excluded.snapshot_json,updated_at=excluded.updated_at")
   .bind(input.period,status,JSON.stringify(view),now,now).run();
 }
 return view;
}

/** Lock the month. Requires every checklist item green (including board approval). Idempotent-safe:
 *  a second close attempt on a locked month is refused with 409. */
export async function closeMonth(db:Db,input:{period:string;actorId:string;asOf?:number}){
 await ensureMonthlyCloseTables(db);
 const existing=await db.prepare("SELECT status FROM finance_monthly_closes WHERE period=?").bind(input.period).first<Row>();
 if(existing&&String(existing.status)==="closed")throw governedJsonError({error:`${input.period} is already closed and locked; post corrections in the next open period`},409);
 // An explicit close is the moment the month's numbers become a record: persist the snapshot and the
 // statutory TDS computation here, where a human asked for it, not on every dashboard read.
 const view=await monthlyCloseView(db,{...input,persist:true});
 if(view.status!=="ready"){
  const blocking=view.checklist.filter(item=>!item.ok).map(item=>item.key);
  throw governedJsonError({error:`Close blocked - unresolved checklist items: ${blocking.join(", ")}`},409);
 }
 /* [R3-D/F8] Who approved and who locked are both recorded on the close event, so the separation the
  * board-role gate now guarantees (lib/statutory-compliance.ts recordBoardApproval: only a board-level
  * identity can resolve the board's own approval, never the Finance operator who closes on it) is
  * evidenced on the record rather than merely enforced at the door. */
 const boardApprover=await getBoardApproval(db,input.period);
 const now=input.asOf??Date.now();
 const result=await db.prepare("UPDATE finance_monthly_closes SET status='closed',closed_by=?,closed_at=?,snapshot_json=?,updated_at=? WHERE period=? AND status!='closed'")
  .bind(input.actorId,now,JSON.stringify({...view,status:"closed",closedBy:input.actorId,closedAt:now}),now,input.period).run();
 if(!Number(result.meta.changes))throw governedJsonError({error:`${input.period} is already closed and locked`},409);
 await db.batch([
  db.prepare("INSERT INTO finance_close_periods (period_code,status,checklist_json,locked_at,locked_by,updated_at) VALUES (?,'locked',?,?,?,?) ON CONFLICT(period_code) DO UPDATE SET status='locked',checklist_json=excluded.checklist_json,locked_at=excluded.locked_at,locked_by=excluded.locked_by,updated_at=excluded.updated_at")
   .bind(input.period,JSON.stringify(view.checklist),now,input.actorId,now),
  db.prepare("INSERT INTO finance_close_events (id,period,event_type,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)")
   .bind(`FCE-${crypto.randomUUID().slice(0,10).toUpperCase()}`,input.period,"closed",input.actorId,JSON.stringify({revenue:view.revenue.total,gstNetPayable:view.gst.netPayable,tds:view.tds.total,boardApprovedBy:boardApprover?.approvedBy??null,boardApproverRole:boardApprover?.approverRole??null}),now),
 ]);
 return{period:input.period,status:"closed" as const,closedBy:input.actorId,closedAt:now};
}
