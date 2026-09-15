"use client";
import{useEffect,useState}from"react";
import Link from"next/link";

type Mapping={source_key:string;account_code:string;approval_reference:string};
type ExpenseLink={expense_id:string;employee_id:string;employee_code?:string|null;merchant?:string|null;amount?:number|null;linkage_status:string};
type PayrollPost={payroll_run_id:string;period_code:string;status:string;total_debit:number;total_credit:number};
type Policy={id:string;policy_code:string;version:number;status:string};
type ExportRow={id:string;payroll_run_id:string;period_code:string;sandbox_only:number;external_submission:number};
type Reconciliation={id:string;payroll_batch_id:string;period_code:string;sandbox_reference:string;expected_amount:number;matched_amount:number;status:string};
type Period={period_code:string;status:string};
type PostableRun={id:string;period_start:number;period_end:number;status:string;period_code:string};
type ReconcilableBatch={id:string;run_id:string;total_amount:number;status:string;period_code:string};
type UnlinkedExpense={id:string;expense_date:string;merchant:string;amount:number;claimant:string};
type LinkableEmployee={id:string;employee_code:string;display_name:string};
type Payload={mappings:Mapping[];expenseLinks:ExpenseLink[];payrollPosts:PayrollPost[];statutoryPolicies:Policy[];statutoryExports:ExportRow[];bankReconciliations:Reconciliation[];periods:Period[];requiredPayrollAccountKeys:string[];postableRuns?:PostableRun[];exportableRuns?:PostableRun[];reconcilableBatches?:ReconcilableBatch[];unlinkedExpenses?:UnlinkedExpense[];linkableEmployees?:LinkableEmployee[];truth:{expenseEmployeeLinkageEnabled:boolean;payrollJournalConfigured:boolean;missingPayrollAccountMappings:string[];statutoryPolicyConfigured:boolean;financePeriodLockingEnforced:boolean;statutoryExternalSubmissionEnabled:boolean;liveBankTransmissionEnabled:boolean;bankReconciliationMode:string;sandboxOnly:boolean;productionReady:boolean}};

async function loadPayload(){const r=await fetch("/api/people-finance",{cache:"no-store"}),p=await r.json();if(!r.ok)throw new Error(p.error||"People Finance load failed");return p.data as Payload;}
const rupee=(v:number)=>new Intl.NumberFormat("en-IN",{style:"currency",currency:"INR",maximumFractionDigits:2}).format(v||0);
const day=(v:number)=>new Date(v).toLocaleDateString("en-IN",{timeZone:"Asia/Kolkata"});

/**
 * The six Gate 5 controls, which no screen had.
 *
 * app/api/people-finance/route.ts has always accepted `configure_account`, `link_expense`,
 * `post_payroll_journal`, `save_statutory_policy`, `create_statutory_export` and
 * `record_bank_reconciliation`, and NOT ONE of them was posted by any .tsx in the product. This page
 * rendered the results of those six actions - account mappings, journals, reconciliation references -
 * while offering no way to perform any of them, so the only route to a Finance posting was curl.
 *
 * Every one of the six is a HUMAN action, which is why each gets a control instead of a scheduler:
 * worker/index.ts's `scheduled()` handler calls none of them; `configure_account` and
 * `save_statutory_policy` carry an `approvalReference` naming a real Finance approval;
 * `link_expense` carries a written reason; `post_payroll_journal` and `create_statutory_export`
 * commit an approved payroll run to the books; and `record_bank_reconciliation` is somebody reading a
 * sandbox statement and typing what they matched. All six write through `finance.manage`.
 *
 * The builders below are exported so a test can prove that the body the button posts is the body the
 * real route accepts, and each returns the operator's own reason when the draft is not postable yet.
 * Nothing is pre-filled: an unconfigured field is refused, never defaulted.
 */
export type MappingDraft={sourceKey:string;accountCode:string;approvalReference:string};
export type ExpenseLinkDraft={expenseId:string;employeeId:string;reason:string};
export type JournalDraft={runId:string;periodCode:string};
export type StatutoryPolicyDraft={policyCode:string;effectiveFrom:string;config:string;approvalReference:string};
export type StatutoryExportDraft={runId:string;periodCode:string;policyVersionId:string};
export type ReconciliationDraft={payrollBatchId:string;periodCode:string;sandboxReference:string;matchedAmount:string};

