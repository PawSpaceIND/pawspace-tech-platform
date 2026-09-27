import {ensurePeopleTables} from "./people-foundation";
import {ensurePayrollTables} from "./payroll-engine";
import {ensureSecurityTables} from "./server-auth";
import {ensureAdminMfaTables} from "./admin-mfa";
import {appendPayrollCheck,completePayrollResults} from "./payroll-integrity";
import {governedJsonError} from "./governed-http-error";
type Row=Record<string,unknown>;
const text=(v:unknown)=>String(v??"").trim(), email=(v:unknown)=>text(v).toLowerCase();
const uid=(prefix:string)=>`${prefix}-${crypto.randomUUID()}`;
const refuse=(message:string,status=409)=>governedJsonError({error:message},status);
export async function ensureEmployeeExitTables(db:D1Database){
 await ensurePeopleTables(db);await ensurePayrollTables(db);await ensureSecurityTables(db);await ensureAdminMfaTables(db);
 await db.batch([
  db.prepare("CREATE TABLE IF NOT EXISTS employee_exit_cases (id TEXT PRIMARY KEY,idempotency_key TEXT NOT NULL UNIQUE,employee_id TEXT NOT NULL,user_id TEXT NOT NULL,identity_email TEXT NOT NULL,employee_snapshot_json TEXT NOT NULL,access_ends_at INTEGER NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','access_revoked','cancelled','settled_sandbox')),requested_by TEXT NOT NULL,created_at INTEGER NOT NULL,approved_by TEXT,approved_at INTEGER,revoked_at INTEGER,cancelled_by TEXT,cancel_reason TEXT,clearance_reference TEXT,settlement_reference TEXT,settlement_snapshot_json TEXT,settled_by TEXT,settled_at INTEGER,updated_at INTEGER NOT NULL)"),
  db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS employee_exit_one_open_idx ON employee_exit_cases(employee_id) WHERE status<>'cancelled'"),
  db.prepare("CREATE INDEX IF NOT EXISTS employee_exit_due_idx ON employee_exit_cases(status,access_ends_at)"),
  db.prepare("CREATE TABLE IF NOT EXISTS employee_exit_events (id TEXT PRIMARY KEY,case_id TEXT NOT NULL,action TEXT NOT NULL,actor_id TEXT NOT NULL,detail_json TEXT NOT NULL,created_at INTEGER NOT NULL)"),
 ]);
}
async function tableExists(db:D1Database,name:string){return Boolean(await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").bind(name).first<Row>());}
async function optionalRows(db:D1Database,table:string,sql:string,args:unknown[]=[]){if(!await tableExists(db,table))return [] as Row[];return(await db.prepare(sql).bind(...args).all<Row>()).results;}
function event(db:D1Database,caseId:string,action:string,actor:string,detail:unknown,now:number){return db.prepare("INSERT INTO employee_exit_events (id,case_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(uid("EXIT-EVT"),caseId,action,actor,JSON.stringify(detail),now);}
async function exitCase(db:D1Database,id:string){const row=await db.prepare("SELECT * FROM employee_exit_cases WHERE id=?").bind(id).first<Row>();if(!row)throw refuse("Employee exit case not found",404);return row;}
async function transaction(db:D1Database,writes:D1PreparedStatement[]){try{await db.batch(writes);}catch(error){if(/payroll_integrity_condition|UNIQUE constraint failed: employee_exit_cases/i.test(error instanceof Error?error.message:String(error)))throw refuse("Employee exit evidence changed. Refresh and review before retrying.");throw error;}}
const snapshot=(employee:Row,user:Row,employment:Row)=>JSON.stringify({employeeId:employee.id,workEmail:email(employee.work_email),userEmail:email(employee.user_email),employeeCode:employee.employee_code,joinedAt:employee.joined_at,endedAt:employee.ended_at,userId:user.id,identityEmail:email(user.email),role:user.role_code,employmentId:employment.id,employmentType:employment.employment_type});
async function activeIdentity(db:D1Database,employeeId:string){
 const employee=await db.prepare("SELECT * FROM employees WHERE id=? AND employment_status='active'").bind(employeeId).first<Row>();
 if(!employee)throw refuse("An active direct employee is required");
 const user=await db.prepare("SELECT id,email,role_code,status FROM app_users WHERE lower(email)=?").bind(email(employee.user_email||employee.work_email)).first<Row>();
 const employment=await db.prepare("SELECT * FROM employee_employment_versions WHERE employee_id=? AND effective_until IS NULL ORDER BY version DESC LIMIT 1").bind(employeeId).first<Row>();
 if(!user||user.status!=="active"||!employment||!["direct_employee","full_time","employee"].includes(text(employment.employment_type)))throw refuse("Verified staff identity and direct employment history are required; partner exits use provider governance");
 if(["founder","superuser","service_provider","customer"].includes(text(user.role_code)))throw refuse("This protected or non-staff identity cannot use employee exit");
 const providerLinks=await optionalRows(db,"provider_identity_links","SELECT provider_id FROM provider_identity_links WHERE lower(email)=? AND status='active'",[email(user.email)]);
 if(providerLinks.length)throw refuse("Resolve the linked provider lifecycle before employee exit; no provider booking is cancelled here");
 return{employee,user,employment,serialized:snapshot(employee,user,employment)};
}
function identityGuard(db:D1Database,writes:D1PreparedStatement[],identity:Awaited<ReturnType<typeof activeIdentity>>){const {employee:e,user:u,employment:v}=identity;appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employees WHERE id=? AND employment_status='active' AND lower(work_email)=? AND lower(COALESCE(user_email,''))=? AND joined_at IS ? AND ended_at IS ?) AND EXISTS(SELECT 1 FROM app_users WHERE id=? AND lower(email)=? AND status='active' AND role_code=?) AND EXISTS(SELECT 1 FROM employee_employment_versions WHERE id=? AND employee_id=? AND employment_type=? AND effective_until IS NULL)",[e.id,email(e.work_email),email(e.user_email),e.joined_at,e.ended_at,u.id,email(u.email),u.role_code,v.id,e.id,v.employment_type]);}
export async function requestEmployeeExit(db:D1Database,input:{employeeId:string;accessEndsAt:number;reason:string;idempotencyKey:string;actorId:string}){
 await ensureEmployeeExitTables(db);const now=Date.now();
 if(!text(input.employeeId)||!text(input.idempotencyKey)||text(input.reason).length<8||!email(input.actorId)||!Number.isSafeInteger(input.accessEndsAt)||input.accessEndsAt<=0||!Number.isFinite(new Date(input.accessEndsAt).getTime()))throw refuse("Employee, explicit access cutoff, request key and a clear reason are required",400);
 const prior=await db.prepare("SELECT * FROM employee_exit_cases WHERE idempotency_key=?").bind(input.idempotencyKey).first<Row>();
 if(prior){if(prior.employee_id!==input.employeeId||Number(prior.access_ends_at)!==input.accessEndsAt||prior.reason!==input.reason.trim()||email(prior.requested_by)!==email(input.actorId))throw refuse("Exit request key belongs to different instructions");return{case:prior,duplicatePrevented:true};}
 const identity=await activeIdentity(db,input.employeeId);
 if(email(identity.user.email)===email(input.actorId))throw refuse("Employee exit must be requested by another authorized staff member");
 if(identity.employee.joined_at==null||input.accessEndsAt<=Number(identity.employee.joined_at)||identity.employee.ended_at!=null)throw refuse("Exit cutoff must follow a verified joining date; resolve an existing end date first");
 const id=uid("EXIT"),writes:D1PreparedStatement[]=[];identityGuard(db,writes,identity);
 appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employees WHERE id=? AND employment_status='active' AND ended_at IS NULL) AND EXISTS(SELECT 1 FROM app_users WHERE id=? AND status='active')",[input.employeeId,identity.user.id]);
 writes.push(db.prepare("INSERT INTO employee_exit_cases (id,idempotency_key,employee_id,user_id,identity_email,employee_snapshot_json,access_ends_at,reason,status,requested_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)").bind(id,input.idempotencyKey,input.employeeId,identity.user.id,email(identity.user.email),identity.serialized,input.accessEndsAt,input.reason.trim(),email(input.actorId),now,now),event(db,id,"requested",email(input.actorId),{accessEndsAt:input.accessEndsAt},now));
 await transaction(db,writes);return{case:await exitCase(db,id),duplicatePrevented:false};
}
export async function approveEmployeeExit(db:D1Database,input:{caseId:string;actorId:string}){
 await ensureEmployeeExitTables(db);const row=await exitCase(db,input.caseId);
 if(!email(input.actorId)||[email(row.requested_by),email(row.identity_email)].includes(email(input.actorId)))throw refuse("Exit approval requires an independent authorized staff member");
 if(row.status==="approved")return{case:row,duplicatePrevented:true};if(row.status!=="pending")throw refuse("Only a pending exit can be approved");
 const identity=await activeIdentity(db,text(row.employee_id));if(identity.serialized!==row.employee_snapshot_json)throw refuse("Employee identity or employment changed since the exit request");
 const now=Date.now(),writes:D1PreparedStatement[]=[];appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_exit_cases WHERE id=? AND status='pending')",[row.id]);identityGuard(db,writes,identity);
 writes.push(db.prepare("UPDATE employee_exit_cases SET status='approved',approved_by=?,approved_at=?,updated_at=? WHERE id=?").bind(email(input.actorId),now,now,row.id),event(db,text(row.id),"approved",email(input.actorId),{accessEndsAt:row.access_ends_at},now));await transaction(db,writes);return{case:await exitCase(db,input.caseId),duplicatePrevented:false};
}
export async function cancelEmployeeExit(db:D1Database,input:{caseId:string;actorId:string;reason:string}){
 await ensureEmployeeExitTables(db);const row=await exitCase(db,input.caseId),now=Date.now();
 if(text(input.reason).length<8||!email(input.actorId)||email(input.actorId)===email(row.identity_email))throw refuse("A clear cancellation reason and another authorized actor are required",400);
 if(!["pending","approved"].includes(text(row.status))||(row.status==="approved"&&Number(row.access_ends_at)<=now))throw refuse("A due or executed exit cannot be cancelled; use a governed rehire review");
 const writes:D1PreparedStatement[]=[];appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_exit_cases WHERE id=? AND status=? AND (status='pending' OR access_ends_at>?))",[row.id,row.status,now]);
 writes.push(db.prepare("UPDATE employee_exit_cases SET status='cancelled',cancelled_by=?,cancel_reason=?,updated_at=? WHERE id=?").bind(email(input.actorId),input.reason.trim(),now,row.id),event(db,text(row.id),"cancelled",email(input.actorId),{reason:input.reason.trim()},now));
 await transaction(db,writes);return{case:await exitCase(db,input.caseId)};
}
async function handoverItems(db:D1Database,employeeId:string,identityEmail:string){
 const leads=await optionalRows(db,"lead_assignments","SELECT id,lead_id FROM lead_assignments WHERE lower(employee_email)=? AND status='current' ORDER BY id",[identityEmail]);
 const cases=await optionalRows(db,"unified_cases","SELECT id FROM unified_cases WHERE lower(owner_email)=? AND status NOT IN ('resolved','closed','cancelled') ORDER BY id",[identityEmail]);
 const reports=await db.prepare("SELECT DISTINCT e.id FROM employees e JOIN employee_employment_versions v ON v.employee_id=e.id WHERE e.employment_status='active' AND v.manager_employee_id=? AND v.effective_until IS NULL ORDER BY e.id").bind(employeeId).all<Row>();
 return [...leads.map(r=>({type:"lead",id:text(r.lead_id),recordId:text(r.id)})),...cases.map(r=>({type:"case",id:text(r.id),recordId:text(r.id)})),...reports.results.map(r=>({type:"direct_report",id:text(r.id),recordId:text(r.id)}))];
}
export async function executeEmployeeExit(db:D1Database,input:{caseId:string;actorId:string;asOf?:number}){
 await ensureEmployeeExitTables(db);const row=await exitCase(db,input.caseId),now=input.asOf??Date.now();
 if(!email(input.actorId)||email(input.actorId)===email(row.identity_email))throw refuse("Another authorized actor must execute an approved exit");
 if(["access_revoked","settled_sandbox"].includes(text(row.status)))return{case:row,duplicatePrevented:true};
 if(row.status!=="approved"||!row.approved_by||Number(row.access_ends_at)>now)throw refuse("Exit must be independently approved and its cutoff reached before execution");
 const identity=await activeIdentity(db,text(row.employee_id));if(identity.serialized!==row.employee_snapshot_json)throw refuse("Employee identity or employment changed; review exit evidence before execution");
 const handover=await handoverItems(db,text(row.employee_id),text(row.identity_email)),writes:D1PreparedStatement[]=[];identityGuard(db,writes,identity);
 appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_exit_cases WHERE id=? AND status='approved' AND access_ends_at<=?) AND EXISTS(SELECT 1 FROM employees WHERE id=? AND employment_status='active' AND ended_at IS NULL) AND EXISTS(SELECT 1 FROM app_users WHERE id=? AND lower(email)=? AND status='active')",[row.id,now,row.employee_id,row.user_id,row.identity_email]);
 writes.push(db.prepare("UPDATE employees SET employment_status='exited',ended_at=?,updated_at=? WHERE id=?").bind(row.access_ends_at,now,row.employee_id),db.prepare("UPDATE app_users SET status='disabled',updated_at=? WHERE id=?").bind(now,row.user_id),db.prepare("UPDATE active_sessions SET revoked_at=?,revoke_reason='employee_exit' WHERE user_id=? AND revoked_at IS NULL").bind(now,row.user_id));
 writes.push(db.prepare("UPDATE employee_employment_versions SET effective_until=? WHERE employee_id=? AND effective_from<? AND (effective_until IS NULL OR effective_until>=?)").bind(Number(row.access_ends_at)-1,row.employee_id,row.access_ends_at,row.access_ends_at),db.prepare("UPDATE employee_compensation_assignments SET effective_until=? WHERE employee_id=? AND effective_from<? AND (effective_until IS NULL OR effective_until>=?)").bind(Number(row.access_ends_at)-1,row.employee_id,row.access_ends_at,row.access_ends_at));
 if(await tableExists(db,"lead_assignment_memberships"))writes.push(db.prepare("UPDATE lead_assignment_memberships SET active=0,updated_by=?,updated_at=? WHERE lower(employee_email)=?").bind(input.actorId,now,row.identity_email));
 if(await tableExists(db,"employee_journey_activations"))writes.push(db.prepare("UPDATE employee_journey_activations SET status='exited',updated_at=? WHERE employee_id=?").bind(now,row.employee_id));
 writes.push(db.prepare("UPDATE employee_exit_cases SET status='access_revoked',revoked_at=?,updated_at=? WHERE id=?").bind(now,now,row.id),event(db,text(row.id),"access_revoked",email(input.actorId),{handoverRequired:handover,earningsPreserved:true},now));
 await transaction(db,writes);return{case:await exitCase(db,input.caseId),handover,duplicatePrevented:false};
}
/** A source-derived review, never a new payable balance. Final salary still belongs to payroll. */
export async function employeeExitSettlement(db:D1Database,caseId:string){
 await ensureEmployeeExitTables(db);const row=await exitCase(db,caseId),employeeId=text(row.employee_id),identityEmail=text(row.identity_email),cutoff=Number(row.access_ends_at);
 const handover=await handoverItems(db,employeeId,identityEmail),blockers:string[]=[];
 if(!["access_revoked","settled_sandbox"].includes(text(row.status)))blockers.push("exit_access_not_revoked");
 if(handover.length)blockers.push("open_work_handover_required");
 const payroll=(await db.prepare("SELECT r.id,r.run_id,r.net_pay,p.status,p.period_start,p.period_end FROM employee_payroll_results r JOIN payroll_runs p ON p.id=r.run_id WHERE r.employee_id=? AND p.period_start<? AND p.status NOT IN ('cancelled','superseded') ORDER BY p.period_start,r.id").bind(employeeId,cutoff).all<Row>()).results;
 const instructions=await optionalRows(db,"employee_salary_instructions","SELECT id,result_id,amount_paise,status,provider_payout_id,environment FROM employee_salary_instructions WHERE employee_id=? ORDER BY id",[employeeId]);
 const finalPeriod=payroll.filter(r=>Number(r.period_start)<cutoff&&Number(r.period_end)>=cutoff);
 if(finalPeriod.length!==1)blockers.push("one_canonical_final_period_payroll_required");
 const verifiedRuns=new Set<string>();
 for(const result of payroll){
  if(!["approved","payment_prepared","paid_sandbox","paid"].includes(text(result.status)))blockers.push("payroll_approval_required");
  if(payroll.some(other=>other.id!==result.id&&Number(other.period_start)<Number(result.period_end)&&Number(other.period_end)>Number(result.period_start)))blockers.push("conflicting_payroll_history");
  if(!verifiedRuns.has(text(result.run_id))){verifiedRuns.add(text(result.run_id));try{await completePayrollResults(db,(await db.prepare("SELECT * FROM payroll_runs WHERE id=?").bind(result.run_id).first<Row>())!);}catch(error){if(!(error instanceof Response))throw error;blockers.push("payroll_evidence_requires_review");}}
  if(Number(result.net_pay)>0&&!instructions.some(i=>i.result_id===result.id&&i.status==="paid_sandbox"&&i.environment==="sandbox"&&Number(i.amount_paise)===Math.round(Number(result.net_pay)*100)&&/^pout_[A-Za-z0-9]+$/.test(text(i.provider_payout_id))))blockers.push("sandbox_salary_confirmation_required");
 }
 const incentives=await optionalRows(db,"employee_incentive_results","SELECT r.id,r.status,r.approved_amount FROM employee_incentive_results r WHERE r.employee_id=? AND r.status IN ('calculated','approved','held') AND NOT EXISTS(SELECT 1 FROM incentive_payroll_links l WHERE l.source_type='incentive_result' AND l.source_id=r.id) ORDER BY r.id",[employeeId]);
 const sales=await optionalRows(db,"sales_incentive_period_results","SELECT r.id,r.status,r.approved_total FROM sales_incentive_period_results r WHERE r.employee_id IN (?,?) AND r.status IN ('draft','approved') AND NOT EXISTS(SELECT 1 FROM sales_incentive_payroll_links l WHERE l.result_id=r.id) ORDER BY r.id",[employeeId,identityEmail]);
 const advances=await optionalRows(db,"salary_advances","SELECT id,status,amount FROM salary_advances WHERE employee_id=? AND status IN ('pending','active') ORDER BY id",[employeeId]);
 if(incentives.length||sales.length)blockers.push("outstanding_incentive_review");if(advances.length)blockers.push("outstanding_advance_review");
 const sources={employeeId,cutoff,payroll,instructions,incentives,sales,advances,handover};
 const serialized=JSON.stringify(sources),bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(serialized)),revision=Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,"0")).join("");
 return{caseId,employeeId,caseStatus:text(row.status),accessEndsAt:cutoff,blockers:[...new Set(blockers)],ready:!blockers.length,revision,sources,settledEvidenceCurrent:row.status==="settled_sandbox"&&row.settlement_snapshot_json===serialized&&!blockers.length,livePaymentConfirmed:false,policyReviewRequired:true,environment:"sandbox" as const};
}
export async function closeEmployeeExitSandbox(db:D1Database,input:{caseId:string;revision:string;clearanceReference:string;policyReviewReference:string;actorId:string;confirmSandbox:boolean}){
 await ensureEmployeeExitTables(db);const row=await exitCase(db,input.caseId);
 if(input.confirmSandbox!==true||text(input.clearanceReference).length<8||text(input.policyReviewReference).length<8||!email(input.actorId))throw refuse("Explicit sandbox confirmation, handover/assets clearance and Finance policy-review references are required",400);
 if([email(row.identity_email),email(row.requested_by)].includes(email(input.actorId)))throw refuse("Final settlement review requires an independent authorized Finance actor");
 const review=await employeeExitSettlement(db,input.caseId);
 if(!review.ready||review.revision!==input.revision)throw refuse(`Settlement evidence must be refreshed or completed: ${review.blockers.join(', ')||'changed source records'}`);
 if(row.status==="settled_sandbox"){if(!review.settledEvidenceCurrent)throw refuse("Settlement evidence changed after closure; review the underlying payroll");return{review,duplicatePrevented:true};}
 const now=Date.now(),writes:D1PreparedStatement[]=[];
 appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_exit_cases WHERE id=? AND status='access_revoked') AND EXISTS(SELECT 1 FROM employees WHERE id=? AND employment_status='exited' AND ended_at=?) AND EXISTS(SELECT 1 FROM app_users WHERE id=? AND status='disabled')",[row.id,row.employee_id,row.access_ends_at,row.user_id]);
 appendPayrollCheck(db,writes,"(SELECT COUNT(*) FROM employee_payroll_results r JOIN payroll_runs p ON p.id=r.run_id WHERE r.employee_id=? AND p.period_start<? AND p.status NOT IN ('cancelled','superseded'))=?",[row.employee_id,row.access_ends_at,review.sources.payroll.length]);
 for(const p of review.sources.payroll)appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_payroll_results r JOIN payroll_runs p ON p.id=r.run_id WHERE r.id=? AND r.employee_id=? AND r.net_pay=? AND p.status=? AND p.period_start=? AND p.period_end=?)",[p.id,row.employee_id,p.net_pay,p.status,p.period_start,p.period_end]);
 for(const p of review.sources.instructions)appendPayrollCheck(db,writes,"EXISTS(SELECT 1 FROM employee_salary_instructions WHERE id=? AND status=? AND amount_paise=? AND COALESCE(provider_payout_id,'')=?)",[p.id,p.status,p.amount_paise,text(p.provider_payout_id)]);
 if(await tableExists(db,"lead_assignments"))appendPayrollCheck(db,writes,"NOT EXISTS(SELECT 1 FROM lead_assignments WHERE lower(employee_email)=? AND status='current')",[row.identity_email]);
 if(await tableExists(db,"unified_cases"))appendPayrollCheck(db,writes,"NOT EXISTS(SELECT 1 FROM unified_cases WHERE lower(owner_email)=? AND status NOT IN ('resolved','closed','cancelled'))",[row.identity_email]);
 appendPayrollCheck(db,writes,"NOT EXISTS(SELECT 1 FROM employees e JOIN employee_employment_versions v ON v.employee_id=e.id WHERE e.employment_status='active' AND v.manager_employee_id=? AND v.effective_until IS NULL)",[row.employee_id]);
 if(await tableExists(db,"salary_advances"))appendPayrollCheck(db,writes,"NOT EXISTS(SELECT 1 FROM salary_advances WHERE employee_id=? AND status IN ('pending','active'))",[row.employee_id]);
 if(await tableExists(db,"employee_incentive_results"))appendPayrollCheck(db,writes,"NOT EXISTS(SELECT 1 FROM employee_incentive_results r WHERE r.employee_id=? AND r.status IN ('calculated','approved','held') AND NOT EXISTS(SELECT 1 FROM incentive_payroll_links l WHERE l.source_type='incentive_result' AND l.source_id=r.id))",[row.employee_id]);
 if(await tableExists(db,"sales_incentive_period_results"))appendPayrollCheck(db,writes,"NOT EXISTS(SELECT 1 FROM sales_incentive_period_results r WHERE r.employee_id IN (?,?) AND r.status IN ('draft','approved') AND NOT EXISTS(SELECT 1 FROM sales_incentive_payroll_links l WHERE l.result_id=r.id))",[row.employee_id,row.identity_email]);
 writes.push(db.prepare("UPDATE employee_exit_cases SET status='settled_sandbox',clearance_reference=?,settlement_reference=?,settlement_snapshot_json=?,settled_by=?,settled_at=?,updated_at=? WHERE id=?").bind(input.clearanceReference.trim(),input.policyReviewReference.trim(),JSON.stringify(review.sources),email(input.actorId),now,now,row.id),event(db,text(row.id),"sandbox_review_closed",email(input.actorId),{revision:review.revision,livePaymentConfirmed:false},now));
 await transaction(db,writes);return{review:await employeeExitSettlement(db,input.caseId),duplicatePrevented:false};
}
export async function employeeExitDirectory(db:D1Database){await ensureEmployeeExitTables(db);const rows=(await db.prepare("SELECT id,employee_id,identity_email,access_ends_at,reason,status,requested_by,approved_by,created_at,revoked_at,settled_at FROM employee_exit_cases ORDER BY created_at DESC,id LIMIT 201").all<Row>()).results;return{cases:rows.slice(0,200),hasMore:rows.length>200,livePaymentEnabled:false};}
export async function runApprovedEmployeeExitSweep(db:D1Database,asOf=Date.now()){
 if(!await tableExists(db,"employee_exit_cases"))return{processed:0,reviewRequired:[],enabled:false};
 const due=(await db.prepare("SELECT id FROM employee_exit_cases WHERE status='approved' AND access_ends_at<=? ORDER BY access_ends_at,id LIMIT 20").bind(asOf).all<Row>()).results;
 let processed=0;const reviewRequired:string[]=[];for(const row of due){try{await executeEmployeeExit(db,{caseId:text(row.id),actorId:"system:approved-employee-exit",asOf});processed++;}catch{reviewRequired.push(text(row.id));}}
 return{processed,reviewRequired,enabled:true,livePaymentEnabled:false};
}
