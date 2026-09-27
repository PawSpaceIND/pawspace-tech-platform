import { governedJsonError } from "./governed-http-error";
type Row = Record<string, unknown>;

/** Append an assertion to the SAME D1 batch as the writes it protects. The temporary row is
 * deleted inside that transaction; a failed CHECK aborts the entire batch, not just this statement. */
export function appendPayrollCheck(db:D1Database, statements:D1PreparedStatement[], condition:string, args:unknown[]=[]){
  const id=crypto.randomUUID();
  statements.push(db.prepare(`INSERT INTO payroll_integrity_checks (id,valid) SELECT ?,CASE WHEN ${condition} THEN 1 ELSE 0 END`).bind(id,...args));
  statements.push(db.prepare("DELETE FROM payroll_integrity_checks WHERE id=?").bind(id));
}
export function payrollIntegrityConflict(){return governedJsonError({error:"Payroll changed, overlaps another run, or has incomplete evidence. Review the existing run before retrying.",code:"payroll_integrity_conflict"},409);}
export function isPayrollIntegrityConflict(error:unknown){return /payroll_integrity_condition|UNIQUE constraint failed: payroll_runs.idempotency_key/i.test(error instanceof Error?error.message:String(error));}

/** Replay is successful only for the same complete calculation, never merely an existing run ID.
 * Legacy records without a snapshot must contain results; new snapshots additionally pin every
 * employee and line count. We never delete or silently repair a historical incomplete run. */
export async function completePayrollResults(db:D1Database,run:Row,period?:{periodStart:number;periodEnd:number}){
  if(period&&(Number(run.period_start)!==period.periodStart||Number(run.period_end)!==period.periodEnd))throw payrollIntegrityConflict();
  const results=(await db.prepare("SELECT * FROM employee_payroll_results WHERE run_id=? ORDER BY employee_id").bind(run.id).all<Row>()).results;
  if(!results.length)throw payrollIntegrityConflict();
  let snapshot:Row;
  try{snapshot=JSON.parse(String(run.input_snapshot_json||"{}")) as Row;}catch{throw payrollIntegrityConflict();}
  if(!snapshot||typeof snapshot!=="object"||Array.isArray(snapshot))throw payrollIntegrityConflict();
  if(Array.isArray(snapshot.employees)){
    const expected=snapshot.employees as Row[];
    if(expected.length!==results.length||new Set(expected.map(e=>String(e.employeeId))).size!==results.length)throw payrollIntegrityConflict();
    const lines=(await db.prepare("SELECT l.result_id,COUNT(*) count FROM payroll_result_lines l JOIN employee_payroll_results r ON r.id=l.result_id WHERE r.run_id=? GROUP BY l.result_id").bind(run.id).all<Row>()).results;
    const counts=new Map(lines.map(row=>[String(row.result_id),Number(row.count)]));
    for(const e of expected){
      const result=results.find(row=>String(row.employee_id)===String(e.employeeId));
      if(!result||String(result.structure_id)!==String(e.structureId)||String(result.source_snapshot_json)!==JSON.stringify(e))throw payrollIntegrityConflict();
      const count=[e.components,e.incentives,e.salesIncentives,e.advances].reduce<number>((sum,items)=>sum+(Array.isArray(items)?items.length:0),0);
      if(count!==(counts.get(String(result.id))||0))throw payrollIntegrityConflict();
    }
  }
  for(const result of results){
    const gross=Number(result.gross_earnings),deductions=Number(result.total_deductions),reimbursement=Number(result.reimbursements),net=Number(result.net_pay);
    if(![gross,deductions,reimbursement,net].every(Number.isFinite)||net<0||Math.abs(gross-deductions+reimbursement-net)>.011)throw payrollIntegrityConflict();
  }
  return results;
}