export const EMPTY_MAPPING_DRAFT:MappingDraft={sourceKey:"",accountCode:"",approvalReference:""};
export const EMPTY_EXPENSE_LINK_DRAFT:ExpenseLinkDraft={expenseId:"",employeeId:"",reason:""};
export const EMPTY_JOURNAL_DRAFT:JournalDraft={runId:"",periodCode:""};
export const EMPTY_STATUTORY_POLICY_DRAFT:StatutoryPolicyDraft={policyCode:"",effectiveFrom:"",config:"",approvalReference:""};
export const EMPTY_STATUTORY_EXPORT_DRAFT:StatutoryExportDraft={runId:"",periodCode:"",policyVersionId:""};
export const EMPTY_RECONCILIATION_DRAFT:ReconciliationDraft={payrollBatchId:"",periodCode:"",sandboxReference:"",matchedAmount:""};

type Built={ok:true;body:Record<string,unknown>}|{ok:false;error:string};

export const PERIOD_CODE=/^\d{4}-(0[1-9]|1[0-2])$/;
/** A yyyy-mm-dd field as the epoch milliseconds the engine stores, or null when it is not a date. */
export function dayValue(value:string){
  const text=String(value??"").trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(text))return null;
  const parsed=Date.parse(`${text}T00:00:00.000Z`);
  return Number.isFinite(parsed)?parsed:null;
}

export function configureAccountPayload(draft:MappingDraft,requiredKeys:string[]):Built{
  const sourceKey=draft.sourceKey.trim(),accountCode=draft.accountCode.trim(),approvalReference=draft.approvalReference.trim();
  if(!requiredKeys.includes(sourceKey))return{ok:false,error:"Choose one of the required payroll account keys"};
  if(!accountCode)return{ok:false,error:"Finance account code is required"};
  if(approvalReference.length<4)return{ok:false,error:"Finance approval reference is required"};
  return{ok:true,body:{action:"configure_account",sourceKey,accountCode,approvalReference}};
}

export function linkExpensePayload(draft:ExpenseLinkDraft):Built{
  const expenseId=draft.expenseId.trim(),employeeId=draft.employeeId.trim(),reason=draft.reason.trim();
  if(!expenseId)return{ok:false,error:"Choose the expense to link"};
  if(!employeeId)return{ok:false,error:"Choose the employee this expense belongs to"};
  if(reason.length<8)return{ok:false,error:"A clear expense linkage reason is required"};
  return{ok:true,body:{action:"link_expense",expenseId,employeeId,reason}};
}

/**
 * The period is DERIVED from the run, never typed.
 *
 * postPayrollJournal dates its entries from the run's own period_end and refuses a declared period
 * that disagrees ("period_mismatch: this payroll run is dated 2026-07; it cannot be posted as
 * 2026-08"), because posting the identical journal under a different month splits the books. A
 * free-text period field could only ever produce that refusal, so the control carries the run's own
 * period code and the operator cannot get it wrong.
 */
export function postPayrollJournalPayload(draft:JournalDraft):Built{
  const runId=draft.runId.trim(),periodCode=draft.periodCode.trim();
  if(!runId)return{ok:false,error:"Choose an approved payroll run to post"};
  if(!PERIOD_CODE.test(periodCode))return{ok:false,error:"A valid finance period code YYYY-MM is required"};
  return{ok:true,body:{action:"post_payroll_journal",runId,periodCode}};
}

export function saveStatutoryPolicyPayload(draft:StatutoryPolicyDraft):Built{
  const policyCode=draft.policyCode.trim(),approvalReference=draft.approvalReference.trim();
  if(!policyCode)return{ok:false,error:"Statutory policy code is required"};
  const effectiveFrom=dayValue(draft.effectiveFrom);
  if(effectiveFrom===null)return{ok:false,error:"Statutory policy effective date is required"};
  let config:unknown;
  try{config=JSON.parse(draft.config||"");}catch{return{ok:false,error:"Statutory configuration must be a JSON object"};}
  if(!config||typeof config!=="object"||Array.isArray(config)||!Object.keys(config as Record<string,unknown>).length)
    return{ok:false,error:"Explicit statutory configuration is required"};
  if(approvalReference.length<4)return{ok:false,error:"Statutory approval reference is required"};
  return{ok:true,body:{action:"save_statutory_policy",policyCode,effectiveFrom,config,approvalReference}};
}

