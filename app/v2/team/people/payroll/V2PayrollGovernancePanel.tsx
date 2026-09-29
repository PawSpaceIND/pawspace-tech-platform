"use client";
import{useEffect,useMemo,useState}from"react";
type Run={id:string;status:string;period_start:number;period_end:number};
type Emp={id:string;employee_code:string;display_name:string};
type Result={id:string;employee_id:string;display_name?:string;employee_code?:string;net_pay:number;gross_earnings:number;total_deductions:number};
type Adj={id:string;employee_id:string;kind:string;amount:number;units:number;reason:string;status:string};
type Item={employee_id:string;amount:number;batch_code:string;release_at:number;hold_status:string;hold_reason?:string|null};
type Data={policy?:Record<string,unknown>|null;run?:Run|null;results:Result[];adjustments:Adj[];releasePlan?:Record<string,unknown>&{items:Item[]}|null;truth:Record<string,unknown>};
type Props={runs:Run[];employees:Emp[]};
const box={border:"1px solid var(--staff-line)",borderRadius:"calc(12px * var(--paw-radius-scale))",padding:16,margin:"16px 0"};
const input={display:"block",width:"100%",minHeight:42,padding:9,border:"1px solid var(--staff-line)",borderRadius:"calc(8px * var(--paw-radius-scale))",background:"var(--staff-surface)",color:"var(--staff-text)"};
const day=(v:number)=>new Date(v).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"});
const at=(date:string)=>Date.parse(date+"T10:00:00+05:30");
export default function V2PayrollGovernancePanel({runs,employees}:Props){
 const[runId,setRunId]=useState(runs[0]?.id||""),[data,setData]=useState<Data|null>(null),[busy,setBusy]=useState(false),[msg,setMsg]=useState(""),[err,setErr]=useState("");
 const[salaryDay,setSalaryDay]=useState(7),[cutoffDay,setCutoffDay]=useState(28),[paid,setPaid]=useState("CL,SL,PL"),[unpaid,setUnpaid]=useState("LOP,LWP"),[lopCodes,setLopCodes]=useState("BASIC,HRA"),[cap,setCap]=useState(25),[policyRef,setPolicyRef]=useState("");
 const[employeeId,setEmployeeId]=useState(""),[amount,setAmount]=useState(0),[reason,setReason]=useState(""),[evidence,setEvidence]=useState("");
 const[salaryDate,setSalaryDate]=useState(""),[batchCode,setBatchCode]=useState("BATCH-1"),[holdReason,setHoldReason]=useState("");
 async function load(id=runId){if(!id)return;const r=await fetch("/api/v2/payroll-governance?runId="+encodeURIComponent(id),{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"V2 payroll governance load failed");setData(p.data);}
 async function act(body:Record<string,unknown>,success:string){setBusy(true);setErr("");setMsg("");try{const r=await fetch("/api/v2/payroll-governance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}),p=await r.json();if(!r.ok)throw new Error(p.error||"Action failed");setMsg(success);await load();}catch(e){setErr(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 useEffect(()=>{if(!runId)return;let active=true;void fetch("/api/v2/payroll-governance?runId="+encodeURIComponent(runId),{cache:"no-store"}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error||"V2 payroll governance load failed");if(active)setData(p.data);}).catch(e=>{if(active)setErr(e instanceof Error?e.message:String(e));});return()=>{active=false;};},[runId]);
 const selected=useMemo(()=>data?.results.find(r=>r.employee_id===employeeId),[data,employeeId]);
 const approved=String(data?.releasePlan?.status||"")==="approved";
 const split=(v:string)=>v.split(",").map(x=>x.trim()).filter(Boolean);
 return <section aria-label="PawSpace V2 HR payroll governance" style={box}>
  <p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE V2 · HR + PAYROLL GOVERNANCE</p>
  <h2>Leave, LOP, deductions, approvals and salary release</h2>
  <p>This control exists only on V2. Salary cannot enter the payout queue until payroll is approved, the V2 release plan has independent HR and Finance approvals, the employee is not held, and that batch date is due.</p>
  {err&&<p role="alert">{err}</p>}{msg&&<p role="status">{msg}</p>}
  <label>Payroll run<select style={input} value={runId} onChange={e=>setRunId(e.target.value)}><option value="">Choose run</option>{runs.map(r=><option key={r.id} value={r.id}>{day(r.period_start)} → {day(r.period_end)} · {r.status}</option>)}</select></label>
  <details style={box}><summary>V2 payroll policy</summary>
   <label>Salary day<input style={input} type="number" min="1" max="28" value={salaryDay} onChange={e=>setSalaryDay(Number(e.target.value))}/></label>
   <label>Payroll cut-off day<input style={input} type="number" min="1" max="28" value={cutoffDay} onChange={e=>setCutoffDay(Number(e.target.value))}/></label>
   <label>Paid leave codes<input style={input} value={paid} onChange={e=>setPaid(e.target.value)}/></label>
   <label>Unpaid leave / LOP codes<input style={input} value={unpaid} onChange={e=>setUnpaid(e.target.value)}/></label>
   <label>Salary components eligible for LOP<input style={input} value={lopCodes} onChange={e=>setLopCodes(e.target.value)}/></label>
   <label>Authorized deduction policy reference<input style={input} value={policyRef} onChange={e=>setPolicyRef(e.target.value)}/></label>
   <label>Maximum authorized deduction (% of gross)<input style={input} type="number" min="0" max="100" value={cap} onChange={e=>setCap(Number(e.target.value))}/></label>
   <button disabled={busy||policyRef.trim().length<8} onClick={()=>void act({action:"save_policy",salaryDay,cutoffDay,paidLeaveCodes:split(paid),unpaidLeaveCodes:split(unpaid),lopDeductibleComponentCodes:split(lopCodes),authorizedDeductionEnabled:true,authorizedDeductionPolicyReference:policyRef,maxAuthorizedDeductionPercent:cap},"V2 payroll policy saved")}>Save V2 policy</button>
  </details>
  <details style={box}><summary>Employee adjustment: LOP / authorized deduction</summary>
   <label>Employee<select style={input} value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">Choose employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.display_name} · {e.employee_code}</option>)}</select></label>
   {selected&&<p>Current net pay ₹{Number(selected.net_pay).toFixed(2)} · Gross ₹{Number(selected.gross_earnings).toFixed(2)}</p>}
   <label>Evidence/reference<input style={input} value={evidence} onChange={e=>setEvidence(e.target.value)}/></label>
   <button disabled={busy||!runId||!employeeId||evidence.trim().length<4} onClick={()=>void act({action:"derive_lop",runId,employeeId,evidenceReference:evidence},"LOP derived from approved attendance and leave facts; HR approval required")}>Derive LOP</button>
   <hr/>
   <label>Authorized deduction amount (₹)<input style={input} type="number" min="0" step="0.01" value={amount} onChange={e=>setAmount(Number(e.target.value))}/></label>
   <label>Reason<input style={input} value={reason} onChange={e=>setReason(e.target.value)}/></label>
   <button disabled={busy||!runId||!employeeId||amount<=0||reason.trim().length<8||evidence.trim().length<4} onClick={()=>void act({action:"propose_authorized_deduction",runId,employeeId,amount,reason,evidenceReference:evidence},"Authorized deduction proposed; HR and Finance approvals required")}>Propose deduction</button>
   <div style={{display:"grid",gap:8,marginTop:12}}>{data?.adjustments.map(a=><article key={a.id} style={box}><b>{a.kind.replaceAll("_"," ")} · ₹{Number(a.amount).toFixed(2)}</b><div>{a.reason} · {a.status}</div><div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>{a.status==="pending_hr"&&<><button disabled={busy} onClick={()=>void act({action:"decide_adjustment_hr",adjustmentId:a.id,decision:"approve"},"HR approved adjustment")}>HR approve</button><button disabled={busy} onClick={()=>void act({action:"decide_adjustment_hr",adjustmentId:a.id,decision:"reject"},"Adjustment rejected")}>Reject</button></>}{a.status==="pending_finance"&&<><button disabled={busy} onClick={()=>void act({action:"decide_adjustment_finance",adjustmentId:a.id,decision:"approve"},"Finance approved adjustment")}>Finance approve</button><button disabled={busy} onClick={()=>void act({action:"decide_adjustment_finance",adjustmentId:a.id,decision:"reject"},"Adjustment rejected")}>Reject</button></>}</div></article>)}</div>
   <button disabled={busy||!data?.adjustments.some(a=>a.status==="approved")} onClick={()=>void act({action:"apply_adjustments",runId},"Approved adjustments applied before payroll review")}>Apply approved adjustments</button>
  </details>
  <details style={box}><summary>Salary date, batches and holds</summary>
   <label>Salary date<input style={input} type="date" value={salaryDate} onChange={e=>setSalaryDate(e.target.value)}/></label>
   <label>Default batch code<input style={input} value={batchCode} onChange={e=>setBatchCode(e.target.value)}/></label>
   <button disabled={busy||!runId||!salaryDate} onClick={()=>void act({action:"create_release_plan",runId,salaryDate:at(salaryDate),items:(data?.results||[]).map(r=>({employeeId:r.employee_id,batchCode,releaseAt:at(salaryDate)}))},"Salary release plan created; HR then Finance must approve it")}>Create salary release plan</button>
   {data?.releasePlan&&<><p><b>Plan status:</b> {String(data.releasePlan.status)} · <b>Salary date:</b> {day(Number(data.releasePlan.salary_date))}</p>
   <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{!Boolean(data.releasePlan.hr_approved_by)&&<button disabled={busy} onClick={()=>void act({action:"approve_release_plan_hr",runId},"HR approved salary release plan")}>HR approve plan</button>}{Boolean(data.releasePlan.hr_approved_by)&&!Boolean(data.releasePlan.finance_approved_by)&&<button disabled={busy} onClick={()=>void act({action:"approve_release_plan_finance",runId},"Finance approved salary release plan")}>Finance approve plan</button>}</div>
   <div style={{display:"grid",gap:8,marginTop:12}}>{data.releasePlan.items.map(item=><article key={item.employee_id} style={box}><b>{employees.find(e=>e.id===item.employee_id)?.display_name||item.employee_id} · ₹{Number(item.amount).toFixed(2)}</b><div>{item.batch_code} · {day(item.release_at)} · {item.hold_status}</div>{item.hold_reason&&<div>Hold: {item.hold_reason}</div>}<div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:8}}>{!approved&&item.hold_status!=="held"&&<><input aria-label={"Hold reason "+item.employee_id} style={{...input,maxWidth:300}} placeholder="Hold reason" value={employeeId===item.employee_id?holdReason:""} onChange={e=>{setEmployeeId(item.employee_id);setHoldReason(e.target.value)}}/><button disabled={busy||employeeId!==item.employee_id||holdReason.trim().length<8} onClick={()=>void act({action:"set_salary_hold",runId,employeeId:item.employee_id,hold:true,reason:holdReason},"Salary held before release")}>Hold salary</button></>}{approved&&item.hold_status==="held"&&<button disabled={busy} onClick={()=>void act({action:"release_held_salary",runId,employeeId:item.employee_id,releaseAt:Math.max(Date.now(),Number(data.releasePlan?.salary_date)||0)},"Release proposed. HR and independent Finance must approve the revised plan before salary queueing.")}>Propose release for approval</button>}</div></article>)}</div></>}
   <button disabled={busy||!approved} onClick={()=>void act({action:"queue_due_salary",runId,asOf:Date.now()},"Due, non-held salary instructions queued for RazorpayX TEST processing")}>Queue due salary batches</button>
  </details>
  <p><b>Control boundary:</b> HR and Finance approvals are separate; a plan creator cannot self-approve. Held or future-dated salaries remain outside the payout queue. Live salary remains disabled until the production RazorpayX gate is explicitly enabled.</p>
 </section>;
}
