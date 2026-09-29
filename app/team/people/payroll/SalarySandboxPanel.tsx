"use client";
import{useEffect,useState}from"react";
type Employee={id:string;display_name:string;employee_code:string};
type Run={id:string;status:string};
type Instruction={id:string;employeeId:string;runId:string;status:string;amountPaise:number;providerPayoutId:string|null;utr:string|null;error:string|null};
type Accounting={local_payout_id:string;status:string;reason?:string|null};
type Props={employees:Employee[];runs:Run[];canApprove:boolean;onSaved:()=>Promise<void>};
const inputStyle={display:"block",width:"100%",minHeight:44,padding:10,border:"1px solid var(--staff-line)",borderRadius:"calc(8px * var(--paw-radius-scale))",background:"var(--staff-surface)",color:"var(--staff-text)"};
export default function SalarySandboxPanel({employees,runs,canApprove,onSaved}:Props){
 const[books,setBooks]=useState<Accounting[]>([]);
 const[items,setItems]=useState<Instruction[]>([]),[error,setError]=useState(""),[message,setMessage]=useState(""),[busy,setBusy]=useState(false),[confirmed,setConfirmed]=useState(false);
 const[employeeId,setEmployeeId]=useState(""),[fund,setFund]=useState(""),[proof,setProof]=useState(""),[expiry,setExpiry]=useState(""),[runId,setRunId]=useState("");
 async function refresh(){const r=await fetch("/api/payroll?mode=salary",{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"Salary instructions unavailable");setItems(p.data?.instructions||[]);setBooks(p.data?.payoutAccounting||[]);}
 useEffect(()=>{if(!canApprove)return;let active=true;void fetch("/api/payroll?mode=salary",{cache:"no-store"}).then(async r=>{const p=await r.json();if(!r.ok)throw new Error(p.error||"Salary instructions unavailable");if(active){setItems(p.data?.instructions||[]);setBooks(p.data?.payoutAccounting||[]);}}).catch(e=>{if(active)setError(String(e.message));});return()=>{active=false};},[canApprove]);
 async function act(body:Record<string,unknown>){if(!confirmed){setError("Confirm TEST-only operation first");return;}setBusy(true);setError("");setMessage("");try{const r=await fetch("/api/payroll",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({...body,confirmSandbox:true})}),p=await r.json();if(!r.ok)throw new Error(p.error||"Salary action failed");await refresh();await onSaved();setMessage(p.data?.reconciliationRequired?"Transport outcome requires reconciliation. This salary is not marked paid.":"TEST salary action recorded. Check provider status below.");}catch(e){setError(e instanceof Error?e.message:String(e));}finally{setBusy(false);}}
 if(!canApprove)return null;
 return <section aria-label="Employee salary sandbox" style={{border:"1px solid var(--staff-line)",borderRadius:"calc(12px * var(--paw-radius-scale))",padding:16,margin:"24px 0"}}>
 <h2>Employee salary · TEST mode</h2><p>Separate employee instructions reuse the existing payout transport. Live salary is disabled. A prepared batch is not a confirmed salary deposit. Approved payroll Finance mappings and its posted accrual are required before instructions can be prepared. Principal posting is separate from provider fees and bank-statement reconciliation.</p>
 <label style={{display:"block",padding:12}}><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>{" "}I confirm these are TEST fund accounts and no live salary payment is authorized.</label>
 {error&&<p role="alert">{error}</p>}{message&&<p role="status">{message}</p>}
 <details><summary>Record reviewed employee TEST beneficiary evidence</summary>
 <label>Employee<select style={inputStyle} value={employeeId} onChange={e=>setEmployeeId(e.target.value)}><option value="">Choose employee</option>{employees.map(e=><option key={e.id} value={e.id}>{e.display_name} · {e.employee_code}</option>)}</select></label>
 <label>TEST fund account ID<input style={inputStyle} placeholder="fa_…" value={fund} onChange={e=>setFund(e.target.value)}/></label>
 <label>Verification evidence reference<input style={inputStyle} value={proof} onChange={e=>setProof(e.target.value)}/></label>
 <label>Evidence expiry (IST)<input style={inputStyle} type="date" value={expiry} onChange={e=>setExpiry(e.target.value)}/></label>
 <p>This records Finance-reviewed evidence; it does not automatically verify account ownership.</p>
 <button disabled={busy||!confirmed||!employeeId||!fund||proof.length<8||!expiry} onClick={()=>void act({action:"save_salary_beneficiary",employeeId,fundAccountId:fund,verificationReference:proof,expiresAt:Date.parse(`${expiry}T23:59:59+05:30`)})}>Save reviewed TEST beneficiary</button></details>
 <div style={{margin:"16px 0"}}><label>Prepared payroll run<select style={inputStyle} value={runId} onChange={e=>setRunId(e.target.value)}><option value="">Choose prepared payroll</option>{runs.filter(r=>r.status==="payment_prepared").map(r=><option key={r.id} value={r.id}>{r.id}</option>)}</select></label><button disabled={busy||!confirmed||!runId} onClick={()=>void act({action:"authorize_salary_sandbox",runId})}>Authorize TEST salary instructions</button></div>
 <button disabled={busy} onClick={()=>void refresh().catch(e=>setError(e.message))}>Refresh salary status</button>
 {!items.length&&<p>No employee salary instructions have been authorized.</p>}
 {items.map(item=><article key={item.id} style={{borderTop:"1px solid var(--staff-line)",padding:"16px 0"}}><strong>{employees.find(e=>e.id===item.employeeId)?.display_name||item.employeeId} · ₹{(item.amountPaise/100).toFixed(2)}</strong><p>{item.status} · {item.runId}</p><p>Principal accounting: {books.find(b=>b.local_payout_id===item.id)?.status.replaceAll("_"," ")||"Awaiting provider confirmation"}. Bank-statement verification remains separate.</p>{item.providerPayoutId&&<p>TEST provider reference: {item.providerPayoutId}{item.utr?` · ${item.utr}`:""}</p>}{item.error&&<p role="alert">{item.error}</p>}
 {["approved_sandbox","reconciliation_required"].includes(item.status)&&<button disabled={busy||!confirmed} onClick={()=>void act({action:"dispatch_salary_sandbox",instructionId:item.id})}>Dispatch original TEST instruction</button>}{" "}
 {item.providerPayoutId&&<button disabled={busy||!confirmed} onClick={()=>void act({action:"reconcile_salary_sandbox",instructionId:item.id})}>Reconcile TEST provider status</button>}
 </article>)}
 </section>;
}
