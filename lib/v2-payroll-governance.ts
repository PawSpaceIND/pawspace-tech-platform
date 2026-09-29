import{completePayrollResults,appendPayrollCheck,isPayrollIntegrityConflict,payrollIntegrityConflict}from"./payroll-integrity";
import{ensurePayrollTables,calculatePayroll}from"./payroll-engine";
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

function jsonList(v:unknown):string[]{
 let value:unknown;
 try{value=JSON.parse(text(v));}catch{throw bad("V2 payroll policy list is unreadable; correct the policy before calculating deductions");}
 if(!Array.isArray(value)||value.some(item=>typeof item!=="string"||!text(item)))throw bad("V2 payroll policy lists must contain valid codes");
 return value.map(text);
}
export function v2PayrollBoolean(value:unknown,label:string):boolean{
 if(typeof value!=="boolean")throw bad(`${label} must be a JSON boolean`,400);
 return value;
}
export function v2PayrollReleaseAt(value:unknown,minimum=1):number{
 if(typeof value!=="number"||!Number.isSafeInteger(value)||value<minimum||value>8640000000000000)
  throw bad("Valid salary release date at or after the plan salary date is required",400);
 return value;
}
async function activePolicy(db:Db){return db.prepare("SELECT * FROM v2_payroll_policies WHERE status='active' ORDER BY version DESC LIMIT 1").first<Row>();}
async function event(db:Db,input:{runId?:string;employeeId?:string;action:string;actorId:string;detail?:unknown}){await db.prepare("INSERT INTO v2_payroll_governance_events (id,run_id,employee_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?,?)").bind(uid("V2PGE"),input.runId||null,input.employeeId||null,input.action,input.actorId,JSON.stringify(input.detail||{}),Date.now()).run();}

export async function saveV2PayrollPolicy(db:Db,input:V2PayrollPolicyInput){
 await ensureV2PayrollGovernance(db);
 if(!Number.isInteger(input.salaryDay)||input.salaryDay<1||input.salaryDay>28)throw bad("Salary day must be between 1 and 28",400);
 if(!Number.isInteger(input.cutoffDay)||input.cutoffDay<1||input.cutoffDay>28)throw bad("Payroll cutoff day must be between 1 and 28",400);
 v2PayrollBoolean(input.authorizedDeductionEnabled,"Authorized deduction enabled");
 if(input.authorizedDeductionEnabled&&text(input.authorizedDeductionPolicyReference).length<8)throw bad("Authorized deduction policy reference is required",400);
 if(!Number.isFinite(input.maxAuthorizedDeductionPercent)||input.maxAuthorizedDeductionPercent<0||input.maxAuthorizedDeductionPercent>100)throw bad("Authorized deduction cap must be between 0 and 100",400);
 const prior=await activePolicy(db),version=num(prior?.version)+1,now=Date.now(),id=uid("V2POL");
 if(prior)await db.prepare("UPDATE v2_payroll_policies SET status='retired' WHERE id=?").bind(prior.id).run();
 await db.prepare("INSERT INTO v2_payroll_policies (id,version,status,salary_day,cutoff_day,paid_leave_codes_json,unpaid_leave_codes_json,lop_component_codes_json,authorized_deduction_enabled,authorized_deduction_policy_reference,authorized_deduction_max_percent,created_by,created_at) VALUES (?,?, 'active',?,?,?,?,?,?,?,?,?,?)").bind(id,version,input.salaryDay,input.cutoffDay,JSON.stringify(input.paidLeaveCodes),JSON.stringify(input.unpaidLeaveCodes),JSON.stringify(input.lopDeductibleComponentCodes),input.authorizedDeductionEnabled?1:0,text(input.authorizedDeductionPolicyReference)||null,input.maxAuthorizedDeductionPercent,input.actorId,now).run();
 return{id,version};
}

/** Explicit V2 selection binds governance even when no deduction is ultimately applied. */
async function enrollV2PayrollRun(db:Db,runId:string){
 const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(runId).first<Row>();
 if(!run||text(run.status)!=="calculated")throw bad("Select V2 governance before payroll review");
 const snapshot=JSON.parse(text(run.input_snapshot_json)) as Row;
 if(snapshot.payrollScope==="v2")return;
 if(snapshot.payrollScope!==undefined)throw payrollIntegrityConflict();
 await completePayrollResults(db,run);
 const updated=JSON.stringify({...snapshot,payrollScope:"v2"});
 const saved=await db.prepare("UPDATE payroll_runs SET input_snapshot_json=? WHERE id=? AND status='calculated' AND input_snapshot_json=?").bind(updated,runId,run.input_snapshot_json).run();
 if(num(saved.meta?.changes)!==1)throw payrollIntegrityConflict();
}

