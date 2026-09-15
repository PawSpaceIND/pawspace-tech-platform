import{authError,authorize,database,requirePermission,resolveActor,securityAudit}from"../../../lib/server-auth";
import{governedJsonError}from"../../../lib/governed-http-error";
import{approveAdjustment,assignShift,attendanceLeaveDirectory,decideLeave,grantLeaveEntitlement,recordAttendance,requestAdjustment,requestLeave,saveLeavePolicy,saveShiftPolicy,setPeriodLock}from"../../../lib/attendance-leave";
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
export async function GET(request:Request){try{
 const actor=await authorize(request,"attendance.view"),db=await database();
 const directory=await attendanceLeaveDirectory(db);
 const attendanceManager=managesAttendance(actor),leaveManager=managesLeave(actor);
 if(attendanceManager||leaveManager){
  // Only a manager gets the roster, and only so the assignment/grant/decision controls can name a
  // person instead of demanding a raw employee id. Guarded because `employees` belongs to
  // lib/people-foundation.ts, which this route does not own and cannot assume has been initialised.
  const roster=await db.prepare("SELECT id,employee_code,display_name FROM employees WHERE employment_status='active' ORDER BY display_name LIMIT 200").all<Row>().catch(()=>({results:[] as Row[]}));
  return Response.json({data:{...directory,employees:roster.results,scope:{mode:"manager",employeeId:null,canManageAttendance:attendanceManager,canManageLeave:leaveManager}},productionReady:false});
 }
 const own=await ownEmployee(db,actor.email);
 const id=own?text(own.id):"";
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