export function createStatutoryExportPayload(draft:StatutoryExportDraft):Built{
  const runId=draft.runId.trim(),policyVersionId=draft.policyVersionId.trim(),periodCode=draft.periodCode.trim();
  if(!runId)return{ok:false,error:"Choose an approved payroll run to export"};
  if(!policyVersionId)return{ok:false,error:"Choose the active statutory policy version to export under"};
  if(!PERIOD_CODE.test(periodCode))return{ok:false,error:"A valid finance period code YYYY-MM is required"};
  return{ok:true,body:{action:"create_statutory_export",runId,policyVersionId,periodCode}};
}

export function recordBankReconciliationPayload(draft:ReconciliationDraft):Built{
  const payrollBatchId=draft.payrollBatchId.trim(),sandboxReference=draft.sandboxReference.trim(),periodCode=draft.periodCode.trim();
  if(!payrollBatchId)return{ok:false,error:"Choose the sandbox payment batch being reconciled"};
  if(!PERIOD_CODE.test(periodCode))return{ok:false,error:"A valid finance period code YYYY-MM is required"};
  if(sandboxReference.length<4)return{ok:false,error:"Sandbox reconciliation reference is required"};
  const matchedAmount=Number(String(draft.matchedAmount??"").trim());
  if(!String(draft.matchedAmount??"").trim()||!Number.isFinite(matchedAmount)||matchedAmount<0)return{ok:false,error:"Matched amount must be zero or positive"};
  return{ok:true,body:{action:"record_bank_reconciliation",payrollBatchId,periodCode,sandboxReference,matchedAmount}};
}

const card={border:"1px solid #ddd",borderRadius:10,padding:12,display:"grid",gap:6} as const;
const field={display:"block",width:"100%",padding:8} as const;