export async function calculateV2Payroll(db:Db,input:{periodStart:number;periodEnd:number;idempotencyKey:string;actorId:string}){
 await ensureV2PayrollGovernance(db);
 return calculatePayroll(db,{...input,governanceScope:"v2"});
}

export async function deriveV2Lop(db:Db,input:{runId:string;employeeId:string;actorId:string;evidenceReference:string}){
 await ensureV2PayrollGovernance(db);const policy=await activePolicy(db);if(!policy)throw bad("V2 payroll policy is not configured");
 const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=? AND status='calculated'").bind(input.runId).first<Row>();if(!run)throw bad("Calculated payroll run is required");
 const result=await db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=? AND employee_id=?").bind(input.runId,input.employeeId).first<Row>();if(!result)throw bad("Employee payroll result not found",404);
 await enrollV2PayrollRun(db,input.runId);
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
 if(!Number.isFinite(input.amount)||!Number.isSafeInteger(Math.round(input.amount*100))||money(input.amount)<=0||text(input.reason).length<8||text(input.evidenceReference).length<4)throw bad("Amount, reason and evidence are required",400);
 const result=await db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=? AND employee_id=?").bind(input.runId,input.employeeId).first<Row>();if(!result)throw bad("Employee payroll result not found",404);
 const cap=money(num(result.gross_earnings)*num(policy.authorized_deduction_max_percent)/100);if(input.amount>cap)throw bad("Deduction exceeds the configured policy cap");
 await enrollV2PayrollRun(db,input.runId);
 const id=uid("V2ADJ");await db.prepare("INSERT INTO v2_payroll_adjustments (id,run_id,employee_id,kind,units,amount,reason,evidence_reference,policy_version,status,requested_by,created_at) VALUES (?,?,?,?,0,?,?,?,?, 'pending_hr',?,?)").bind(id,input.runId,input.employeeId,"authorized_deduction",money(input.amount),text(input.reason),text(input.evidenceReference),num(policy.version),input.actorId,Date.now()).run();
 await event(db,{runId:input.runId,employeeId:input.employeeId,action:"authorized_deduction_proposed",actorId:input.actorId,detail:{amount:money(input.amount)}});
 return{id,status:"pending_hr"};
}

export async function decideV2Adjustment(db:Db,input:{adjustmentId:string;stage:"hr"|"finance";decision:"approve"|"reject";actorId:string}){
 if(!["hr","finance"].includes(input.stage)||!["approve","reject"].includes(input.decision))throw bad("Valid approval stage and explicit decision are required",400);
 await ensureV2PayrollGovernance(db);const row=await db.prepare("SELECT * FROM v2_payroll_adjustments WHERE id=?").bind(input.adjustmentId).first<Row>();if(!row)throw bad("Adjustment not found",404);const now=Date.now();
 if(input.decision==="reject"){const changed=await db.prepare("UPDATE v2_payroll_adjustments SET status='rejected',rejected_by=?,rejected_at=? WHERE id=? AND status IN ('pending_hr','pending_finance') AND applied_at IS NULL").bind(input.actorId,now,input.adjustmentId).run();if(num(changed.meta?.changes)!==1)throw bad("Adjustment changed; refresh before deciding");await event(db,{runId:text(row.run_id),employeeId:text(row.employee_id),action:"adjustment_rejected",actorId:input.actorId,detail:{stage:input.stage}});return{status:"rejected"};}
 if(input.stage==="hr"){if(text(row.status)!=="pending_hr")throw bad("Adjustment is not awaiting HR approval");if(text(row.requested_by).toLowerCase()===input.actorId.toLowerCase())throw bad("Requester cannot approve their own payroll adjustment");const changed=await db.prepare("UPDATE v2_payroll_adjustments SET status='pending_finance',hr_approved_by=?,hr_approved_at=? WHERE id=? AND status='pending_hr' AND applied_at IS NULL").bind(input.actorId,now,input.adjustmentId).run();if(num(changed.meta?.changes)!==1)throw bad("Adjustment changed; refresh before deciding");return{status:"pending_finance"};}
 if(text(row.status)!=="pending_finance")throw bad("Adjustment is not awaiting Finance approval");if([row.requested_by,row.hr_approved_by].some(v=>text(v).toLowerCase()===input.actorId.toLowerCase()))throw bad("Finance approver must be independent");const changed=await db.prepare("UPDATE v2_payroll_adjustments SET status='approved',finance_approved_by=?,finance_approved_at=? WHERE id=? AND status='pending_finance' AND applied_at IS NULL").bind(input.actorId,now,input.adjustmentId).run();if(num(changed.meta?.changes)!==1)throw bad("Adjustment changed; refresh before deciding");return{status:"approved"};
}

