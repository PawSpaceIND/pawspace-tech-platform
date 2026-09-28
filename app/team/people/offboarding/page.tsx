"use client";
import {useCallback,useEffect,useRef,useState} from "react";
import Link from "next/link";
import StaffModule from "../../../components/staff-workspace/StaffModule";
import styles from "./offboarding.module.css";
type ExitCase={id:string;employee_id:string;identity_email:string;access_ends_at:number;status:string;reason:string;requested_by:string;approved_by:string|null};
type Employee={id:string;employee_code:string;display_name:string;employment_status:string};
type Directory={asOf:number;cases:ExitCase[];hasMore:boolean;capabilities:{identity:boolean;salaryView:boolean;settlement:boolean}};
type Review={caseId:string;employeeId:string;caseStatus:string;accessEndsAt:number;ready:boolean;revision:string;blockers:string[];settledEvidenceCurrent:boolean;sources:{payroll:Array<{id:string;run_id:string;net_pay:number;status:string}>;handover:Array<{type:string;id:string}>}};
const at=(v:number)=>new Intl.DateTimeFormat("en-IN",{timeZone:"Asia/Kolkata",dateStyle:"medium",timeStyle:"short"}).format(new Date(v));
const money=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR"}).format(v);
async function exchange<T>(path:string,body?:Record<string,unknown>):Promise<T>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),25000);
 try{const response=await fetch(path,{method:body?"POST":"GET",credentials:"same-origin",cache:"no-store",signal:controller.signal,...(body?{headers:{"content-type":"application/json"},body:JSON.stringify(body)}:{})});
  const payload=await response.json();if(!response.ok)throw new Error(payload.error||`Request refused (${response.status})`);if(!payload.data)throw new Error("The server did not return employee review data");return payload.data as T;
 }finally{clearTimeout(timer);}
}
export default function EmployeeOffboardingPage(){
 const[data,setData]=useState<Directory|null>(null),[employees,setEmployees]=useState<Employee[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(""),[notice,setNotice]=useState("");
 const[form,setForm]=useState({employeeId:"",cutoff:"",reason:""}),[confirmed,setConfirmed]=useState(false),[busy,setBusy]=useState(false);
 const[review,setReview]=useState<Review|null>(null),[reviewLoading,setReviewLoading]=useState(false),[clearance,setClearance]=useState(""),[policy,setPolicy]=useState(""),[testConfirmed,setTestConfirmed]=useState(false);
 const lock=useRef(false),requestKey=useRef(""),reviewSequence=useRef(0),mounted=useRef(true);
 const load=useCallback(async()=>{try{const directory=await exchange<Directory>("/api/employee-offboarding");const people=directory.capabilities.identity?await exchange<{employees:Employee[]}>("/api/people-foundation"):{employees:[]};if(mounted.current){setData(directory);setEmployees(people.employees);setError("");}}catch(e){if(mounted.current){setData(null);setError(e instanceof Error?e.message:"Employee exit data is unavailable");}}finally{if(mounted.current)setLoading(false);}},[]);
 useEffect(()=>{let active=true;mounted.current=true;
  void exchange<Directory>("/api/employee-offboarding").then(async directory=>{const people=directory.capabilities.identity?await exchange<{employees:Employee[]}>("/api/people-foundation"):{employees:[]};if(active){setData(directory);setEmployees(people.employees);setError("");}}).catch(e=>{if(active){setData(null);setError(e instanceof Error?e.message:"Employee exit data is unavailable");}}).finally(()=>{if(active)setLoading(false);});
  return()=>{active=false;mounted.current=false;};
 },[]);
 async function openReview(id:string){const seq=++reviewSequence.current;setReview(null);setReviewLoading(true);setTestConfirmed(false);setClearance("");setPolicy("");try{const value=await exchange<Review>(`/api/employee-offboarding?caseId=${encodeURIComponent(id)}`);if(mounted.current&&seq===reviewSequence.current)setReview(value);}catch(e){if(mounted.current&&seq===reviewSequence.current)setError(e instanceof Error?e.message:"Settlement review is unavailable");}finally{if(mounted.current&&seq===reviewSequence.current)setReviewLoading(false);}}
 async function mutate(body:Record<string,unknown>,success:string){if(lock.current)return false;lock.current=true;setBusy(true);setError("");setNotice("");reviewSequence.current++;setReview(null);setReviewLoading(false);try{await exchange("/api/employee-offboarding",body);if(mounted.current){setNotice(success);await load();}return true;}catch(e){if(mounted.current)setError(e instanceof Error?e.message:"The update was not confirmed. Refresh before retrying.");return false;}finally{lock.current=false;if(mounted.current)setBusy(false);}}
 function change(key:keyof typeof form,value:string){requestKey.current="";setConfirmed(false);setForm(current=>({...current,[key]:value}));}
 async function create(){const accessEndsAt=Date.parse(`${form.cutoff}:00+05:30`);if(!Number.isFinite(accessEndsAt)){setError("Choose a valid India-time access cutoff");return;}if(!requestKey.current)requestKey.current=crypto.randomUUID();if(await mutate({action:"request",employeeId:form.employeeId,accessEndsAt,reason:form.reason,idempotencyKey:requestKey.current},"Exit requested. A different authorized staff member must approve it.")){requestKey.current="";setConfirmed(false);setForm({employeeId:"",cutoff:"",reason:""});}}
 function decide(row:ExitCase,action:"approve"|"execute"|"cancel"){if(action==="cancel"){const reason=window.prompt("Why is this exit being cancelled? At least eight characters.");if(reason)void mutate({action,caseId:row.id,reason},"Exit cancellation recorded.");return;}if(window.confirm(`${action==="approve"?"Approve the exit for":"Revoke staff access for"} ${row.identity_email}? The approved cutoff is ${at(row.access_ends_at)} IST. Earned salary and handover records will be retained.`))void mutate({action,caseId:row.id},action==="approve"?"Exit approved. Access will stop at the recorded cutoff.":"Access revoked. Complete handover and Finance review separately.");}
 return <StaffModule><main className={styles.page}>
  <p><Link href="/team/people">← People</Link></p><button disabled={busy||loading} onClick={()=>{setLoading(true);void load();}}>Refresh records</button><h1>Employee exits & final-settlement review</h1>
  <p>Request an exit, obtain independent approval and preserve earned payroll. Access removal never marks salary paid or silently cancels assigned work.</p>
  <aside className={styles.boundary}><strong>Sandbox settlement only.</strong> This screen does not send a bank payment. Statutory entitlements, deductions, equipment clearance and policy applicability need an explicit Finance/HR review.</aside>
  {error&&<p role="alert" className={styles.error}>{error}</p>}{notice&&<p role="status">{notice}</p>}
  {loading&&<p role="status">Loading employee exit records…</p>}
  {!loading&&!data&&<section><h2>Employee exits unavailable</h2><p>People and user-administration access is required. No employee or salary state is inferred from a failed read.</p><button onClick={()=>void load()}>Retry</button><p><Link href="/team">Staff home and sign-in</Link></p></section>}
  {data?.capabilities.identity&&<section className={styles.panel}><h2>Request an employee exit</h2><form onSubmit={e=>{e.preventDefault();if(confirmed)void create();}}>
   <div className={styles.grid}><label>Employee<select required disabled={busy} value={form.employeeId} onChange={e=>change("employeeId",e.target.value)}><option value="">Choose an active employee</option>{employees.filter(e=>e.employment_status==="active").map(e=><option key={e.id} value={e.id}>{e.display_name} · {e.employee_code}</option>)}</select></label>
   <label>Access stops at (India time)<input type="datetime-local" step="60" required disabled={busy} value={form.cutoff} onChange={e=>change("cutoff",e.target.value)}/></label></div>
   <label>Reason<textarea required minLength={8} disabled={busy} value={form.reason} onChange={e=>change("reason",e.target.value)}/></label>
   <label className={styles.check}><input type="checkbox" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/>I have reviewed the employee and cutoff. Another authorized person must approve this request.</label>
   <button type="submit" disabled={busy||!confirmed||!form.employeeId||!form.cutoff||form.reason.trim().length<8}>Request exit</button>
  </form></section>}
  {data&&<section><h2>Exit records</h2>{data.hasMore&&<p role="status">Showing the most recent 200 cases; older history remains in the audit records.</p>}{!data.cases.length&&<p>No employee exits have been recorded.</p>}
   <div className={styles.cards}>{data.cases.map(row=><article key={row.id} className={styles.panel}><h3>{row.identity_email}</h3><p><strong>{row.status.replaceAll("_"," ")}</strong> · Access cutoff {at(row.access_ends_at)} IST</p><p>{row.reason}</p><p>Requested by {row.requested_by} · Approved by {row.approved_by||"Not approved"}</p><small>Case <code>{row.id}</code> · Employee <code>{row.employee_id}</code></small>
    <div className={styles.actions}>{data.capabilities.identity&&row.status==="pending"&&<button disabled={busy} onClick={()=>decide(row,"approve")}>Approve exit</button>}
     {data.capabilities.identity&&row.status==="approved"&&<button disabled={busy||row.access_ends_at>data.asOf} onClick={()=>decide(row,"execute")}>Execute due exit</button>}
     {data.capabilities.identity&&(row.status==="pending"||(row.status==="approved"&&row.access_ends_at>data.asOf))&&<button disabled={busy} onClick={()=>decide(row,"cancel")}>Cancel exit request</button>}
     {data.capabilities.salaryView&&row.status!=="cancelled"&&<button disabled={busy||reviewLoading} onClick={()=>void openReview(row.id)}>Review handover & settlement</button>}
    </div></article>)}</div></section>}
  {reviewLoading&&<p role="status">Checking canonical payroll, salary confirmations and handover…</p>}
  {review&&<section className={styles.panel}><h2>Final-settlement review</h2><p>Employee <code>{review.employeeId}</code> · {review.caseStatus.replaceAll("_"," ")}</p>
   {review.caseStatus==="settled_sandbox"&&<p role={review.settledEvidenceCurrent?"status":"alert"}>{review.settledEvidenceCurrent?"The recorded sandbox review still matches current source evidence.":"Source evidence has changed since the recorded review. Finance must reconcile it; the old review is not current settlement proof."}</p>}
   {!!review.blockers.length&&<div role="alert"><strong>Required before closure</strong><ul>{review.blockers.map(item=><li key={item}>{item.replaceAll("_"," ")}</li>)}</ul></div>}
   <h3>Canonical payroll records</h3>{!review.sources.payroll.length?<p>No payroll result has been found. Salary is unknown, not zero.</p>:review.sources.payroll.map(row=><p key={row.id}>{money(Number(row.net_pay))} · {row.status.replaceAll("_"," ")} · Result <code>{row.id}</code></p>)}
   {!!review.sources.handover.length&&<><h3>Open handover items</h3>{review.sources.handover.map(item=><p key={`${item.type}:${item.id}`}>{item.type.replaceAll("_"," ")} · <code>{item.id}</code></p>)}</>}
   <p><Link href="/team/people/payroll">Payroll controls</Link> · <Link href="/team/people/incentives">Incentives</Link> · <Link href="/team/sales">Sales handover</Link> · <Link href="/team/people">People and reporting lines</Link></p>
   {data?.capabilities.settlement&&review.caseStatus!=="settled_sandbox"&&<form onSubmit={e=>{e.preventDefault();if(review.ready&&testConfirmed)void mutate({action:"settle_sandbox",caseId:review.caseId,revision:review.revision,clearanceReference:clearance,policyReviewReference:policy,confirmSandbox:true},"Sandbox settlement review recorded. No bank payment was initiated.");}}>
    <div className={styles.grid}><label>Handover & equipment clearance reference<input required minLength={8} value={clearance} disabled={busy} onChange={e=>setClearance(e.target.value)}/></label><label>Finance policy-review reference<input required minLength={8} value={policy} disabled={busy} onChange={e=>setPolicy(e.target.value)}/></label></div>
    <label className={styles.check}><input type="checkbox" checked={testConfirmed} disabled={busy} onChange={e=>setTestConfirmed(e.target.checked)}/>I reviewed the current evidence and policy references. This records sandbox completion only, not a real bank deposit or statutory filing.</label>
    <button disabled={busy||!review.ready||!testConfirmed||clearance.trim().length<8||policy.trim().length<8}>Record sandbox settlement review</button>
   </form>}
  </section>}
 </main></StaffModule>;
}
