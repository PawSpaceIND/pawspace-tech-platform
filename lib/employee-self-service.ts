/**
 * Employee self-service portal - an employee's OWN window into their working life.
 * Every function here resolves the employee from the authenticated actor's email and returns ONLY
 * that employee's data: an employee can never see another employee through this module. HR/manager
 * views live elsewhere (payroll, attendance-leave, incentives directories) behind their own permissions.
 *
 * Surfaces:
 *  - profile + current compensation (structure component breakdown)
 *  - payslips (list + latest breakdown) from payroll runs, self-view only
 *  - approved incentives, salary-advance balance (recovered/outstanding), leave balances + requests
 *  - the employee's own performance row + peer rank (from the operational leaderboard facts)
 * Actions:
 *  - apply for leave (the employee is the maker; a manager approves - maker/checker preserved)
 *  - self check-in / check-out (records attendance for the employee only)
 */
import{requestLeave,recordAttendance}from"./attendance-leave";
import{salaryAdvanceDirectory}from"./salary-advance-governance";
import{employeePerformanceCenter}from"./employee-performance-center";
import{dailyIncentiveAccrualSummary}from"./daily-incentive-accrual";

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const num=(v:unknown)=>Number(v||0);
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;

/** Resolve the employee record bound to this identity (work email or linked user email). Own-record only. */
export async function resolveEmployeeForActor(db:Db,email:string):Promise<Row|null>{
 const e=text(email).toLowerCase();
 if(!e)return null;
 return await db.prepare("SELECT * FROM employees WHERE (LOWER(work_email)=? OR LOWER(user_email)=?) AND employment_status='active' LIMIT 1").bind(e,e).first<Row>().catch(()=>null);
}

/** The employee's own payslips: every payroll result for them, newest first, with the line breakdown of the latest. */
async function ownPayslips(db:Db,employeeId:string){
 const results=await db.prepare("SELECT r.id,r.run_id,r.gross_earnings,r.total_deductions,r.reimbursements,r.net_pay,p.period_start,p.period_end,p.status run_status,p.approved_at FROM employee_payroll_results r JOIN payroll_runs p ON p.id=r.run_id WHERE r.employee_id=? ORDER BY p.period_end DESC LIMIT 24").bind(employeeId).all<Row>().catch(()=>({results:[] as Row[]}));
 const list=results.results.map(r=>({resultId:text(r.id),runId:text(r.run_id),periodStart:num(r.period_start),periodEnd:num(r.period_end),status:text(r.run_status),gross:money(r.gross_earnings),deductions:money(r.total_deductions),reimbursements:money(r.reimbursements),net:money(r.net_pay)}));
 let latestLines:Row[]=[];
 if(list.length){const lines=await db.prepare("SELECT component_code,label,kind,amount FROM payroll_result_lines WHERE result_id=? ORDER BY CASE kind WHEN 'earning' THEN 0 WHEN 'reimbursement' THEN 1 WHEN 'deduction' THEN 2 ELSE 3 END,label").bind(list[0].resultId).all<Row>().catch(()=>({results:[] as Row[]}));
  latestLines=lines.results.map(l=>({code:text(l.component_code),label:text(l.label),kind:text(l.kind),amount:money(l.amount)}));}
 return{list,latest:list[0]||null,latestLines};
}

/** Current compensation: the active salary structure's component breakdown (what the employee is entitled to). */
async function ownCompensation(db:Db,employeeId:string){
 const now=Date.now();
 const assignment=await db.prepare("SELECT * FROM employee_compensation_assignments WHERE employee_id=? AND effective_from<=? AND (effective_until IS NULL OR effective_until>=?) ORDER BY effective_from DESC LIMIT 1").bind(employeeId,now,now).first<Row>().catch(()=>null);
 if(!assignment)return null;
 const structure=await db.prepare("SELECT structure_code,version,currency,components_json FROM salary_structure_versions WHERE id=?").bind(assignment.structure_id).first<Row>().catch(()=>null);
 if(!structure)return null;
 let components:Array<{code:string;label:string;kind:string;amount:number}>=[];
 try{components=(JSON.parse(text(structure.components_json)||"[]") as Row[]).map(c=>({code:text(c.code),label:text(c.label),kind:text(c.kind),amount:money(c.amount)}));}catch{components=[];}
 const gross=money(components.filter(c=>c.kind==="earning").reduce((a,c)=>a+c.amount,0));
 const deductions=money(components.filter(c=>c.kind==="deduction").reduce((a,c)=>a+c.amount,0));
 return{structureCode:text(structure.structure_code),version:num(structure.version),currency:text(structure.currency)||"INR",components,grossMonthly:gross,fixedDeductions:deductions,netMonthly:money(gross-deductions)};
}

/** Approved incentives credited to the employee (own only). */
async function ownIncentives(db:Db,employeeId:string){
 const rows=await db.prepare("SELECT r.approved_amount,r.calculated_amount,r.status,p.period_start,p.period_end,s.scheme_code FROM employee_incentive_results r JOIN employee_incentive_periods p ON p.id=r.period_id JOIN incentive_scheme_versions s ON s.id=p.scheme_id WHERE r.employee_id=? ORDER BY p.period_end DESC LIMIT 24").bind(employeeId).all<Row>().catch(()=>({results:[] as Row[]}));
 const list=rows.results.map(r=>({scheme:text(r.scheme_code),periodStart:num(r.period_start),periodEnd:num(r.period_end),status:text(r.status),calculated:money(r.calculated_amount),approved:money(r.approved_amount)}));
 return{list,approvedTotal:money(list.filter(r=>r.status==="approved").reduce((a,r)=>a+r.approved,0))};
}

