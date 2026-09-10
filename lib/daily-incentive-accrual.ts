/**
 * Daily incentive AUTO-accrual. Each day the background scheduler runs this sweep for the previous
 * (complete) IST day: for every employee with a configured sales base vertical it computes the day's
 * sales incentive (tier ladder + Blitz multiplier from the sales-incentive engine) and records an
 * ACCRUAL row - idempotently, one per employee per day. A per-day sweep marker makes repeated 5-minute
 * ticks a no-op once a day is processed.
 *
 * "Auto payment" here means auto-ACCRUAL, not auto-disbursement: no money moves. Accruals are the daily
 * evidence trail that feeds the monthly governed incentive/payroll pipeline (calculate -> human approve ->
 * one-time payroll inclusion). Real payment stays gated and sandbox until deliberately switched on.
 */
import{computeDailySalesIncentive}from"./sales-incentive-engine";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

/** IST calendar date (YYYY-MM-DD) for a timestamp. */
function istDate(ms:number){return new Date(ms+19800000).toISOString().slice(0,10);}

export async function ensureDailyIncentiveAccrualTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS daily_incentive_accruals (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,accrual_date TEXT NOT NULL,base_vertical TEXT NOT NULL,achieved_value REAL NOT NULL,base_incentive REAL NOT NULL,blitz INTEGER NOT NULL DEFAULT 0,incentive REAL NOT NULL,status TEXT NOT NULL DEFAULT 'accrued',source TEXT NOT NULL DEFAULT 'auto_daily_sweep',created_at INTEGER NOT NULL,UNIQUE(employee_id,accrual_date))"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_daily_accrual_emp ON daily_incentive_accruals(employee_id,accrual_date)"),
 db.prepare("CREATE TABLE IF NOT EXISTS daily_incentive_sweep_runs (accrual_date TEXT PRIMARY KEY,employee_count INTEGER NOT NULL,accrued_total REAL NOT NULL,completed_at INTEGER NOT NULL)"),
]);}

/** Accrue the previous complete IST day's sales incentive for every configured employee. One-time per day, idempotent. */
export async function runDailyIncentiveAccrualSweep(db:Db,input:{asOf?:number;date?:string}={}){
 await ensureDailyIncentiveAccrualTables(db);
 const asOf=Number(input.asOf)||Date.now();
 const date=/^\d{4}-\d{2}-\d{2}$/.test(text(input.date))?text(input.date):istDate(asOf-86400000);
 // sales base table may not exist yet on a cold DB
 const hasBase=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sales_employee_base'").first<Row>().catch(()=>null);
 if(!hasBase)return{date,processed:0,accruedTotal:0,skipped:true,reason:"no_sales_base_table"};
 const marker=await db.prepare("SELECT accrual_date FROM daily_incentive_sweep_runs WHERE accrual_date=?").bind(date).first<Row>();
 if(marker)return{date,processed:0,accruedTotal:0,skipped:true,reason:"already_processed"};
 const employees=await db.prepare("SELECT DISTINCT employee_id FROM sales_employee_base WHERE effective_from<=? AND (effective_until IS NULL OR effective_until>?)").bind(date,date).all<Row>();
 let processed=0,accruedTotal=0;
 for(const e of employees.results){
  const employeeId=text(e.employee_id);
  const result=await computeDailySalesIncentive(db,{employeeId,date,actorId:"system:daily-incentive-sweep"}).catch(()=>null);
  if(!result)continue;
  const write=await db.prepare("INSERT INTO daily_incentive_accruals (id,employee_id,accrual_date,base_vertical,achieved_value,base_incentive,blitz,incentive,status,source,created_at) VALUES (?,?,?,?,?,?,?,?, 'accrued','auto_daily_sweep',?) ON CONFLICT(employee_id,accrual_date) DO NOTHING")
    .bind(uid("DIA"),employeeId,date,result.baseVertical,money(result.achievedValue),money(result.baseIncentive),result.blitz?1:0,money(result.incentive),asOf).run();
  if(num(write.meta?.changes)>0){processed++;accruedTotal=money(accruedTotal+money(result.incentive));}
 }
 await db.prepare("INSERT INTO daily_incentive_sweep_runs (accrual_date,employee_count,accrued_total,completed_at) VALUES (?,?,?,?) ON CONFLICT(accrual_date) DO UPDATE SET employee_count=excluded.employee_count,accrued_total=excluded.accrued_total,completed_at=excluded.completed_at")
  .bind(date,employees.results.length,accruedTotal,asOf).run();
 return{date,processed,accruedTotal,employeesConsidered:employees.results.length,skipped:false};
}