export async function applyApprovedV2Adjustments(db:Db,input:{runId:string;actorId:string}){
 await ensureV2PayrollGovernance(db);
 await enrollV2PayrollRun(db,input.runId);
 const run=await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();
 if(!run||text(run.status)!=="calculated")throw bad("Adjustments must be applied before payroll review");
 const results=await completePayrollResults(db,run);
 const adjustments=(await db.prepare("SELECT * FROM v2_payroll_adjustments WHERE run_id=? AND status='approved' AND applied_at IS NULL ORDER BY created_at,id").bind(input.runId).all<Row>()).results;
 if(!adjustments.length)return{runId:input.runId,applied:0};
 const statements:D1PreparedStatement[]=[],now=Date.now();
 const updates=new Map<string,{row:Row;deduction:number;net:number}>();
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM payroll_runs WHERE id=? AND status='calculated' AND input_snapshot_json=?)",[input.runId,run.input_snapshot_json]);
 for(const a of adjustments){
  const result=results.find(r=>text(r.employee_id)===text(a.employee_id));if(!result)throw payrollIntegrityConflict();
  const amount=money(a.amount),delta=Math.round(amount*100),actors=[a.requested_by,a.hr_approved_by,a.finance_approved_by].map(v=>text(v).toLowerCase());
  if(!["lop","authorized_deduction"].includes(text(a.kind))||!Number.isFinite(amount)||delta<=0||!Number.isSafeInteger(delta)||
     actors.some(v=>!v)||new Set(actors).size!==3||!(num(a.hr_approved_at)>0)||!(num(a.finance_approved_at)>0)||
     !Number.isSafeInteger(num(a.policy_version))||num(a.policy_version)<1||!text(a.reason)||!text(a.evidence_reference))throw payrollIntegrityConflict();
  const total=updates.get(text(result.id))??{row:result,deduction:Math.round(num(result.total_deductions)*100),net:Math.round(num(result.net_pay)*100)};
  if(!Number.isSafeInteger(total.net)||!Number.isSafeInteger(total.deduction)||total.deduction>Number.MAX_SAFE_INTEGER-delta)throw payrollIntegrityConflict();
  if(total.net<delta)throw bad("Approved deductions would create negative net pay");
  total.deduction+=delta;total.net-=delta;updates.set(text(result.id),total);
  appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_payroll_adjustments WHERE id=? AND run_id=? AND employee_id=? AND kind=? AND amount=? AND policy_version=? AND status='approved' AND applied_at IS NULL AND requested_by=? AND hr_approved_by=? AND finance_approved_by=? AND hr_approved_at=? AND finance_approved_at=?) AND NOT EXISTS(SELECT 1 FROM payroll_result_lines WHERE source_type='v2_hr_payroll_adjustment' AND source_reference=?)",[a.id,input.runId,a.employee_id,a.kind,a.amount,a.policy_version,a.requested_by,a.hr_approved_by,a.finance_approved_by,a.hr_approved_at,a.finance_approved_at,a.id]);
  const component=text(a.kind)==="lop"?"LOP":"AUTHORIZED_DEDUCTION",label=text(a.kind)==="lop"?"Loss of pay":"Authorized HR deduction",lineId=`V2PAYLINE:${a.id}`;
  statements.push(db.prepare("INSERT INTO payroll_result_lines (id,result_id,component_code,label,kind,amount,source_type,source_reference,policy_version) VALUES (?,?,?,?,'deduction',?,'v2_hr_payroll_adjustment',?,?)").bind(lineId,result.id,component,label,amount,a.id,`v2_policy:${a.policy_version}`));
  statements.push(db.prepare("UPDATE v2_payroll_adjustments SET status='applied',applied_at=? WHERE id=? AND status='approved' AND applied_at IS NULL").bind(now,a.id));
  appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_payroll_adjustments WHERE id=? AND status='applied' AND applied_at=?) AND (SELECT COUNT(*) FROM payroll_result_lines WHERE source_type='v2_hr_payroll_adjustment' AND source_reference=?)=1 AND EXISTS(SELECT 1 FROM payroll_result_lines WHERE id=? AND result_id=? AND component_code=? AND label=? AND kind='deduction' AND amount=? AND policy_version=?)",[a.id,now,a.id,lineId,result.id,component,label,amount,`v2_policy:${a.policy_version}`]);
 }
 for(const total of updates.values()){
  const r=total.row;
  appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM employee_payroll_results WHERE id=? AND run_id=? AND total_deductions=? AND net_pay=? AND source_snapshot_json=?)",[r.id,input.runId,r.total_deductions,r.net_pay,r.source_snapshot_json]);
  statements.push(db.prepare("UPDATE employee_payroll_results SET total_deductions=?,net_pay=? WHERE id=?").bind(total.deduction/100,total.net/100,r.id));
  appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM employee_payroll_results WHERE id=? AND total_deductions=? AND net_pay=?)",[r.id,total.deduction/100,total.net/100]);
 }
 // Retain original salary inputs; separately bind the approved V2 adjustment identities.
 const snapshot=JSON.parse(String(run.input_snapshot_json)) as Row;
 snapshot.v2PayrollAdjustments=[...((snapshot.v2PayrollAdjustments??[]) as string[]),...adjustments.map(a=>text(a.id))];
 const updatedSnapshot=JSON.stringify(snapshot);
 statements.push(db.prepare("UPDATE payroll_runs SET input_snapshot_json=? WHERE id=? AND status='calculated' AND input_snapshot_json=?").bind(updatedSnapshot,input.runId,run.input_snapshot_json));
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM payroll_runs WHERE id=? AND status='calculated' AND input_snapshot_json=?)",[input.runId,updatedSnapshot]);
 statements.push(db.prepare("INSERT INTO v2_payroll_governance_events (id,run_id,employee_id,action,actor_id,detail_json,created_at) VALUES (?,?,NULL,'adjustments_applied',?,?,?)").bind(uid("V2PGE"),input.runId,input.actorId,JSON.stringify({count:adjustments.length,adjustmentIds:adjustments.map(a=>a.id)}),now));
 try{await db.batch(statements);}catch(error){if(isPayrollIntegrityConflict(error))throw payrollIntegrityConflict();throw error;}
 return{runId:input.runId,applied:adjustments.length};
}