/** The employee's own performance row + peer rank from the operational leaderboard (if they appear in the facts). */
async function ownPerformance(db:Db,email:string){
 const board=await employeePerformanceCenter(db,{metric:"net_collected_revenue",days:30}).catch(()=>null);
 if(!board)return null;
 const me=board.rows.find(r=>text(r.employeeEmail).toLowerCase()===text(email).toLowerCase());
 if(!me)return{appears:false,teamCode:board.teamCode,ofEmployees:board.rows.length};
 return{appears:true,teamCode:board.teamCode,ofEmployees:board.rows.length,rank:me.rank,netCollectedRevenue:me.netCollectedRevenue,bookingConversions:me.bookingConversions,qualifiedLeads:me.qualifiedLeads,firstResponseRate:me.firstResponseRate,meaningfulActions:me.meaningfulActions};
}

/** The employee's own leave balances + their own leave requests. */
async function ownLeave(db:Db,employeeId:string){
 const balances=await db.prepare("SELECT leave_code,balance FROM employee_leave_balances WHERE employee_id=? ORDER BY leave_code").bind(employeeId).all<Row>().catch(()=>({results:[] as Row[]}));
 const requests=await db.prepare("SELECT id,leave_code,start_date,end_date,units,reason,status,created_at FROM leave_requests WHERE employee_id=? ORDER BY created_at DESC LIMIT 30").bind(employeeId).all<Row>().catch(()=>({results:[] as Row[]}));
 return{balances:balances.results.map(b=>({leaveCode:text(b.leave_code),balance:num(b.balance)})),requests:requests.results.map(r=>({id:text(r.id),leaveCode:text(r.leave_code),startDate:text(r.start_date),endDate:text(r.end_date),units:num(r.units),reason:text(r.reason),status:text(r.status),createdAt:num(r.created_at)}))};
}

/** Assemble the full self-service view for the authenticated employee. Cold-DB safe; returns linked:false when no employee record. */
export async function employeeSelfServiceView(db:Db,input:{email:string}){
 const employee=await resolveEmployeeForActor(db,input.email);
 if(!employee)return{linked:false,email:text(input.email),productionReady:false};
 const employeeId=text(employee.id);
 const[compensation,payslips,incentives,dailyIncentive,advances,leave,performance,attendance]=await Promise.all([
  ownCompensation(db,employeeId),
  ownPayslips(db,employeeId),
  ownIncentives(db,employeeId),
  dailyIncentiveAccrualSummary(db,{employeeId}).catch(()=>({list:[] as Row[],total:0})),
  salaryAdvanceDirectory(db,{employeeId}).catch(()=>[] as Row[]),
  ownLeave(db,employeeId),
  ownPerformance(db,text(employee.work_email)),
  db.prepare("SELECT work_date,status,worked_minutes,exception_code FROM attendance_days WHERE employee_id=? ORDER BY work_date DESC LIMIT 14").bind(employeeId).all<Row>().catch(()=>({results:[] as Row[]})),
 ]);
 const advanceRows=(advances as Row[]).map(a=>({id:text(a.id),amount:money(a.amount),recoveryMonths:num(a.recoveryMonths),monthlyAmount:money(a.monthlyAmount),status:text(a.status),recovered:money(a.recovered),outstanding:money(a.outstanding)}));
 return{
  linked:true,
  employee:{id:employeeId,code:text(employee.employee_code),name:text(employee.display_name),workEmail:text(employee.work_email),joinedAt:num(employee.joined_at)},
  compensation,
  payslips,
  incentives,
  dailyIncentive:{list:(dailyIncentive as {list:Row[]}).list.slice(0,30),total:money((dailyIncentive as {total:number}).total)},
  advances:{list:advanceRows,outstanding:money(advanceRows.reduce((a,r)=>a+r.outstanding,0))},
  leave,
  attendance:attendance.results.map(a=>({workDate:text(a.work_date),status:text(a.status),workedMinutes:num(a.worked_minutes),exception:a.exception_code?text(a.exception_code):null})),
  performance,
  truth:{ownRecordOnly:true,payslipSource:"payroll_runs",incentiveSource:"approved_scheme_results_only",rankingType:"operational_metric_sort",productionReady:false},
 };
}

/** The employee applies for their own leave (maker). A manager approves later - the requester cannot self-approve. */
export async function applyForLeave(db:Db,input:{email:string;leaveCode:string;startDate:string;endDate:string;units:number;reason:string}){
 const employee=await resolveEmployeeForActor(db,input.email);
 if(!employee)throw new Error("No active employee record is linked to your identity");
 return await requestLeave(db,{employeeId:text(employee.id),leaveCode:text(input.leaveCode),startDate:text(input.startDate),endDate:text(input.endDate),units:Number(input.units),reason:text(input.reason),actorId:text(input.email)});
}

/** The employee records their own attendance (check-in/check-out). */
export async function selfRecordAttendance(db:Db,input:{email:string;eventType:"check_in"|"check_out";occurredAt:number;idempotencyKey:string}){
 const employee=await resolveEmployeeForActor(db,input.email);
 if(!employee)throw new Error("No active employee record is linked to your identity");
 if(input.eventType!=="check_in"&&input.eventType!=="check_out")throw new Error("Invalid attendance event");
 return await recordAttendance(db,{employeeId:text(employee.id),eventType:input.eventType,occurredAt:Number(input.occurredAt),idempotencyKey:text(input.idempotencyKey),actorId:text(input.email),source:"self_service"});
}
