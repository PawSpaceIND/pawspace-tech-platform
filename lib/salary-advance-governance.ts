/**
 * Salary advances with a CONFIGURABLE N-month recovery schedule. HR grants an employee an advance;
 * the number of deduction months is set per advance (1..24). On approval (maker/checker - the
 * requester cannot approve) the schedule is generated: amount/months per month, the last instalment
 * absorbing the rounding remainder so recovery is exact to the paisa. Each payroll run then deducts
 * the due instalment AUTOMATICALLY (same hook pattern as approved incentives), marks it recovered
 * against that run, and closes the advance when the last instalment is taken. One instalment per
 * advance per run - a re-run or an extra run in the month never double-deducts. HR can cancel a
 * pending advance or waive the remaining balance (reason required, audited).
 */

type Db=D1Database;
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim();
const money=(v:unknown)=>Math.round(Number(v||0)*100)/100;
const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;

export type AdvanceDeductionEntry={installmentId:string;advanceId:string;label:string;amount:number;seq:number;of:number};

export async function ensureSalaryAdvanceTables(db:Db){await db.batch([
 db.prepare("CREATE TABLE IF NOT EXISTS salary_advances (id TEXT PRIMARY KEY,employee_id TEXT NOT NULL,amount REAL NOT NULL,recovery_months INTEGER NOT NULL,monthly_amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pending',reason TEXT NOT NULL,requested_by TEXT NOT NULL,approved_by TEXT,approved_at INTEGER,closed_reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)"),
 db.prepare("CREATE TABLE IF NOT EXISTS salary_advance_installments (id TEXT PRIMARY KEY,advance_id TEXT NOT NULL,employee_id TEXT NOT NULL,seq INTEGER NOT NULL,amount REAL NOT NULL,status TEXT NOT NULL DEFAULT 'pending',payroll_run_id TEXT,payroll_result_id TEXT,deducted_at INTEGER,waive_reason TEXT,UNIQUE(advance_id,seq))"),
 db.prepare("CREATE INDEX IF NOT EXISTS idx_advance_installments_emp ON salary_advance_installments(employee_id,status)"),
]);}

/** HR requests an advance for an employee, defining the recovery months (1..24). Maker step. */
export async function requestSalaryAdvance(db:Db,input:{employeeId:string;amount:number;recoveryMonths:number;reason:string;actorId:string}){
 await ensureSalaryAdvanceTables(db);
 const amount=money(input.amount),months=Math.floor(Number(input.recoveryMonths));
 if(!text(input.employeeId))throw new Error("Employee is required");
 if(!(amount>0))throw new Error("Advance amount must be positive");
 if(!(months>=1&&months<=24))throw new Error("Recovery months must be between 1 and 24");
 if(text(input.reason).length<8)throw new Error("A clear advance reason is required");
 const employee=await db.prepare("SELECT id FROM employees WHERE id=? AND employment_status='active'").bind(input.employeeId).first<Row>().catch(()=>null);
 if(!employee)throw new Error("Active employee is required");
 const open=await db.prepare("SELECT id FROM salary_advances WHERE employee_id=? AND status IN ('pending','active')").bind(input.employeeId).first<Row>();
 if(open)throw new Error("The employee already has a pending or active advance - close it before granting another");
 const id=uid("ADV"),now=Date.now(),monthly=money(amount/months);
 await db.prepare("INSERT INTO salary_advances (id,employee_id,amount,recovery_months,monthly_amount,status,reason,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,'pending',?,?,?,?)")
  .bind(id,input.employeeId,amount,months,monthly,text(input.reason),input.actorId,now,now).run();
 return{id,employeeId:input.employeeId,amount,recoveryMonths:months,monthlyAmount:monthly,status:"pending"};
}

/** Checker approval (requester cannot approve their own). Generates the exact recovery schedule. */
export async function approveSalaryAdvance(db:Db,input:{advanceId:string;actorId:string}){
 await ensureSalaryAdvanceTables(db);
 const adv=await db.prepare("SELECT * FROM salary_advances WHERE id=? AND status='pending'").bind(input.advanceId).first<Row>();
 if(!adv)throw new Error("Pending salary advance not found");
 if(text(adv.requested_by)===text(input.actorId))throw new Error("Maker/checker: the requester cannot approve their own advance");
 const months=Number(adv.recovery_months),amount=money(adv.amount),monthly=money(amount/months),now=Date.now();
 const statements=[db.prepare("UPDATE salary_advances SET status='active',approved_by=?,approved_at=?,updated_at=? WHERE id=? AND status='pending'").bind(input.actorId,now,now,input.advanceId)];
 let scheduled=0;
 for(let seq=1;seq<=months;seq++){const instalment=seq===months?money(amount-monthly*(months-1)):monthly;scheduled=money(scheduled+instalment);
  statements.push(db.prepare("INSERT INTO salary_advance_installments (id,advance_id,employee_id,seq,amount,status) VALUES (?,?,?,?,?,'pending')").bind(uid("ADVI"),input.advanceId,text(adv.employee_id),seq,instalment));}
 if(scheduled!==amount)throw new Error("Advance schedule does not reconcile to the approved amount");
 await db.batch(statements);
 return{advanceId:input.advanceId,status:"active",installments:months,monthlyAmount:monthly};
}

