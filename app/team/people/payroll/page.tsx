"use client";
import{useEffect,useState}from"react";
import Link from"next/link";
import{istDayStart,istDayString}from"../../../../lib/ist-day";

/**
 * Payroll: the screen that makes /api/payroll writable. [R3E-PAYROLL-CONTROLS]
 *
 * This page was NINE LINES and read-only. /api/payroll has always accepted save_structure,
 * assign_compensation, calculate, review, approve, prepare_payment and authorize_live_disbursement,
 * and the only two fetch("/api/payroll") calls in the whole product were this page's GET and the
 * onboarding form's structure dropdown - so there was no screen anywhere to define compensation,
 * calculate a run, review it, approve it, prepare payment or read the payslip register. A runtime
 * audit completed the entire payroll journey only by calling the API directly.
 *
 * Three rules are built into the controls rather than left for the engine to refuse after the fact:
 *
 *  - ONE RUN PER PERIOD. The period is chosen as a MONTH, not as two free dates, and the bounds are
 *    IST midnight to IST midnight of the following month - which is what the Finance period code is
 *    derived from downstream, and what makes two adjacent months provably non-overlapping. The
 *    idempotency key is derived from that month, so it is STABLE: a double-clicked button replays
 *    into the same run instead of minting a second one, which is the only thing an idempotency key
 *    was ever protecting against. lib/payroll-engine.ts now refuses an overlapping period outright;
 *    the control refuses it first, and names the run that already covers those days.
 *  - MAKER/CHECKER, drawn not discovered. The screen knows who is signed in (`scope` from the route)
 *    and disables Review for the person who calculated the run and Approve for either of them, with
 *    the reason written on the control. The engine still enforces both - this only stops the product
 *    from offering a button whose single possible outcome is a 409.
 *  - NOTHING IS TRANSMITTED. Payment preparation is sandbox-only and the live-disbursement control
 *    says in its own label that it records an MFA-backed approval and moves no money, because that is
 *    all lib/payroll-live-disbursement.ts does.
 *
 * The builders below are exported so a test can prove that the body a button posts is the body the
 * real route accepts, and the screen is exported as a pure function of the payload so the permission
 * split can be rendered and read back rather than taken on trust.
 */

export type Run={id:string;period_start:number;period_end:number;status:string;created_by:string;reviewed_by?:string|null;approved_by?:string|null;employee_count?:number;gross_earnings?:number;total_deductions?:number;reimbursements?:number;employer_cost?:number;net_pay?:number};
export type Structure={id:string;structure_code:string;version:number;status:string;effective_from:number;components_json?:string};
export type EmployeeRow={id:string;employee_code:string;display_name:string};
export type Assignment={employee_id:string;structure_id:string;effective_from:number};
export type Batch={id:string;run_id:string;status:string;instruction_count:number;total_amount:number;external_transmission:number};
export type LiveAuthorization={run_id:string;actor_email:string;actor_role:string;approved_at:number};
export type Scope={email:string;roleCode:string;canManagePayroll:boolean;canApprovePayroll:boolean;canManageCompensation:boolean};
export type RegisterRow={result_id:string;employee_id:string;employee_code:string;display_name:string;gross_earnings:number;total_deductions:number;reimbursements:number;employer_cost:number;net_pay:number};
export type Payload={
  runs:Run[];structures:Structure[];paymentBatches:Batch[];compensationAssignments:Assignment[];
  employees:EmployeeRow[];liveDisbursementAuthorizations:LiveAuthorization[];scope:Scope;
  truth:{statutoryPolicyConfigured:boolean;incentivePolicyConfigured:boolean;bankTransmissionEnabled:boolean;approvedRunImmutable:boolean;payrollPeriodRunOnce:boolean;productionReady:boolean};
};

