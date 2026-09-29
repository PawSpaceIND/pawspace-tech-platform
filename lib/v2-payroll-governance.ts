import{ensurePayrollTables}from"./payroll-engine";
import{ensureAttendanceLeaveTables}from"./attendance-leave";
import{queueEmployeeSalary}from"./employee-payroll-payout";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>Math.round(num(v)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,18)}`;
const bad=(message:string,status=409)=>new Response(message,{status});

export type V2PayrollPolicyInput={
 salaryDay:number;
 cutoffDay:number;
 paidLeaveCodes:string[];
 unpaidLeaveCodes:string[];
 lopDeductibleComponentCodes:string[];
 authorizedDeductionEnabled:boolean;
 authorizedDeductionPolicyReference:string;
 maxAuthorizedDeductionPercent:number;
 actorId:string;
};

export async function ensureV2PayrollGovernance(db:Db){
 await ensurePayrollTables(db);await ensureAttendanceLeaveTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS v2_payroll_policies (id TEXT PRIMARY KEY,version INTEGER NOT NULL,status TEXT NOT NULL,salary_day INTEGER NOT NULL,cutoff_day INTEGER NOT NULL,paid_leave_codes_json TEXT NOT NULL,unpaid_leave_codes_json TEXT NOT NULL,lop_component_codes_json TEXT NOT NULL,authorized_deduction_enabled INTEGER NOT NULL,authorized_deduction_policy_reference TEXT,authorized_deduction_max_percent REAL NOT NULL,created_by TEXT NOT NULL,created_at INTEGER NOT NULL,UNIQUE(version))"),
  db.prepare("CREATE TABLE IF NOT EXISTS v2_payroll_adjustments (id TEXT PRIMARY KEY,run_id TEXT NOT NULL,employee_id TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('lop','authorized_deduction')),units REAL NOT NULL DEFAULT 0,amount REAL NOT NULL,reason TEXT NOT NULL,evidence_reference TEXT NOT NULL,policy_version INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'pending_hr',requested_by TEXT NOT NULL,hr_approved_by TEXT,hr_approved_at INTEGER,finance_approved_by TEXT,finance_approved_at INTEGER,rejected_by TEXT,rejected_at INTEGER,applied_at INTEGER,created_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS v2_payroll_adjustments_run_idx ON v2_payroll_adjustments(run_id,status)"),
  db.prepare("CREATE TABLE IF NOT EXISTS v2_salary_release_plans (id TEXT PRIMARY KEY,run_id TEXT NOT NULL UNIQUE,salary_date INTEGER NOT NULL,status TEXT NOT NULL DEFAULT 'draft',created_by TEXT NOT NULL,hr_approved_by TEXT,hr_approved_at INTEGER,finance_approved_by TEXT,finance_approved_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE TABLE IF NOT EXISTS v2_salary_release_items (id TEXT PRIMARY KEY,plan_id TEXT NOT NULL,result_id TEXT NOT NULL UNIQUE,employee_id TEXT NOT NULL,amount REAL NOT NULL,batch_code TEXT NOT NULL,release_at INTEGER NOT NULL,hold_status TEXT NOT NULL DEFAULT 'ready' CHECK(hold_status IN ('ready','held','released')),hold_reason TEXT,held_by TEXT,held_at INTEGER,released_by TEXT,released_at INTEGER,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE INDEX IF NOT EXISTS v2_salary_release_due_idx ON v2_salary_release_items(plan_id,hold_status,release_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS v2_payroll_governance_events (id TEXT PRIMARY KEY,run_id TEXT,employee_id TEXT,action TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL DEFAULT '{}',created_at INTEGER NOT NULL)")
 ]);
}

function jsonList(v:unknown){try{const a=JSON.parse(text(v)||"[]");return Array.isArray(a)?a.map(text).filter(Boolean):[];}catch{return[];}}
async function activePolicy(db:Db){return db.prepare("SELECT * FROM v2_payroll_policies WHERE status='active' ORDER BY version DESC LIMIT 1").first<Row>();}
async function event(db:Db,input:{runId?:string;employeeId?:string;action:string;actorId:string;detail?:unknown}){await db.prepare("INSERT INTO v2_payroll_governance_events (id,run_id,employee_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(uid("V2PGE"),input.runId||null,input.employeeId||null,input.action,input.actorId,JSON.stringify(input.detail||{}),Date.now()).run();}

export async function saveV2PayrollPolicy(db:Db,input:V2PayrollPolicyInput){
 await ensureV2PayrollGovernance(db);
 if(!Number.isInteger(input.salaryDay)||input.salaryDay<1||input.salaryDay>28)throw bad("Salary day must be between 1 and 28",400);
 if(!Number.isInteger(input.cutoffDay)||input.cutoffDay<1||input.cutoffDay>28)throw bad("Payroll cutoff day must be between 1 and 28",400);
 if(input.authorizedDeductionEnabled&&text(input.authorizedDeductionPolicyReference).length<8)throw bad("Authorized deduction policy reference is required",400);
 if(input.maxAuthorizedDeductionPercent<0||input.maxAuthorizedDeductionPercent>100)throw bad("Authorized deduction cap must be between 0 and 100",400);
 const prior=await activePolicy(db),version=num(prior?.version)+1,now=Date.now(),id=uid("V2POL");
 if(prior)await db.prepare("UPDATE v2_payroll_policies SET status='retired' WHERE id=?").bind(prior.id).run();
 await db.prepare("INSERT INTO v2_payroll_policies (id,version,status,salary_day,cutoff_day,paid_leave_codes_json,unpaid_leave_codes_json,lop_component_codes_json,authorized_deduction_enabled,authorized_deduction_policy_reference,authorized_deduction_max_percent,created_by,created_at) VALUES (?,?, 'active',?,?,?,?,?,?,?,?,?,?)").bind(id,version,input.salaryDay,input.cutoffDay,JSON.stringify(input.paidLeaveCodes),JSON.stringify(input.unpaidLeaveCodes),JSON.stringify(input.lopDeductibleComponentCodes),input.authorizedDeductionEnabled?1:0,text(input.authorizedDeductionPolicyReference)||null,input.maxAuthorizedDeductionPercent,input.actorId,now).run();
 return{id,version};
}

export async function deriveV2Lop(db:Db,input:{runId:string;employeeId:string;actorId:string;evidenceReference:string}){
 await ensureV2PayrollGovernance(db);const policy=await activePolicy(db);if(!policy)throw bad("V2 payroll policy is not configured");
 const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=? AND status='calculated'").bind(input.runId).first<Row>();if(!run)throw bad("Calculated payroll run is required");
 const result=await db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=? AND employee_id=?").bind(input.runId,input.employeeId).first<Row>();if(!result)throw bad("Employee payroll result not found",404);
 const start=new Date(num(run.period_start)).toISOString().slice(0,10),end=new Date(num(run.period_end)-1).toISOString().slice(0,10);
 const days=(await db.prepare("SELECT work_date,status FROM attendance_days WHERE employee_id=? AND work_date>=? AND work_date<=? ORDER BY work_date").bind(input.employeeId,start,end).all<Row>()).results;
 if(!days.length)throw bad("Attendance summary is required before deriving LOP");
 const paid=new Set(jsonList(policy.paid_leave_codes_json)),unpaid=new Set(jsonList(policy.unpaid_leave_codes_json));
 const leaves=(await db.prepare("SELECT leave_code,start_date,end_date,units FROM leave_requests WHERE employee_id=? AND status='approved' AND end_date>=? AND start_date<=?").bind(input.employeeId,start,end).all<Row>()).results;
 let unpaidUnits=0;for(const leave of leaves){const code=text(leave.leave_code);if(unpaid.has(code))unpaidUnits+=num(leave.units);}
 const approvedLeaveDates=new Set<string>();
 for(const leave of leaves){const code=text(leave.leave_code);if(!paid.has(code)&&!unpaid.has(code))continue;let d=new Date(text(leave.start_date)+"T00:00:00Z");const last=new Date(text(leave.end_date)+"T00:00:00Z");while(d<=last){approvedLeaveDates.add(d.toISOString().slice(0,10));d=new Date(d.getTime()+86400000);}}
 const absenceUnits=days.filter(d=>text(d.status)==="absent"&&!approvedLeaveDates.has(text(d.work_date))).length;
 const units=money(absenceUnits+unpaidUnits);if(units<=0)return{units:0,amount:0,created:false};
 const componentCodes=new Set(jsonList(policy.lop_component_codes_json));
 const lines=(await db.prepare("SELECT component_code,amount FROM payroll_result_lines WHERE result_id=? AND kind='earning'").bind(result.id).all<Row>()).results;
 const base=money(lines.filter(l=>componentCodes.size===0||componentCodes.has(text(l.component_code))).reduce((s,l)=>s+num(l.amount),0));
 const payableDays=days.filter(d=>!["holiday","weekly_off"].includes(text(d.status))).length;if(payableDays<=0)throw bad("Working-day attendance basis is incomplete");
 const amount=money(Math.min(num(result.net_pay),base/payableDays*units));const existing=await db.prepare("SELECT id FROM v2_payroll_adjustments WHERE run_id=? AND employee_id=? AND kind='lop' AND status NOT IN ('rejected')").bind(input.runId,input.employeeId).first<Row>();if(existing)throw bad("LOP adjustment already exists for this employee/run");
 const id=uid("V2ADJ");await db.prepare("INSERT INTO v2_payroll_adjustments (id,run_id,employee_id,kind,units,amount,reason,evidence_reference,policy_version,status,requested_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,'pending_hr',?,?)").bind(id,input.runId,input.employeeId,"lop",units,amount,`Attendance/leave-derived LOP: ${units} unit(s)`,text(input.evidenceReference),num(policy.version),input.actorId,Date.now()).run();
 await event(db,{runId:input.runId,employeeId:input.employeeId,action:"lop_derived",actorId:input.actorId,detail:{units,amount}});
 return{id,units,amount,created:true};
}

export async function proposeV2AuthorizedDeduction(db:Db,input:{runId:string;employeeId:string;amount:number;reason:string;evidenceReference:string;actorId:string}){
 await ensureV2PayrollGovernance(db);const policy=await activePolicy(db);if(!policy||num(policy.authorized_deduction_enabled)!==1)throw bad("Authorized deductions are disabled until an approved HR/Finance policy is configured");
 if(input.amount<=0||text(input.reason).length<8||text(input.evidenceReference).length<4)throw bad("Amount, reason and evidence are required",400);
 const result=await db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=? AND employee_id=?").bind(input.runId,input.employeeId).first<Row>();if(!result)throw bad("Employee payroll result not found",404);
 const cap=money(num(result.gross_earnings)*num(policy.authorized_deduction_max_percent)/100);if(input.amount>cap)throw bad("Deduction exceeds the configured policy cap");
 const id=uid("V2ADJ");await db.prepare("INSERT INTO v2_payroll_adjustments (id,run_id,employee_id,kind,units,amount,reason,evidence_reference,policy_version,status,requested_by,created_at) VALUES (?,?,?,?,0,?,?,?,?, 'pending_hr',?,?)").bind(id,input.runId,input.employeeId,"authorized_deduction",money(input.amount),text(input.reason),text(input.evidenceReference),num(policy.version),input.actorId,Date.now()).run();
 await event(db,{runId:input.runId,employeeId:input.employeeId,action:"authorized_deduction_proposed",actorId:input.actorId,detail:{amount:money(input.amount)}});
 return{id,status:"pending_hr"};
}

export async function decideV2Adjustment(db:Db,input:{adjustmentId:string;stage:"hr"|"finance";decision:"approve"|"reject";actorId:string}){
 await ensureV2PayrollGovernance(db);const row=await db.prepare("SELECT * FROM v2_payroll_adjustments WHERE id=?").bind(input.adjustmentId).first<Row>();if(!row)throw bad("Adjustment not found",404);const now=Date.now();
 if(input.decision==="reject"){await db.prepare("UPDATE v2_payroll_adjustments SET status='rejected',rejected_by=?,rejected_at=? WHERE id=? AND status IN ('pending_hr','pending_finance')").bind(input.actorId,now,input.adjustmentId).run();await event(db,{runId:text(row.run_id),employeeId:text(row.employee_id),action:"adjustment_rejected",actorId:input.actorId,detail:{stage:input.stage}});return{status:"rejected"};}
 if(input.stage==="hr"){if(text(row.status)!=="pending_hr")throw bad("Adjustment is not awaiting HR approval");if(text(row.requested_by).toLowerCase()===input.actorId.toLowerCase())throw bad("Requester cannot approve their own payroll adjustment");await db.prepare("UPDATE v2_payroll_adjustments SET status='pending_finance',hr_approved_by=?,hr_approved_at=? WHERE id=?").bind(input.actorId,now,input.adjustmentId).run();return{status:"pending_finance"};}
 if(text(row.status)!=="pending_finance")throw bad("Adjustment is not awaiting Finance approval");if([row.requested_by,row.hr_approved_by].some(v=>text(v).toLowerCase()===input.actorId.toLowerCase()))throw bad("Finance approver must be independent");await db.prepare("UPDATE v2_payroll_adjustments SET status='approved',finance_approved_by=?,finance_approved_at=? WHERE id=?").bind(input.actorId,now,input.adjustmentId).run();return{status:"approved"};
}

export async function applyApprovedV2Adjustments(db:Db,input:{runId:string;actorId:string}){
 await ensureV2PayrollGovernance(db);const run=await db.prepare("SELECT status FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();if(!run||text(run.status)!=="calculated")throw bad("Adjustments must be applied before payroll review");
 const rows=(await db.prepare("SELECT * FROM v2_payroll_adjustments WHERE run_id=? AND status='approved' AND applied_at IS NULL ORDER BY created_at").bind(input.runId).all<Row>()).results;
 for(const a of rows){const result=await db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=? AND employee_id=?").bind(input.runId,a.employee_id).first<Row>();if(!result)throw bad("Payroll result changed; re-review required");const amount=money(a.amount),nextNet=money(num(result.net_pay)-amount);if(nextNet<0)throw bad("Approved deductions would create negative net pay");const id=uid("PAYLINE"),now=Date.now();await db.batch([
  db.prepare("UPDATE employee_payroll_results SET total_deductions=total_deductions+?,net_pay=? WHERE id=?").bind(amount,nextNet,result.id),
  db.prepare("INSERT INTO payroll_result_lines (id,result_id,component_code,label,kind,amount,source_type,source_reference,policy_version) VALUES (?,?,?,?, 'deduction',?,?,?,?)").bind(id,result.id,text(a.kind)==="lop"?"LOP":"AUTHORIZED_DEDUCTION",text(a.kind)==="lop"?"Loss of pay":"Authorized HR deduction",amount,"v2_hr_payroll_adjustment",a.id,`v2_policy:${a.policy_version}`),
  db.prepare("UPDATE v2_payroll_adjustments SET status='applied',applied_at=? WHERE id=?").bind(now,a.id)
 ]);}
 await event(db,{runId:input.runId,action:"adjustments_applied",actorId:input.actorId,detail:{count:rows.length}});
 return{runId:input.runId,applied:rows.length};
}

export async function createV2SalaryReleasePlan(db:Db,input:{runId:string;salaryDate:number;items?:Array<{employeeId:string;releaseAt?:number;batchCode?:string;hold?:boolean;holdReason?:string}>;actorId:string}){
 await ensureV2PayrollGovernance(db);const run=await db.prepare("SELECT status FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();if(!run||text(run.status)!=="approved")throw bad("Approved payroll is required before release planning");
 if(!Number.isFinite(input.salaryDate)||input.salaryDate<Date.now()-86400000)throw bad("Valid salary date is required",400);
 const prior=await db.prepare("SELECT id FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(prior)throw bad("Salary release plan already exists");
 const results=(await db.prepare("SELECT id,employee_id,net_pay FROM employee_payroll_results WHERE run_id=? AND net_pay>0 ORDER BY employee_id").bind(input.runId).all<Row>()).results;if(!results.length)throw bad("No payable salaries found");
 const planId=uid("V2PLAN"),now=Date.now(),requested=new Map((input.items||[]).map(x=>[x.employeeId,x]));
 const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO v2_salary_release_plans (id,run_id,salary_date,status,created_by,created_at,updated_at) VALUES (?,? ,?,'draft',?,?,?)").bind(planId,input.runId,input.salaryDate,input.actorId,now,now)];
 for(const result of results){const cfg=requested.get(text(result.employee_id)),releaseAt=Number(cfg?.releaseAt||input.salaryDate),held=Boolean(cfg?.hold),reason=text(cfg?.holdReason);if(held&&reason.length<8)throw bad("Held salary requires a clear reason",400);statements.push(db.prepare("INSERT INTO v2_salary_release_items (id,plan_id,result_id,employee_id,amount,batch_code,release_at,hold_status,hold_reason,held_by,held_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(uid("V2ITEM"),planId,result.id,result.employee_id,money(result.net_pay),text(cfg?.batchCode)||"BATCH-1",releaseAt,held?"held":"ready",held?reason:null,held?input.actorId:null,held?now:null,now,now));}
 await db.batch(statements);await event(db,{runId:input.runId,action:"release_plan_created",actorId:input.actorId,detail:{salaryDate:input.salaryDate,count:results.length}});return{planId,status:"draft",count:results.length};
}

export async function approveV2SalaryReleasePlan(db:Db,input:{runId:string;stage:"hr"|"finance";actorId:string}){
 await ensureV2PayrollGovernance(db);const plan=await db.prepare("SELECT * FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(!plan)throw bad("Release plan not found",404);const now=Date.now();
 if(input.stage==="hr"){if(text(plan.hr_approved_by))throw bad("HR approval already recorded");if(text(plan.created_by).toLowerCase()===input.actorId.toLowerCase())throw bad("Plan creator cannot provide HR approval");await db.prepare("UPDATE v2_salary_release_plans SET status='pending_finance',hr_approved_by=?,hr_approved_at=?,updated_at=? WHERE id=?").bind(input.actorId,now,now,plan.id).run();return{status:"pending_finance"};}
 if(!text(plan.hr_approved_by))throw bad("HR approval is required first");if([plan.created_by,plan.hr_approved_by].some(v=>text(v).toLowerCase()===input.actorId.toLowerCase()))throw bad("Finance approval must be independent");await db.prepare("UPDATE v2_salary_release_plans SET status='approved',finance_approved_by=?,finance_approved_at=?,updated_at=? WHERE id=?").bind(input.actorId,now,now,plan.id).run();return{status:"approved"};
}

export async function setV2SalaryHold(db:Db,input:{runId:string;employeeId:string;hold:boolean;reason?:string;releaseAt?:number;actorId:string}){
 await ensureV2PayrollGovernance(db);const plan=await db.prepare("SELECT id,status FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(!plan)throw bad("Release plan not found",404);if(text(plan.status)==="approved")throw bad("Approved plan is immutable; create a governed release action instead");
 const now=Date.now(),reason=text(input.reason);if(input.hold&&reason.length<8)throw bad("Hold reason is required",400);
 await db.prepare("UPDATE v2_salary_release_items SET hold_status=?,hold_reason=?,held_by=?,held_at=?,release_at=COALESCE(?,release_at),updated_at=? WHERE plan_id=? AND employee_id=?").bind(input.hold?"held":"ready",input.hold?reason:null,input.hold?input.actorId:null,input.hold?now:null,input.releaseAt??null,now,plan.id,input.employeeId).run();return{employeeId:input.employeeId,hold:input.hold};
}

export async function releaseHeldV2Salary(db:Db,input:{runId:string;employeeId:string;releaseAt:number;actorId:string}){
 await ensureV2PayrollGovernance(db);const plan=await db.prepare("SELECT id,status FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(!plan||text(plan.status)!=="approved")throw bad("Approved release plan is required");const now=Date.now();
 const changed=await db.prepare("UPDATE v2_salary_release_items SET hold_status='ready',release_at=?,released_by=?,released_at=?,updated_at=? WHERE plan_id=? AND employee_id=? AND hold_status='held'").bind(input.releaseAt,input.actorId,now,now,plan.id,input.employeeId).run();if(!num(changed.meta?.changes))throw bad("Held salary item not found");
 await event(db,{runId:input.runId,employeeId:input.employeeId,action:"held_salary_released",actorId:input.actorId,detail:{releaseAt:input.releaseAt}});return{employeeId:input.employeeId,status:"ready",releaseAt:input.releaseAt};
}

export async function v2PayrollGovernanceDirectory(db:Db,runId?:string){
 await ensureV2PayrollGovernance(db);const policy=await activePolicy(db),run=runId?await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(runId).first<Row>():null;
 const adjustments=runId?(await db.prepare("SELECT * FROM v2_payroll_adjustments WHERE run_id=? ORDER BY created_at DESC").bind(runId).all<Row>()).results:[];
 const results=runId?(await db.prepare("SELECT r.id,r.employee_id,r.gross_earnings,r.total_deductions,r.reimbursements,r.net_pay,e.employee_code,e.display_name FROM employee_payroll_results r LEFT JOIN employees e ON e.id=r.employee_id WHERE r.run_id=? ORDER BY COALESCE(e.display_name,r.employee_id)").bind(runId).all<Row>()).results:[];
 const plan=runId?await db.prepare("SELECT * FROM v2_salary_release_plans WHERE run_id=?").bind(runId).first<Row>():null;
 const items=plan?(await db.prepare("SELECT * FROM v2_salary_release_items WHERE plan_id=? ORDER BY release_at,employee_id").bind(plan.id).all<Row>()).results:[];
 return{policy,run,results,adjustments,releasePlan:plan?{...plan,items}:null,truth:{scope:"pawspace_v2_only",requiresHrApproval:true,requiresIndependentFinanceApproval:true,automaticPunitiveFine:false,leaveAwareLop:true,scheduledSalaryRelease:true,batchRelease:true,selectiveHold:true,liveMoneyEnabled:false}};
}


export async function queueDueV2SalaryInstructions(db:Db,input:{runId:string;asOf?:number;actorId:string}){
 await ensureV2PayrollGovernance(db);const asOf=Number(input.asOf||Date.now());
 const plan=await db.prepare("SELECT * FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(!plan||text(plan.status)!=="approved")throw bad("HR and Finance must approve the V2 salary release plan first");
 if(asOf<num(plan.salary_date))return{runId:input.runId,queued:0,notDueYet:true,salaryDate:num(plan.salary_date)};
 const run=await db.prepare("SELECT status FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();if(!run||text(run.status)!=="payment_prepared")throw bad("Canonical payroll payment batch must be prepared before salary queueing");
 const due=(await db.prepare("SELECT result_id,employee_id,batch_code,release_at FROM v2_salary_release_items WHERE plan_id=? AND hold_status='ready' AND release_at<=? ORDER BY release_at,batch_code,employee_id").bind(plan.id,asOf).all<Row>()).results;
 if(!due.length)return{runId:input.runId,queued:0,notDueYet:false};
 const data=await queueEmployeeSalary(db,{runId:input.runId,actorId:input.actorId,resultIds:due.map(row=>text(row.result_id))});
 await event(db,{runId:input.runId,action:"due_salary_instructions_queued",actorId:input.actorId,detail:{asOf,count:due.length,batches:[...new Set(due.map(row=>text(row.batch_code)))]}});
 return{runId:input.runId,queued:due.length,instructions:data.instructions,duplicatePrevented:Boolean(data.duplicatePrevented)};
}

export async function runV2SalaryReleaseSweep(db:Db,input:{asOf:number;actorId:string}){
 await ensureV2PayrollGovernance(db);
 const plans=(await db.prepare("SELECT run_id FROM v2_salary_release_plans WHERE status='approved' AND salary_date<=? ORDER BY salary_date LIMIT 25").bind(input.asOf).all<Row>()).results;
 const results:Array<{runId:string;queued:number;error?:string}>=[];
 for(const plan of plans){const runId=text(plan.run_id);try{const result=await queueDueV2SalaryInstructions(db,{runId,asOf:input.asOf,actorId:input.actorId});results.push({runId,queued:num(result.queued)});}catch(error){results.push({runId,queued:0,error:error instanceof Response?await error.text():error instanceof Error?error.message:String(error)});}}
 return{processed:plans.length,queued:results.reduce((sum,row)=>sum+row.queued,0),failed:results.filter(row=>row.error).length,results,liveMoneyEnabled:false};
}