export async function createV2SalaryReleasePlan(db:Db,input:{runId:string;salaryDate:number;items?:Array<{employeeId:string;releaseAt?:number;batchCode?:string;hold?:boolean;holdReason?:string}>;actorId:string}){
 await ensureV2PayrollGovernance(db);const run=await db.prepare("SELECT status FROM payroll_runs WHERE id=?").bind(input.runId).first<Row>();if(!run||text(run.status)!=="approved")throw bad("Approved payroll is required before release planning");
 if(v2PayrollReleaseAt(input.salaryDate)<Date.now()-86400000)throw bad("Valid salary date is required",400);
 const prior=await db.prepare("SELECT id FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(prior)throw bad("Salary release plan already exists");
 const results=(await db.prepare("SELECT id,employee_id,net_pay FROM employee_payroll_results WHERE run_id=? AND net_pay>0 ORDER BY employee_id").bind(input.runId).all<Row>()).results;if(!results.length)throw bad("No payable salaries found");
 if(input.items!==undefined&&!Array.isArray(input.items))throw bad("Salary release items must be an array",400);
 const requested=new Map<string,NonNullable<typeof input.items>[number]>();
 for(const item of input.items??[]){
  if(!item||typeof item!=="object"||Array.isArray(item)||typeof item.employeeId!=="string"||!text(item.employeeId))throw bad("Each salary release item needs a valid employee identity",400);
  const employeeId=text(item.employeeId);
  if(requested.has(employeeId)||results.filter(result=>text(result.employee_id)===employeeId).length!==1)throw bad("Salary release employee is unknown or duplicated",400);
  requested.set(employeeId,item);
 }
 const planId=uid("V2PLAN"),now=Date.now();
 const statements:D1PreparedStatement[]=[db.prepare("INSERT INTO v2_salary_release_plans (id,run_id,salary_date,status,created_by,created_at,updated_at) VALUES (?,? ,?,'draft',?,?,?)").bind(planId,input.runId,input.salaryDate,input.actorId,now,now)];
 for(const result of results){const cfg=requested.get(text(result.employee_id)),releaseAt=v2PayrollReleaseAt(cfg?.releaseAt===undefined?input.salaryDate:cfg.releaseAt,input.salaryDate),held=v2PayrollBoolean(cfg?.hold===undefined?false:cfg.hold,"Salary hold"),reason=text(cfg?.holdReason);if(held&&reason.length<8)throw bad("Held salary requires a clear reason",400);statements.push(db.prepare("INSERT INTO v2_salary_release_items (id,plan_id,result_id,employee_id,amount,batch_code,release_at,hold_status,hold_reason,held_by,held_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)").bind(uid("V2ITEM"),planId,result.id,result.employee_id,money(result.net_pay),text(cfg?.batchCode)||"BATCH-1",releaseAt,held?"held":"ready",held?reason:null,held?input.actorId:null,held?now:null,now,now));}
 await db.batch(statements);await event(db,{runId:input.runId,action:"release_plan_created",actorId:input.actorId,detail:{salaryDate:input.salaryDate,count:results.length}});return{planId,status:"draft",count:results.length};
}

export async function approveV2SalaryReleasePlan(db:Db,input:{runId:string;stage:"hr"|"finance";actorId:string}){
 if(!["hr","finance"].includes(input.stage))throw bad("Valid release approval stage is required",400);
 await ensureV2PayrollGovernance(db);const plan=await db.prepare("SELECT * FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(!plan)throw bad("Release plan not found",404);const now=Date.now();
 if(input.stage==="hr"){
  if(text(plan.status)!=="draft"||text(plan.hr_approved_by))throw bad("Plan is not awaiting HR approval");
  if(text(plan.created_by).toLowerCase()===input.actorId.toLowerCase())throw bad("Plan creator cannot provide HR approval");
  const changed=await db.prepare("UPDATE v2_salary_release_plans SET status='pending_finance',hr_approved_by=?,hr_approved_at=?,updated_at=? WHERE id=? AND status='draft' AND hr_approved_by IS NULL AND finance_approved_by IS NULL").bind(input.actorId,now,now,plan.id).run();
  if(num(changed.meta?.changes)!==1)throw bad("Release plan changed; refresh before approving");return{status:"pending_finance"};
 }
 if(text(plan.status)!=="pending_finance"||!text(plan.hr_approved_by)||!(num(plan.hr_approved_at)>0))throw bad("HR approval is required first");
 if([plan.created_by,plan.hr_approved_by].some(v=>text(v).toLowerCase()===input.actorId.toLowerCase()))throw bad("Finance approval must be independent");
 const changed=await db.prepare("UPDATE v2_salary_release_plans SET status='approved',finance_approved_by=?,finance_approved_at=?,updated_at=? WHERE id=? AND status='pending_finance' AND hr_approved_by=? AND hr_approved_at=? AND finance_approved_by IS NULL").bind(input.actorId,now,now,plan.id,plan.hr_approved_by,plan.hr_approved_at).run();
 if(num(changed.meta?.changes)!==1)throw bad("Release plan changed; refresh before approving");return{status:"approved"};
}

export async function setV2SalaryHold(db:Db,input:{runId:string;employeeId:string;hold:boolean;reason?:string;releaseAt?:number;actorId:string}){
 await ensureV2PayrollGovernance(db);const plan=await db.prepare("SELECT * FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();if(!plan)throw bad("Release plan not found",404);
 if(!["draft","pending_finance"].includes(text(plan.status)))throw bad("Approved plan is immutable; create a governed release action instead");
 v2PayrollBoolean(input.hold,"Salary hold");if(input.releaseAt!==undefined)v2PayrollReleaseAt(input.releaseAt,num(plan.salary_date));
 const now=Date.now(),reason=text(input.reason);if(input.hold&&reason.length<8)throw bad("Hold reason is required",400);
 const statements:D1PreparedStatement[]=[];
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_salary_release_plans WHERE id=? AND status=? AND hr_approved_by IS ? AND hr_approved_at IS ? AND finance_approved_by IS NULL)",[plan.id,plan.status,plan.hr_approved_by??null,plan.hr_approved_at??null]);
 statements.push(db.prepare("UPDATE v2_salary_release_items SET hold_status=?,hold_reason=?,held_by=?,held_at=?,release_at=COALESCE(?,release_at),updated_at=? WHERE plan_id=? AND employee_id=?").bind(input.hold?"held":"ready",input.hold?reason:null,input.hold?input.actorId:null,input.hold?now:null,input.releaseAt??null,now,plan.id,input.employeeId));
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_salary_release_items WHERE plan_id=? AND employee_id=? AND hold_status=? AND hold_reason IS ?)",[plan.id,input.employeeId,input.hold?"held":"ready",input.hold?reason:null]);
 // A changed item requires the two independent approvers to review the revised plan.
 statements.push(db.prepare("UPDATE v2_salary_release_plans SET status='draft',hr_approved_by=NULL,hr_approved_at=NULL,finance_approved_by=NULL,finance_approved_at=NULL,updated_at=? WHERE id=?").bind(now,plan.id));
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_salary_release_plans WHERE id=? AND status='draft' AND hr_approved_by IS NULL AND finance_approved_by IS NULL)",[plan.id]);
 statements.push(db.prepare("INSERT INTO v2_payroll_governance_events (id,run_id,employee_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,'release_plan_item_changed',?,?,?)").bind(uid("V2PGE"),input.runId,input.employeeId,input.actorId,JSON.stringify({hold:input.hold,releaseAt:input.releaseAt??null,previousHrApprovalInvalidated:Boolean(plan.hr_approved_by)}),now));
 try{await db.batch(statements);}catch(error){if(isPayrollIntegrityConflict(error))throw payrollIntegrityConflict();throw error;}
 return{employeeId:input.employeeId,hold:input.hold,approvalRequired:true};
}