const text=(v:unknown)=>String(v??"").trim();
const rupee=(v?:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(Number(v||0));
const day=(v?:number|null)=>Number.isFinite(Number(v))?istDayString(Number(v)):"—";
const when=(v?:number|null)=>v?new Date(Number(v)).toLocaleString("en-IN",{timeZone:"Asia/Kolkata"}):"—";

type Built={ok:true;body:Record<string,unknown>}|{ok:false;error:string};

export const PAYROLL_MONTH=/^\d{4}-(0[1-9]|1[0-2])$/;
export const COMPONENT_KINDS=["earning","deduction","reimbursement","employer_cost"] as const;

/**
 * A payroll month as the engine's half-open period, in IST.
 *
 * The right edge is the FIRST instant of the next month, so September ends exactly where October
 * begins and the two can never overlap. Downstream, lib/people-finance-integration.ts derives the
 * Finance period code from `period_end` as `new Date(period_end).toISOString().slice(0,7)`; with an
 * IST month boundary that is 18:30Z on the last day of the month, which reads back as the month the
 * payroll is FOR. A UTC-midnight boundary would read back as the month after it.
 */
export function payrollMonthBounds(month:string){
  const value=text(month);
  if(!PAYROLL_MONTH.test(value))return null;
  const year=Number(value.slice(0,4)),index=Number(value.slice(5,7));
  const nextYear=index===12?year+1:year,nextIndex=index===12?1:index+1;
  const pad=(n:number)=>String(n).padStart(2,"0");
  const periodStart=istDayStart(`${year}-${pad(index)}-01`),periodEnd=istDayStart(`${nextYear}-${pad(nextIndex)}-01`);
  if(!Number.isFinite(periodStart)||!Number.isFinite(periodEnd))return null;
  return{periodStart,periodEnd,idempotencyKey:`payroll-month:${year}-${pad(index)}`};
}

export function monthLabel(month:string){
  const bounds=payrollMonthBounds(month);
  if(!bounds)return text(month)||"—";
  return new Date(bounds.periodStart).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata",month:"long",year:"numeric"});
}

/** The run, if any, whose period overlaps this month - the engine's own half-open overlap test. */
export function runCovering(month:string,runs:Run[]){
  const bounds=payrollMonthBounds(month);
  if(!bounds)return null;
  return runs.find(run=>Number(run.period_start)<bounds.periodEnd&&bounds.periodStart<Number(run.period_end))??null;
}

export function calculatePayrollPayload(month:string,runs:Run[]):Built{
  const bounds=payrollMonthBounds(month);
  if(!bounds)return{ok:false,error:"Choose the payroll month to calculate"};
  const clash=runCovering(month,runs);
  if(clash)return{ok:false,error:`${monthLabel(month)} has already been calculated as payroll run ${clash.id} (${clash.status}). A payroll period is run once; correct that run rather than calculating a second one.`};
  return{ok:true,body:{action:"calculate",...bounds}};
}

export type ComponentDraft={code:string;label:string;kind:string;amount:string};
export type StructureDraft={structureCode:string;effectiveFrom:string;approvalReference:string;components:ComponentDraft[]};
export const EMPTY_COMPONENT:ComponentDraft={code:"",label:"",kind:"earning",amount:""};
export const EMPTY_STRUCTURE_DRAFT:StructureDraft={structureCode:"",effectiveFrom:"",approvalReference:"",components:[{...EMPTY_COMPONENT}]};

export function saveStructurePayload(draft:StructureDraft):Built{
  const structureCode=text(draft.structureCode);
  if(!structureCode)return{ok:false,error:"A salary structure code is required"};
  const effectiveFrom=istDayStart(draft.effectiveFrom);
  if(!Number.isFinite(effectiveFrom))return{ok:false,error:"A salary structure effective date is required"};
  const rows=draft.components.filter(c=>text(c.code)||text(c.label)||text(c.amount));
  if(!rows.length)return{ok:false,error:"At least one explicit salary component is required"};
  for(const row of rows){
    if(!text(row.code)||!text(row.label))return{ok:false,error:"Every salary component needs a code and a label"};
    if(!(COMPONENT_KINDS as readonly string[]).includes(text(row.kind)))return{ok:false,error:"Every salary component needs an earning / deduction / reimbursement / employer-cost kind"};
    const amount=Number(text(row.amount));
    if(!text(row.amount)||!Number.isFinite(amount)||amount<0)return{ok:false,error:`Component ${text(row.code)} needs an amount of zero or more`};
  }
  return{ok:true,body:{action:"save_structure",structureCode,effectiveFrom,approvalReference:text(draft.approvalReference),
    components:rows.map(row=>({code:text(row.code),label:text(row.label),kind:text(row.kind),amount:Number(text(row.amount))}))}};
}

export type AssignDraft={employeeId:string;structureId:string;effectiveFrom:string;reason:string};
export const EMPTY_ASSIGN_DRAFT:AssignDraft={employeeId:"",structureId:"",effectiveFrom:"",reason:""};

export function assignCompensationPayload(draft:AssignDraft):Built{
  if(!text(draft.employeeId))return{ok:false,error:"Choose the employee whose compensation is being set"};
  if(!text(draft.structureId))return{ok:false,error:"Choose an active salary structure"};
  const effectiveFrom=istDayStart(draft.effectiveFrom);
  if(!Number.isFinite(effectiveFrom))return{ok:false,error:"A compensation effective date is required"};
  if(text(draft.reason).length<8)return{ok:false,error:"A compensation reason of at least 8 characters is required"};
  return{ok:true,body:{action:"assign_compensation",employeeId:text(draft.employeeId),structureId:text(draft.structureId),effectiveFrom,reason:text(draft.reason)}};
}

export const reviewPayload=(runId:string)=>({action:"review",runId});
export const approvePayload=(runId:string)=>({action:"approve",runId});
export const preparePaymentPayload=(runId:string)=>({action:"prepare_payment",runId});
export const authorizeLiveDisbursementPayload=(runId:string)=>({action:"authorize_live_disbursement",runId});

export type Gate={visible:boolean;enabled:boolean;reason:string};
const closed:Gate={visible:false,enabled:false,reason:""};

/**
 * Which lifecycle control this actor may see, and whether it can fire.
 *
 * lib/payroll-engine.ts refuses a maker who reviews their own run and a maker OR reviewer who
 * approves it; lib/payroll-live-disbursement.ts refuses the same two for live authorization. Mirrored
 * here so the reason is on the disabled button instead of arriving as a 409 after the click. The
 * engine remains the authority - nothing here can grant anything it would refuse.
 */
export function runGates(run:Run,scope:Scope|null|undefined):{review:Gate;approve:Gate;preparePayment:Gate;authorizeLive:Gate}{
  const me=text(scope?.email).toLowerCase();
  const maker=!!me&&text(run.created_by).toLowerCase()===me;
  const reviewer=!!me&&text(run.reviewed_by).toLowerCase()===me;
  const status=text(run.status);
  const manage=!!scope?.canManagePayroll,approve=!!scope?.canApprovePayroll;
  return{
    review:manage&&status==="calculated"
      ?{visible:true,enabled:!maker,reason:maker?"Maker/checker: you calculated this run, so somebody else has to review it.":""}
      :closed,
    approve:approve&&status==="reviewed"
      ?{visible:true,enabled:!maker&&!reviewer,reason:maker?"Maker/checker: you calculated this run.":reviewer?"Maker/checker: you reviewed this run.":""}
      :closed,
    preparePayment:manage&&status==="approved"?{visible:true,enabled:true,reason:""}:closed,
    authorizeLive:approve&&status==="approved"
      ?{visible:true,enabled:!maker&&!reviewer,reason:maker||reviewer?"Maker/checker: the maker and the reviewer cannot authorize disbursement.":""}
      :closed,
  };
}

const box={border:"1px solid #ddd",borderRadius:12,padding:14} as const;
const field={display:"block",width:"100%",padding:8,boxSizing:"border-box",marginBottom:6} as const;
const hint={color:"#a3324b",fontSize:13,margin:"0 0 6px"} as const;
type Post=(body:Record<string,unknown>)=>Promise<void>;

async function loadPayload(){const r=await fetch("/api/payroll",{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"Payroll load failed");return p.data as Payload;}
async function loadRegister(runId:string){const r=await fetch(`/api/payroll?mode=register&runId=${encodeURIComponent(runId)}`,{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"Payslip register load failed");return(p.data?.register||[]) as RegisterRow[];}

export function SalaryStructureForm({busy,onSubmit}:{busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<StructureDraft>({...EMPTY_STRUCTURE_DRAFT,components:[{...EMPTY_COMPONENT}]});
  const built=saveStructurePayload(draft);
  const setComponent=(index:number,patch:Partial<ComponentDraft>)=>setDraft({...draft,components:draft.components.map((c,i)=>i===index?{...c,...patch}:c)});
  return <article style={box}>
    <h3 style={{marginTop:0}}>Define a salary structure version</h3>
    <p style={{fontSize:13,marginTop:0}}>Every component is explicit: the engine invents no statutory deduction and no default. Saving publishes a new version and closes the previous one the day before this date.</p>
    <input placeholder="Structure code (STD, FIELD-BLR…)" aria-label="Structure code" value={draft.structureCode} style={field} onChange={e=>setDraft({...draft,structureCode:e.target.value})}/>
    <label style={{fontSize:13}}>Effective from (IST)<input type="date" aria-label="Structure effective from" value={draft.effectiveFrom} style={field} onChange={e=>setDraft({...draft,effectiveFrom:e.target.value})}/></label>
    {draft.components.map((component,index)=><div key={index} style={{display:"flex",gap:6,alignItems:"flex-start"}}>
      <input placeholder="Code" aria-label={`Component ${index+1} code`} value={component.code} style={{...field,flex:1}} onChange={e=>setComponent(index,{code:e.target.value})}/>
      <input placeholder="Label" aria-label={`Component ${index+1} label`} value={component.label} style={{...field,flex:2}} onChange={e=>setComponent(index,{label:e.target.value})}/>
      <select aria-label={`Component ${index+1} kind`} value={component.kind} style={{...field,flex:1}} onChange={e=>setComponent(index,{kind:e.target.value})}>
        {COMPONENT_KINDS.map(kind=><option key={kind} value={kind}>{kind}</option>)}
      </select>
      <input placeholder="Amount" type="number" aria-label={`Component ${index+1} amount`} value={component.amount} style={{...field,flex:1}} onChange={e=>setComponent(index,{amount:e.target.value})}/>
    </div>)}
    <button type="button" onClick={()=>setDraft({...draft,components:[...draft.components,{...EMPTY_COMPONENT}]})}>Add a component</button>
    <input placeholder="Approval reference (optional)" aria-label="Structure approval reference" value={draft.approvalReference} style={{...field,marginTop:6}} onChange={e=>setDraft({...draft,approvalReference:e.target.value})}/>
    {built.ok?null:<p role="status" style={hint}>{built.error}</p>}
    <button disabled={busy||!built.ok} onClick={()=>{if(built.ok)void onSubmit(built.body);}}>Publish structure version</button>
  </article>;
}

export function AssignCompensationForm({employees,structures,assignments,busy,onSubmit}:{employees:EmployeeRow[];structures:Structure[];assignments:Assignment[];busy:boolean;onSubmit:Post}){
  const[draft,setDraft]=useState<AssignDraft>({...EMPTY_ASSIGN_DRAFT});
  const built=assignCompensationPayload(draft);
  const active=structures.filter(s=>s.status==="active_uat");
  const current=assignments.find(a=>a.employee_id===text(draft.employeeId));
  return <article style={box}>
    <h3 style={{marginTop:0}}>Assign compensation</h3>
    <p style={{fontSize:13,marginTop:0}}>An employee with no active assignment is refused by payroll with &quot;configuration_required: compensation assignment missing&quot;, so the whole run stops until every active employee has one.</p>
    <select aria-label="Compensation employee" value={draft.employeeId} style={field} onChange={e=>setDraft({...draft,employeeId:e.target.value})}>
      <option value="">Select an employee</option>
      {employees.map(e=><option key={e.id} value={e.id}>{e.display_name} · {e.employee_code}</option>)}
    </select>
    <select aria-label="Compensation structure" value={draft.structureId} style={field} onChange={e=>setDraft({...draft,structureId:e.target.value})}>
      <option value="">Select an active salary structure</option>
      {active.map(s=><option key={s.id} value={s.id}>{s.structure_code} v{s.version}</option>)}
    </select>
    <label style={{fontSize:13}}>Effective from (IST)<input type="date" aria-label="Compensation effective from" value={draft.effectiveFrom} style={field} onChange={e=>setDraft({...draft,effectiveFrom:e.target.value})}/></label>
    <input placeholder="Reason (8+ characters)" aria-label="Compensation reason" value={draft.reason} style={field} onChange={e=>setDraft({...draft,reason:e.target.value})}/>
    {draft.employeeId?<p style={{fontSize:13,margin:"0 0 6px"}}>Current assignment: {current?`${current.structure_id} from ${day(current.effective_from)}`:"none — this employee cannot be paid yet"}</p>:null}
    {built.ok?null:<p role="status" style={hint}>{built.error}</p>}
    <button disabled={busy||!built.ok} onClick={()=>{if(built.ok)void onSubmit(built.body);}}>Assign compensation</button>
  </article>;
}

export function CalculateRunForm({runs,busy,onSubmit}:{runs:Run[];busy:boolean;onSubmit:Post}){
  const[month,setMonth]=useState("");
  const built=calculatePayrollPayload(month,runs);
  const bounds=payrollMonthBounds(month);
  return <article style={box}>
    <h3 style={{marginTop:0}}>Calculate a payroll month</h3>
    <p style={{fontSize:13,marginTop:0}}>The period runs from IST midnight on the 1st to IST midnight on the 1st of the next month, and the idempotency key is derived from the month — so pressing this twice replays into the same run. A period that has already been calculated is refused here and in the engine.</p>
    <label style={{fontSize:13}}>Payroll month<input type="month" aria-label="Payroll month" value={month} style={field} onChange={e=>setMonth(e.target.value)}/></label>
    {bounds?<p style={{fontSize:13,margin:"0 0 6px"}}>Period: <b>{day(bounds.periodStart)}</b> → <b>{day(bounds.periodEnd)}</b> (exclusive) · key <code>{bounds.idempotencyKey}</code></p>:null}
    {built.ok?null:<p role="status" style={hint}>{built.error}</p>}
    <button disabled={busy||!built.ok} onClick={()=>{if(built.ok)void onSubmit(built.body);}}>Calculate payroll</button>
  </article>;
}

export function RunLifecycle({runs,scope,batches,liveAuthorizations,busy,selectedRunId,register,onSelect,onPost}:{runs:Run[];scope:Scope|null;batches:Batch[];liveAuthorizations:LiveAuthorization[];busy:boolean;selectedRunId:string;register:RegisterRow[];onSelect:(runId:string)=>void;onPost:Post}){
  return <section style={{display:"grid",gap:8}}>
    {!runs.length?<p>No payroll run has been calculated yet.</p>:null}
    {runs.map(run=>{
      const gates=runGates(run,scope);
      const batch=batches.find(b=>b.run_id===run.id);
      const live=liveAuthorizations.find(a=>a.run_id===run.id);
      return <article key={run.id} style={box}>
        <b>{day(run.period_start)} → {day(run.period_end)} · {run.status}</b>
        <div><code>{run.id}</code> · {run.employee_count??0} employee(s) · net {rupee(run.net_pay)} · employer cost {rupee(run.employer_cost)}</div>
        <div style={{fontSize:13}}>Maker: {run.created_by} · Reviewer: {run.reviewed_by||"—"} · Approver: {run.approved_by||"—"}</div>
        {batch?<div style={{fontSize:13}}>Sandbox batch <code>{batch.id}</code> · {batch.instruction_count} instruction(s) · {rupee(batch.total_amount)} · external transmission {Number(batch.external_transmission)===0?"NO":"YES"}</div>:null}
        {live?<div style={{fontSize:13}}>Live-disbursement authorisation recorded by {live.actor_email} ({live.actor_role}) at {when(live.approved_at)} — an approval record only; nothing is transmitted.</div>:null}
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:6}}>
          {gates.review.visible?<button disabled={busy||!gates.review.enabled} title={gates.review.reason} onClick={()=>void onPost(reviewPayload(run.id))}>Review</button>:null}
          {gates.approve.visible?<button disabled={busy||!gates.approve.enabled} title={gates.approve.reason} onClick={()=>void onPost(approvePayload(run.id))}>Approve</button>:null}
          {gates.preparePayment.visible?<button disabled={busy} onClick={()=>void onPost(preparePaymentPayload(run.id))}>Prepare sandbox payment</button>:null}
          {gates.authorizeLive.visible?<button disabled={busy||!gates.authorizeLive.enabled} title={gates.authorizeLive.reason} onClick={()=>void onPost(authorizeLiveDisbursementPayload(run.id))}>Record live-disbursement authorisation (transmits nothing)</button>:null}
          <button disabled={busy} onClick={()=>onSelect(run.id)}>Payslip register</button>
        </div>
        {[gates.review,gates.approve,gates.authorizeLive].filter(g=>g.visible&&!g.enabled&&g.reason).map((g,i)=><p key={i} role="status" style={hint}>{g.reason}</p>)}
        {selectedRunId===run.id?<div style={{overflowX:"auto",marginTop:8}}>
          <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
            <thead><tr style={{textAlign:"left"}}><th style={{padding:"4px 6px"}}>Employee</th><th style={{textAlign:"right"}}>Gross</th><th style={{textAlign:"right"}}>Deductions</th><th style={{textAlign:"right"}}>Reimbursements</th><th style={{textAlign:"right"}}>Employer cost</th><th style={{textAlign:"right",padding:"4px 6px"}}>Net</th></tr></thead>
            <tbody>{register.map(row=><tr key={row.result_id} style={{borderTop:"1px solid #eee"}}>
              <td style={{padding:"4px 6px"}}>{row.display_name||row.employee_id}{row.employee_code?` · ${row.employee_code}`:""}</td>
              <td style={{textAlign:"right"}}>{rupee(row.gross_earnings)}</td>
              <td style={{textAlign:"right"}}>{rupee(row.total_deductions)}</td>
              <td style={{textAlign:"right"}}>{rupee(row.reimbursements)}</td>
              <td style={{textAlign:"right"}}>{rupee(row.employer_cost)}</td>
              <td style={{textAlign:"right",padding:"4px 6px"}}>{rupee(row.net_pay)}</td>
            </tr>)}</tbody>
          </table>
          {!register.length?<p style={{margin:0}}>This run produced no payslip rows.</p>:null}
        </div>:null}
      </article>;
    })}
  </section>;
}

/** The whole authenticated screen as a pure function of the payload, so the permission split renders. */
export function PayrollScreen({data,busy,loading,error,message,selectedRunId,register,onSelect,onPost,onRefresh}:{data:Payload|null;busy:boolean;loading:boolean;error:string;message:string;selectedRunId:string;register:RegisterRow[];onSelect:(runId:string)=>void;onPost:Post;onRefresh:()=>void}){
  const scope=data?.scope??null;
  return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
    <p><Link href="/team/people">← People</Link> · <Link href="/team/people/finance">Finance + Statutory →</Link></p>
    <p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE · PEOPLE · PAYROLL</p>
    <h1>Deterministic payroll control</h1>
    <p>Salary structures and employee compensation are effective-dated. A payroll period is calculated once, reviewed by somebody other than its maker and approved by a third person. Statutory policy is explicit configuration, Finance journal posting requires approved account mappings, and payment preparation is sandbox-only.</p>
    {error?<p role="alert" style={{color:"crimson"}}>{error}</p>:null}
    {message?<p role="status" style={{color:"#276"}}>{message}</p>:null}

    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(220px,1fr))",gap:10,margin:"18px 0"}}>
      <article style={box}><small>Salary structures</small><strong style={{display:"block",fontSize:28}}>{data?.structures.length||0}</strong></article>
      <article style={box}><small>Payroll runs</small><strong style={{display:"block",fontSize:28}}>{data?.runs.length||0}</strong></article>
      <article style={box}><small>Sandbox payment batches</small><strong style={{display:"block",fontSize:28}}>{data?.paymentBatches.length||0}</strong></article>
      <article style={box}><small>Bank transmission</small><strong style={{display:"block",fontSize:20}}>{data?.truth.bankTransmissionEnabled?"ENABLED":"SANDBOX ONLY"}</strong></article>
    </section>
    <p><button onClick={onRefresh} disabled={loading||busy}>{loading?"Refreshing…":"Refresh"}</button></p>

    {data&&!scope?.canManageCompensation?<p role="status" style={{...box,borderColor:"#e5b8b8"}}>
      <b>Compensation controls are out of reach for every role.</b> Defining a salary structure and assigning compensation both require <code>compensation.manage</code>, which no role in <code>lib/platform-security.ts</code> <code>defaultRoles</code> holds — only a founder/superuser wildcard identity. Until the owner decides that permission model, salary structures can only be created by a wildcard identity, and payroll cannot be calculated for an employee who has never been assigned one.
    </p>:null}

    {data&&scope?.canManageCompensation?<>
      <h2>Compensation</h2>
      <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))",gap:10}}>
        <SalaryStructureForm busy={busy} onSubmit={onPost}/>
        <AssignCompensationForm employees={data.employees} structures={data.structures} assignments={data.compensationAssignments} busy={busy} onSubmit={onPost}/>
      </section>
    </>:null}

    {data&&scope?.canManagePayroll?<>
      <h2>Run payroll</h2>
      <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))",gap:10}}>
        <CalculateRunForm runs={data.runs} busy={busy} onSubmit={onPost}/>
      </section>
    </>:null}
    {data&&!scope?.canManagePayroll&&!scope?.canApprovePayroll?<p role="status">You can read payroll but not act on it: calculating, reviewing and preparing payment need <code>payroll.manage</code> and approval needs <code>payroll.approve</code>.</p>:null}

    <h2>Payroll runs</h2>
    <RunLifecycle runs={data?.runs??[]} scope={scope} batches={data?.paymentBatches??[]} liveAuthorizations={data?.liveDisbursementAuthorizations??[]} busy={busy} selectedRunId={selectedRunId} register={register} onSelect={onSelect} onPost={onPost}/>

    <h2>Salary structures</h2>
    <section style={{display:"grid",gap:8}}>{(data?.structures??[]).map(s=><article key={s.id} style={box}>
      <b>{s.structure_code} v{s.version} · {s.status}</b><div><code>{s.id}</code> · effective {day(s.effective_from)}</div>
    </article>)}</section>

    {loading&&!data?<p>Loading payroll…</p>:null}
    <footer style={{marginTop:24}}><b>Statutory policy:</b> CONFIGURATION REQUIRED · <b>Finance journal:</b> CONFIGURATION-GATED · <b>Live bank instruction:</b> NO · <b>One run per period:</b> {data?.truth.payrollPeriodRunOnce===false?"NO":"YES"} · <b>Production ready:</b> NO</footer>
  </main>;
}

