"use client";
import{useEffect,useState}from"react";
// R3-G / F4: this "back to the hub" cue was unconditional while /team/people needs people.view, so a
// child screen offered a door its own hub refuses. Same gate as every other link on the platform.
import{StaffGatedLink}from"../../../components/hub-workspace-links";
import{istDayEnd,istDayStart,istDayString}from"../../../../lib/ist-day";
import{leaveSpanDays}from"../../../../lib/leave-span";

/**
 * Time & leave: the screen that makes /api/attendance-leave reachable. [W2C-TIME-CONTROLS]
 *
 * Six of this route's nine actions were posted by NO .tsx file in the repository - request_leave,
 * request_adjustment, approve_adjustment, save_shift_policy, assign_shift, save_leave_policy and
 * decide_leave. (An inventory scan credited approve_adjustment to the Incentives screen; that screen
 * posts an identically-named INCENTIVE action to a different route.) The consequences compounded:
 *
 *   - no screen could define a leave policy, and lib/attendance-leave.ts refuses every leave request
 *     with "Active leave policy configuration is required" until one exists, so the apply-for-leave
 *     form on /me was a button that could only ever fail;
 *   - no screen could DECIDE a leave request, so anything that did get requested sat pending forever;
 *   - no screen could request or approve an attendance adjustment, which is the only way to correct
 *     attendance inside a locked payroll period.
 *
 * The permission split in the route is reproduced here rather than reinvented: an employee sees their
 * own days, requests and balance and can ask for leave or a correction; attendance.manage owns the
 * shift configuration, the adjustment queue and the period lock; leave.manage owns leave policy,
 * entitlement grants and the approval queue. `scope` in the GET payload says which of those the
 * signed-in actor is, so the screen never draws a control its own API would refuse.
 */

export type AttendanceDay={id:string;employee_id:string;work_date:string;status:string;first_check_in?:number|null;last_check_out?:number|null;worked_minutes?:number|null;exception_code?:string|null};
export type LeaveRequest={id:string;employee_id:string;leave_code:string;start_date:string;end_date:string;units:number;status:string;reason:string;requested_by?:string|null};
export type Adjustment={id:string;employee_id:string;work_date:string;status:string;reason:string;requested_status?:string|null;requested_check_in?:number|null;requested_check_out?:number|null};
export type LeavePolicy={id:string;name:string;version:number;leave_code:string;allow_negative:number;entitlement_units?:number|null;effective_from:number};
export type ShiftPolicy={id:string;name:string;version:number;timezone:string;start_time?:string|null;end_time?:string|null;location_rule:string;effective_from:number};
export type ShiftAssignment={id:string;employee_id:string;shift_policy_id:string;effective_from:number};
export type LeaveBalance={employee_id:string;leave_code:string;balance:number};
export type PeriodLock={id:string;period_start:number;period_end:number;status:string};
export type EmployeeRow={id:string;employee_code:string;display_name:string};
export type Scope={mode:"manager"|"self";employeeId:string|null;organizationalScope?:string;canManageAttendance:boolean;canManageLeave:boolean};
export type Payload={
  attendanceDays:AttendanceDay[];pendingAdjustments:Adjustment[];leaveRequests:LeaveRequest[];
  leavePolicies:LeavePolicy[];shiftPolicies:ShiftPolicy[];shiftAssignments:ShiftAssignment[];
  leaveBalances:LeaveBalance[];periodLocks:PeriodLock[];employees:EmployeeRow[];scope:Scope;
  truth:{hardcodedGraceMinutes:boolean;hardcodedLeaveEntitlement:boolean;hardcodedOvertimeRate:boolean;gpsRequired:boolean;productionReady:boolean};
};

const when=(v?:number|null)=>v?new Date(v).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"—";
const day=(v?:number|null)=>v?istDayString(v):"—";
/** "2026-09-15T09:00" from a datetime-local input, or NaN when the field is empty or unparseable. */
export const epochOf=(value:string)=>{const parsed=new Date(value).getTime();return Number.isFinite(parsed)?parsed:NaN;};
/**
 * Every date this screen sends is an IST calendar day. [R3E-IST-DAY]
 *
 * These were utcDayStart/utcDayEnd, and the period lock was the place it hurt: a lock typed as
 * "2026-09-01 → 2026-09-14" was stored as 1 Sep 00:00Z → 14 Sep 23:59Z, which is 1 Sep 05:30 IST to
 * 15 Sep 05:29 IST. Reproduced against the running product: a check-in on 15 September - a day the
 * operator never locked - was refused 409, while a check-in at 02:00 IST on 1 September - a day they
 * DID lock - was accepted, and filed itself against 31 August, inside the previous payroll month.
 * The same shift applies to every effective date on this screen, which is what a leave policy, a
 * shift policy and a shift assignment are dated by.
 */