export async function releaseHeldV2Salary(db:Db,input:{runId:string;employeeId:string;releaseAt:number;actorId:string}){
 v2PayrollReleaseAt(input.releaseAt);await ensureV2PayrollGovernance(db);
 const plan=await db.prepare("SELECT * FROM v2_salary_release_plans WHERE run_id=?").bind(input.runId).first<Row>();
 if(!plan||text(plan.status)!=="approved")throw bad("Approved release plan is required");
 v2PayrollReleaseAt(input.releaseAt,num(plan.salary_date));
 const item=await db.prepare("SELECT * FROM v2_salary_release_items WHERE plan_id=? AND employee_id=? AND hold_status='held'").bind(plan.id,input.employeeId).first<Row>();
 if(!item)throw bad("Held salary item not found");
 const now=Date.now(),statements:D1PreparedStatement[]=[];
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_salary_release_plans WHERE id=? AND status='approved' AND hr_approved_by IS ? AND finance_approved_by IS ? AND updated_at=?)",[plan.id,plan.hr_approved_by??null,plan.finance_approved_by??null,plan.updated_at]);
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_salary_release_items WHERE id=? AND plan_id=? AND employee_id=? AND hold_status='held' AND release_at=? AND updated_at=?)",[item.id,plan.id,input.employeeId,item.release_at,item.updated_at]);
 const instructions=await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='employee_salary_instructions'").first<Row>();
 if(instructions)appendPayrollCheck(db,statements,"NOT EXISTS(SELECT 1 FROM employee_salary_instructions WHERE result_id=?)",[item.result_id]);
 statements.push(db.prepare("UPDATE v2_salary_release_items SET hold_status='ready',release_at=?,released_by=?,released_at=?,updated_at=? WHERE id=?").bind(input.releaseAt,input.actorId,now,now,item.id));
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_salary_release_items WHERE id=? AND hold_status='ready' AND release_at=?)",[item.id,input.releaseAt]);
 // The schedule amendment is not a payment authorization: both approvers review the new plan.
 statements.push(db.prepare("UPDATE v2_salary_release_plans SET status='draft',hr_approved_by=NULL,hr_approved_at=NULL,finance_approved_by=NULL,finance_approved_at=NULL,updated_at=? WHERE id=?").bind(now,plan.id));
 appendPayrollCheck(db,statements,"EXISTS(SELECT 1 FROM v2_salary_release_plans WHERE id=? AND status='draft' AND hr_approved_by IS NULL AND finance_approved_by IS NULL)",[plan.id]);
 statements.push(db.prepare("INSERT INTO v2_payroll_governance_events (id,run_id,employee_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,'held_salary_release_proposed',?,?,?)").bind(uid("V2PGE"),input.runId,input.employeeId,input.actorId,JSON.stringify({releaseAt:input.releaseAt,previousHrApproval:plan.hr_approved_by,previousFinanceApproval:plan.finance_approved_by,approvalRequired:true}),now));
 try{await db.batch(statements);}catch(error){if(isPayrollIntegrityConflict(error))throw payrollIntegrityConflict();throw error;}
 return{employeeId:input.employeeId,status:"pending_approval",releaseAt:input.releaseAt,approvalRequired:true};
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