/** Accrued daily incentive per employee over a window (for self-service / dashboards). Cold-DB safe. */
export async function dailyIncentiveAccrualSummary(db:Db,input:{employeeId?:string;from?:string;to?:string}={}){
 await ensureDailyIncentiveAccrualTables(db);
 const employeeId=text(input.employeeId);
 const rows=await db.prepare(`SELECT * FROM daily_incentive_accruals WHERE (?='' OR employee_id=?) AND (?='' OR accrual_date>=?) AND (?='' OR accrual_date<=?) ORDER BY accrual_date DESC,employee_id LIMIT 400`)
  .bind(employeeId,employeeId,text(input.from),text(input.from),text(input.to),text(input.to)).all<Row>().catch(()=>({results:[] as Row[]}));
 const list=rows.results.map(r=>({employeeId:text(r.employee_id),date:text(r.accrual_date),baseVertical:text(r.base_vertical),achievedValue:money(r.achieved_value),incentive:money(r.incentive),blitz:num(r.blitz)===1,status:text(r.status)}));
 return{list,total:money(list.reduce((a,r)=>a+r.incentive,0))};
}

export type SalesPayrollIncentiveEntry={sourceType:"sales_incentive_period";sourceId:string;label:string;kind:"earning";amount:number;policyVersion:string};

async function ensureSalesIncentivePeriodTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS sales_incentive_period_results (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,month_start TEXT NOT NULL,daily_accrued_total REAL NOT NULL,monthly_achieved_value REAL NOT NULL,monthly_tier_target REAL,monthly_bonus REAL NOT NULL,approved_total REAL NOT NULL,status TEXT NOT NULL DEFAULT 'draft',generated_by TEXT NOT NULL,generated_at INTEGER NOT NULL,approved_by TEXT,approved_at INTEGER,UNIQUE(employee_id,month_start))"),
 db.prepare("CREATE TABLE IF NOT EXISTS sales_incentive_payroll_links (id TEXT PRIMARY KEY,result_id TEXT NOT NULL UNIQUE,payroll_run_id TEXT NOT NULL,payroll_result_id TEXT NOT NULL,employee_id TEXT NOT NULL,amount REAL NOT NULL,created_at INTEGER NOT NULL)"),
]);}
function monthEnd(monthStart:string){const[y,m]=monthStart.split("-").map(Number);return new Date(Date.UTC(y,m,0)).toISOString().slice(0,10);}
function msDate(ms:number){return new Date(ms).toISOString().slice(0,10);}

/** Canonical sales incentive result for a month: daily accrual evidence plus the published monthly tier bonus. */
export async function buildSalesIncentivePeriodResult(db:Db,input:{employeeId:string;monthStart:string;actorId:string}){
 await ensureDailyIncentiveAccrualTables(db);await ensureSalesIncentivePeriodTables(db);
 if(!/^\d{4}-\d{2}-01$/.test(input.monthStart))throw new Error("monthStart must be the first day of a month");
 const existing=await db.prepare("SELECT * FROM sales_incentive_period_results WHERE employee_id=? AND month_start=?").bind(input.employeeId,input.monthStart).first<Row>();
 if(existing&&text(existing.status)!=="draft")return{result:existing,immutable:true};
 const end=monthEnd(input.monthStart),daily=await dailyIncentiveAccrualSummary(db,{employeeId:input.employeeId,from:input.monthStart,to:end});
 const {computeMonthlySalesIncentive}=await import("./sales-incentive-engine");
 const monthly=await computeMonthlySalesIncentive(db,{employeeId:input.employeeId,monthStart:input.monthStart,actorId:input.actorId});
 const total=money(daily.total+monthly.incentive),now=Date.now(),id=existing?text(existing.id):uid("SIPR");
 await db.prepare("INSERT INTO sales_incentive_period_results (id,employee_id,month_start,daily_accrued_total,monthly_achieved_value,monthly_tier_target,monthly_bonus,approved_total,status,generated_by,generated_at) VALUES (?,?,?,?,?,?,?,?, 'draft',?,?) ON CONFLICT(employee_id,month_start) DO UPDATE SET daily_accrued_total=excluded.daily_accrued_total,monthly_achieved_value=excluded.monthly_achieved_value,monthly_tier_target=excluded.monthly_tier_target,monthly_bonus=excluded.monthly_bonus,approved_total=excluded.approved_total,generated_by=excluded.generated_by,generated_at=excluded.generated_at WHERE sales_incentive_period_results.status='draft'")
  .bind(id,input.employeeId,input.monthStart,money(daily.total),money(monthly.achievedValue),monthly.tierTarget==null?null:money(monthly.tierTarget),money(monthly.incentive),total,input.actorId,now).run();
 return{result:await db.prepare("SELECT * FROM sales_incentive_period_results WHERE employee_id=? AND month_start=?").bind(input.employeeId,input.monthStart).first<Row>(),immutable:false};
}