export{istDayStart,istDayEnd};

/*
 * Each `missing*` predicate mirrors the engine rule it fronts, so a control is live only when the
 * request behind it can actually be accepted, and the operator reads WHICH field is missing instead of
 * spending a round trip to find out. The engine stays the authority - these never replace its checks.
 */

export type LeaveDraft={leaveCode:string;startDate:string;endDate:string;units:string;reason:string};
/** Both dates present -> the Days field is the span they describe, so the two cannot disagree. */
export function withDerivedDays(draft:LeaveDraft):LeaveDraft{const span=leaveSpanDays(draft.startDate,draft.endDate);return span===null?draft:{...draft,units:String(span)};}
export function missingLeaveRequestFields(draft:LeaveDraft,policies:LeavePolicy[]){
  const missing:string[]=[];
  if(!policies.length)missing.push("an active leave policy — ask People Ops to publish one before requesting leave");
  else if(!policies.some(p=>p.leave_code===draft.leaveCode.trim()))missing.push("a leave type that has an active policy");
  if(!draft.startDate)missing.push("a start date");
  if(!draft.endDate)missing.push("an end date");
  if(draft.startDate&&draft.endDate&&draft.endDate<draft.startDate)missing.push("an end date on or after the start date");
  const units=Number(draft.units);
  if(!draft.units.trim()||!Number.isFinite(units)||units<=0)missing.push("a positive number of days");
  // `units` is what the balance is debited by, and it was free text with no tie to the dates at all -
  // a ten-day range could be, and was, booked against one day of leave. [R3E-LEAVE-UNITS]
  else{const span=leaveSpanDays(draft.startDate,draft.endDate);if(span!==null&&units!==span&&units!==span-0.5)missing.push(`days that match the dates — ${draft.startDate} to ${draft.endDate} is ${span} day(s)`);}
  if(draft.reason.trim().length<4)missing.push("a reason of at least 4 characters");
  return missing;
}

export type AdjustmentDraft={workDate:string;requestedStatus:string;checkIn:string;checkOut:string;reason:string};
export function missingAdjustmentFields(draft:AdjustmentDraft){
  const missing:string[]=[];
  if(!draft.workDate)missing.push("the work date being corrected");
  if(draft.reason.trim().length<8)missing.push("a reason of at least 8 characters");
  if(draft.checkIn&&Number.isNaN(epochOf(draft.checkIn)))missing.push("a readable check-in time");
  if(draft.checkOut&&Number.isNaN(epochOf(draft.checkOut)))missing.push("a readable check-out time");
  if(draft.checkIn&&draft.checkOut&&epochOf(draft.checkOut)<epochOf(draft.checkIn))missing.push("a check-out at or after the check-in");
  if(!draft.checkIn&&!draft.checkOut&&!draft.requestedStatus.trim())missing.push("a corrected status, or a corrected check-in/check-out");
  return missing;
}

export type LeavePolicyDraft={name:string;leaveCode:string;allowNegative:boolean;entitlementUnits:string;effectiveFrom:string};
export function missingLeavePolicyFields(draft:LeavePolicyDraft){
  const missing:string[]=[];
  if(!draft.name.trim())missing.push("a policy name");
  if(!draft.leaveCode.trim())missing.push("a leave code");
  if(!draft.effectiveFrom||Number.isNaN(istDayStart(draft.effectiveFrom)))missing.push("an effective date");
  if(draft.entitlementUnits.trim()&&!(Number(draft.entitlementUnits)>0))missing.push("entitlement units above zero, or none at all");
  return missing;
}

export type GrantDraft={employeeId:string;leaveCode:string;units:string;reason:string};
export function missingGrantFields(draft:GrantDraft,policies:LeavePolicy[]){
  const missing:string[]=[];
  if(!draft.employeeId.trim())missing.push("an employee");
  const policy=policies.find(p=>p.leave_code===draft.leaveCode.trim());
  if(!policy)missing.push("a leave type that has an active policy");
  if(draft.reason.trim().length<4)missing.push("a reason of at least 4 characters");
  const typed=draft.units.trim()?Number(draft.units):null;
  if(typed!==null&&!(typed>0))missing.push("units above zero");
  if(typed===null&&policy&&!(Number(policy.entitlement_units)>0))missing.push(`units to grant — the ${policy.leave_code} policy carries no entitlement`);
  return missing;
}