export default function PayrollPage(){
  const[data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[message,setMessage]=useState("");
  const[loading,setLoading]=useState(true),[busy,setBusy]=useState(false);
  const[selectedRunId,setSelectedRunId]=useState(""),[register,setRegister]=useState<RegisterRow[]>([]);
  async function load(){setLoading(true);try{setData(await loadPayload());setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setLoading(false);}}
  useEffect(()=>{let active=true;void loadPayload().then(payload=>{if(active){setData(payload);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);
  async function select(runId:string){
    if(selectedRunId===runId){setSelectedRunId("");setRegister([]);return;}
    setSelectedRunId(runId);setError("");
    try{setRegister(await loadRegister(runId));}catch(e){setRegister([]);setError(e instanceof Error?e.message:String(e));}
  }
  async function post(body:Record<string,unknown>){
    setBusy(true);setError("");setMessage("");
    try{
      const response=await fetch("/api/payroll",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});
      const payload=await response.json() as{error?:string;data?:{effect?:string}};
      if(!response.ok)throw new Error(payload.error||"Payroll update failed");
      setMessage(payload.data?.effect||"Saved.");
      await load();
      if(selectedRunId)setRegister(await loadRegister(selectedRunId).catch(()=>[]));
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  }
  return <PayrollScreen data={data} busy={busy} loading={loading} error={error} message={message} selectedRunId={selectedRunId} register={register} onSelect={runId=>void select(runId)} onPost={post} onRefresh={()=>void load()}/>;
}