export default function PeopleFinancePage(){
  const[data,setData]=useState<Payload|null>(null),[error,setError]=useState(""),[loading,setLoading]=useState(true);
  const[busy,setBusy]=useState<string|null>(null),[actionError,setActionError]=useState(""),[actionNote,setActionNote]=useState("");
  const[mappingDraft,setMappingDraft]=useState<MappingDraft>({...EMPTY_MAPPING_DRAFT});
  const[expenseDraft,setExpenseDraft]=useState<ExpenseLinkDraft>({...EMPTY_EXPENSE_LINK_DRAFT});
  const[journalDraft,setJournalDraft]=useState<JournalDraft>({...EMPTY_JOURNAL_DRAFT});
  const[policyDraft,setPolicyDraft]=useState<StatutoryPolicyDraft>({...EMPTY_STATUTORY_POLICY_DRAFT});
  const[exportDraft,setExportDraft]=useState<StatutoryExportDraft>({...EMPTY_STATUTORY_EXPORT_DRAFT});
  const[reconciliationDraft,setReconciliationDraft]=useState<ReconciliationDraft>({...EMPTY_RECONCILIATION_DRAFT});

  const refresh=async()=>{try{setData(await loadPayload());setError("");}catch(e){setError(e instanceof Error?e.message:String(e));}};
  useEffect(()=>{let active=true;void loadPayload().then(x=>{if(active){setData(x);setError("");}}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e));}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[]);

  /* The route's own refusal text reaches the operator verbatim; lib/people-finance-integration.ts
   * brands each business rule so authError() keeps its message and its 4xx instead of redacting it
   * to "People Finance update failed". */
  async function post(payload:Record<string,unknown>){
    const response=await fetch("/api/people-finance",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(payload)});
    const body=await response.json() as {error?:string};
    if(!response.ok)throw new Error(body.error||"People Finance action failed");
    return body;
  }
  async function submit(key:string,built:Built,note:string,reset:()=>void){
    if(!built.ok){setActionError(built.error);setActionNote("");return;}
    setBusy(key);setActionError("");setActionNote("");
    try{await post(built.body);reset();setActionNote(note);await refresh();}
    catch(e){setActionError(e instanceof Error?e.message:String(e));}
    finally{setBusy(null);}
  }

  const requiredKeys=data?.requiredPayrollAccountKeys??[];
  const runs=data?.postableRuns??[];
  /* The statutory export lists EXPORTABLE runs, not postable ones. [R3E-STATUTORY-EXPORT-REACH]
   * `postableRuns` drops a run the moment its Finance journal is posted - which is the normal next
   * step - so this dropdown emptied itself with no explanation and the month's statutory package
   * became unreachable, while the same export succeeded over the API. */
  const exportRuns=data?.exportableRuns??runs;
  const batches=data?.reconcilableBatches??[];
  const expenses=data?.unlinkedExpenses??[];
  const employees=data?.linkableEmployees??[];
  const activePolicies=(data?.statutoryPolicies??[]).filter(p=>p.status==="active_uat");

  return <main style={{maxWidth:1180,margin:"0 auto",padding:"32px 20px",fontFamily:"system-ui,sans-serif"}}>
    <p><Link href="/team/people">← People</Link> · <Link href="/team/people/payroll">Payroll →</Link></p>
    <p style={{fontWeight:800,letterSpacing:1}}>PAWSPACE · PEOPLE · FINANCE + STATUTORY</p>
    <h1>Gate 5 integration control</h1>
    <p>Employee expenses can be linked to the employee master. Approved payroll can post only through Finance-approved account mappings and unlocked periods. Statutory output and bank reconciliation are UAT sandbox records only; this workspace never submits a filing or transmits a bank instruction.</p>
    {error?<p style={{color:"crimson"}}>{error}</p>:null}
    {actionError?<p style={{color:"crimson"}}>{actionError}</p>:null}
    {actionNote?<p style={{color:"#276"}}>{actionNote}</p>:null}

    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(210px,1fr))",gap:10,margin:"18px 0"}}>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Expense links</small><strong style={{display:"block",fontSize:28}}>{data?.expenseLinks.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Payroll journals</small><strong style={{display:"block",fontSize:28}}>{data?.payrollPosts.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Statutory policies</small><strong style={{display:"block",fontSize:28}}>{data?.statutoryPolicies.length||0}</strong></article>
      <article style={{border:"1px solid #ddd",borderRadius:12,padding:14}}><small>Bank mode</small><strong style={{display:"block",fontSize:18}}>{data?.truth.bankReconciliationMode||"sandbox_reference_only"}</strong></article>
    </section>

    <h2>Gate 5 controls</h2>
    <p style={{color:"#666",fontSize:13}}>All six write through <code>finance.manage</code> and are recorded in the security audit. Nothing here is pre-filled; a refusal from the engine is shown exactly as it was written.</p>
    <section style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(330px,1fr))",gap:10}}>

      <article style={card}>
        <b>Configure a payroll account mapping</b>
        <p style={{fontSize:12,color:"#666",margin:0}}>Payroll cannot post to Finance until every required key carries a Finance-approved account code.</p>
        <label>Mapping key<select style={field} value={mappingDraft.sourceKey} onChange={e=>setMappingDraft({...mappingDraft,sourceKey:e.target.value})}>
          <option value="">Choose a key…</option>{requiredKeys.map(key=><option key={key} value={key}>{key}</option>)}</select></label>
        <label>Finance account code<input style={field} value={mappingDraft.accountCode} onChange={e=>setMappingDraft({...mappingDraft,accountCode:e.target.value})}/></label>
        <label>Finance approval reference<input style={field} value={mappingDraft.approvalReference} onChange={e=>setMappingDraft({...mappingDraft,approvalReference:e.target.value})}/></label>
        <button disabled={busy!=null} onClick={()=>void submit("configure_account",configureAccountPayload(mappingDraft,requiredKeys),"Account mapping saved",()=>setMappingDraft({...EMPTY_MAPPING_DRAFT}))}>{busy==="configure_account"?"Saving…":"Save mapping"}</button>
      </article>

      <article style={card}>
        <b>Link an expense to an employee</b>
        <p style={{fontSize:12,color:"#666",margin:0}}>The expense ledger is never rewritten; this records who the expense belongs to, and why.</p>
        <label>Expense<select style={field} value={expenseDraft.expenseId} onChange={e=>setExpenseDraft({...expenseDraft,expenseId:e.target.value})}>
          <option value="">Choose an unlinked expense…</option>{expenses.map(x=><option key={x.id} value={x.id}>{x.expense_date} · {x.merchant} · {rupee(x.amount)} · {x.claimant}</option>)}</select></label>
        <label>Employee<select style={field} value={expenseDraft.employeeId} onChange={e=>setExpenseDraft({...expenseDraft,employeeId:e.target.value})}>
          <option value="">Choose an active employee…</option>{employees.map(e2=><option key={e2.id} value={e2.id}>{e2.employee_code} · {e2.display_name}</option>)}</select></label>
        <label>Reason (at least 8 characters)<input style={field} value={expenseDraft.reason} onChange={e=>setExpenseDraft({...expenseDraft,reason:e.target.value})}/></label>
        <button disabled={busy!=null} onClick={()=>void submit("link_expense",linkExpensePayload(expenseDraft),"Expense linked",()=>setExpenseDraft({...EMPTY_EXPENSE_LINK_DRAFT}))}>{busy==="link_expense"?"Linking…":"Link expense"}</button>
      </article>

      <article style={card}>
        <b>Post an approved payroll run to Finance</b>
        <p style={{fontSize:12,color:"#666",margin:0}}>The period is the run&apos;s own; a run is only listed here while it is approved, unlocked and not yet posted.</p>
        {data&&!data.truth.payrollJournalConfigured?<p style={{fontSize:12,color:"#a35",margin:0}}>Configuration required first: {data.truth.missingPayrollAccountMappings.join(", ")}</p>:null}
        <label>Payroll run<select style={field} value={journalDraft.runId} onChange={e=>{const run=runs.find(r=>r.id===e.target.value);setJournalDraft({runId:e.target.value,periodCode:run?.period_code??""});}}>
          <option value="">Choose an approved run…</option>{runs.map(r=><option key={r.id} value={r.id}>{day(r.period_start)} → {day(r.period_end)} · {r.status} · {r.id}</option>)}</select></label>
        <div style={{fontSize:12,color:"#666"}}>Finance period: <b>{journalDraft.periodCode||"—"}</b></div>
        <button disabled={busy!=null} onClick={()=>void submit("post_payroll_journal",postPayrollJournalPayload(journalDraft),"Payroll journal posted",()=>setJournalDraft({...EMPTY_JOURNAL_DRAFT}))}>{busy==="post_payroll_journal"?"Posting…":"Post payroll journal"}</button>
      </article>

      <article style={card}>
        <b>Save a statutory policy version</b>
        <p style={{fontSize:12,color:"#666",margin:0}}>Statutory rates and rules are explicit versioned configuration. There is no default: the configuration below is what will be applied.</p>
        <label>Policy code<input style={field} value={policyDraft.policyCode} onChange={e=>setPolicyDraft({...policyDraft,policyCode:e.target.value})}/></label>
        <label>Effective from<input type="date" style={field} value={policyDraft.effectiveFrom} onChange={e=>setPolicyDraft({...policyDraft,effectiveFrom:e.target.value})}/></label>
        <label>Configuration (JSON object)<textarea style={{...field,minHeight:70,fontFamily:"monospace"}} value={policyDraft.config} onChange={e=>setPolicyDraft({...policyDraft,config:e.target.value})}/></label>
        <label>Statutory approval reference<input style={field} value={policyDraft.approvalReference} onChange={e=>setPolicyDraft({...policyDraft,approvalReference:e.target.value})}/></label>
        <button disabled={busy!=null} onClick={()=>void submit("save_statutory_policy",saveStatutoryPolicyPayload(policyDraft),"Statutory policy version saved",()=>setPolicyDraft({...EMPTY_STATUTORY_POLICY_DRAFT}))}>{busy==="save_statutory_policy"?"Saving…":"Save statutory policy"}</button>
      </article>

      <article style={card}>
        <b>Create a sandbox statutory export</b>
        <p style={{fontSize:12,color:"#666",margin:0}}>A sandbox package only. It is never submitted to any authority: <code>external_submission</code> stays 0.</p>
        <label>Payroll run<select style={field} value={exportDraft.runId} onChange={e=>{const run=exportRuns.find(r=>r.id===e.target.value);setExportDraft({...exportDraft,runId:e.target.value,periodCode:run?.period_code??""});}}>
          <option value="">Choose an approved run…</option>{exportRuns.map(r=><option key={r.id} value={r.id}>{day(r.period_start)} → {day(r.period_end)} · {r.id}</option>)}</select></label>
        {!exportRuns.length?<p style={{fontSize:12,color:"#a35",margin:0}}>No approved payroll run exists yet. A run has to be approved before a statutory package can be built from it.</p>:null}
        <label>Statutory policy version<select style={field} value={exportDraft.policyVersionId} onChange={e=>setExportDraft({...exportDraft,policyVersionId:e.target.value})}>
          <option value="">Choose an active policy version…</option>{activePolicies.map(p=><option key={p.id} value={p.id}>{p.policy_code} v{p.version}</option>)}</select></label>
        <div style={{fontSize:12,color:"#666"}}>Export period: <b>{exportDraft.periodCode||"—"}</b></div>
        <button disabled={busy!=null} onClick={()=>void submit("create_statutory_export",createStatutoryExportPayload(exportDraft),"Sandbox statutory export created",()=>setExportDraft({...EMPTY_STATUTORY_EXPORT_DRAFT}))}>{busy==="create_statutory_export"?"Creating…":"Create sandbox export"}</button>
      </article>

      <article style={card}>
        <b>Record a sandbox bank reconciliation</b>
        <p style={{fontSize:12,color:"#666",margin:0}}>A reference and a matched amount only. No instruction is transmitted, now or ever, from this workspace.</p>
        <label>Sandbox payment batch<select style={field} value={reconciliationDraft.payrollBatchId} onChange={e=>{const batch=batches.find(b=>b.id===e.target.value);setReconciliationDraft({...reconciliationDraft,payrollBatchId:e.target.value,periodCode:batch?.period_code??""});}}>
          <option value="">Choose a prepared batch…</option>{batches.map(b=><option key={b.id} value={b.id}>{b.id} · {rupee(b.total_amount)} · {b.status}</option>)}</select></label>
        <label>Sandbox reference<input style={field} value={reconciliationDraft.sandboxReference} onChange={e=>setReconciliationDraft({...reconciliationDraft,sandboxReference:e.target.value})}/></label>
        <label>Matched amount<input type="number" style={field} value={reconciliationDraft.matchedAmount} onChange={e=>setReconciliationDraft({...reconciliationDraft,matchedAmount:e.target.value})}/></label>
        <div style={{fontSize:12,color:"#666"}}>Finance period: <b>{reconciliationDraft.periodCode||"—"}</b></div>
        <button disabled={busy!=null} onClick={()=>void submit("record_bank_reconciliation",recordBankReconciliationPayload(reconciliationDraft),"Sandbox reconciliation recorded",()=>setReconciliationDraft({...EMPTY_RECONCILIATION_DRAFT}))}>{busy==="record_bank_reconciliation"?"Recording…":"Record reconciliation"}</button>
      </article>

    </section>

    <h2>Payroll account mapping boundary</h2>
    <section style={{display:"grid",gap:8}}>{data?.requiredPayrollAccountKeys.map(key=>{
      const mapping=data.mappings.find(x=>x.source_key===key);
      return <article key={key} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{key}</b><div>{mapping?<>Account <code>{mapping.account_code}</code> · approval {mapping.approval_reference}</>:"Configuration required before Finance posting"}</div></article>;
    })}</section>

    <h2>Recent payroll Finance posts</h2>
    <section style={{display:"grid",gap:8}}>{data?.payrollPosts.map(post2=><article key={post2.payroll_run_id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{post2.period_code} · {post2.status}</b><div><code>{post2.payroll_run_id}</code></div><div>Debit {rupee(post2.total_debit)} · Credit {rupee(post2.total_credit)}</div></article>)}</section>

    <h2>Sandbox reconciliation references</h2>
    <section style={{display:"grid",gap:8}}>{data?.bankReconciliations.map(row=><article key={row.id} style={{border:"1px solid #ddd",borderRadius:10,padding:12}}><b>{row.period_code} · {row.status}</b><div>{row.sandbox_reference}</div><div>Expected {rupee(row.expected_amount)} · matched {rupee(row.matched_amount)}</div></article>)}</section>

    {loading?<p>Loading Gate 5 controls…</p>:null}
    <footer style={{marginTop:24}}><b>Gate 5 engineering:</b> IMPLEMENTED FOR UAT · <b>External statutory submission:</b> NO · <b>Live bank transmission:</b> NO · <b>Production ready:</b> NO</footer>
  </main>;
}
