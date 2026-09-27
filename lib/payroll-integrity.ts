import { governedJsonError } from "./governed-http-error";
type Row = Record<string, unknown>;
const text=(value:unknown)=>String(value??"");
const cents=(value:unknown)=>Math.round(Number(value)*100);
export function appendPayrollCheck(db:D1Database, statements:D1PreparedStatement[], condition:string, args:unknown[]=[]){
 const id=crypto.randomUUID();
 statements.push(db.prepare(`INSERT INTO payroll_integrity_checks (id,valid) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`).bind(id,...args));
 statements.push(db.prepare("DELETE FROM payroll_integrity_checks WHERE id=?").bind(id));
}
export function payrollIntegrityConflict(){return governedJsonError({error:"Payroll changed, overlaps another run, or has incomplete evidence. Review the existing run before retrying.",code:"payroll_integrity_conflict"},409);}
export function isPayrollIntegrityConflict(error:unknown){return /payroll_integrity_condition|UNIQUE constraint failed: payroll_runs.idempotency_key/i.test(error instanceof Error?error.message:String(error));}
function rows(value:unknown):Row[]{if(!Array.isArray(value)||value.some(v=>!v||typeof v!=="object"||Array.isArray(v)))throw payrollIntegrityConflict();return value as Row[];}
function lineKey(row:Row){
 const amount=Number(row.amount);if(!Number.isFinite(amount)||amount<0)throw payrollIntegrityConflict();
 return JSON.stringify([text(row.component_code),text(row.label),text(row.kind),cents(amount),text(row.source_type),text(row.source_reference),text(row.policy_version)]);
}
function expectedLines(employee:Row){
 const structure=text(employee.structureId),version=text(employee.structureVersion);
 return[
  ...rows(employee.components).map(c=>({component_code:c.code,label:c.label,kind:c.kind,amount:c.amount,source_type:"salary_structure",source_reference:structure,policy_version:`salary_structure:${version}`})),
  ...rows(employee.incentives??[]).map(e=>({component_code:e.sourceType==="incentive_result"?"INCENTIVE":"INCENTIVE_REVERSAL",label:e.label,kind:e.kind,amount:e.amount,source_type:e.sourceType,source_reference:e.sourceId,policy_version:e.policyVersion})),
  ...rows(employee.salesIncentives??[]).map(e=>({component_code:"SALES_INCENTIVE",label:e.label,kind:e.kind,amount:e.amount,source_type:e.sourceType,source_reference:e.sourceId,policy_version:e.policyVersion})),
  ...rows(employee.advances??[]).map(e=>({component_code:"ADVANCE_RECOVERY",label:e.label,kind:"deduction",amount:e.amount,source_type:"salary_advance",source_reference:e.installmentId,policy_version:`salary_advance:${text(e.advanceId)}`})),
 ];
}
/** Verify the whole saved artifact, not only the run identifier or number of component lines.
 * Legacy incomplete rows are refused for reconciliation; they are never silently repaired. */
export async function completePayrollResults(db:D1Database,run:Row,period?:{periodStart:number;periodEnd:number}){
 if(period&&(Number(run.period_start)!==period.periodStart||Number(run.period_end)!==period.periodEnd))throw payrollIntegrityConflict();
 if(!["calculated","reviewed","approved","payment_prepared","paid_sandbox","paid"].includes(text(run.status)))throw payrollIntegrityConflict();
 const results=(await db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=? ORDER BY employee_id").bind(run.id).all<Row>()).results;
 if(!results.length)throw payrollIntegrityConflict();
 let snapshot:Row;try{snapshot=JSON.parse(text(run.input_snapshot_json)||"{}");}catch{throw payrollIntegrityConflict();}
 if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))throw payrollIntegrityConflict();
 const lines=(await db.prepare("SELECT l.* FROM payroll_result_lines l JOIN employee_payroll_results r ON r.id=l.result_id WHERE r.run_id=?").bind(run.id).all<Row>()).results;
 const slips=(await db.prepare("SELECT employee_id,result_id FROM payslips WHERE run_id=?").bind(run.id).all<Row>()).results;
 if(slips.length!==results.length||results.some(r=>slips.filter(p=>text(p.employee_id)===text(r.employee_id)&&text(p.result_id)===text(r.id)).length!==1))throw payrollIntegrityConflict();
 const byResult=new Map<string,Row[]>();for(const line of lines){const key=text(line.result_id);const group=byResult.get(key)||[];group.push(line);byResult.set(key,group);}
 if(Array.isArray(snapshot.employees)){
  const expected=rows(snapshot.employees);
  if(expected.length!==results.length||new Set(expected.map(e=>text(e.employeeId))).size!==results.length)throw payrollIntegrityConflict();
  for(const e of expected){
   const result=results.find(row=>text(row.employee_id)===text(e.employeeId));
   if(!result||text(result.structure_id)!==text(e.structureId)||text(result.source_snapshot_json)!==JSON.stringify(e))throw payrollIntegrityConflict();
   const actual=(byResult.get(text(result.id))||[]).map(lineKey).sort();
   const required=expectedLines(e).map(lineKey).sort();
   if(JSON.stringify(actual)!==JSON.stringify(required))throw payrollIntegrityConflict();
  }
 }
 for(const result of results){
  const own=byResult.get(text(result.id))||[];if(!own.length)throw payrollIntegrityConflict();
  const totals={earning:0,deduction:0,reimbursement:0,employer_cost:0};
  for(const line of own){lineKey(line);const kind=text(line.kind);if(!Object.hasOwn(totals,kind))throw payrollIntegrityConflict();totals[kind as keyof typeof totals]+=cents(line.amount);}
  for(const[field,kind]of[["gross_earnings","earning"],["total_deductions","deduction"],["reimbursements","reimbursement"],["employer_cost","employer_cost"]]as const){if(!Number.isFinite(Number(result[field]))||cents(result[field])!==totals[kind])throw payrollIntegrityConflict();}
  const net=Number(result.net_pay);if(!Number.isFinite(net)||net<0||cents(net)!==totals.earning-totals.deduction+totals.reimbursement)throw payrollIntegrityConflict();
 }
 return results;
}