export type ShiftPolicyDraft={name:string;timezone:string;startTime:string;endTime:string;weeklyOff:string;locationRule:string;effectiveFrom:string};
export function missingShiftPolicyFields(draft:ShiftPolicyDraft){
  const missing:string[]=[];
  if(!draft.name.trim())missing.push("a shift name");
  if(!draft.timezone.trim())missing.push("a timezone");
  if(!draft.effectiveFrom||Number.isNaN(istDayStart(draft.effectiveFrom)))missing.push("an effective date");
  return missing;
}

export type AssignShiftDraft={employeeId:string;shiftPolicyId:string;effectiveFrom:string;reason:string};
export function missingAssignShiftFields(draft:AssignShiftDraft){
  const missing:string[]=[];
  if(!draft.employeeId.trim())missing.push("an employee");
  if(!draft.shiftPolicyId.trim())missing.push("a shift policy");
  if(!draft.effectiveFrom||Number.isNaN(istDayStart(draft.effectiveFrom)))missing.push("an effective date");
  if(draft.reason.trim().length<8)missing.push("a reason of at least 8 characters");
  return missing;
}

export type PeriodLockDraft={periodStart:string;periodEnd:string;status:string};
export function missingPeriodLockFields(draft:PeriodLockDraft){
  const missing:string[]=[];
  if(!draft.periodStart)missing.push("a period start");
  if(!draft.periodEnd)missing.push("a period end");
  if(draft.periodStart&&draft.periodEnd&&draft.periodEnd<draft.periodStart)missing.push("a period end on or after the start");
  return missing;
}

/*
 * The exact request body each control sends, as a function. The button calls it, and so can a test -
 * so "the screen posts something the API accepts" is provable end to end instead of inferred from the
 * shape of a JSX handler. Every one names its `action`, which is the whole point: six of these actions
 * were named by no .tsx file in the repository.
 */
export const leaveRequestBody=(employeeId:string,draft:LeaveDraft)=>({action:"request_leave",employeeId,leaveCode:draft.leaveCode.trim(),startDate:draft.startDate,endDate:draft.endDate,units:Number(draft.units),reason:draft.reason.trim()});
export const adjustmentRequestBody=(employeeId:string,draft:AdjustmentDraft)=>({action:"request_adjustment",employeeId,workDate:draft.workDate,requestedStatus:draft.requestedStatus.trim()||null,requestedCheckIn:draft.checkIn?epochOf(draft.checkIn):null,requestedCheckOut:draft.checkOut?epochOf(draft.checkOut):null,reason:draft.reason.trim()});
export const leaveDecisionBody=(requestId:string,decision:"approved"|"rejected",reason:string)=>({action:"decide_leave",requestId,decision,reason:reason.trim()});
export const adjustmentApprovalBody=(requestId:string)=>({action:"approve_adjustment",requestId});
export const leavePolicyBody=(draft:LeavePolicyDraft)=>({action:"save_leave_policy",name:draft.name.trim(),leaveCode:draft.leaveCode.trim(),allowNegative:draft.allowNegative,entitlementUnits:draft.entitlementUnits.trim()?Number(draft.entitlementUnits):null,effectiveFrom:istDayStart(draft.effectiveFrom)});
export const grantEntitlementBody=(draft:GrantDraft)=>({action:"grant_leave_entitlement",employeeId:draft.employeeId,leaveCode:draft.leaveCode.trim(),units:draft.units.trim()?Number(draft.units):null,reason:draft.reason.trim()});
export const shiftPolicyBody=(draft:ShiftPolicyDraft)=>({action:"save_shift_policy",name:draft.name.trim(),timezone:draft.timezone.trim(),startTime:draft.startTime||null,endTime:draft.endTime||null,weeklyOff:draft.weeklyOff.split(",").map(d=>d.trim()).filter(Boolean),locationRule:draft.locationRule,effectiveFrom:istDayStart(draft.effectiveFrom)});
export const assignShiftBody=(draft:AssignShiftDraft)=>({action:"assign_shift",employeeId:draft.employeeId,shiftPolicyId:draft.shiftPolicyId,effectiveFrom:istDayStart(draft.effectiveFrom),reason:draft.reason.trim()});
export const periodLockBody=(draft:PeriodLockDraft)=>({action:"set_period_lock",periodStart:istDayStart(draft.periodStart),periodEnd:istDayEnd(draft.periodEnd),status:draft.status});

