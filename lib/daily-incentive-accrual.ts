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
