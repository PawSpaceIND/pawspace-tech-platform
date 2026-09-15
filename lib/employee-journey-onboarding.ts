/*
 * Employee activation is a REFUSAL BOUNDARY, not a write pipeline with a check bolted on the end.
 *
 * The original onboardEmployeeJourney wrote first and asked afterwards:
 *
 *     upsertEmployee -> addEmploymentVersion -> assignCompensation -> INSERT app_users
 *                    -> employeeJourneyReadiness()   <- evaluated LAST, threw if not ready
 *
 * There was no transaction and no compensating delete, so the throw left all four writes committed.
 * One of the readiness checks it threw from is time-dependent - `compensation_assignment` requires
 * `a.effective_from<=now`, and effective_from is derived from joinedAt - so ANY joined date in the
 * future was a GUARANTEED throw AFTER everything had already been written. The operator saw
 * HTTP 500 "People update failed"; the database was left holding an active employees row, an ACTIVE
 * app_users row (a working staff login), an open employment version and an open compensation
 * assignment. Only employee_journey_activations, the one row nobody pays from, was missing - so the
 * ghost appeared on /team/people, the next payroll run paid it, and because re-submitting the form
 * failed identically the operator never learned it existed.
 *
 * The fix is ordering, not error handling:
 *
 *   1. PREFLIGHT. Every readiness check is decidable from reads alone, so all of them are decided
 *      BEFORE the first write - including the ones that used to be decided after it. A future joined
 *      date, a contract engagement, an already-inactive person, a retired structure and an email that
 *      belongs to somebody else are now refusals that never touch the database.
 *   2. COMPENSATE. A refusal can still arrive late (a salary structure retired by someone else
 *      between preflight and readiness), so the write phase records exactly what it created and a
 *      single db.batch - atomic in D1 - removes it again before the refusal is raised. Rows that were
 *      already there are restored to their prior values, never deleted.
 *   3. SAY WHY. Every refusal is thrown as governedJsonError(...), which registers the Response in
 *      lib/governed-http-error.ts's WeakSet. That identity is the only thing authError() trusts: a
 *      plain Error becomes 500 "People update failed", and even a bare `throw new Response(...)` keeps
 *      its status but has its body replaced by the route's fallback. The operator gets the real
 *      reason and a 4xx, because a future joined date is a correctable input, not a server fault.
 *
 * people_audit_events is deliberately NOT unwound: the attempt happened, and a compensated refusal
 * appends `employee.activation_rolled_back` so the trail says so.
 */
import{ensurePeopleTables,upsertEmployee,addEmploymentVersion}from"./people-foundation";import{ensurePayrollTables,assignCompensation}from"./payroll-engine";import{ensureSecurityTables}from"./server-auth";import{governedJsonError}from"./governed-http-error";
type Db=D1Database;type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim();const uid=(p:string)=>`${p}-${crypto.randomUUID().slice(0,12).toUpperCase()}`;
/** Engagement types employeeJourneyReadiness refuses to treat as salaried employment. */
const CONTRACT_EMPLOYMENT_TYPES=["contract","contractor","contract_provider"];
const isContractEngagement=(v:unknown)=>CONTRACT_EMPLOYMENT_TYPES.includes(text(v).toLowerCase());
/** Refuse the activation with a caller-safe reason. Only these survive authError() as a 4xx body. */
function refuse(message:string,status:number):never{throw governedJsonError({error:message},status);}
export async function ensureEmployeeJourneyTables(db:Db){await Promise.all([ensurePeopleTables(db),ensurePayrollTables(db),ensureSecurityTables(db)]);await db.prepare("CREATE TABLE IF NOT EXISTS employee_journey_activations (employee_id TEXT PRIMARY KEY,status TEXT NOT NULL,role_code TEXT NOT NULL,readiness_json TEXT NOT NULL,activated_by TEXT NOT NULL,activated_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)").run();}
export async function employeeJourneyReadiness(db:Db,employeeId:string){await ensureEmployeeJourneyTables(db);const now=Date.now(),employee=await db.prepare("SELECT * FROM employees WHERE id=?").bind(employeeId).first<Row>(),employment=await db.prepare("SELECT * FROM employee_employment_versions WHERE employee_id=? AND effective_until IS NULL ORDER BY version DESC LIMIT 1").bind(employeeId).first<Row>(),comp=await db.prepare("SELECT a.*,s.status structure_status FROM employee_compensation_assignments a JOIN salary_structure_versions s ON s.id=a.structure_id WHERE a.employee_id=? AND a.effective_from<=? AND (a.effective_until IS NULL OR a.effective_until>=?) ORDER BY a.effective_from DESC LIMIT 1").bind(employeeId,now,now).first<Row>(),user=employee?await db.prepare("SELECT role_code,status FROM app_users WHERE lower(email)=lower(?)").bind(employee.user_email||employee.work_email).first<Row>():null;const checks=[{code:"employee_active",passed:text(employee?.employment_status)==="active"},{code:"identity_provisioned",passed:text(user?.status)==="active"&&Boolean(text(user?.role_code))},{code:"employment_version",passed:Boolean(employment)&&!isContractEngagement(employment?.employment_type)},{code:"compensation_assignment",passed:Boolean(comp)&&text(comp?.structure_status)==="active_uat"}];return{employeeId,ready:checks.every(c=>c.passed),checks};}