const box={border:"1px solid #ddd",borderRadius:12,padding:14} as const;
const field={width:"100%",marginBottom:6,minHeight:34,boxSizing:"border-box"} as const;
const hint={color:"#a3324b",fontSize:13,margin:"0 0 6px"} as const;
type Post=(body:Record<string,unknown>)=>Promise<void>;

function Missing({missing}:{missing:string[]}){
  if(!missing.length)return null;
  return <p role="status" style={hint}>This still needs {missing.join("; ")}.</p>;
}

export function LeaveRequestForm({employeeId,policies,balances,busy,onSubmit}:{employeeId:string;policies:LeavePolicy[];balances:LeaveBalance[];busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<LeaveDraft>({leaveCode:policies[0]?.leave_code??"",startDate:"",endDate:"",units:"1",reason:""});
  const missing=missingLeaveRequestFields(draft,policies);
  const balance=balances.find(b=>b.leave_code===draft.leaveCode.trim());
  return <article style={box}>
    <h3 style={{marginTop:0}}>Request leave</h3>
    <select aria-label="Leave type" value={draft.leaveCode} style={field} onChange={e=>setDraft({...draft,leaveCode:e.target.value})}>
      <option value="">Select a leave type</option>
      {policies.map(p=><option key={p.id} value={p.leave_code}>{p.leave_code} · {p.name} (v{p.version}){Number(p.allow_negative)===1?" · negative allowed":""}</option>)}
    </select>
    <div style={{display:"flex",gap:8}}>
      <label style={{flex:1,fontSize:13}}>From<input type="date" value={draft.startDate} style={field} onChange={e=>setDraft(withDerivedDays({...draft,startDate:e.target.value}))}/></label>
      <label style={{flex:1,fontSize:13}}>To<input type="date" value={draft.endDate} style={field} onChange={e=>setDraft(withDerivedDays({...draft,endDate:e.target.value}))}/></label>
      <label style={{width:90,fontSize:13}}>Days<input type="number" min="0.5" step="0.5" aria-label="Leave days" value={draft.units} style={field} onChange={e=>setDraft({...draft,units:e.target.value})}/></label>
    </div>
    <input placeholder="Reason" aria-label="Leave reason" value={draft.reason} style={field} onChange={e=>setDraft({...draft,reason:e.target.value})}/>
    <p style={{fontSize:13,margin:"0 0 6px"}}>Balance on {draft.leaveCode||"—"}: <b>{balance?balance.balance:0}</b> day(s)</p>
    <Missing missing={missing}/>
    <button disabled={busy||missing.length>0} onClick={()=>void onSubmit(leaveRequestBody(employeeId,draft))}>Submit for approval</button>
  </article>;
}

export function AdjustmentRequestForm({employeeId,busy,onSubmit}:{employeeId:string;busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<AdjustmentDraft>({workDate:"",requestedStatus:"present",checkIn:"",checkOut:"",reason:""});
  const missing=missingAdjustmentFields(draft);
  return <article style={box}>
    <h3 style={{marginTop:0}}>Request an attendance correction</h3>
    <p style={{fontSize:13,marginTop:0}}>Once a payroll period is locked, a check-in or check-out is refused outright. This request is the only way a day inside a locked period can still be corrected — a manager with attendance.manage approves it and the correction is applied.</p>
    <label style={{fontSize:13}}>Work date<input type="date" value={draft.workDate} style={field} onChange={e=>setDraft({...draft,workDate:e.target.value})}/></label>
    <input placeholder="Corrected status (present, absent, on_leave…)" aria-label="Corrected status" value={draft.requestedStatus} style={field} onChange={e=>setDraft({...draft,requestedStatus:e.target.value})}/>
    <div style={{display:"flex",gap:8}}>
      <label style={{flex:1,fontSize:13}}>Corrected check-in<input type="datetime-local" value={draft.checkIn} style={field} onChange={e=>setDraft({...draft,checkIn:e.target.value})}/></label>
      <label style={{flex:1,fontSize:13}}>Corrected check-out<input type="datetime-local" value={draft.checkOut} style={field} onChange={e=>setDraft({...draft,checkOut:e.target.value})}/></label>
    </div>
    <input placeholder="Reason (8+ characters)" aria-label="Adjustment reason" value={draft.reason} style={field} onChange={e=>setDraft({...draft,reason:e.target.value})}/>
    <Missing missing={missing}/>
    <button disabled={busy||missing.length>0} onClick={()=>void onSubmit(adjustmentRequestBody(employeeId,draft))}>Request correction</button>
  </article>;
}

export function LeaveDecisionQueue({requests,busy,onDecide}:{requests:LeaveRequest[];busy:boolean;onDecide:Post}){
  const[reasons,setReasons]=useState<Record<string,string>>({});
  const pending=requests.filter(r=>r.status==="pending");
  return <article style={box}>
    <h3 style={{marginTop:0}}>Leave approval queue</h3>
    {!pending.length?<p style={{margin:0}}>No leave request is waiting for a decision.</p>:null}
    {pending.map(r=><div key={r.id} style={{borderTop:"1px solid #eee",padding:"8px 0"}}>
      <b>{r.leave_code} · {r.units} day(s)</b> · <code>{r.employee_id}</code> · {r.start_date} → {r.end_date}
      <div style={{fontSize:13}}>{r.reason}</div>
      <input placeholder="Decision note" aria-label={`Decision note for ${r.id}`} value={reasons[r.id]??""} style={field} onChange={e=>setReasons({...reasons,[r.id]:e.target.value})}/>
      <div style={{display:"flex",gap:8}}>
        <button disabled={busy} onClick={()=>void onDecide(leaveDecisionBody(r.id,"approved",reasons[r.id]??""))}>Approve</button>
        <button disabled={busy} onClick={()=>void onDecide(leaveDecisionBody(r.id,"rejected",reasons[r.id]??""))}>Reject</button>
      </div>
      <small>Maker/checker: the person who raised a request can never approve it.</small>
    </div>)}
  </article>;
}

export function AdjustmentApprovalQueue({adjustments,busy,onApprove}:{adjustments:Adjustment[];busy:boolean;onApprove:Post}){
  return <article style={box}>
    <h3 style={{marginTop:0}}>Attendance adjustment queue</h3>
    {!adjustments.length?<p style={{margin:0}}>No attendance correction is waiting for approval.</p>:null}
    {adjustments.map(a=><div key={a.id} style={{borderTop:"1px solid #eee",padding:"8px 0"}}>
      <b>{a.work_date}</b> · <code>{a.employee_id}</code> · requested {a.requested_status||"present"} · in {when(a.requested_check_in)} · out {when(a.requested_check_out)}
      <div style={{fontSize:13}}>{a.reason}</div>
      <button disabled={busy} onClick={()=>void onApprove(adjustmentApprovalBody(a.id))}>Approve correction</button>
    </div>)}
  </article>;
}

export function LeavePolicyForm({busy,onSubmit}:{busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<LeavePolicyDraft>({name:"",leaveCode:"",allowNegative:false,entitlementUnits:"",effectiveFrom:""});
  const missing=missingLeavePolicyFields(draft);
  return <article style={box}>
    <h3 style={{marginTop:0}}>Leave policy</h3>
    <p style={{fontSize:13,marginTop:0}}>Until an active policy exists for a leave code, every request for it is refused with &quot;Active leave policy configuration is required&quot;. Saving publishes a new version; entitlement units are what an entitlement grant credits by default.</p>
    <input placeholder="Policy name" aria-label="Leave policy name" value={draft.name} style={field} onChange={e=>setDraft({...draft,name:e.target.value})}/>
    <input placeholder="Leave code (CL, SL, EL…)" aria-label="Leave code" value={draft.leaveCode} style={field} onChange={e=>setDraft({...draft,leaveCode:e.target.value})}/>
    <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:6}}>
      <label style={{flex:1,fontSize:13}}>Entitlement units<input type="number" min="0" step="0.5" value={draft.entitlementUnits} style={field} onChange={e=>setDraft({...draft,entitlementUnits:e.target.value})}/></label>
      <label style={{flex:1,fontSize:13}}>Effective from<input type="date" value={draft.effectiveFrom} style={field} onChange={e=>setDraft({...draft,effectiveFrom:e.target.value})}/></label>
      <label style={{fontSize:13}}><input type="checkbox" checked={draft.allowNegative} onChange={e=>setDraft({...draft,allowNegative:e.target.checked})}/> Allow a negative balance</label>
    </div>
    <Missing missing={missing}/>
    <button disabled={busy||missing.length>0} onClick={()=>void onSubmit(leavePolicyBody(draft))}>Publish policy version</button>
  </article>;
}

export function GrantEntitlementForm({employees,policies,busy,onSubmit}:{employees:EmployeeRow[];policies:LeavePolicy[];busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<GrantDraft>({employeeId:"",leaveCode:policies[0]?.leave_code??"",units:"",reason:""});
  const missing=missingGrantFields(draft,policies);
  return <article style={box}>
    <h3 style={{marginTop:0}}>Grant leave entitlement</h3>
    <p style={{fontSize:13,marginTop:0}}>Credits the balance a request is judged against. Leave units blank to grant the active policy&apos;s entitlement. One grant per policy version per employee — pressing this twice credits once.</p>
    <select aria-label="Employee" value={draft.employeeId} style={field} onChange={e=>setDraft({...draft,employeeId:e.target.value})}>
      <option value="">Select an employee</option>
      {employees.map(e=><option key={e.id} value={e.id}>{e.display_name} · {e.employee_code}</option>)}
    </select>
    <select aria-label="Entitlement leave type" value={draft.leaveCode} style={field} onChange={e=>setDraft({...draft,leaveCode:e.target.value})}>
      <option value="">Select a leave type</option>
      {policies.map(p=><option key={p.id} value={p.leave_code}>{p.leave_code} · entitlement {p.entitlement_units??"none"}</option>)}
    </select>
    <input placeholder="Units (blank = policy entitlement)" aria-label="Entitlement units to grant" value={draft.units} style={field} onChange={e=>setDraft({...draft,units:e.target.value})}/>
    <input placeholder="Reason" aria-label="Entitlement reason" value={draft.reason} style={field} onChange={e=>setDraft({...draft,reason:e.target.value})}/>
    <Missing missing={missing}/>
    <button disabled={busy||missing.length>0} onClick={()=>void onSubmit(grantEntitlementBody(draft))}>Grant entitlement</button>
  </article>;
}

export function ShiftPolicyForm({busy,onSubmit}:{busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<ShiftPolicyDraft>({name:"",timezone:"Asia/Kolkata",startTime:"",endTime:"",weeklyOff:"",locationRule:"not_required",effectiveFrom:""});
  const missing=missingShiftPolicyFields(draft);
  return <article style={box}>
    <h3 style={{marginTop:0}}>Shift policy</h3>
    <input placeholder="Shift name" aria-label="Shift name" value={draft.name} style={field} onChange={e=>setDraft({...draft,name:e.target.value})}/>
    <input placeholder="Timezone" aria-label="Shift timezone" value={draft.timezone} style={field} onChange={e=>setDraft({...draft,timezone:e.target.value})}/>
    <div style={{display:"flex",gap:8}}>
      <label style={{flex:1,fontSize:13}}>Start<input type="time" value={draft.startTime} style={field} onChange={e=>setDraft({...draft,startTime:e.target.value})}/></label>
      <label style={{flex:1,fontSize:13}}>End<input type="time" value={draft.endTime} style={field} onChange={e=>setDraft({...draft,endTime:e.target.value})}/></label>
      <label style={{flex:1,fontSize:13}}>Effective from<input type="date" value={draft.effectiveFrom} style={field} onChange={e=>setDraft({...draft,effectiveFrom:e.target.value})}/></label>
    </div>
    <input placeholder="Weekly off days, comma separated (sun,sat)" aria-label="Weekly off" value={draft.weeklyOff} style={field} onChange={e=>setDraft({...draft,weeklyOff:e.target.value})}/>
    <select aria-label="Location rule" value={draft.locationRule} style={field} onChange={e=>setDraft({...draft,locationRule:e.target.value})}>
      <option value="not_required">Location not required</option>
      <option value="policy_required">Location required by policy</option>
    </select>
    <Missing missing={missing}/>
    <button disabled={busy||missing.length>0} onClick={()=>void onSubmit(shiftPolicyBody(draft))}>Publish shift version</button>
  </article>;
}

export function AssignShiftForm({employees,shiftPolicies,busy,onSubmit}:{employees:EmployeeRow[];shiftPolicies:ShiftPolicy[];busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<AssignShiftDraft>({employeeId:"",shiftPolicyId:"",effectiveFrom:"",reason:""});
  const missing=missingAssignShiftFields(draft);
  return <article style={box}>
    <h3 style={{marginTop:0}}>Assign a shift</h3>
    <select aria-label="Shift assignee" value={draft.employeeId} style={field} onChange={e=>setDraft({...draft,employeeId:e.target.value})}>
      <option value="">Select an employee</option>
      {employees.map(e=><option key={e.id} value={e.id}>{e.display_name} · {e.employee_code}</option>)}
    </select>
    <select aria-label="Shift policy" value={draft.shiftPolicyId} style={field} onChange={e=>setDraft({...draft,shiftPolicyId:e.target.value})}>
      <option value="">Select a shift policy</option>
      {shiftPolicies.map(p=><option key={p.id} value={p.id}>{p.name} v{p.version} · {p.timezone}</option>)}
    </select>
    <label style={{fontSize:13}}>Effective from<input type="date" value={draft.effectiveFrom} style={field} onChange={e=>setDraft({...draft,effectiveFrom:e.target.value})}/></label>
    <input placeholder="Reason (8+ characters)" aria-label="Shift assignment reason" value={draft.reason} style={field} onChange={e=>setDraft({...draft,reason:e.target.value})}/>
    <Missing missing={missing}/>
    <button disabled={busy||missing.length>0} onClick={()=>void onSubmit(assignShiftBody(draft))}>Assign shift</button>
  </article>;
}

export function PeriodLockForm({locks,busy,onSubmit}:{locks:PeriodLock[];busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<PeriodLockDraft>({periodStart:"",periodEnd:"",status:"locked"});
  const missing=missingPeriodLockFields(draft);
  return <article style={box}>
    <h3 style={{marginTop:0}}>Payroll period lock</h3>
    <p style={{fontSize:13,marginTop:0}}>A locked period refuses every check-in and check-out inside it. Corrections then have to travel through the adjustment queue, which leaves an approver and a reason on the record.</p>
    <div style={{display:"flex",gap:8}}>
      <label style={{flex:1,fontSize:13}}>Period start<input type="date" value={draft.periodStart} style={field} onChange={e=>setDraft({...draft,periodStart:e.target.value})}/></label>
      <label style={{flex:1,fontSize:13}}>Period end<input type="date" value={draft.periodEnd} style={field} onChange={e=>setDraft({...draft,periodEnd:e.target.value})}/></label>
      <label style={{flex:1,fontSize:13}}>State<select aria-label="Period lock state" value={draft.status} style={field} onChange={e=>setDraft({...draft,status:e.target.value})}><option value="locked">Locked</option><option value="open">Open</option></select></label>
    </div>
    <Missing missing={missing}/>
    <button disabled={busy||missing.length>0} onClick={()=>void onSubmit(periodLockBody(draft))}>Apply period state</button>
    <div style={{marginTop:8}}>{locks.map(l=><div key={l.id} style={{fontSize:13}}>{day(l.period_start)} → {day(l.period_end)} · <b>{l.status}</b></div>)}</div>
  </article>;
}

async function fetchPayload(){const r=await fetch("/api/attendance-leave",{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"Attendance load failed");return p.data as Payload;}

/**
 * The whole authenticated screen, as a pure function of the GET payload.
 *
 * Split out from the default export so the permission SPLIT is something a test can render rather than
 * something a reader has to take on trust: hand it a `scope` and read back which controls exist. The
 * default export owns the fetch, the busy flag and the error/success line, and nothing else.
 */
export function TimeAndLeaveScreen({data,busy,loading,error,message,onPost,onRefresh}:{data:Payload|null;busy:boolean;loading:boolean;error:string;message:string;onPost:Post;onRefresh:()=>void}){
  const scope=data?.scope,selfId=scope?.employeeId??"";
  return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
    <p><StaffGatedLink href="/team/people" permission="people.view">← People</StaffGatedLink></p>
    <p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE · PEOPLE · TIME &amp; LEAVE</p>
    <h1>Attendance, adjustments and leave</h1>
    <p>Policy-driven attendance and leave truth. Grace periods, entitlements, overtime and location requirements stay configuration-required until approved.</p>
    {error?<p role="alert">{error}</p>:null}
    {message?<p role="status">{message}</p>:null}
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10,margin:"18px 0"}}>
      <article style={box}><small>Attendance rows</small><strong style={{display:"block",fontSize:28}}>{data?.attendanceDays.length||0}</strong></article>
      <article style={box}><small>Pending adjustments</small><strong style={{display:"block",fontSize:28}}>{data?.pendingAdjustments.length||0}</strong></article>
      <article style={box}><small>Leave requests</small><strong style={{display:"block",fontSize:28}}>{data?.leaveRequests.length||0}</strong></article>
      <article style={box}><small>Active leave policies</small><strong style={{display:"block",fontSize:28}}>{data?.leavePolicies.length||0}</strong></article>
    </section>
    <p><button onClick={onRefresh} disabled={loading||busy}>{loading?"Refreshing…":"Refresh"}</button></p>

    {data&&!data.leavePolicies.length?<p role="status"><b>No active leave policy exists.</b> Every leave request is refused with &quot;Active leave policy configuration is required&quot; until someone holding leave.manage publishes one below.</p>:null}
    {data&&scope?.mode==="self"&&!selfId?<p role="status">Your sign-in is not linked to an active employee record, so there is nothing of your own to show. Ask People Ops to link your work email.</p>:null}
    {/* Which rows this screen is showing, stated rather than guessed at. A manager scoped to their own
      * reporting line sees a different roster from one who is not scoped at all, and until now there
      * was nothing on the page that said which of the two you were looking at. [R3E-TIME-SCOPE] */}
    {data&&scope?.mode==="manager"?<p role="status">{
      scope.organizationalScope==="reporting_line"?"Showing your own reporting line: you and your direct reports."
      :scope.organizationalScope==="global_no_direct_reports"?"Showing every employee: nobody currently reports to you, so there is no reporting line to narrow this to."
      :scope.organizationalScope==="global_unlinked"?"Showing every employee: your sign-in is not linked to an employee record, so there is no reporting line to narrow this to."
      :"Showing every employee: you hold company-wide People access."
    }</p>:null}

    {data&&selfId?<>
      <h2>My time and leave</h2>
      <p>Balance: {data.leaveBalances.length?data.leaveBalances.map(b=>`${b.leave_code} ${b.balance}`).join(" · "):"no leave balance has been granted yet"}</p>
      <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:10}}>
        <LeaveRequestForm employeeId={selfId} policies={data.leavePolicies} balances={data.leaveBalances} busy={busy} onSubmit={onPost}/>
        <AdjustmentRequestForm employeeId={selfId} busy={busy} onSubmit={onPost}/>
      </section>
    </>:null}

    {data&&scope?.canManageLeave?<>
      <h2>Leave administration</h2>
      <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:10}}>
        <LeavePolicyForm busy={busy} onSubmit={onPost}/>
        <GrantEntitlementForm employees={data.employees} policies={data.leavePolicies} busy={busy} onSubmit={onPost}/>
        <LeaveDecisionQueue requests={data.leaveRequests} busy={busy} onDecide={onPost}/>
      </section>
    </>:null}

    {data&&scope?.canManageAttendance?<>
      <h2>Attendance administration</h2>
      <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(320px,1fr))",gap:10}}>
        <ShiftPolicyForm busy={busy} onSubmit={onPost}/>
        <AssignShiftForm employees={data.employees} shiftPolicies={data.shiftPolicies} busy={busy} onSubmit={onPost}/>
        <AdjustmentApprovalQueue adjustments={data.pendingAdjustments} busy={busy} onApprove={onPost}/>
        <PeriodLockForm locks={data.periodLocks} busy={busy} onSubmit={onPost}/>
      </section>
    </>:null}

    <h2>Attendance</h2>
    <section style={{display:"grid",gap:8}}>{data?.attendanceDays.map(r=><article key={r.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{r.work_date} · {r.status}</b><div><code>{r.employee_id}</code> · In {when(r.first_check_in)} · Out {when(r.last_check_out)} · Worked {r.worked_minutes??"—"} min</div>{r.exception_code?<div><b>Exception:</b> {r.exception_code}</div>:null}</article>)}</section>
    <h2>Leave</h2>
    <section style={{display:"grid",gap:8}}>{data?.leaveRequests.map(r=><article key={r.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{r.leave_code} · {r.status}</b><div><code>{r.employee_id}</code> · {r.start_date} → {r.end_date} · {r.units} unit(s)</div><div>{r.reason}</div></article>)}</section>
    {loading&&!data?<p>Loading attendance and leave…</p>:null}
    <footer style={{marginTop:24}}><b>GPS required by code:</b> NO · <b>Hard-coded leave/grace/OT policy:</b> NO · <b>Production ready:</b> NO</footer>
  </main>;
}

export default function PeopleTimePage(){
  const[data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[message,setMessage]=useState(""),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  async function load(){setLoading(true);try{setData(await fetchPayload());setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setLoading(false);}}
  useEffect(()=>{let active=true;void fetchPayload().then(payload=>{if(active){setData(payload);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  async function post(body:Record<string,unknown>){
    setBusy(true);setError("");setMessage("");
    try{
      const response=await fetch("/api/attendance-leave",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const payload=await response.json() as{error?:string};
      if(!response.ok)throw new Error(payload.error||"Attendance/leave update failed");
      setMessage("Saved.");
      await load();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  return <TimeAndLeaveScreen data={data} busy={busy} loading={loading} error={error} message={message} onPost={post} onRefresh={()=>void load()}/>;
}
