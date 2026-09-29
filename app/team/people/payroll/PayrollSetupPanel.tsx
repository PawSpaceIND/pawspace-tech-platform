"use client";
import{useState}from"react";
type Component={code:string;label:string;kind:"earning"|"deduction"|"reimbursement"|"employer_cost";amount:number};
type Structure={id:string;structure_code:string;version:number;status:string;components_json?:string};
type Employee={id:string;employee_code:string;display_name:string};
type Props={structures:Structure[];employees:Employee[];capabilities?:{configure:boolean;calculate:boolean};onSaved:()=>Promise<void>};
const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kolkata",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date());
const inputStyle={display:"block",width:"100%",minHeight:44,padding:10,border:"1px solid var(--staff-line)",borderRadius:"calc(8px * var(--paw-radius-scale))",background:"var(--staff-surface)",color:"var(--staff-text)"};
const card={border:"1px solid var(--staff-line)",borderRadius:"calc(12px * var(--paw-radius-scale))",padding:16,marginBottom:16};
function componentsOf(structure?:Structure):Component[]{try{const items=JSON.parse(structure?.components_json||"[]");return Array.isArray(items)?items:[];}catch{return[];}}
export default function PayrollSetupPanel({structures,employees,capabilities,onSaved}:Props){
 const[code,setCode]=useState(""),[effective,setEffective]=useState(today),[components,setComponents]=useState<Component[]>([{code:"BASIC",label:"Basic salary",kind:"earning",amount:0}]);
 const[structureId,setStructureId]=useState(""),[employeeId,setEmployeeId]=useState(""),[reason,setReason]=useState("");
 const[mode,setMode]=useState("calendar_days"),[prorated,setProrated]=useState<string[]>([]),[reference,setReference]=useState("");
 const[month,setMonth]=useState(()=>today().slice(0,7)),[busy,setBusy]=useState(false),[message,setMessage]=useState(""),[error,setError]=useState("");
 const active=structures.filter(s=>s.status==="active_uat"),selected=active.find(s=>s.id===structureId);
 async function act(body:Record<string,unknown>,success:string){setBusy(true);setError("");setMessage("");try{const endpoint=body.action==="calculate"&&window.location.pathname.startsWith("/v2/")?"/api/v2/payroll-governance":"/api/payroll";const response=await fetch(endpoint,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)});const payload=await response.json();if(!response.ok)throw new Error(payload.error||"Payroll action could not be completed");await onSaved();setMessage(success);}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 function chooseStructure(id:string){setStructureId(id);setProrated(componentsOf(active.find(s=>s.id===id)).filter(c=>c.kind==="earning").map(c=>c.code));}
 function calculate(){const [year,number]=month.split("-").map(Number);if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)){setError("Choose a valid payroll month");return;}const next=new Date(Date.UTC(year,number,1)).toISOString().slice(0,10);void act({action:"calculate",periodStart:Date.parse(`${month}-01T00:00:00+05:30`),periodEnd:Date.parse(`${next}T00:00:00+05:30`),idempotencyKey:`employee-payroll:${month}`},"Payroll calculated. A different reviewer and approver must check it before payment preparation.");}
 return <section aria-label="Payroll setup and calculation" style={{margin:"24px 0"}}>
 <h2>Payroll setup and calculation</h2><p>Reuse the governed salary structures and employee records. No action here sends a bank payment. Attendance deductions and overtime must not be invented from missing records.</p>
 {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 {capabilities?.configure&&<>
 <details style={card}><summary>Create a salary structure version</summary>
 <label>Structure code<input style={inputStyle} value={code} onChange={e=>setCode(e.target.value)}/></label>
 <label>Effective from (IST)<input style={inputStyle} type="date" value={effective} onChange={e=>setEffective(e.target.value)}/></label>
 <div style={{display:"grid",gap:12,margin:"12px 0"}}>{components.map((c,i)=><fieldset key={i} style={{border:"1px solid var(--staff-line)",padding:12}}><legend>Component {i+1}</legend>
 <label>Code<input style={inputStyle} value={c.code} onChange={e=>setComponents(items=>items.map((x,j)=>j===i?{...x,code:e.target.value}:x))}/></label>
 <label>Label<input style={inputStyle} value={c.label} onChange={e=>setComponents(items=>items.map((x,j)=>j===i?{...x,label:e.target.value}:x))}/></label>
 <label>Type<select style={inputStyle} value={c.kind} onChange={e=>setComponents(items=>items.map((x,j)=>j===i?{...x,kind:e.target.value as Component["kind"]}:x))}><option value="earning">Earning</option><option value="deduction">Deduction</option><option value="reimbursement">Reimbursement</option><option value="employer_cost">Employer cost</option></select></label>
 <label>Monthly amount (₹)<input style={inputStyle} type="number" min="0" step="0.01" value={c.amount} onChange={e=>setComponents(items=>items.map((x,j)=>j===i?{...x,amount:Number(e.target.value)}:x))}/></label>
 {components.length>1&&<button type="button" disabled={busy} onClick={()=>setComponents(items=>items.filter((_,j)=>j!==i))}>Remove component</button>}</fieldset>)}</div>
 <button type="button" disabled={busy} onClick={()=>setComponents(items=>[...items,{code:"",label:"",kind:"earning",amount:0}])}>Add component</button>{" "}
 <button type="button" disabled={busy||!code.trim()||components.some(c=>!c.code.trim()||!c.label.trim()||!Number.isFinite(c.amount)||c.amount<0)} onClick={()=>void act({action:"save_structure",structureCode:code.trim(),effectiveFrom:Date.parse(`${effective}T00:00:00+05:30`),components},"Salary structure version created. Configure its calculation policy before a partial-month payroll.")}>Save salary structure</button>
 </details>
 <div style={card}><label>Salary structure<select style={inputStyle} value={structureId} onChange={e=>chooseStructure(e.target.value)}><option value="">Choose a salary structure</option>{active.map(s=><option key={s.id} value={s.id}>{s.structure_code} · version {s.version}</option>)}</select></label>
 <details><summary>Approve joining/leaving-date calculation policy</summary><p>Policy is immutable once this structure has payroll history. A partial-month employee is blocked until this explicit policy exists.</p>
 <label>Partial-month basis<select style={inputStyle} value={mode} onChange={e=>setMode(e.target.value)}><option value="calendar_days">Prorate selected components by employed calendar days</option><option value="full_period">Pay the full period explicitly</option></select></label>
 {mode==="calendar_days"&&<fieldset><legend>Components to prorate</legend>{componentsOf(selected).map(c=><label key={c.code} style={{display:"block",padding:8}}><input type="checkbox" checked={prorated.includes(c.code)} onChange={e=>setProrated(values=>e.target.checked?[...values,c.code]:values.filter(v=>v!==c.code))}/>{" "}{c.label} ({c.kind})</label>)}</fieldset>}
 <label>Approval reference<input style={inputStyle} value={reference} onChange={e=>setReference(e.target.value)}/></label>
 <button type="button" disabled={busy||!selected||reference.trim().length<4||(mode==="calendar_days"&&!prorated.length)} onClick={()=>void act({action:"save_calculation_policy",structureId,mode,componentCodes:mode==="calendar_days"?prorated:[],approvalReference:reference},"Salary calculation policy saved with its approval reference.")}>Save approved calculation policy</button></details>
 <details><summary>Assign compensation to an employee</summary><label>Employee<select style={inputStyle} value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">Choose an employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.display_name} · {e.employee_code}</option>)}</select></label>
 <label>Effective from (IST)<input style={inputStyle} type="date" value={effective} onChange={e=>setEffective(e.target.value)}/></label><label>Reason<input style={inputStyle} value={reason} onChange={e=>setReason(e.target.value)}/></label>
 <button type="button" disabled={busy||!selected||!employeeId||reason.trim().length<8} onClick={()=>void act({action:"assign_compensation",employeeId,structureId,effectiveFrom:Date.parse(`${effective}T00:00:00+05:30`),reason},"Compensation assignment saved with dated history.")}>Assign compensation</button></details></div>
 </>}
 {capabilities?.calculate&&<div style={card}><label>Payroll month (IST)<input style={inputStyle} type="month" value={month} onChange={e=>setMonth(e.target.value)}/></label><p>One canonical run for this month; retries return that same complete run. An overlapping or incomplete historical run must be reconciled first.</p><button type="button" disabled={busy||!month} onClick={calculate}>{busy?"Working…":"Calculate monthly payroll"}</button></div>}
 </section>;
}