/** What the write phase created, so a late refusal can put the database back exactly as it found it. */
type ActivationWrites={employeeId:string;workEmail:string;priorEmployee:Row|null;priorUser:Row|null;createdVersionId:string|null;createdAssignmentId:string|null;actorId:string;blocked:string};

/**
 * Undo an activation whose refusal arrived after the writes, as ONE atomic D1 batch.
 * Rows this call created are deleted; rows that already existed are restored to their prior values.
 */
async function rollbackActivationWrites(db:Db,state:ActivationWrites){
 const now=Date.now(),statements=[];
 if(state.createdAssignmentId)statements.push(db.prepare("DELETE FROM employee_compensation_assignments WHERE id=?").bind(state.createdAssignmentId));
 if(state.createdVersionId)statements.push(db.prepare("DELETE FROM employee_employment_versions WHERE id=?").bind(state.createdVersionId));
 statements.push(state.priorUser
  ?db.prepare("UPDATE app_users SET name=?,role_code=?,status=?,updated_at=? WHERE lower(email)=lower(?)").bind(text(state.priorUser.name),text(state.priorUser.role_code),text(state.priorUser.status),Number(state.priorUser.updated_at)||now,state.workEmail)
  :db.prepare("DELETE FROM app_users WHERE lower(email)=lower(?)").bind(state.workEmail));
 statements.push(state.priorEmployee
  ?db.prepare("UPDATE employees SET user_email=?,employee_code=?,display_name=?,work_email=?,phone=?,joined_at=?,updated_at=? WHERE id=?").bind(state.priorEmployee.user_email??null,text(state.priorEmployee.employee_code),text(state.priorEmployee.display_name),text(state.priorEmployee.work_email),state.priorEmployee.phone??null,state.priorEmployee.joined_at??null,Number(state.priorEmployee.updated_at)||now,state.employeeId)
  :db.prepare("DELETE FROM employees WHERE id=?").bind(state.employeeId));
 statements.push(db.prepare("INSERT INTO people_audit_events (id,employee_id,action,actor_id,detail_json,created_at) VALUES (?,?,?,?,?,?)").bind(uid("PAE"),state.employeeId,"employee.activation_rolled_back",state.actorId,JSON.stringify({blocked:state.blocked,workEmail:state.workEmail}),now));
 await db.batch(statements);
}