export async function approveSalesIncentivePeriodResult(db:Db,input:{employeeId:string;monthStart:string;actorId:string}){
 await ensureSalesIncentivePeriodTables(db);const row=await db.prepare("SELECT * FROM sales_incentive_period_results WHERE employee_id=? AND month_start=?").bind(input.employeeId,input.monthStart).first<Row>();
 if(!row)throw new Error("Generate the sales incentive period result before approval");if(text(row.status)==="payroll_included")return{result:row,duplicatePrevented:true};if(text(row.status)==="approved")return{result:row,duplicatePrevented:true};
 if(text(input.actorId).toLowerCase().startsWith("system:"))throw new Error("Sales incentive approval requires a human actor");
 const now=Date.now(),claim=await db.prepare("UPDATE sales_incentive_period_results SET status='approved',approved_by=?,approved_at=? WHERE id=? AND status='draft'").bind(input.actorId,now,row.id).run();
 if(!num(claim.meta?.changes))return{result:await db.prepare("SELECT * FROM sales_incentive_period_results WHERE id=?").bind(row.id).first<Row>(),duplicatePrevented:true};
 return{result:await db.prepare("SELECT * FROM sales_incentive_period_results WHERE id=?").bind(row.id).first<Row>(),duplicatePrevented:false};
}

export async function approvedSalesIncentiveEntriesForPayroll(db:Db,input:{employeeId:string;periodStart:number;periodEnd:number}):Promise<SalesPayrollIncentiveEntry[]>{
 await ensureSalesIncentivePeriodTables(db);const from=msDate(input.periodStart).slice(0,7)+"-01",to=msDate(Math.max(input.periodStart,input.periodEnd-1)).slice(0,7)+"-01";
 const rows=await db.prepare("SELECT r.* FROM sales_incentive_period_results r LEFT JOIN sales_incentive_payroll_links l ON l.result_id=r.id WHERE r.employee_id=? AND r.status='approved' AND r.month_start>=? AND r.month_start<=? AND l.id IS NULL AND r.approved_total>0 ORDER BY r.month_start").bind(input.employeeId,from,to).all<Row>();
 return rows.results.map(r=>({sourceType:"sales_incentive_period" as const,sourceId:text(r.id),label:`Approved sales incentive · ${text(r.month_start)}`,kind:"earning" as const,amount:money(r.approved_total),policyVersion:`sales_rate_sheet:${text(r.month_start)}`}));
}
export async function markSalesIncentiveEntriesIncluded(db:Db,input:{entries:SalesPayrollIncentiveEntry[];payrollRunId:string;payrollResultId:string;employeeId:string}){
 await ensureSalesIncentivePeriodTables(db);const now=Date.now();for(const e of input.entries){await db.prepare("INSERT OR IGNORE INTO sales_incentive_payroll_links (id,result_id,payroll_run_id,payroll_result_id,employee_id,amount,created_at) VALUES (?,?,?,?,?,?,?)").bind(uid("SIPL"),e.sourceId,input.payrollRunId,input.payrollResultId,input.employeeId,e.amount,now).run();await db.prepare("UPDATE sales_incentive_period_results SET status='payroll_included' WHERE id=? AND status='approved'").bind(e.sourceId).run();}}

export async function salesIncentivePeriodTruth(db:Db,input:{employeeId:string;monthStart:string}){await ensureSalesIncentivePeriodTables(db);const row=await db.prepare("SELECT r.*,l.payroll_run_id,l.payroll_result_id,l.created_at payroll_included_at FROM sales_incentive_period_results r LEFT JOIN sales_incentive_payroll_links l ON l.result_id=r.id WHERE r.employee_id=? AND r.month_start=?").bind(input.employeeId,input.monthStart).first<Row>();if(!row)return null;return{employeeId:text(row.employee_id),monthStart:text(row.month_start),dailyAccruedTotal:money(row.daily_accrued_total),monthlyAchievedValue:money(row.monthly_achieved_value),monthlyTierTarget:row.monthly_tier_target==null?null:money(row.monthly_tier_target),monthlyBonus:money(row.monthly_bonus),total:money(row.approved_total),status:text(row.status),approvedBy:row.approved_by?text(row.approved_by):null,approvedAt:row.approved_at?num(row.approved_at):null,payrollRunId:row.payroll_run_id?text(row.payroll_run_id):null,payrollResultId:row.payroll_result_id?text(row.payroll_result_id):null,payrollIncludedAt:row.payroll_included_at?num(row.payroll_included_at):null};}
