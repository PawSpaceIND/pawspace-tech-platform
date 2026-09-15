import{authError,authorize,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{governedJsonError}from"../../../lib/governed-http-error";
import{ensurePeopleTables}from"../../../lib/people-foundation";
import{approveAdjustment,assignShift,attendanceLeaveDirectory,decideLeave,grantLeaveEntitlement,recordAttendance,requestAdjustment,requestLeave,saveLeavePolicy,saveShiftPolicy,setPeriodLock,type AttendanceScope}from"../../../lib/attendance-leave";
type Row=Record<string,unknown>;const text=(v:unknown)=>String(v??"").trim();
type Actor=Awaited<ReturnType<typeof resolveActor>>;
const can=(actor:Actor,permission:string)=>actor.permissions.includes("*")||actor.permissions.includes(permission);
const managesAttendance=(actor:Actor)=>can(actor,"attendance.manage")||can(actor,"people.manage");
const managesLeave=(actor:Actor)=>can(actor,"leave.manage")||can(actor,"people.manage");
async function ownEmployee(db:D1Database,email:string){return db.prepare("SELECT id FROM employees WHERE lower(COALESCE(user_email,work_email))=? AND employment_status='active'").bind(email.toLowerCase()).first<Row>();}
/**
 * The self-scope refusal reached the operator as "Attendance/leave update failed". [W2C-SCOPE-REFUSAL]
 *
 * It threw a bare `new Response(...,403)`. lib/server-auth.ts authError() trusts a Response only when
 * it carries the governed-http-error mark, so it kept the 403 and REPLACED the body with the route's
 * catch-block fallback - the one refusal on this route a caller can actually act on ("you are asking
 * about somebody else's attendance") arrived indistinguishable from a server fault.
 * governedJsonError() is the same mechanism lib/server-auth.ts uses for its own 403s.
 */
async function assertEmployeeScope(db:D1Database,actor:Actor,employeeId:string){if(managesAttendance(actor)||managesLeave(actor))return;const own=await ownEmployee(db,actor.email);if(!own||text(own.id)!==employeeId)throw governedJsonError({error:"Employee self-service scope denied"},403);}
/**
 * A manager's Time & Leave scope is their own reporting line. [R3E-TIME-SCOPE]
 *
 * This route handed the whole roster and the 100 most recent attendance rows to any holder of
 * attendance.manage or leave.manage. Manager One, whose direct reports are EMP1 and EMP2, therefore
 * read EMP3's attendance row - EMP3 reports to Manager Two - while /team/people/reports restricted the
 * same identity to two employees off the same `manager_employee_id` column.
 *
 * Company-wide scope is the one lib/people-reports.ts already uses: people.manage, payroll.view or
 * audit.view, plus the wildcard. Below that, an actor who HAS a reporting line is narrowed to it -
 * their direct reports and themselves, because a manager's own row is what the self section of the
 * screen renders.
 *
 * Two cases deliberately keep the company-wide view, and both are reported back in
 * `scope.organizationalScope` so the screen states which one it is instead of being silently narrow:
 * an actor who is not on the employee master at all (an HR or ops identity People has never linked),
 * and an actor with no direct reports. Neither has a reporting line to scope TO, and narrowing them
 * to nothing would empty Time & Leave for the identity that runs it - and would also hide every
 * employee whose employment-version row has never been written, which is not a privacy improvement.
 * Closing those two is a permission-model decision for the owner, not a fixer's.
 */
async function managerScope(db:D1Database,actor:Actor):Promise<AttendanceScope&{reason:string;ownEmployeeId:string|null}>{
 if(["people.manage","payroll.view","audit.view"].some(permission=>can(actor,permission))){const own=await ownEmployee(db,actor.email);return{employeeIds:null,reason:"global",ownEmployeeId:own?text(own.id):null};}
 const own=await ownEmployee(db,actor.email);
 if(!own)return{employeeIds:null,reason:"global_unlinked",ownEmployeeId:null};
 const directs=await db.prepare("SELECT e.id FROM employees e JOIN employee_employment_versions v ON v.employee_id=e.id AND v.effective_until IS NULL WHERE e.employment_status='active' AND v.manager_employee_id=? ORDER BY e.id LIMIT 300").bind(text(own.id)).all<Row>();
 if(!directs.results.length)return{employeeIds:null,reason:"global_no_direct_reports",ownEmployeeId:text(own.id)};
 return{employeeIds:[...new Set([text(own.id),...directs.results.map(r=>text(r.id))])],reason:"reporting_line",ownEmployeeId:text(own.id)};
}
export async function GET(request:Request){try{
 const actor=await authorize(request,"attendance.view"),db=await database();
 /*
  * `employees` belongs to lib/people-foundation.ts and this route reads it three times - ownEmployee,
  * the direct-reports query and the roster. On a database where People has never been opened the table
  * does not exist, ownEmployee threw, and the whole screen answered 500 "Unable to load attendance and
  * leave": a working module reading as an outage on every new environment.
  *
  * Ensured through the OWNER rather than guarded with another .catch(). A catch that swallows a
  * missing table swallows a real read failure too, and then renders it as an empty roster - the
  * refused-read-as-a-clean-zero shape this codebase has already had to fix once.
  */
 await ensurePeopleTables(db);
 const attendanceManager=managesAttendance(actor),leaveManager=managesLeave(actor);
 if(attendanceManager||leaveManager){
  const scope=await managerScope(db,actor);
  const directory=await attendanceLeaveDirectory(db,scope);
  // Only a manager gets the roster, and only so the assignment/grant/decision controls can name a
  // person instead of demanding a raw employee id - narrowed to the same reporting line as the rows
  // above, so the controls cannot name somebody the screen may not show. Guarded because `employees`
  // belongs to lib/people-foundation.ts, which this route does not own and cannot assume initialised.
  const roster=scope.employeeIds===null
   ?await db.prepare("SELECT id,employee_code,display_name FROM employees WHERE employment_status='active' ORDER BY display_name LIMIT 200").all<Row>()
   :await db.prepare("SELECT id,employee_code,display_name FROM employees WHERE employment_status='active' ORDER BY display_name LIMIT 200").all<Row>().then(rows=>({results:rows.results.filter(r=>scope.employeeIds?.includes(text(r.id)))}));
  return Response.json({data:{...directory,employees:roster.results,scope:{mode:"manager",employeeId:scope.ownEmployeeId,organizationalScope:scope.reason,canManageAttendance:attendanceManager,canManageLeave:leaveManager}},productionReady:false});
 }
 const own=await ownEmployee(db,actor.email);
 const id=own?text(own.id):"";
 const directory=await attendanceLeaveDirectory(db,{employeeIds:id?[id]:[]});
 const mine=(rows:Row[])=>id?rows.filter(r=>text(r.employee_id)===id):[];
 // An employee still needs the leave POLICIES (which codes exist, and whether the engine has any
 // configuration at all) and the period locks (why a check-in was refused). Neither is personal data;
 // both are the configuration their own request is judged against.
 return Response.json({data:{attendanceDays:mine(directory.attendanceDays),pendingAdjustments:mine(directory.pendingAdjustments),leaveRequests:mine(directory.leaveRequests),leaveBalances:mine(directory.leaveBalances),shiftAssignments:mine(directory.shiftAssignments),leavePolicies:directory.leavePolicies,shiftPolicies:[],periodLocks:directory.periodLocks,employees:[],scope:{mode:"self",employeeId:id||null,canManageAttendance:false,canManageLeave:false},truth:directory.truth},productionReady:false});
}catch(error){return authError(error,"Unable to load attendance and leave");}}
export async function POST(request:Request){try{const actor=await resolveActor(request),db=await database(),body=await request.json() as Row,action=text(body.action),employeeId=text(body.employeeId);
 if(["check_in","check_out","request_adjustment","request_leave"].includes(action)){requirePermission(actor,action==="request_leave"?"leave.view":"attendance.view");await assertEmployeeScope(db,actor,employeeId);}
 if(action==="check_in"||action==="check_out"){const data=await recordAttendance(db,{employeeId,eventType:action,occurredAt:Number(body.occurredAt||Date.now()),idempotencyKey:text(body.idempotencyKey),actorId:actor.email,source:text(body.source)||"self_service"});await securityAudit(db,actor,`attendance.${action}`,"employee",employeeId,"completed",{duplicatePrevented:data.duplicatePrevented});return Response.json({data,productionReady:false});}
 if(action==="request_adjustment"){const data=await requestAdjustment(db,{employeeId,workDate:text(body.workDate),requestedStatus:text(body.requestedStatus)||null,requestedCheckIn:body.requestedCheckIn==null?null:Number(body.requestedCheckIn),requestedCheckOut:body.requestedCheckOut==null?null:Number(body.requestedCheckOut),reason:text(body.reason),actorId:actor.email});await securityAudit(db,actor,"attendance.request_adjustment","employee",employeeId,"completed",{requestId:data.id,workDate:text(body.workDate)});return Response.json({data,productionReady:false});}
 if(action==="request_leave"){const data=await requestLeave(db,{employeeId,leaveCode:text(body.leaveCode),startDate:text(body.startDate),endDate:text(body.endDate),units:Number(body.units),reason:text(body.reason),actorId:actor.email});await securityAudit(db,actor,"leave.request","employee",employeeId,"completed",{requestId:data.id,leaveCode:text(body.leaveCode),units:Number(body.units)});return Response.json({data,productionReady:false});}
 if(action==="save_shift_policy"){requirePermission(actor,"attendance.manage");const data=await saveShiftPolicy(db,{name:text(body.name),timezone:text(body.timezone),startTime:text(body.startTime)||null,endTime:text(body.endTime)||null,weeklyOff:Array.isArray(body.weeklyOff)?body.weeklyOff.map(text):[],locationRule:text(body.locationRule)==="policy_required"?"policy_required":"not_required",effectiveFrom:Number(body.effectiveFrom),actorId:actor.email});await securityAudit(db,actor,"attendance.save_shift_policy","shift_policy",data.id,"completed",{version:data.version});return Response.json({data,productionReady:false});}
 if(action==="assign_shift"){requirePermission(actor,"attendance.manage");const data=await assignShift(db,{employeeId,shiftPolicyId:text(body.shiftPolicyId),effectiveFrom:Number(body.effectiveFrom),reason:text(body.reason),actorId:actor.email});await securityAudit(db,actor,"attendance.assign_shift","employee",employeeId,"completed",{assignmentId:data.id,shiftPolicyId:text(body.shiftPolicyId)});return Response.json({data,productionReady:false});}
 if(action==="approve_adjustment"){requirePermission(actor,"attendance.manage");const data=await approveAdjustment(db,{requestId:text(body.requestId),actorId:actor.email});await securityAudit(db,actor,"attendance.approve_adjustment","attendance_adjustment",text(body.requestId),"completed",{});return Response.json({data,productionReady:false});}
 if(action==="set_period_lock"){requirePermission(actor,"attendance.manage");const data=await setPeriodLock(db,{periodStart:Number(body.periodStart),periodEnd:Number(body.periodEnd),status:text(body.status)==="locked"?"locked":"open",actorId:actor.email});await securityAudit(db,actor,"attendance.set_period_lock","people_period_lock",`${data.periodStart}-${data.periodEnd}`,"completed",{status:data.status});return Response.json({data,productionReady:false});}
 if(action==="save_leave_policy"){requirePermission(actor,"leave.manage");const data=await saveLeavePolicy(db,{name:text(body.name),leaveCode:text(body.leaveCode),allowNegative:Boolean(body.allowNegative),entitlementUnits:body.entitlementUnits==null?null:Number(body.entitlementUnits),effectiveFrom:Number(body.effectiveFrom),actorId:actor.email});await securityAudit(db,actor,"leave.save_policy","leave_policy",data.id,"completed",{version:data.version,leaveCode:text(body.leaveCode)});return Response.json({data,productionReady:false});}
 if(action==="grant_leave_entitlement"){requirePermission(actor,"leave.manage");const data=await grantLeaveEntitlement(db,{employeeId,leaveCode:text(body.leaveCode),units:body.units==null||text(body.units)===""?null:Number(body.units),reason:text(body.reason),actorId:actor.email});await securityAudit(db,actor,"leave.grant_entitlement","employee",employeeId,"completed",{leaveCode:text(body.leaveCode),granted:data.granted,balance:data.balance,duplicatePrevented:data.duplicatePrevented});return Response.json({data,productionReady:false});}
 if(action==="decide_leave"){requirePermission(actor,"leave.manage");const decision=text(body.decision);if(decision!=="approved"&&decision!=="rejected")return Response.json({error:"Decision must be approved or rejected"},{status:400});const data=await decideLeave(db,{requestId:text(body.requestId),decision,reason:text(body.reason),actorId:actor.email});await securityAudit(db,actor,"leave.decide","leave_request",text(body.requestId),"completed",{decision});return Response.json({data,productionReady:false});}
 return Response.json({error:"Unknown attendance/leave action"},{status:400});}catch(error){return authError(error,"Attendance/leave update failed");}}