export async function onboardEmployeeJourney(db:Db,input:{employeeCode:string;displayName:string;workEmail:string;phone?:string|null;joinedAt:number;employmentType?:string;title?:string|null;teamCode?:string|null;managerEmployeeId?:string|null;costCentreCode?:string|null;locationCode?:string|null;structureId:string;roleCode:string;reason:string;actorId:string}){
 await ensureEmployeeJourneyTables(db);
 const now=Date.now(),reason=text(input.reason),employeeCode=text(input.employeeCode),displayName=text(input.displayName),workEmail=text(input.workEmail).toLowerCase(),roleCode=text(input.roleCode),structureId=text(input.structureId),employmentType=text(input.employmentType)||"direct_employee",joinedAt=Number(input.joinedAt);

 /* ---------------------------------------------------------------------------------------------
  * PREFLIGHT - reads only. Nothing below this block writes until every refusal has been decided.
  * Each check mirrors a check in employeeJourneyReadiness(), which used to run after the writes.
  * ------------------------------------------------------------------------------------------- */
 if(reason.length<8)refuse("A clear employee onboarding reason is required",400);
 if(!employeeCode||!displayName||!workEmail)refuse("Employee code, name and work email are required",400);
 if(!roleCode)refuse("A self-service role is required for employee activation",400);
 if(!Number.isFinite(joinedAt)||joinedAt<=0)refuse("A valid joined date is required",400);
 /* THE P0. Compensation is effective-dated from joinedAt and readiness requires effective_from<=now,
  * so a future joined date can never be activated - not today, and not on any retry. It is refused
  * here, before the first write, instead of after the fourth. */
 if(joinedAt>now)refuse("Joined date cannot be in the future: an employee can only be activated on or after the day they join",422);
 if(isContractEngagement(employmentType))refuse("Contract engagements are onboarded through partner linkage, not salaried employee activation",409);
 const role=await db.prepare("SELECT code FROM role_definitions WHERE code=?").bind(roleCode).first<Row>();
 if(!role)refuse("Employee role is not configured",400);
 const structure=await db.prepare("SELECT id FROM salary_structure_versions WHERE id=? AND status='active_uat'").bind(structureId).first<Row>();
 if(!structure)refuse("Active salary structure is required before employee activation",409);

 /* employees.employee_code, work_email and user_email are each UNIQUE. Matching all three in one
  * read turns what would otherwise be a D1 constraint violation - reported to the operator as a 500 -
  * into a named refusal, and identifies the row upsertEmployee will reuse. */
 const matched=(await db.prepare("SELECT * FROM employees WHERE employee_code=? OR work_email=? OR lower(COALESCE(user_email,''))=?").bind(employeeCode,workEmail,workEmail).all<Row>()).results;
 if(matched.length>1)refuse("This employee code and this work email already belong to two different employee records",409);
 const priorEmployee=matched[0]??null;
 if(priorEmployee&&text(priorEmployee.employee_code)!==employeeCode&&text(priorEmployee.work_email).toLowerCase()!==workEmail)refuse("Another employee record already owns this work email",409);
 const employeeIdBefore=text(priorEmployee?.id);
 if(priorEmployee&&text(priorEmployee.employment_status)!=="active")refuse(`This person is already on record as ${text(priorEmployee.employment_status)||"inactive"} and cannot be activated as a salaried employee`,409);

 const latestVersion=employeeIdBefore?await db.prepare("SELECT * FROM employee_employment_versions WHERE employee_id=? ORDER BY version DESC LIMIT 1").bind(employeeIdBefore).first<Row>():null;
 const openVersion=latestVersion&&latestVersion.effective_until==null?latestVersion:null;
 if(openVersion&&isContractEngagement(openVersion.employment_type))refuse("This person holds an open contract engagement and cannot be activated as a salaried employee",409);
 if(!openVersion&&latestVersion&&Number(latestVersion.effective_from)>=joinedAt)refuse("Employment history already holds a version effective on or after this joined date",409);

 const openAssignment=employeeIdBefore?await db.prepare("SELECT a.*,s.status structure_status FROM employee_compensation_assignments a JOIN salary_structure_versions s ON s.id=a.structure_id WHERE a.employee_id=? AND a.effective_until IS NULL ORDER BY a.effective_from DESC LIMIT 1").bind(employeeIdBefore).first<Row>():null;
 if(openAssignment&&(Number(openAssignment.effective_from)>now||text(openAssignment.structure_status)!=="active_uat"))refuse("The existing compensation assignment is not yet effective on an active salary structure; correct compensation before activating",409);

 const priorUser=await db.prepare("SELECT id,name,role_code,status,updated_at FROM app_users WHERE lower(email)=lower(?)").bind(workEmail).first<Row>();
 /* ------------------------------------- END PREFLIGHT ---------------------------------------- */

 const employee=await upsertEmployee(db,{employeeCode,displayName,workEmail,userEmail:workEmail,phone:text(input.phone)||null,joinedAt,actorId:input.actorId}),employeeId=text(employee?.id);
 const createdVersion=openVersion?null:await addEmploymentVersion(db,{employeeId,effectiveFrom:joinedAt,employmentType,title:text(input.title)||null,teamCode:text(input.teamCode)||null,managerEmployeeId:text(input.managerEmployeeId)||null,costCentreCode:text(input.costCentreCode)||null,locationCode:text(input.locationCode)||null,reason,actorId:input.actorId});
 const createdAssignment=openAssignment?null:await assignCompensation(db,{employeeId,structureId,effectiveFrom:joinedAt,reason,actorId:input.actorId});
 await db.prepare("INSERT INTO app_users (id,email,name,role_code,status,created_at,updated_at) VALUES (?,?,?,?, 'active',?,?) ON CONFLICT(email) DO UPDATE SET name=excluded.name,role_code=excluded.role_code,status='active',updated_at=excluded.updated_at").bind(`USR-${employeeId}`,workEmail,displayName,roleCode,now,now).run();

 const readiness=await employeeJourneyReadiness(db,employeeId);
 if(!readiness.ready){
  /* Preflight decided every one of these, so reaching here means the world changed underneath us
   * (a structure retired, a record edited) between the reads and the writes. Put it back. */
  const blocked=readiness.checks.filter(c=>!c.passed).map(c=>c.code).join(", ");
  await rollbackActivationWrites(db,{employeeId,workEmail,priorEmployee,priorUser,createdVersionId:text(createdVersion?.id)||null,createdAssignmentId:text(createdAssignment?.id)||null,actorId:input.actorId,blocked});
  refuse(`Employee journey readiness blocked: ${blocked}. Nothing was provisioned - the activation was rolled back in full.`,409);
 }
 await db.prepare("INSERT INTO employee_journey_activations (employee_id,status,role_code,readiness_json,activated_by,activated_at,updated_at) VALUES (?,'active',?,?,?,?,?) ON CONFLICT(employee_id) DO UPDATE SET status='active',role_code=excluded.role_code,readiness_json=excluded.readiness_json,activated_by=excluded.activated_by,updated_at=excluded.updated_at").bind(employeeId,roleCode,JSON.stringify(readiness.checks),input.actorId,now,now).run();
 return{employeeId,status:"active",roleCode,readiness,duplicatePrevented:Boolean(openVersion&&openAssignment)};
}