/** The instalment due in this payroll run: ONE pending instalment per active advance (lowest seq).
 * Same contract as approved incentives - the payroll engine includes it and marks it recovered. */
export async function advanceDeductionEntriesForPayroll(db:Db,input:{employeeId:string}):Promise<AdvanceDeductionEntry[]>{
 await ensureSalaryAdvanceTables(db);
 const rows=await db.prepare("SELECT i.id,i.advance_id,i.seq,i.amount,a.recovery_months FROM salary_advance_installments i JOIN salary_advances a ON a.id=i.advance_id WHERE i.employee_id=? AND i.status='pending' AND a.status='active' AND i.seq=(SELECT MIN(seq) FROM salary_advance_installments x WHERE x.advance_id=i.advance_id AND x.status='pending')").bind(input.employeeId).all<Row>();
 return rows.results.map(r=>({installmentId:text(r.id),advanceId:text(r.advance_id),label:`Advance recovery ${Number(r.seq)}/${Number(r.recovery_months)}`,amount:money(r.amount),seq:Number(r.seq),of:Number(r.recovery_months)}));
}

/** Mark instalments deducted against a payroll run; close the advance when fully recovered. */
export async function markAdvanceInstallmentsDeducted(db:Db,input:{entries:AdvanceDeductionEntry[];payrollRunId:string;payrollResultId:string;employeeId:string}){
 await ensureSalaryAdvanceTables(db);
 const now=Date.now();
 for(const e of input.entries){
  await db.prepare("UPDATE salary_advance_installments SET status='deducted',payroll_run_id=?,payroll_result_id=?,deducted_at=? WHERE id=? AND status='pending'").bind(input.payrollRunId,input.payrollResultId,now,e.installmentId).run();
  const left=await db.prepare("SELECT COUNT(*) c FROM salary_advance_installments WHERE advance_id=? AND status='pending'").bind(e.advanceId).first<Row>();
  if(Number(left?.c||0)===0)await db.prepare("UPDATE salary_advances SET status='recovered',closed_reason='fully_recovered',updated_at=? WHERE id=? AND status='active'").bind(now,e.advanceId).run();
 }
}

/** Cancel a pending advance, or waive the remaining balance of an active one (reason required). */
export async function closeSalaryAdvance(db:Db,input:{advanceId:string;action:"cancel"|"waive_remaining";reason:string;actorId:string}){
 await ensureSalaryAdvanceTables(db);
 if(text(input.reason).length<8)throw new Error("A clear reason is required");
 const adv=await db.prepare("SELECT * FROM salary_advances WHERE id=?").bind(input.advanceId).first<Row>();
 if(!adv)throw new Error("Salary advance not found");
 const now=Date.now();
 if(input.action==="cancel"){
  if(text(adv.status)!=="pending")throw new Error("Only a pending advance can be cancelled");
  await db.prepare("UPDATE salary_advances SET status='cancelled',closed_reason=?,updated_at=? WHERE id=? AND status='pending'").bind(text(input.reason),now,input.advanceId).run();
  return{advanceId:input.advanceId,status:"cancelled"};
 }
 if(text(adv.status)!=="active")throw new Error("Only an active advance can have its balance waived");
 await db.batch([
  db.prepare("UPDATE salary_advance_installments SET status='waived',waive_reason=? WHERE advance_id=? AND status='pending'").bind(text(input.reason),input.advanceId),
  db.prepare("UPDATE salary_advances SET status='recovered',closed_reason=?,updated_at=? WHERE id=?").bind(`waived: ${text(input.reason)}`,now,input.advanceId),
 ]);
 return{advanceId:input.advanceId,status:"recovered",remainderWaived:true};
}

/** HR view: advances with recovered/outstanding balances. Cold-DB safe. */
export async function salaryAdvanceDirectory(db:Db,input:{employeeId?:string}={}){
 await ensureSalaryAdvanceTables(db);
 const employeeId=text(input.employeeId);
 const rows=await db.prepare(`SELECT a.*,COALESCE((SELECT SUM(amount) FROM salary_advance_installments i WHERE i.advance_id=a.id AND i.status='deducted'),0) recovered,COALESCE((SELECT SUM(amount) FROM salary_advance_installments i WHERE i.advance_id=a.id AND i.status='pending'),0) outstanding FROM salary_advances a WHERE (?='' OR a.employee_id=?) ORDER BY a.created_at DESC LIMIT 200`).bind(employeeId,employeeId).all<Row>().catch(()=>({results:[] as Row[]}));
 return rows.results.map(r=>({id:text(r.id),employeeId:text(r.employee_id),amount:money(r.amount),recoveryMonths:Number(r.recovery_months),monthlyAmount:money(r.monthly_amount),status:text(r.status),reason:text(r.reason),requestedBy:text(r.requested_by),approvedBy:r.approved_by?text(r.approved_by):null,recovered:money(r.recovered),outstanding:money(r.outstanding),closedReason:r.closed_reason?text(r.closed_reason):null,createdAt:Number(r.created_at)}));
}
